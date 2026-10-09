import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

export const PROCESS_ROLE_ENV = "PI_SESSION_ATTENTION_PROCESS_ROLE";
export const DISABLE_ENV = "PI_SESSION_ATTENTION_DISABLE";
export const WAITING_EVENT = "session-attention:waiting";

const ITERM_BUNDLE_ID = "com.googlecode.iterm2";
const EXEC_TIMEOUT_MS = 3_000;
const MAX_TITLE_LENGTH = 100;
const MAX_BODY_LENGTH = 200;

type ProcessRole = "main" | "child";
type DeliveryBackend = "terminal-notifier" | "osascript" | "unavailable";

export interface AttentionNotification {
	title: string;
	body: string;
	group: string;
}

export interface TmuxTarget {
	socket: string;
	paneId: string;
}

interface RegisterOptions {
	role?: ProcessRole;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	pid?: number;
}

interface WaitingPayload {
	title?: string;
	body?: string;
}

/**
 * Claims this Pi process's role and marks every subsequently spawned Pi process
 * as a child. Encoding the owner PID preserves the role across /reload while a
 * descendant, whose PID differs from the inherited owner, becomes a child.
 */
export function claimProcessRole(env: NodeJS.ProcessEnv, pid: number): ProcessRole {
	const existing = env[PROCESS_ROLE_ENV];
	if (existing === `${pid}:main`) return "main";
	if (existing === `${pid}:child`) return "child";

	const role: ProcessRole = existing ? "child" : "main";
	env[PROCESS_ROLE_ENV] = `${pid}:${role}`;
	return role;
}

export function tmuxTargetFromEnv(env: NodeJS.ProcessEnv): TmuxTarget | null {
	const socket = env.TMUX?.split(",")[0]?.trim();
	const paneId = env.TMUX_PANE?.trim();
	if (!socket || !paneId) return null;
	return { socket, paneId };
}

export function formatAskBody(args: unknown): string {
	if (!args || typeof args !== "object") return "Waiting for your input";

	const rawQuestions = (args as { questions?: unknown }).questions;
	const questions = Array.isArray(rawQuestions) ? rawQuestions : rawQuestions ? [rawQuestions] : [];
	if (questions.length > 1) return `${questions.length} questions waiting for your input`;

	const question = questions[0];
	if (!question || typeof question !== "object") return "Waiting for your input";
	const text = (question as { question?: unknown }).question;
	return typeof text === "string" && text.trim()
		? truncateText(text, MAX_BODY_LENGTH)
		: "Waiting for your input";
}

export function buildTmuxActivationCommand(target: TmuxTarget, tmuxBinary: string): string {
	const tmux = shellEscape(tmuxBinary);
	const socket = shellEscape(target.socket);
	const pane = shellEscape(target.paneId);
	return [
		`/usr/bin/open -b ${shellEscape(ITERM_BUNDLE_ID)}`,
		`${tmux} -S ${socket} select-window -t ${pane}`,
		`${tmux} -S ${socket} select-pane -t ${pane}`,
	].join(" && ");
}

export async function sendDesktopNotification(
	pi: Pick<ExtensionAPI, "exec">,
	notification: AttentionNotification,
	target: TmuxTarget | null,
): Promise<DeliveryBackend> {
	const args = [
		"-title", notification.title,
		"-message", notification.body,
		"-group", notification.group,
		"-sound", "default",
	];

	const tmuxBinary = target ? await resolveTmuxBinary(pi) : null;
	if (target && tmuxBinary) {
		args.push("-execute", buildTmuxActivationCommand(target, tmuxBinary));
	} else {
		args.push("-activate", ITERM_BUNDLE_ID);
	}

	const terminalNotifier = await safeExec(pi, "terminal-notifier", args);
	if (terminalNotifier?.code === 0) return "terminal-notifier";

	const script = `display notification "${escapeAppleScript(notification.body)}" with title "${escapeAppleScript(notification.title)}"`;
	const osascript = await safeExec(pi, "/usr/bin/osascript", ["-e", script]);
	return osascript?.code === 0 ? "osascript" : "unavailable";
}

