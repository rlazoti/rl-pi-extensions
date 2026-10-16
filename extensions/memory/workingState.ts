/**
 * Working state: the two hand-maintained prose files at the top of the bank.
 *
 * `core/activeProjects.md` (what is open right now) and `core/dailyContext.md`
 * (today's work) are neither entry stores nor authorities: they have no keys, no
 * scopes, no dates-of-claim, and the gate will not write them. Before this module the
 * extension read them only to *archive* them — the model was told a daily file existed
 * and might be stale, but never what was in it, and never what the current projects
 * were. The files were written and never read.
 *
 * So this is a **recall-only surface**, kept deliberately separate from the resolver:
 *
 *   • It never adjudicates. Nothing here is compared, ranked against another claim,
 *     or presented as the answer to a question — the header says so in the prompt, so
 *     the model cannot mistake a hand-written status line for an authority.
 *   • It is bounded by its own token caps, so a growing status file cannot crowd the
 *     authorities out of the prompt, and vice versa.
 *   • What does not fit is **dropped whole and counted**, never truncated mid-line:
 *     half a bullet is a different bullet. The block says how much was dropped and
 *     which tool shows the rest (`memory_read`), so a missing memory is visible.
 *   • Open work is recognised by the rollover's own classifier (`collectOpenWork`),
 *     not a second one — otherwise the prompt shows work the rollover would drop.
 *   • When the daily file is stale, the caveat travels *with* the work rather than
 *     replacing it: the dates are shown, the caution is stated, and the items are not
 *     laundered into current fact.
 *
 * Pure: no filesystem, no clock. The caller passes the file text and today's date.
 */

import { estimateTokens } from "./inject.js";
import { isItem, parseDailyItems } from "./dailyItems.js";
import { collectOpenWork, dailyFreshness, describeAge, type DailyFile, type DailyDate } from "./rollover.js";

/** Tokens of file content each file may spend per turn. Module parameters, not
 *  settings (same stance as the ageing knobs): retuning them is a deliberate edit. */
export interface StateBudget {
	activeProjects: number;
	daily: number;
}

export const DEFAULT_STATE_BUDGET: StateBudget = { activeProjects: 600, daily: 500 };

export const ACTIVE_PROJECTS_FILE = "core/activeProjects.md";
export const DAILY_FILE = "core/dailyContext.md";

export interface WorkingStateInput {
	/** Text of `core/activeProjects.md`, or null when the file is absent/empty. */
	activeProjects: string | null;
	/** Text + mtime of `core/dailyContext.md`, or null when absent/empty. */
	daily: DailyFile | null;
	/** YYYY-MM-DD, supplied by the caller: this module never reads a clock. */
	today: string;
	budget?: Partial<StateBudget>;
}

export interface WorkingStateReport {
	/** The prompt block. Empty string when there is nothing to say. */
	text: string;
	activeProjects: {
		exists: boolean;
		lines: number;
		shownLines: number;
		droppedLines: number;
		tokens: number;
	};
	daily: {
		exists: boolean;
		date: DailyDate | null;
		ageDays: number | null;
		stale: boolean;
		needsDate: boolean;
		items: number;
		shownItems: number;
		droppedItems: number;
		unrecognised: number;
		tokens: number;
	};
	tokens: number;
}

/**
 * Render the working-state block.
 *
 * Order is fixed (activeProjects, then open work) and independent of anything
 * scored, so the block is byte-identical for a given pair of files and date.
 */
export function renderWorkingState(input: WorkingStateInput): WorkingStateReport {
	const budget: StateBudget = {
		activeProjects: input.budget?.activeProjects ?? DEFAULT_STATE_BUDGET.activeProjects,
		daily: input.budget?.daily ?? DEFAULT_STATE_BUDGET.daily,
	};

	const projects = renderActiveProjects(input.activeProjects, budget.activeProjects);
	const daily = renderDaily(input.daily, input.today, budget.daily);

	const sections = [projects.text, daily.text].filter((part) => part !== "");
	const text = sections.length === 0 ? "" : `${HEADER}\n\n${sections.join("\n\n")}\n`;

	return {
		text,
		activeProjects: projects.stats,
		daily: daily.stats,
		tokens: text === "" ? 0 : estimateTokens(text),
	};
}

const HEADER = "## Working state — hand-maintained files, not entry stores and not authorities";

// ─── core/activeProjects.md ────────────────────────────────────────────────

function renderActiveProjects(text: string | null, cap: number): { text: string; stats: WorkingStateReport["activeProjects"] } {
	const stats: WorkingStateReport["activeProjects"] = {
		exists: text !== null && text.trim() !== "",
		lines: 0,
		shownLines: 0,
		droppedLines: 0,
		tokens: 0,
	};
	if (text === null || text.trim() === "") return { text: "", stats };

	const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
	stats.lines = lines.length;

	const kept: string[] = [];
	let used = estimateTokens(`### ${ACTIVE_PROJECTS_FILE}\n`);
	for (const line of lines) {
		const cost = estimateTokens(`${line}\n`);
		// Document order, and stop at the first line that does not fit: skipping
		// ahead would interleave a heading with a body that came from elsewhere.
		if (used + cost > cap) break;
		used += cost;
		kept.push(line);
	}
	stats.shownLines = kept.length;
	stats.droppedLines = lines.length - kept.length;
	stats.tokens = used;

	const footer =
		stats.droppedLines > 0
			? `\n_activeProjects.md is prose, not an entry store: ${kept.length} of ${lines.length} lines fit this turn — the rest with memory_read ${ACTIVE_PROJECTS_FILE}._`
			: `\n_activeProjects.md is prose maintained by hand and by file tools, not an entry store._`;
	return { text: `### ${ACTIVE_PROJECTS_FILE}\n${kept.join("\n")}${footer}`, stats };
}

