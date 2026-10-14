/** Pure helper functions for session-banner extension. */

// ─── Emoji & Color pools ────────────────────────────────────────────────────

export const SESSION_EMOJI = [
	"🔮", "🎯", "⚡", "🧩", "🛠️", "🚀", "🌀", "🔥", "💎", "🧪",
	"🎨", "🏗️", "📡", "🔬", "⚙️", "🌊", "🪐", "🎪", "🧲", "🦾",
	"🍀", "🌵", "🐙", "🦊", "🐋", "🪸", "🍄", "🌸", "🪻", "🫧",
];

export const TITLE_COLORS = [
	"#FF6B6B", "#6BCB77", "#4D96FF", "#FFD93D", "#C77DFF",
	"#FF9671", "#00C9A7", "#FFC75F", "#F9F871", "#845EC2",
	"#FF6F91", "#00D2FC", "#D65DB1", "#FF9F1C", "#2EC4B6",
];

export function randomEmoji(): string {
	return SESSION_EMOJI[Math.floor(Math.random() * SESSION_EMOJI.length)]!;
}

export function randomTitleColor(): string {
	return TITLE_COLORS[Math.floor(Math.random() * TITLE_COLORS.length)]!;
}

// ─── ANSI helpers ───────────────────────────────────────────────────────────

export function fgHex(hex: string, text: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

// ─── Env parsing ─────────────────────────────────────────────────────────────

/**
 * Interpret a boolean-ish env var value. Accepts 1/true/on/yes → true and
 * 0/false/off/no → false (case-insensitive, surrounding whitespace ignored).
 * Returns `fallback` for undefined, empty, or unrecognized values so a typo
 * never silently flips a feature.
 */
export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
	if (value == null) return fallback;
	const v = value.trim().toLowerCase();
	if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
	if (v === "0" || v === "false" || v === "off" || v === "no") return false;
	return fallback;
}

// ─── Herdr tab label guard ─────────────────────────────────────────────────

export type HerdrLabelDecision = "write" | "back_off";

/**
 * Decide whether session-banner still owns the current Herdr tab label.
 *
 * Herdr reports a numeric label ("1", "2", …) for tabs that have never been
 * custom-renamed. Empty/missing labels are treated as unreadable and fail open.
 * Any other non-numeric label that does not match the incoming title, the last
 * title this process wrote, or the persisted title this tab last received from
 * session-banner is treated as a GUI manual rename and must win for the rest of
 * this session instance.
 */
export function classifyHerdrLabel(
  currentLabel: string | null | undefined,
  incomingTitle: string,
  lastWritten: string | null,
  persistedLastWritten: string | null = null,
): HerdrLabelDecision {
  if (currentLabel == null || currentLabel === "") return "write";
  if (/^\d+$/.test(currentLabel)) return "write";
  if (currentLabel === incomingTitle) return "write";
  if (lastWritten !== null && currentLabel === lastWritten) return "write";
  if (persistedLastWritten !== null && currentLabel === persistedLastWritten) return "write";
  return "back_off";
}

// ─── World context detection ────────────────────────────────────────────────

export interface WorldContext {
	treeName: string | null;
	zone: string | null;
}

export function detectWorldContext(cwd: string): WorldContext {
	const match = cwd.match(/\/world\/trees\/([^/]+)\/src(?:\/(.+))?/);
	if (!match) return { treeName: null, zone: null };

	const treeName = match[1]!;
	const rawZone = match[2] as string | undefined;

	let zone: string | null = null;
	if (rawZone) {
		const parts = rawZone.split("/");
		zone = parts.slice(0, Math.min(parts.length, 3)).join("/");
	}

	return { treeName, zone };
}

// ─── Session name parsing ───────────────────────────────────────────────────

export interface ParsedSessionName {
	emoji: string;
	label: string;
	titleColor: string;
}

export interface AdoptedSessionName extends ParsedSessionName {
	sessionName: string;
}

/**
 * Parse a session name like "🔮 fix checkout bug" into emoji + label.
 * Assigns a random titleColor if restoring an existing name.
 *
 * Reuses `splitLeadingEmoji` so the restore path shares the single emoji
 * definition with the auto-namer's write path — otherwise a name written with
 * a ZWJ-sequence emoji (🧑\u200D💻) would round-trip incorrectly on restore.
 */