export function registerSessionAttention(pi: ExtensionAPI, options: RegisterOptions = {}): void {
	const env = options.env ?? process.env;
	const pid = options.pid ?? process.pid;
	const role = options.role ?? claimProcessRole(env, pid);
	const platform = options.platform ?? process.platform;
	const target = tmuxTargetFromEnv(env);
	const disabled = env[DISABLE_ENV] === "1";
	const group = `pi-session-attention:${pid}`;
	let currentContext: ExtensionContext | undefined;

	const isActive = (ctx: ExtensionContext | undefined): boolean =>
		Boolean(ctx && role === "main" && !disabled && platform === "darwin" && ctx.mode === "tui");

	const titleFor = (ctx: ExtensionContext): string => {
		const sessionName = pi.getSessionName()?.trim();
		const label = sessionName || basename(ctx.cwd) || "Pi";
		return truncateText(`π: ${label}`, MAX_TITLE_LENGTH);
	};

	const deliver = async (ctx: ExtensionContext, body: string, title?: string): Promise<DeliveryBackend> => {
		if (!isActive(ctx)) return "unavailable";
		return sendDesktopNotification(pi, {
			title: truncateText(title?.trim() || titleFor(ctx), MAX_TITLE_LENGTH),
			body: truncateText(body, MAX_BODY_LENGTH),
			group,
		}, target);
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await deliver(ctx, "Turn complete — ready for your input");
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName !== "ask") return;
		await deliver(ctx, formatAskBody(event.args));
	});

	pi.events.on(WAITING_EVENT, (payload: unknown) => {
		const ctx = currentContext;
		if (!ctx || !isActive(ctx)) return;
		const waiting = normalizeWaitingPayload(payload);
		void deliver(ctx, waiting.body, waiting.title);
	});

	pi.registerCommand("attention-test", {
		description: "Send a test session-attention desktop notification",
		handler: async (_args, ctx) => {
			if (!isActive(ctx)) {
				ctx.ui.notify(inactiveReason(role, disabled, platform, ctx.mode), "warning");
				return;
			}

			const backend = await deliver(ctx, "Test notification — click to return to this Pi session");
			ctx.ui.notify(
				backend === "unavailable"
					? "Could not deliver a desktop notification"
					: `Session attention test sent via ${backend}`,
				backend === "unavailable" ? "error" : "info",
			);
		},
	});

	pi.registerCommand("attention-status", {
		description: "Show whether session-attention notifications are active",
		handler: async (_args, ctx) => {
			const status = isActive(ctx) ? "active" : inactiveReason(role, disabled, platform, ctx.mode);
			ctx.ui.notify(`Session attention: ${status}`, isActive(ctx) ? "info" : "warning");
		},
	});
}

function normalizeWaitingPayload(payload: unknown): Required<WaitingPayload> {
	if (!payload || typeof payload !== "object") {
		return { title: "", body: "Waiting for your input" };
	}
	const candidate = payload as WaitingPayload;
	return {
		title: typeof candidate.title === "string" ? candidate.title : "",
		body: typeof candidate.body === "string" && candidate.body.trim()
			? candidate.body
			: "Waiting for your input",
	};
}

async function resolveTmuxBinary(pi: Pick<ExtensionAPI, "exec">): Promise<string | null> {
	const result = await safeExec(pi, "/usr/bin/which", ["tmux"]);
	if (result?.code !== 0) return null;
	const binary = result.stdout.trim();
	return binary.startsWith("/") ? binary : null;
}

async function safeExec(
	pi: Pick<ExtensionAPI, "exec">,
	command: string,
	args: string[],
): Promise<ExecResult | null> {
	try {
		return await pi.exec(command, args, { timeout: EXEC_TIMEOUT_MS });
	} catch {
		return null;
	}
}

function inactiveReason(
	role: ProcessRole,
	disabled: boolean,
	platform: NodeJS.Platform,
	mode: ExtensionContext["mode"],
): string {
	if (role === "child") return "disabled in child/background Pi processes";
	if (disabled) return `disabled by ${DISABLE_ENV}=1`;
	if (platform !== "darwin") return "desktop delivery currently requires macOS";
	if (mode !== "tui") return `disabled in ${mode} mode`;
	return "inactive";
}

function truncateText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim() || "Pi needs your attention";
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeAppleScript(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export default function sessionAttention(pi: ExtensionAPI): void {
	registerSessionAttention(pi);
}
