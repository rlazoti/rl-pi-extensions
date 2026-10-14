/**
 * Daily rollover (Phase 6): the day changes, yesterday's context is archived, and
 * open work is carried forward with its age visible.
 *
 * The behaviour this replaces failed in three ways, all of them silent:
 *
 *   1. The date was read from an optional heading, so a file with no date was
 *      treated as *current forever* — archiving never ran, and one daily file
 *      accumulated weeks of two projects under a heading naming only one.
 *   2. Carry-forward was an exact heading match (`Context for Tomorrow`), so every
 *      heading an agent invented — `Next Steps`, `In Progress`, `Handoff` — was
 *      dropped without being reported.
 *   3. It wrote a file shape (`## <date>` + `### Current Session`) that agents do
 *      not use, so scaffolding and content drifted apart immediately.
 *
 * The rules here: a missing date is a defect to report, not a reason to do nothing;
 * open work is carried by meaning (normalised aliases), and anything not carried is
 * listed with a reason; project grouping is preserved; carried items keep the date
 * they came from, because a four-day-old "in progress" should look four days old.
 *
 * Pure: the clock is an argument and no file is touched. `service.ts` applies the
 * plan.
 */

import { parseMarkdown, sectionText, type Section } from "./markdown.js";
import { pruneDailyBody, type DailyItem } from "./dailyItems.js";

export interface DailyFile {
	text: string;
	/** Best available date the file changed, used only when the file has none. */
	modified?: string;
}

export type DateSource = "header" | "mtime" | "missing";

export interface DailyDate {
	date: string;
	source: DateSource;
}

export interface Freshness {
	date: DailyDate | null;
	ageDays: number | null;
	/** True when the file is not from today, or cannot be dated. */
	stale: boolean;
	needsDate: boolean;
}

export interface CarriedSection {
	/** How many of this section's items had no date and were given the file's. */
	stamped?: number;
	/** Project/group heading this came from, when the file grouped by project. */
	group?: string;
	heading: string;
	text: string;
	from: string;
	ageDays: number | null;
}

export interface RolloverPlan {
	from: DailyDate;
	/** Open items too old to keep carrying, and items beyond the per-section cap. */
	retiredItems: Array<{ section: string; item: DailyItem }>;
	cappedItems: Array<{ section: string; item: DailyItem }>;
	today: string;
	archivePath: string;
	/** The old file, byte for byte: an archive is a record, not a draft. */
	archiveText: string;
	freshText: string;
	carried: CarriedSection[];
	notCarried: Array<{ heading: string; reason: string }>;
	/** Items that had no date and were given the file's date while carrying. */
	stamped: number;
}

export type RolloverDecision =
	| { action: "none"; freshness: Freshness; reason: string }
	| { action: "rollover"; plan: RolloverPlan };

const DATE_IN_TEXT = /\b(\d{4}-\d{2}-\d{2})\b/;
const CANONICAL_DATE_FIELD = /^\s{0,3}[-*]\s*date:\s*(\d{4}-\d{2}-\d{2})\s*$/im;

/**
 * Headings that mean "not finished yet". Normalised: lower case, punctuation
 * stripped. The list is deliberately a set of aliases rather than one required
 * heading — an agent that writes `Next Steps` and an agent that writes `Handoff`
 * mean the same thing, and the store must not depend on picking the right words.
 */
const OPEN_HEADINGS = new Set([
	"in progress",
	"open",
	"open work",
	"open items",
	"next steps",
	"next",
	"handoff",
	"hand off",
	"carried forward",
	"carry forward",
	"carried",
	"blocked",
	"pending",
	"waiting on",
	"todo",
	"to do",
	"not done",
	"unstarted",
	"still open",
	"up next",
]);

/** Headings that mean "settled": archived, and durable ones belong in the store. */
const SETTLED_HEADINGS = new Set([
	"completed",
	"complete",
	"done",
	"finished",
	"shipped",
	"key decisions",
	"decisions",
	"outcomes",
	"resolved",
	"closed",
	"results",
	"learned",
]);