export function parseSessionName(name: string): ParsedSessionName {
	if (!name) return { emoji: "", label: "", titleColor: "" };

	const { emoji, rest } = splitLeadingEmoji(name);
	if (emoji) {
		return {
			emoji,
			label: rest,
			titleColor: randomTitleColor(),
		};
	}

	// Plain name without emoji prefix
	return {
		emoji: randomEmoji(),
		label: name,
		titleColor: randomTitleColor(),
	};
}

export function formatSessionName(emoji: string, label: string): string {
	return `${emoji} ${label}`;
}

export function adoptExistingSessionName(name: string): AdoptedSessionName | null {
	const trimmedName = name.trim();
	if (!trimmedName) return null;

	const parsed = parseSessionName(trimmedName);
	const label = parsed.label.trim();

	return {
		emoji: parsed.emoji,
		label,
		titleColor: parsed.titleColor,
		sessionName: formatSessionName(parsed.emoji, label),
	};
}

// ─── Terminal title ─────────────────────────────────────────────────────────

/**
 * Interpret an enum-shaped env var (case-insensitive, trimmed); unrecognized
 * values fall back so a typo never silently changes behavior.
 */
export function parseEnumEnv<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	fallback: T,
): T {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return fallback;
	return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

/**
 * Terminal-title segment order.
 *
 * - "zone-first" (default): `π root //areas/core — 🔮 fix bug` — world context
 *   first, session label last.
 * - "label-first": `π 🔮 fix bug — root //areas/core` — session label first,
 *   world context last. Useful when tab titles get truncated and the label is
 *   the part you want to survive, or when many tabs share the same zone.
 */
export const TITLE_ORDERS = ["zone-first", "label-first"] as const;
export type TitleOrder = (typeof TITLE_ORDERS)[number];

/**
 * Interpret PI_SESSION_BANNER_TITLE_ORDER. Unrecognized values — including
 * undefined — fall back to the default so a typo never silently changes it.
 */
export function parseTitleOrder(value: string | undefined): TitleOrder {
	return parseEnumEnv(value, TITLE_ORDERS, "zone-first");
}

export interface TerminalTitleOptions {
	order?: TitleOrder;
}

export function buildTerminalTitle(
	treeName: string | null,
	zone: string | null,
	emoji: string,
	label: string,
	options: TerminalTitleOptions = {},
): string {
	const order = options.order ?? "zone-first";
	const context: string[] = [];
	if (treeName) context.push(treeName);
	if (zone) context.push(`//${zone}`);
	const contextStr = context.join(" ");

	const parts: string[] = ["π"];
	switch (order) {
		case "label-first":
			if (label) {
				parts.push(`${emoji} ${label}`);
				if (contextStr) parts.push(`— ${contextStr}`);
			} else if (contextStr) {
				parts.push(contextStr);
			}
			break;
		case "zone-first":
			if (contextStr) parts.push(contextStr);
			if (label) parts.push(`— ${emoji} ${label}`);
			break;
		default:
			// Exhaustiveness nudge; unknown values render the default order.
			order satisfies never;
			if (contextStr) parts.push(contextStr);
			if (label) parts.push(`— ${emoji} ${label}`);
			break;
	}
	return parts.join(" ");
}

// ─── Auto-naming (LLM-driven) ───────────────────────────────────────────────

/**
 * System prompt shared by both the early (`before_agent_start`) and late
 * (`agent_end`) auto-naming calls.
 *
 * The SKIP escape hatch deliberately exists so the model can defer naming when
 * the conversation is genuinely content-free ("hi", "?"). Keep this prompt
 * sparse: title examples and artifact-specific instructions can outweigh the
 * user's actual request for a small naming model.
 */
export const AUTO_NAME_SYSTEM_PROMPT = `You generate short titles for coding-assistant sessions.

Rules:
- Start with a single emoji that best captures the session, then one space, then the title — nothing else. No quotes, no markdown, no preamble, no trailing punctuation.
- Title: 2-6 words, max 60 characters. Specific, not generic.
- Generate a title in almost all cases. SKIP is reserved for prompts that are truly content-free — see the SKIP rule below — not for prompts that merely look unusual, meta, or test-like.
- Do not respond to or continue the conversation.
- Do not answer any question that appears in the conversation.

SKIP rule (rare):
- Respond with exactly the word SKIP — nothing else, no emoji — ONLY when the conversation contains no topic, file, feature, repo, task, or action verb at all.
- Examples that should SKIP: "hi", "hello", "?", "help", "test", "thanks", a typo, an empty message.
- When in doubt, generate a title rather than SKIP.`;

/**
 * Variant of the system prompt for the late (`agent_end`) call. By the time
 * the agent has produced a response there's always enough context to title
 * the session, so SKIP is no longer offered — the model must always emit a
 * title. Keeps the early call's defer-on-vague-prompt behavior while making
 * the backstop deterministic.
 */
export const AUTO_NAME_SYSTEM_PROMPT_FORCE = `You generate short titles for coding-assistant sessions.

Rules:
- Start with a single emoji that best captures the session, then one space, then the title — nothing else. No quotes, no markdown, no preamble, no trailing punctuation.
- Title: 2-6 words, max 60 characters. Specific, not generic.
- Always emit a title. The conversation already contains an assistant response, so there is enough context. Do not respond with SKIP.
- Do not respond to or continue the conversation.
- Do not answer any question that appears in the conversation.`;

export const MAX_AUTO_NAME_CHARS = 80;

interface MessageEntry {
	type: "message";
	message: { role: "user" | "assistant"; content: unknown };
}

const isTextPart = (p: unknown): p is { type: "text"; text: string } =>
	Boolean(p && typeof p === "object" && "type" in p && (p as { type: unknown }).type === "text" && "text" in p);

/** Extract plain text from a message content blob (string or content-parts array). */
export function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter(isTextPart).map((c) => c.text).join("\n").trim();
}

