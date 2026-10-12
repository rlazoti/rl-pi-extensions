/**
 * Session Banner — persistent visual identity for Pi sessions.
 *
 * Shows a colored banner widget above the editor with:
 *   emoji │ session name
 *
 * Names sessions automatically by sending compressed conversation context to
 * Claude Haiku in the background on the first 3 user turns. No tool calls,
 * no prompt-engineering pressure on the main agent. Haiku also picks the
 * emoji — it starts the title with whatever single emoji best fits the
 * session; we fall back to a random one from the pool when it omits one.
 *
 * The first attempt fires on `before_agent_start` — the moment the user
 * submits, in parallel with the agent loop — so a clear opening prompt
 * ("fix flaky test in checkout.test.ts") becomes the session name in
 * ~1–2s, not 20 minutes later when the agent finishes. If the prompt is
 * too vague, Haiku returns `SKIP`; the agent_end handler then retries with
 * the assistant's response now in context, and subsequent user turns try
 * again until the name lands (or MAX_AUTO_TURNS is hit).
 *
 * Once a confident name lands it is locked in: later hooks no longer
 * regenerate it, so the title keeps reflecting the session's original
 * intent instead of drifting toward whatever a follow-up turn is about.
 * Retries only continue while the session is still unnamed.
 *
 * Manual renames always win: if the user runs /name (or any other extension
 * sets a name we didn't), we back off permanently for that session.
 *
 * Also sets the terminal/tab title for Ghostty / cmux Cmd+Tab identification,
 * renames the current herdr tab when running inside herdr, and (when running
 * under cmux) renames the cmux workspace itself via the `cmux
 * rename-workspace` CLI so the workspace label in the sidebar updates the
 * moment auto-naming finishes — not a turn later.
 *
 * Commands:
 *   /title <text>  — manually name the session
 *   /title         — re-generate the name from conversation via Haiku
 *
 * Configuration (env vars):
 *   PI_SESSION_BANNER_PROVIDER  — model provider (default: "anthropic")
 *   PI_SESSION_BANNER_MODEL     — model id       (default: "claude-haiku-4-5")
 *   PI_SESSION_BANNER_WIDGET    — set to off/0/false to hide the above-editor
 *                                 banner and keep only the terminal/tab title
 *                                 and pi session name (default: on)
 *   PI_SESSION_BANNER_TITLE_ORDER — "zone-first" (default) renders
 *                                 `π root //areas/core — 🔮 fix bug`;
 *                                 "label-first" renders
 *                                 `π 🔮 fix bug — root //areas/core`
 *
 * NOTE: This extension supersedes the `retitle` extension. Don't enable both —
 * they'd both rename on agent_end and race.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

import { paneRegistry, type BannerOutput } from "./panes.js";

// ─── Test seams ───────────────────────────────────────────────────────────
// Node's test runner cannot mock ESM modules, so the LLM + I/O dependencies
// are injectable. Each setter is null-gated: production runs keep the real
// implementation untouched.
let execFileFn: typeof execFile = execFile;
export function setExecFileForTesting(fn: typeof execFile | null): void {
	if (fn) execFileFn = fn;
}
let fsLike: typeof fs = fs;
export function setFsForTesting(impl: typeof fs | null): void {
	if (impl) fsLike = impl;
}
let completeFn: typeof complete = complete;
export function setCompleteForTesting(fn: typeof complete | null): void {
	if (fn) completeFn = fn;
}
import {
	AUTO_NAME_SYSTEM_PROMPT,
	AUTO_NAME_SYSTEM_PROMPT_FORCE,
	buildAutoNameContext,
	buildTerminalTitle,
	classifyHerdrLabel,
	detectWorldContext,
	adoptExistingSessionName,
	fgHex,
	formatSessionName,
	parseBooleanEnv,
	parseGeneratedName,
	parseSessionName,
	parseTitleOrder,
	randomEmoji,
	randomTitleColor,
} from "./helpers.js";

// Read lazily rather than captured at module load: env set after import (e.g.
// by the test suite) is honored; Pi's env never changes mid-run, so behavior
// in production is identical.
const provider = () => process.env.PI_SESSION_BANNER_PROVIDER || "anthropic";
const modelId = () => process.env.PI_SESSION_BANNER_MODEL || "claude-haiku-4-5";
const MAX_AUTO_TURNS = 3;
const HERDR_TITLE_STATE_LIMIT = 50;
const OPEN_HERDR_TAB_TITLE = "📭 Open";

function herdrTitleStatePath(): string {
  return path.join(os.homedir(), ".pi", "agent", "config", "session-banner", "herdr-titles.json");
}

// ─── cmux workspace title sync ────────────────────────────────────
//
// `ctx.ui.setTitle()` is treated by cmux as a terminal/tab title hint and
// doesn't immediately rename the workspace shown in the sidebar — the user
// reported the workspace title lagging by a turn. Calling `cmux
// rename-workspace` directly via the CLI (same pattern as the cmux-status
// extension) updates the sidebar synchronously so you can identify what each
// workspace is doing the moment auto-naming finishes.
//
// cmux workspaces can contain multiple tabs/surfaces. In that case there is no
// reliable single title for the whole workspace, so before renaming we ask cmux
// for the structured pane list and skip when it reports more than one tab.
// Docked panes (cmux Dock terminals, `dock_scope` set — e.g. a global dock
// terminal that cmux reports inside every workspace) are not workspace tabs,
// so they are excluded from that count.
type HerdrTabGetResponse = { result?: { tab?: { label?: unknown } } };

function herdrTabLabelFromJson(stdout: string): string | null {
  try {
    const response = JSON.parse(stdout) as HerdrTabGetResponse;
    const label = response.result?.tab?.label;
    return typeof label === "string" ? label : null;
  } catch {
    return null;
  }
}

function getHerdrTabLabel(tabId: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFileFn("herdr", ["tab", "get", tabId], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(herdrTabLabelFromJson(stdout));
    });
  });
}

function writeHerdrTabTitle(tabId: string, title: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFileFn("herdr", ["tab", "rename", tabId, title], (error) => resolve(!error));
  });
}

type CmuxPane = {
  dock_scope?: unknown;
  surface_count?: number;
  surface_refs?: unknown[];
  surfaces?: unknown[];
};
type CmuxWorkspace = { ref?: string; panes?: CmuxPane[] };
type CmuxTree = {
  caller?: { workspace_ref?: string | null };
  windows?: Array<{ workspaces?: CmuxWorkspace[] }>;
};

function cmuxWorkspaceHasMultipleTabs(stdout: string): boolean {
  try {
    const tree = JSON.parse(stdout) as CmuxTree;
    const callerWorkspaceRef = tree.caller?.workspace_ref;
    const workspaces = tree.windows?.flatMap((window) => window.workspaces ?? []) ?? [];
    const workspace = callerWorkspaceRef
      ? workspaces.find((candidate) => candidate.ref === callerWorkspaceRef)
      : workspaces[0];
    if (!workspace || !Array.isArray(workspace.panes)) return false;

    let hasSeenTab = false;
    for (const pane of workspace.panes) {
      // Dock panes ride along with every workspace; they aren't tabs.
      if (pane.dock_scope != null) continue;
      let surfaceCount = 0;
      if (Array.isArray(pane.surfaces)) {
        surfaceCount = pane.surfaces.length;
      } else if (Array.isArray(pane.surface_refs)) {
        surfaceCount = pane.surface_refs.length;
      } else if (typeof pane.surface_count === "number") {
        surfaceCount = pane.surface_count;
      }

      if (surfaceCount > 1) return true;
      if (surfaceCount === 1) {
        if (hasSeenTab) return true;
        hasSeenTab = true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function renameCmuxWorkspace(title: string): void {
  const workspaceId = process.env.CMUX_WORKSPACE_ID;
  if (!workspaceId) return;
  // Async + best-effort; never block the agent loop or surface CLI errors.
  execFileFn("cmux", ["--json", "tree", "--workspace", workspaceId], (error, stdout) => {
    if (error) return;
    if (cmuxWorkspaceHasMultipleTabs(stdout)) return;
    execFileFn(
      "cmux",
      ["rename-workspace", "--workspace", workspaceId, "--", title],
      () => {},
    );
  });
}

type RequestAuth = { apiKey?: string; headers?: Record<string, string> };
type AutoNameOptions = { pendingUserMessage?: string; forceTitle?: boolean };
type PendingAutoNameRetry = { ctx: ExtensionContext; options?: AutoNameOptions };
type ModelRegistryWithAuth = {
	getApiKeyAndHeaders?: (model: unknown) => Promise<
		| { ok?: true; apiKey?: string; headers?: Record<string, string> }
		| { ok: false; error?: string }
		| null
		| undefined
	>;
	getApiKey?: (model: unknown) => Promise<string | undefined>;
};

async function getRequestAuth(ctx: ExtensionContext, model: unknown): Promise<RequestAuth | null> {
	const registry = ctx.modelRegistry as unknown as ModelRegistryWithAuth;

	try {
		if (typeof registry.getApiKeyAndHeaders === "function") {
			const auth = await registry.getApiKeyAndHeaders(model);
			if (!auth || auth.ok === false) return null;
			const hasHeaders = Boolean(auth.headers && Object.keys(auth.headers).length > 0);
			if (!auth.apiKey && !hasHeaders) return null;
			return { apiKey: auth.apiKey, headers: auth.headers };
		}

		if (typeof registry.getApiKey === "function") {
			const apiKey = await registry.getApiKey(model);
			return apiKey ? { apiKey } : null;
		}
	} catch {
		return null;
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	let label = "";
	let emoji = "";
	let titleColor = "";

	// When off (PI_SESSION_BANNER_WIDGET=off), skip the colored banner above the
	// editor and keep only the terminal/tab title and the pi session name.
	// Auto-naming, /resume names, and cmux workspace sync are unaffected.
	const showWidget = parseBooleanEnv(process.env.PI_SESSION_BANNER_WIDGET, true);

	// Terminal-title segment order (PI_SESSION_BANNER_TITLE_ORDER). "zone-first"
	// (default) keeps the world context first; "label-first" leads with the
	// session label so it survives tab-title truncation.
	const titleOrder = parseTitleOrder(process.env.PI_SESSION_BANNER_TITLE_ORDER);

	// Auto-naming state.
	//   turnCount: incremented once per user turn (in before_agent_start) so
	//   the cap covers the early + late attempts of the same turn together.
	//   inFlightGeneration: prevents the early (before_agent_start) and late
	//   (agent_end) Haiku calls of the same turn from racing. If the late
	//   backstop arrives while the early call is pending, queue one retry so
	//   an early SKIP can still re-run with the assistant response in context.
	//   autoNamingActive: cleared the moment a confident name lands, so once a
	//   session is named neither the same-turn late backstop nor a later turn
	//   regenerates it. Retries only run while the session is still unnamed.
	//   lastAppliedSessionName/generationEpoch prevent manual renames and stale
	//   cross-session callbacks from being overwritten by background results.
	//   sessionSwitchRestoreTimer tracks Pi's delayed session_switch restore so
	//   a later switch/fork can cancel the stale render before it fires.
	let turnCount = 0;
	let autoNamingActive = true;
	let inFlightGeneration = false;
	let pendingAutoNameRetry: PendingAutoNameRetry | null = null;
	let lastAppliedSessionName = "";
	let generationEpoch = 0;
	let sessionSwitchRestoreTimer: ReturnType<typeof setTimeout> | null = null;
	let bannerRecheckTimer: ReturnType<typeof setTimeout> | null = null;
	// Poll interval + attempt cap for waiting on the editor host to attach (~2s).
	const BANNER_RECHECK_MS = 80;
	const BANNER_RECHECK_MAX = 25;

  // Herdr GUI renames are not visible through Pi session state, so guard every
  // Herdr write with a read of the current tab label. Once a non-owned label is
  // seen, the user's GUI title wins for the rest of this extension instance.
  let herdrTabManuallyRenamed = false;
  let lastHerdrTitleWritten: string | null = null;
  let herdrRenameQueue: Promise<void> = Promise.resolve();
  let herdrTitlePersistenceQueue: Promise<void> = Promise.resolve();
  let herdrRenameEpoch = 0;
  let activeCtx: ExtensionContext | null = null;
  let persistedHerdrTitles: Record<string, string> | null = null;

  function readPersistedHerdrTitles(): Record<string, string> {
    if (persistedHerdrTitles) return persistedHerdrTitles;

    try {
      const parsed = JSON.parse(fsLike.readFileSync(herdrTitleStatePath(), "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        persistedHerdrTitles = pruneHerdrTitles(
          Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
          ),
        );
        return persistedHerdrTitles;
      }
    } catch {
      // Best-effort state only; failed reads fall back to process memory.
    }

    persistedHerdrTitles = {};
    return persistedHerdrTitles;
  }

  function pruneHerdrTitles(titles: Record<string, string>): Record<string, string> {
    const entries = Object.entries(titles);
    if (entries.length <= HERDR_TITLE_STATE_LIMIT) return titles;
    return Object.fromEntries(entries.slice(entries.length - HERDR_TITLE_STATE_LIMIT));
  }

  function persistedHerdrTitle(tabId: string): string | null {
    return readPersistedHerdrTitles()[tabId] ?? null;
  }

  function persistHerdrTitle(tabId: string, title: string): Promise<void> {
    herdrTitlePersistenceQueue = herdrTitlePersistenceQueue
      .catch(() => {})
      .then(async () => {
        try {
          const titles = { ...readPersistedHerdrTitles() };
          delete titles[tabId];
          titles[tabId] = title;
          persistedHerdrTitles = pruneHerdrTitles(titles);

          const statePath = herdrTitleStatePath();
          const snapshot = `${JSON.stringify(persistedHerdrTitles, null, 2)}\n`;
          await fsLike.promises.mkdir(path.dirname(statePath), { recursive: true });
          await fsLike.promises.writeFile(statePath, snapshot, { mode: 0o600 });
        } catch {
          // Best-effort state only; persistence must never reject into the rename queue.
        }
      });
    return herdrTitlePersistenceQueue;
  }

  function resetHerdrRenameGuard(): void {
    herdrTabManuallyRenamed = false;
    herdrRenameEpoch++;
    herdrRenameQueue = Promise.resolve();
  }

  function rememberActiveCtx(ctx: ExtensionContext): boolean {
    if (ctx.hasUI === false) return false;
    activeCtx = ctx;
    return true;
  }

  function adoptManualHerdrSessionName(sessionName: string): void {
    const ctx = activeCtx;
    if (!ctx || ctx.hasUI === false) return;

    const parsed = parseSessionName(sessionName);
    try {
      pi.setSessionName(sessionName);
    } catch {
      return;
    }

    emoji = parsed.emoji;
    label = parsed.label;
    titleColor = parsed.titleColor;
    lastAppliedSessionName = sessionName;
    autoNamingActive = false;
    cancelPendingGeneration();
    renderBanner(ctx);
    renameCmuxWorkspace(sessionName);
  }

  function markHerdrTabOpenForNewSession(): void {
    const herdrTabId = process.env.HERDR_TAB_ID;
    if (process.env.HERDR_ENV !== "1" || !herdrTabId) return;

    const requestEpoch = herdrRenameEpoch;
    herdrRenameQueue = herdrRenameQueue
      .catch(() => {})
      .then(async () => {
        if (requestEpoch !== herdrRenameEpoch) return;
        const wrote = await writeHerdrTabTitle(herdrTabId, OPEN_HERDR_TAB_TITLE);
        if (!wrote || requestEpoch !== herdrRenameEpoch) return;
        herdrTabManuallyRenamed = false;
        lastHerdrTitleWritten = OPEN_HERDR_TAB_TITLE;
        await persistHerdrTitle(herdrTabId, OPEN_HERDR_TAB_TITLE);
      });
  }

  function renameHerdrTab(title: string): void {
    const herdrTabId = process.env.HERDR_TAB_ID;
    if (process.env.HERDR_ENV !== "1" || !herdrTabId || herdrTabManuallyRenamed) return;

    const requestEpoch = herdrRenameEpoch;
    // Async + best-effort; never block the agent loop or surface CLI errors.
    // The queue serializes check-then-write pairs so concurrent naming events
    // cannot observe stale labels and write out of order.
    herdrRenameQueue = herdrRenameQueue
      .catch(() => {})
      .then(async () => {
        if (requestEpoch !== herdrRenameEpoch || herdrTabManuallyRenamed) return;

        const currentLabel = await getHerdrTabLabel(herdrTabId);
        if (requestEpoch !== herdrRenameEpoch) return;

        const persistedLastWritten = persistedHerdrTitle(herdrTabId);
        const hasOwnershipEvidence = lastHerdrTitleWritten !== null || persistedLastWritten !== null;
        const decision = classifyHerdrLabel(currentLabel, title, lastHerdrTitleWritten, persistedLastWritten);
        if (decision === "back_off") {
          herdrTabManuallyRenamed = true;
          // With no in-process or persisted ownership for this tab, a fresh Pi
          // process may be seeing a stale session-banner label from a previous
          // run. Protect the label by backing off, but only adopt it as the Pi
          // session name when we have positive evidence it diverged from a title
          // this extension actually wrote.
          if (hasOwnershipEvidence) adoptManualHerdrSessionName(currentLabel as string);
          return;
        }

        const wrote = await writeHerdrTabTitle(herdrTabId, title);
        if (!wrote || requestEpoch !== herdrRenameEpoch) return;
        lastHerdrTitleWritten = title;
        // Start persistence only after the rename succeeds and its epoch is still current.
        // If a later lifecycle reset bumps the epoch while this best-effort write is in
        // flight, we still let this accepted Herdr title finish; the persistence queue is
        // not reset, so any newer epoch's successful title persists after it and wins.
        await persistHerdrTitle(herdrTabId, title);
      });
  }

	// ─── Banner rendering ─────────────────────────────────────────────

	// Contribute the session title to rich-editor's editor chrome via the shared
	// pane registry. When rich-editor is hosting, the title renders *integrated*
	// into the editor (a single banner) rather than as a separate widget line
	// above it. Registered at a negative order so it outranks rich-editor's own
	// session-name fallback banner (order 0). Reading the live closure vars keeps
	// the pane current as auto-naming / manual renames mutate them.
	const paneReg = paneRegistry();
	const unregisterBannerPane = paneReg.register({
		id: "session-banner:banner",
		slot: "banner",
		order: -10,
		// Honor the same gates as the standalone widget so PI_SESSION_BANNER_WIDGET
		// and the unlabeled state control the integrated banner too. `/editor` no
		// longer has any banner toggle — session-banner owns its banner entirely.
		render: (): BannerOutput | null =>
			showWidget && label ? { slot: "banner", emoji, label, color: titleColor } : null,
	});

	function cancelBannerRecheck(): void {
		if (bannerRecheckTimer) clearTimeout(bannerRecheckTimer);
		bannerRecheckTimer = null;
	}

	function paintBanner(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		const { treeName, zone } = detectWorldContext(ctx.cwd);

		// Terminal / tab title (always set, even without label)
		ctx.ui.setTitle(buildTerminalTitle(treeName, zone, emoji, label, { order: titleOrder }));

		// When rich-editor is hosting the pane registry it composes our banner pane
		// directly into the editor chrome. Clear our standalone widget to avoid a
		// double banner and ask the host to repaint so the new label lands now.
		if (paneReg.hasHost()) {
			ctx.ui.setWidget("session-banner", undefined);
			paneReg.requestRender();
			return;
		}

		// Standalone (no editor host). Banner widget disabled, or unlabeled: clear
		// any prior widget and keep only the title.
		if (!showWidget || !label) {
			ctx.ui.setWidget("session-banner", undefined);
			return;
		}

		ctx.ui.setWidget("session-banner", (_tui, theme) => {
			return {
				render: (width: number) => {
					const content = `  ${emoji}  ${theme.fg("dim", "│")}  ${theme.bold(fgHex(titleColor, label))}`;
					const bar = theme.fg("dim", "─".repeat(width));
					return [bar, truncateToWidth(content, width), bar];
				},
				invalidate: () => {},
			};
		});
	}

	function renderBanner(ctx: ExtensionContext) {
		paintBanner(ctx);
		// Re-arm the deferred re-asserts: every render source (init, switch,
		// fork, renames) is followed by a core repaint that would otherwise win.
		scheduleTitleReasserts(ctx);
		cancelBannerRecheck();
		// Already handed off to the host — nothing to wait for.
		if (paneReg.hasHost()) return;
		// The editor host attaches during the first TUI paint(s), which can land
		// after — and sometimes well after — session_start/switch handlers run (the
		// editor factory may instantiate on a later paint). A one-shot recheck can
		// miss that and leave a duplicate standalone widget. Poll briefly until the
		// host appears, then hand the banner off exactly once; give up after a short
		// window so a genuinely standalone session (no rich-editor) keeps its widget.
		let tries = 0;
		const tick = () => {
			if (paneReg.hasHost()) {
				bannerRecheckTimer = null;
				paintBanner(ctx);
				return;
			}
			if (++tries >= BANNER_RECHECK_MAX) {
				bannerRecheckTimer = null;
				return;
			}
			bannerRecheckTimer = setTimeout(tick, BANNER_RECHECK_MS);
		};
		bannerRecheckTimer = setTimeout(tick, BANNER_RECHECK_MS);
	}

	// ─── State helpers ────────────────────────────────────────────────

	/**
	 * Apply a new label.
	 *
	 * `contextualEmoji` (non-empty) is the task-relevant emoji Haiku chose for an
	 * auto-name; it always wins so the emoji and label stay coherent. When it's
	 * absent we fall back to the random pool, re-rolling only when forceNewVisuals
	 * is set (explicit /title <text>) or no emoji exists yet — so a `/title`
	 * regenerate keeps the existing visuals stable instead of reshuffling them.
	 * (Auto-naming reaches this at most once per session now that the first
	 * confident name locks, so there are no background refinements to churn.)
	 *
	 * Callers are expected to pass a non-empty trimmed label — the regenerate
	 * paths (Haiku via parseGeneratedName, /title args via the `if (input)`
	 * guard) already enforce this.
	 */
	function applyName(newLabel: string, forceNewVisuals: boolean, contextualEmoji?: string): void {
		label = newLabel.trim();
		if (contextualEmoji) emoji = contextualEmoji;
		else if (forceNewVisuals || !emoji) emoji = randomEmoji();
		if (forceNewVisuals || !titleColor) titleColor = randomTitleColor();
		const sessionName = formatSessionName(emoji, label);
		lastAppliedSessionName = sessionName;
		pi.setSessionName(sessionName);
		renameHerdrTab(sessionName);
		renameCmuxWorkspace(sessionName);
	}

	function restoreState(): string {
		const sessionName = pi.getSessionName() || "";
		const parsed = parseSessionName(sessionName);
		emoji = parsed.emoji;
		label = parsed.label;
		titleColor = parsed.titleColor;
		return sessionName;
	}

	function cancelPendingGeneration(): void {
		generationEpoch++;
		inFlightGeneration = false;
		pendingAutoNameRetry = null;
	}

	function resetAutoNaming(currentSessionName: string): void {
		turnCount = 0;
		lastAppliedSessionName = currentSessionName;
		cancelPendingGeneration();
		// If session already has a name (e.g. /resume), leave it alone.
		autoNamingActive = !currentSessionName;
	}

	function cancelPendingSessionSwitchRestore(): void {
		if (sessionSwitchRestoreTimer) clearTimeout(sessionSwitchRestoreTimer);
		sessionSwitchRestoreTimer = null;
	}

	// Pi core paints its own terminal title after session_start and on
	// session_info_changed, overwriting ours. Re-assert on a short cancelable
	// schedule so the banner title reliably wins in practice. (Core behavior
	// verified against the live pi runtime; the pinned SDK predates it, so CI
	// can't cover this.)
	const TITLE_REASSERT_DELAYS_MS = [150, 1000];
	let titleReassertTimers: ReturnType<typeof setTimeout>[] = [];

	function cancelTitleReasserts(): void {
		for (const timer of titleReassertTimers) clearTimeout(timer);
		titleReassertTimers = [];
	}

	function scheduleTitleReasserts(ctx: ExtensionContext): void {
		cancelTitleReasserts();
		for (const delay of TITLE_REASSERT_DELAYS_MS) {
			titleReassertTimers.push(
				setTimeout(() => {
					// Adopt a late-loading session name; otherwise just re-paint.
					if (!adoptExternalSessionName(ctx)) paintBanner(ctx);
				}, delay),
			);
		}
	}

	function adoptExternalSessionName(ctx: ExtensionContext): boolean {
		const currentSessionName = pi.getSessionName() || "";
		if (currentSessionName === lastAppliedSessionName) return false;

		const adopted = adoptExistingSessionName(currentSessionName);
		emoji = adopted?.emoji ?? "";
		label = adopted?.label ?? "";
		titleColor = adopted?.titleColor ?? "";
		lastAppliedSessionName = currentSessionName;
		autoNamingActive = false;
		cancelPendingGeneration();
		renderBanner(ctx);
		renameHerdrTab(currentSessionName);
		return true;
	}

	// ─── Auto-naming via Haiku ────────────────────────────────────────

	async function generateName(
		ctx: ExtensionContext,
		conversation: string,
		options?: { forceTitle?: boolean },
	): Promise<{ emoji: string; label: string } | null> {
		try {
			const model = ctx.modelRegistry.find(provider(), modelId());
			if (!model) return null;

			const auth = await getRequestAuth(ctx, model);
			if (!auth) return null;

			const response = await completeFn(
				model,
				{
					systemPrompt: options?.forceTitle ? AUTO_NAME_SYSTEM_PROMPT_FORCE : AUTO_NAME_SYSTEM_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `<conversation>\n${conversation}\n</conversation>\n\nGenerate a short title.`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers },
			);

			const raw = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();

			return parseGeneratedName(raw);
		} catch {
			return null;
		}
	}

	// ─── Lifecycle ────────────────────────────────────────────────────

	// Shared init for session_start and session_fork: restore whatever name the
	// (new) branch actually carries, render it, and only arm auto-naming when the
	// branch is genuinely unnamed. A fork can inherit the parent's session_info
	// name — Pi copies it into the branched session when you fork after an
	// auto-name has landed — or start unnamed when you fork the first message.
	// restoreState() handles both; hard-clearing visuals would hide an inherited
	// name and wedge auto-naming into permanent back-off on the fork's first turn.
	function initSessionState(ctx: ExtensionContext): void {
		cancelPendingSessionSwitchRestore();
		resetHerdrRenameGuard();
		const currentSessionName = restoreState();
		resetAutoNaming(currentSessionName);
		renderBanner(ctx);
    const hasUserMessage = ctx.sessionManager
      .getBranch()
      .some((entry) => entry.type === "message" && entry.message.role === "user");
    if (!currentSessionName && !hasUserMessage) markHerdrTabOpenForNewSession();
    else renameHerdrTab(currentSessionName);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!rememberActiveCtx(ctx)) return;
		initSessionState(ctx);
	});

	// When the session is replaced (newSession / fork / switchSession / reload),
	// or pi exits, the OLD extension instance receives `session_shutdown` and
	// its captured `pi` + `ctx` become stale — calling `pi.getSessionName()` or
	// `pi.setSessionName()` after that throws `assertActive`. Background Haiku
	// calls launched from this instance can still resolve after shutdown, so we
	// bump the epoch (and clear the deferred switch-restore timer) to make the
	// pending `.then()` early-return before it touches any stale handle.
	pi.on("session_shutdown", async (event, ctx) => {
		activeCtx = null;
		cancelPendingSessionSwitchRestore();
		cancelTitleReasserts();
		cancelBannerRecheck();
		cancelPendingGeneration();
		resetHerdrRenameGuard();
		autoNamingActive = false;
		// Tear down on quit AND reload; both discard this module instance:
		//
		//   1. Drop our banner pane from the shared registry (which SURVIVES
		//      /reload). On reload the fresh instance re-registers via
		//      session_start — but if the user disabled/removed session-banner, or
		//      the new instance throws before registering, an un-dropped closure
		//      would linger and rich-editor would keep rendering a stale integrated
		//      banner (our render gates on captured label/showWidget, so a dead
		//      closure still paints). Also stop the pending host recheck timer.
		//   2. Clear the terminal/tab title we set via setTitle() — otherwise the
		//      "π — <emoji> <label>" title persists (after pi exits it looks like a
		//      live session; after a reload-to-disabled it's just stale). The fresh
		//      instance re-sets it on session_start when still enabled.
		//
		// pi >= 0.80 also fires session_shutdown on same-instance session
		// replacement (reason "new"/"resume"/"back"); there the SAME instance's
		// session_switch updates the pane/title, so we skip teardown to avoid a
		// needless flicker. The pinned SDK type has no `reason` (and there
		// session_shutdown fires only on exit), so a missing reason is a quit.
		// Optional-chain the cast so a malformed or missing event can't throw.
		const reason = (event as { reason?: string } | null | undefined)?.reason;
		if (reason === undefined || reason === "quit" || reason === "reload") {
			unregisterBannerPane();
			cancelBannerRecheck();
			if (ctx.hasUI) ctx.ui.setTitle("");
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (!rememberActiveCtx(ctx)) return;
		// Invalidate callbacks from the previous session immediately. The state
		// restore stays deferred because Pi loads the new session name async.
		cancelPendingSessionSwitchRestore();
		cancelTitleReasserts();
		cancelBannerRecheck();
		cancelPendingGeneration();
		resetHerdrRenameGuard();
		autoNamingActive = false;
		sessionSwitchRestoreTimer = setTimeout(() => {
			sessionSwitchRestoreTimer = null;
			resetHerdrRenameGuard();
			const currentSessionName = restoreState();
			resetAutoNaming(currentSessionName);
			renderBanner(ctx);
			renameHerdrTab(currentSessionName);
		}, 50);
	});

	const initBranchedSession = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		if (!rememberActiveCtx(ctx)) return;
		initSessionState(ctx);
	};

	pi.on("session_fork", initBranchedSession);
	// OMP emits `session_branch` for tree-branch operations; its fork flow uses
	// `session_switch`, which is handled above.
	// The pinned Pi SDK types do not include OMP's event name, but both runtimes
	// store handlers by string key and accept additional lifecycle events.
	const ompApi = pi as unknown as {
		on(event: "session_branch", handler: typeof initBranchedSession): void;
	};
	ompApi.on("session_branch", initBranchedSession);

	/**
	 * Try to auto-name the session. Shared by the early (before_agent_start)
	 * and late (agent_end) hooks. Fire-and-forget: never blocks the agent loop.
	 *
	 * `pendingUserMessage` is the prompt from before_agent_start — it isn't
	 * persisted into the branch yet at that point, so we splice it in.
	 *
	 * `forceTitle` swaps in the SKIP-less system prompt for the late call,
	 * where the assistant has already produced a response and there's no
	 * legitimate reason for the model to defer.
	 */
	function runPendingAutoNameRetry(): void {
		const retry = pendingAutoNameRetry;
		pendingAutoNameRetry = null;
		if (retry) tryAutoName(retry.ctx, retry.options);
	}

	/** @returns true when it already rendered synchronously (external-name adoption). */
	function tryAutoName(
		ctx: ExtensionContext,
		options?: AutoNameOptions,
	): boolean {
		if (adoptExternalSessionName(ctx)) return true;
		if (!autoNamingActive || turnCount > MAX_AUTO_TURNS) return false;
		if (inFlightGeneration) {
			if (options?.forceTitle) pendingAutoNameRetry = { ctx, options };
			return false;
		}

		const conversation = buildAutoNameContext(ctx.sessionManager.getBranch(), {
			pendingUserMessage: options?.pendingUserMessage,
		});
		if (!conversation.trim()) return false;

		const requestEpoch = ++generationEpoch;
		inFlightGeneration = true;
		generateName(ctx, conversation, { forceTitle: options?.forceTitle })
			.then((result) => {
				if (requestEpoch !== generationEpoch) return;
				inFlightGeneration = false;
				// null = SKIP, provider failure, or unparsable response — leave
				// existing name alone and run a queued late backstop if one arrived.
				if (!result) {
					runPendingAutoNameRetry();
					return;
				}
				pendingAutoNameRetry = null;
				// One more guard: don't clobber a manual rename that landed mid-flight.
				if (adoptExternalSessionName(ctx)) return;
				applyName(result.label, false, result.emoji);
				// Lock in the first confident name. Further auto-naming (the
				// same-turn late backstop and every later turn) would just churn the
				// title away from the session's original intent, so we stop here and
				// let /title be the only thing that renames from now on.
				autoNamingActive = false;
				renderBanner(ctx);
			});
		return false;
	}

	// Early naming: fire Haiku in parallel with the agent loop the moment the
	// user submits, so a clear opening prompt produces a title in ~1–2s
	// instead of waiting for a long-running turn to finish. Allows SKIP so
	// genuinely content-free prompts ("hi", "?") defer to the next attempt.
	pi.on("before_agent_start", (event, ctx) => {
		if (!rememberActiveCtx(ctx)) return;
		turnCount++;
		const rendered = tryAutoName(ctx, { pendingUserMessage: event.prompt });
		// Keep the title asserted over core's paints (skip if already rendered).
		if (!rendered) paintBanner(ctx);
	});

	// Late naming: backstop for the early call, and a no-op once a name has
	// landed (auto-naming is locked after the first confident name). It only
	// does real work when the early call SKIPped or failed and the session is
	// still unnamed; with the assistant's response now available it forces a
	// title (SKIP is suppressed here — by this point there's enough context).
	pi.on("agent_end", (_event, ctx) => {
		if (!rememberActiveCtx(ctx)) return;
		const rendered = tryAutoName(ctx, { forceTitle: true });
		// See before_agent_start.
		if (!rendered) paintBanner(ctx);
	});

	// ─── Commands ─────────────────────────────────────────────────────

	pi.registerCommand("title", {
		description: "Name this session. With args: set directly. Without: regenerate via LLM.",
		handler: async (args, ctx) => {
			rememberActiveCtx(ctx);
			const input = (args || "").trim();

			if (input) {
				cancelPendingGeneration();
				applyName(input, true);
				autoNamingActive = false;
				turnCount = 0;
				renderBanner(ctx);
				ctx.ui.notify(`Session named: ${emoji} ${label}`, "info");
				return;
			}

			const conversation = buildAutoNameContext(ctx.sessionManager.getBranch());
			if (!conversation.trim()) {
				ctx.ui.notify("No conversation to name yet", "warning");
				return;
			}

			// /title is user-initiated — force a title even if the conversation
			// would normally read as too vague to auto-name. Cancel any background
			// request so the command result cannot be overwritten by a stale callback.
			const wasAutoNamingActive = autoNamingActive;
			cancelPendingGeneration();
			autoNamingActive = false;
			let result: { emoji: string; label: string } | null = null;
			try {
				result = await generateName(ctx, conversation, { forceTitle: true });
			} finally {
				autoNamingActive = wasAutoNamingActive;
			}
			if (!result) {
				ctx.ui.notify(`Failed to generate name (provider=${provider()}, model=${modelId()})`, "warning");
				return;
			}

			applyName(result.label, false, result.emoji);
			turnCount = 0;
			renderBanner(ctx);
			ctx.ui.notify(`Session named: ${emoji} ${label}`, "info");
		},
	});
}