// ─── core/dailyContext.md: open work only ──────────────────────────────────

/** One renderable thing: a whole item (possibly multi-line) or one prose line. */
interface DailyUnit {
	group: string;
	/** The item's own date, or null when the line carries none. */
	date: string | null;
	/** Document position, so selection can be re-sorted without re-sorting output. */
	order: number;
	text: string;
}

function renderDaily(file: DailyFile | null, today: string, cap: number): { text: string; stats: WorkingStateReport["daily"] } {
	const stats: WorkingStateReport["daily"] = {
		exists: file !== null && file.text.trim() !== "",
		date: null,
		ageDays: null,
		stale: false,
		needsDate: false,
		items: 0,
		shownItems: 0,
		droppedItems: 0,
		unrecognised: 0,
		tokens: 0,
	};
	if (file === null || file.text.trim() === "") return { text: "", stats };

	const freshness = dailyFreshness(file, today);
	stats.date = freshness.date;
	stats.ageDays = freshness.ageDays;
	stats.stale = freshness.stale;
	stats.needsDate = freshness.needsDate;

	const groups = collectOpenWork(file.text);
	const units: DailyUnit[] = [];
	let order = 0;
	for (const group of groups) {
		for (const entry of parseDailyItems(group.text)) {
			if (isItem(entry)) {
				units.push({ group: group.title, date: entry.date, order: order++, text: entry.raw });
			} else if (entry.prose.trim() !== "") {
				// Prose under an open heading is open work — "run the gate:" plus a
				// command block is work even though it is not a bullet.
				units.push({ group: group.title, date: null, order: order++, text: entry.prose });
			}
		}
	}
	stats.items = units.length;

	// Selection order for the cap: undated first (unknown age is not a reason to drop
	// work first, the same rule the rollover ages by), then newest dated first. Output
	// goes back to document order, because that is how the file reads.
	const preferred = [...units].sort(
		(a, b) =>
			(a.date === null ? 0 : 1) - (b.date === null ? 0 : 1) ||
			(b.date ?? "").localeCompare(a.date ?? "") ||
			a.order - b.order,
	);

	const header = `### ${DAILY_FILE} — open work (${describeDate(freshness.date)})`;
	let used = estimateTokens(`${header}\n`);
	const kept = new Set<number>();
	const chargedGroups = new Set<string>();
	for (const unit of preferred) {
		// The group label is charged once, to the first unit kept from that group.
		const labelCost = unit.group !== "" && !chargedGroups.has(unit.group) ? estimateTokens(`**${unit.group}**\n`) : 0;
		const cost = estimateTokens(`${unit.text}\n`) + labelCost;
		if (used + cost > cap) continue;
		used += cost;
		kept.add(unit.order);
		if (unit.group !== "") chargedGroups.add(unit.group);
	}

	const lines: string[] = [];
	const labelled = new Set<string>();
	for (const unit of units) {
		if (!kept.has(unit.order)) continue;
		if (unit.group !== "" && !labelled.has(unit.group)) {
			labelled.add(unit.group);
			lines.push(`**${unit.group}**`);
		}
		lines.push(unit.text);
	}
	stats.shownItems = kept.size;
	stats.droppedItems = units.length - kept.size;

	const notes: string[] = [];
	if (freshness.stale) {
		const why = freshness.date?.source === "mtime" ? ", dated by file mtime because the file has no date field" : "";
		notes.push(`${DAILY_FILE} is dated ${when(freshness.date)} (${describeAge(freshness.ageDays)}${why}). Unfinished items in it may no longer be true; say so rather than repeating them.`);
	}
	if (stats.needsDate && !freshness.stale) {
		notes.push(`${DAILY_FILE} has no \`- date:\` field: its day was inferred from its modification time.`);
	}
	if (stats.droppedItems > 0) {
		notes.push(`${stats.droppedItems} further open item(s) did not fit this turn — the rest with memory_read ${DAILY_FILE}.`);
	}
	stats.tokens = used;

	const body =
		lines.length === 0
			? units.length === 0
				? "_No open work recognised under its headings._"
				: `_No open item fit this turn — the whole list with memory_read ${DAILY_FILE}._`
			: lines.join("\n");
	const footer = notes.length === 0 ? "" : `\n_${notes.join(" ")}_`;
	return { text: `${header}\n${body}${footer}`, stats };
}

function describeDate(date: DailyDate | null): string {
	if (date === null) return "date unknown — the file has no `- date:` field";
	return date.source === "mtime" ? `${date.date}, inferred from the file's modification time` : date.date;
}

function when(date: DailyDate | null): string {
	return date === null ? "unknown" : date.date;
}