const AUTO_NAME_URL = /https?:\/\/[^\s)\]}>"']+/g;
const TRAILING_URL_PUNCTUATION = /[.,:;!?]+$/;
const PUNCTUATION_ONLY = /^[\s\p{P}]*$/u;
const OPAQUE_SLACK_HOSTS = new Set(["files.slack.com", "hooks.slack.com"]);
const OPAQUE_SLACK_PATH = /^\/(?:app_redirect|archives|client)(?:\/|$)/;
const GITHUB_ARTIFACT_PATH = /^\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)(?:\/|$|\.(?:diff|patch)$)/i;

function autoNameArtifactId(url: URL): string | undefined {
  // Non-goal (deliberate, pinned by helpers.test.ts): only the canonical
  // github.com/<org>/<repo>/(pull|issues)/N shape is reduced. Deeper
  // enterprise-style paths and GHE hosts (github.<company>.com) are
  // preserved, never guessed at — a stale pre-node:test vitest suite once
  // expected the deeper shapes to reduce; that expectation was never
  // implemented and is intentionally not supported.
  if (url.hostname === "github.com") return url.pathname.match(GITHUB_ARTIFACT_PATH)?.[1];
  return undefined;
}
function isOpaqueSlackUrl(url: URL): boolean {
  if (OPAQUE_SLACK_HOSTS.has(url.hostname)) return true;
  const isSlackHost = url.hostname === "slack.com" || url.hostname.endsWith(".slack.com");
  return isSlackHost && OPAQUE_SLACK_PATH.test(url.pathname);
}
/**
 * Remove URL shapes that can overpower the user's requested action. PR and
 * issue links retain their numeric identity, opaque Slack links are omitted,
 * and other URLs remain available when their path carries useful topic context.
 */