function normalise(heading: string): string {
	return heading.toLowerCase().replace(/[*`_]/g, "").replace(/\s+/g, " ").replace(/[:–—-]+$/, "").trim();
}

export function isOpenHeading(heading: string): boolean {
	return OPEN_HEADINGS.has(normalise(heading));
}

export function isSettledHeading(heading: string): boolean {
	return SETTLED_HEADINGS.has(normalise(heading));
}

/** Read the date a daily file is about. A `- date:` field wins; a bare date in the text is only evidence. */
export function dailyDate(file: DailyFile): DailyDate | null {
	const field = CANONICAL_DATE_FIELD.exec(file.text);
	if (field) return { date: field[1]!, source: "header" };
	const heading = /^ {0,3}#{1,6}\s+.*?(\d{4}-\d{2}-\d{2})/m.exec(file.text);
	if (heading) return { date: heading[1]!, source: "header" };
	const inline = DATE_IN_TEXT.exec(file.text.split(/\r?\n/, 4).join("\n"));
	if (inline) return { date: inline[1]!, source: "header" };
	if (file.modified && DATE_IN_TEXT.test(file.modified)) return { date: file.modified.slice(0, 10), source: "mtime" };
	return null;
}

function daysBetween(from: string, to: string): number | null {
	const start = Date.parse(`${from}T00:00:00Z`);
	const end = Date.parse(`${to}T00:00:00Z`);
	if (Number.isNaN(start) || Number.isNaN(end)) return null;
	return Math.round((end - start) / 86_400_000);
}

export function dailyFreshness(file: DailyFile, today: string): Freshness {
	const date = dailyDate(file);
	const ageDays = date === null ? null : daysBetween(date.date, today);
	const needsDate = date === null || date.source === "mtime";
	return { date, ageDays, stale: date === null || date.date !== today, needsDate };
}

interface Classified {
	node: Section;
	kind: "open" | "settled" | "group" | "unknown";
}

function classify(node: Section): Classified {
	if (node.children.length > 0 && !isOpenHeading(node.title) && !isSettledHeading(node.title)) return { node, kind: "group" };
	if (isOpenHeading(node.title)) return { node, kind: "open" };
	if (isSettledHeading(node.title)) return { node, kind: "settled" };
	return { node, kind: "unknown" };
}

/** Collect open-work leaves under a node, with the group they belong to. */
function collectOpen(node: Section, group?: string): Array<{ group?: string; heading: string; text: string }> {
	const found: Array<{ group?: string; heading: string; text: string }> = [];
	const classified = classify(node);
	if (classified.kind === "open") {
		const body = sectionText(node);
		if (body !== "") found.push({ group, heading: node.title, text: body });
		return found;
	}
	const nextGroup = classified.kind === "group" ? node.title : group;
	for (const child of node.children) found.push(...collectOpen(child, nextGroup));
	return found;
}

function renderCarried(entry: { group?: string; heading: string; text: string }, from: string, ageDays: number | null): string {
	const age = ageDays !== null && ageDays >= 2 ? `, ${ageDays} days old` : "";
	const lines = [entry.group ? `### ${entry.heading} — ${entry.group} (from ${from}${age})` : `### ${entry.heading} (from ${from}${age})`, "", entry.text];
	return lines.join("\n");
}

/**
 * Decide what to do with the daily file at session start. A file dated today is
 * left alone; an undated file whose modification time is today is left alone too —
 * it is almost certainly today's file with a missing date field — but it is
 * reported, because that missing field is what made archiving never run for weeks.
 */
export function planDailyRollover(file: DailyFile, today: string, options: { force?: boolean; retireAfterDays?: number; maxItems?: number } = {}): RolloverPlan | null {
	const freshness = dailyFreshness(file, today);
	// Dated today: nothing to do. Undated: roll it over anyway — "unknown date" must
	// not mean "current forever", which is exactly how one file sat undated for
	// weeks. The fresh file gets a real date field, so this normalises in one pass.
	if (options.force !== true && freshness.date !== null && freshness.date.date === today) return null;

	const from: DailyDate = freshness.date ?? { date: today, source: "missing" };
	// `force` is for the case the date check cannot see: a file last touched today
	// whose content plainly belongs to earlier days. A human decides that; the code
	// never infers it.
	if (options.force === true && freshness.date === null) return null;
	const parsed = parseMarkdown(file.text);
	const carried: CarriedSection[] = [];
	const notCarried: Array<{ heading: string; reason: string }> = [];

	const retiredItems: RolloverPlan["retiredItems"] = [];
	const cappedItems: RolloverPlan["cappedItems"] = [];

	const walk = (node: Section, group?: string) => {
		const classified = classify(node);
		if (classified.kind === "open") {
			const body = sectionText(node);
			if (body !== "") {
				// Carried item by item: stamped with the day the file was about (never
				// today — that would launder old intentions into fresh work), then aged
				// and capped per section. Everything dropped is returned, not hidden.
				const pruned = pruneDailyBody(body, today, { retireAfterDays: options.retireAfterDays, maxItems: options.maxItems, stampWith: from.source === "missing" ? today : from.date });
				for (const item of pruned.retired) retiredItems.push({ section: node.title, item });
				for (const item of pruned.capped) cappedItems.push({ section: node.title, item });
				if (pruned.text !== "") carried.push({ group, heading: node.title, text: pruned.text, from: from.source === "missing" ? "undated" : from.date, ageDays: daysBetween(from.date, today), stamped: pruned.stamped });
			}
			return;
		}
		if (classified.kind === "settled") {
			notCarried.push({ heading: node.title, reason: "settled work — archived; anything durable belongs in the entry store (memory_write)" });
			return;
		}
		if (classified.kind === "unknown" && node.children.length === 0) {
			notCarried.push({ heading: node.title, reason: "unrecognised heading — not carried; if it is open work, name it Next Steps / In Progress / Handoff / Blocked, or move it into one of those" });
			return;
		}
		const nextGroup = classified.kind === "group" ? node.title : group;
		for (const child of node.children) walk(child, nextGroup);
		if (classified.kind === "group" && node.children.length > 0 && collectOpen(node).length === 0) {
			notCarried.push({ heading: node.title, reason: "no open work under it — archived as a group" });
		}
	};

	for (const node of parsed.nodes) walk(node);
	if (parsed.preamble.join("\n").trim() !== "" && parsed.nodes.length === 0) {
		notCarried.push({ heading: "(document preamble)", reason: "prose before the first heading — nothing under it could be classified" });
	}

	const carriedFrom = from.source === "missing" ? "an undated file (no date field, no modification time)" : from.source === "mtime" ? `${from.date} (recovered from the file's modification time: the file had no date field)` : from.date;
	const fresh: string[] = [`# Daily Context — ${today}`, "", `- date: ${today}`, `- carried from: ${carriedFrom}`, ""];
	const grouped = carried.some((entry) => entry.group !== undefined);
	if (carried.length === 0) {
		fresh.push("## Open work", "", "_Nothing was carried forward. The previous day's file is archived, and the sections that were not carried are listed with their reasons in the rollover report._", "");
	} else if (!grouped) {
		fresh.push("## Open work", "", ...carried.map((entry) => renderCarried({ heading: entry.heading, text: entry.text }, entry.from, entry.ageDays)), "");
	} else {
		const byGroup = new Map<string, CarriedSection[]>();
		for (const entry of carried) {
			const key = entry.group ?? "General";
			byGroup.set(key, [...(byGroup.get(key) ?? []), entry]);
		}
		for (const [group, entries] of byGroup) {
			fresh.push(`## ${group}`, "", ...entries.map((entry) => renderCarried({ heading: entry.heading, text: entry.text }, entry.from, entry.ageDays)), "");
		}
	}
	fresh.push("## Settled today", "", "## Notes", "");

	// The month directory comes from the date, never from the stamp: slicing
	// "undated-2026-10-14" gives a directory called "undated".
	const stamp = from.source === "missing" ? `undated-${today}` : from.date;
	const month = (from.source === "missing" ? today : from.date).slice(0, 7);
	return {
		from,
		today,
		archivePath: `history/daily/${month}/${stamp}-dailyContext.md`,
		archiveText: file.text,
		freshText: `${fresh.join("\n").trimEnd()}\n`,
		carried,
		notCarried,
		retiredItems,
		cappedItems,
		stamped: carried.reduce((total, entry) => total + (entry.stamped ?? 0), 0),
	};
}

/** A one-paragraph summary of a rollover, for the session that performed it. */
export function renderRolloverNotice(plan: RolloverPlan): string {
	const carried = plan.carried.length === 0 ? "nothing" : `${plan.carried.length} open-work section(s)`;
	const dropped = plan.notCarried.length === 0 ? "" : `; ${plan.notCarried.length} not carried (${plan.notCarried.map((item) => item.heading).join(", ")})`;
	const where = plan.from.source === "missing" ? "an undated file" : `${plan.from.date}${plan.from.source === "mtime" ? " (dated by file mtime)" : ""}`;
	const items = plan.retiredItems.length + plan.cappedItems.length === 0 ? "" : `; ${plan.retiredItems.length} item(s) aged out and ${plan.cappedItems.length} beyond the carry cap — all still in the archive`;
	const stamped = plan.stamped === 0 ? "" : `; dated ${plan.stamped} item(s) that had none`;
	return `Rolled over daily context from ${where}: archived to ${plan.archivePath}, carried ${carried}${dropped}${items}${stamped}.`;
}
