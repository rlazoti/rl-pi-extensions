import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_WARN_SECONDS = 60;
const MAX_TIMER_MS = 2 ** 31 - 1;

function seconds(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0.001 && n * 1000 <= MAX_TIMER_MS ? n : fallback;
}

function preview(command: string): string {
	const line = command
		.replace(/\s+/gu, " ")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, "")
		.trim();
	const chars = Array.from(line.slice(0, 241));
	return chars.length > 120 ? chars.slice(0, 120).join("") + "…" : line;
}

export default function commandWatchdog(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const timeoutSeconds = seconds(env.PI_COMMAND_WATCHDOG_TIMEOUT, DEFAULT_TIMEOUT_SECONDS);
	const warnSeconds = seconds(env.PI_COMMAND_WATCHDOG_WARN_AFTER, DEFAULT_WARN_SECONDS);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	function clear(id: string): void {
		const timer = timers.get(id);
		if (timer) clearTimeout(timer);
		timers.delete(id);
	}

	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const id = event.toolCallId;
		clear(id);
		// Pi applies this to just the command, returning a native timeout result.
		// Aborting through the extension context would stop sibling calls too.
		event.input.timeout ??= timeoutSeconds;

		if (!ctx.hasUI || !(event.input.timeout > warnSeconds)) return;
		const command = event.input.command;
		const timer = setTimeout(() => {
			timers.delete(id);
			try {
				ctx.ui.notify(`command-watchdog: Bash call still pending after ${warnSeconds} seconds: ${preview(command)}`, "warning");
			} catch {
				// A disappearing UI must not interfere with the native deadline.
			}
		}, warnSeconds * 1000);
		timer.unref();
		timers.set(id, timer);
	});

	// Unlike tool_result, this also fires for a call blocked in preflight.
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "bash") clear(event.toolCallId);
	});

	pi.on("session_shutdown", () => {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	});
}