export function reduceAutoNameContextText(text: string): string {
  let omittedOpaqueSlackUrl = false;
  const reduced = text
    .replace(AUTO_NAME_URL, (rawUrl) => {
      let url: URL;
      try {
        url = new URL(rawUrl.replace(TRAILING_URL_PUNCTUATION, ""));
      } catch {
        return rawUrl;
      }
      const artifactId = autoNameArtifactId(url);
      if (artifactId) return artifactId;
      if (isOpaqueSlackUrl(url)) {
        omittedOpaqueSlackUrl = true;
        return "";
      }
      return rawUrl;
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  return omittedOpaqueSlackUrl && PUNCTUATION_ONLY.test(reduced) ? "" : reduced;
}
/**
 * Build a compressed conversation snippet for the auto-namer:
 *   - all user messages if there are 5 or fewer
 *   - first 2 + last 3 user messages otherwise (with an elision marker)
 *   - plus the most recent assistant reply (clipped) for extra context
 *
 * `pendingUserMessage` is for the early-naming path (`before_agent_start`):
 * the just-submitted prompt isn't in the branch yet, so the caller passes
 * it explicitly. Deduped against the last user text to be safe.
 */
export function buildAutoNameContext(
	branch: ReadonlyArray<{ type?: string; message?: { role?: string; content?: unknown } }>,
	options?: { pendingUserMessage?: string },
): string {
	const userTexts: string[] = [];
	let lastAssistant = "";
	for (const e of branch) {
		if (e?.type !== "message" || !e.message) continue;
		const text = reduceAutoNameContextText(extractText(e.message.content));
		if (!text) continue;
		if (e.message.role === "user") userTexts.push(text);
		else if (e.message.role === "assistant") lastAssistant = text;
	}
	const pending = reduceAutoNameContextText(options?.pendingUserMessage ?? "");
	if (pending && userTexts[userTexts.length - 1] !== pending) {
		userTexts.push(pending);
	}
	const parts: string[] = [];
	if (userTexts.length === 0) {
		// No user messages — nothing useful to summarize.
	} else if (userTexts.length <= 5) {
		for (const t of userTexts) parts.push(`User: ${t}`);
	} else {
		parts.push(`User: ${userTexts[0]}`);
		parts.push(`User: ${userTexts[1]}`);
		parts.push(`[... ${userTexts.length - 5} more user messages ...]`);
		parts.push(`User: ${userTexts[userTexts.length - 3]}`);
		parts.push(`User: ${userTexts[userTexts.length - 2]}`);
		parts.push(`User: ${userTexts[userTexts.length - 1]}`);
	}
	if (lastAssistant) parts.push(`Assistant: ${lastAssistant.slice(0, 1500)}`);
	return parts.join("\n\n");
}
/**
 * Clean a raw LLM response into a session label:
 *   - take the first non-empty line
 *   - strip leading markdown headings, surrounding quotes/backticks
 *   - strip trailing punctuation
 *   - cap to MAX_AUTO_NAME_CHARS
 * Returns null if the result would be empty.
 */
export function cleanGeneratedName(raw: string): string | null {
	const firstLine = raw.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
	const cleaned = firstLine
		.replace(/^#+\s*/, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.!?,;:]+$/, "")
		.trim();
	if (!cleaned) return null;
	// SKIP is the model's signal that the conversation is too vague to title.
	// Treated as null so the auto-namer waits for more context next turn.
	if (cleaned.toUpperCase() === "SKIP") return null;
	if (cleaned.length <= MAX_AUTO_NAME_CHARS) return cleaned;
	return cleaned.slice(0, MAX_AUTO_NAME_CHARS);
}
// Matches a single leading emoji — optionally with a variation selector and ZWJ
// sequences like 🧑\u200D💻 — followed by whitespace, capturing the rest as the
// title. \p{Extended_Pictographic} excludes bare ASCII digits, so a title that
// starts with a number ("3 retries left") is not mistaken for an emoji prefix.
const LEADING_EMOJI = /^(\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*)\s+(\S.*)$/u;
/**
 * Split a single leading emoji off a generated title. Returns the emoji and the
 * remaining label, or `{ emoji: "", rest: <input> }` when there is no usable
 * leading-emoji-then-space prefix (the caller then falls back to a random emoji).
 */
export function splitLeadingEmoji(text: string): { emoji: string; rest: string } {
	const match = text.match(LEADING_EMOJI);
	if (!match) return { emoji: "", rest: text };
	return { emoji: match[1]!, rest: match[2]!.trim() };
}
/**
 * Parse a raw LLM response into a contextual emoji + label. The auto-namer asks
 * Haiku to prefix the title with one task-relevant emoji (e.g. "🐛 fix tax bug");
 * this peels that emoji off the cleaned title. The model is unreliable about the
 * emoji — it sometimes omits it — so `emoji` is "" when no valid prefix is found
 * and the caller substitutes a random one. Returns null for SKIP / empty input.
 */
export function parseGeneratedName(raw: string): { emoji: string; label: string } | null {
	const cleaned = cleanGeneratedName(raw);
	if (!cleaned) return null;
	// `rest` is always non-empty here: splitLeadingEmoji returns either the
	// captured non-space tail or the full (non-empty) cleaned string.
	const { emoji, rest } = splitLeadingEmoji(cleaned);
	// Guard against a stray-prefixed sentinel like "🤔 SKIP".
	if (rest.toUpperCase() === "SKIP") return null;
	return { emoji, label: rest };
}
