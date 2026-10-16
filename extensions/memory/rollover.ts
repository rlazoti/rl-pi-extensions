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
import { isItem, parseDailyItems, pruneDailyBody, type DailyItem } from "./dailyItems.js";

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
	return heading
		.toLowerCase()
		.replace(/[*`_]/g, "")
		// A heading the rollover itself wrote — `Next Steps (from 2026-10-13, 11 days
		// old)` — must still read as open work on the next pass. Annotation goes in the
		// body, and tolerance here also covers hand-edited headings.
		.replace(/\s*\((from|carried|aged)[^)]*\)/g, " ")
		.replace(/\d{4}-\d{2}-\d{2}/g, " ")
		.replace(/\s+/g, " ")
		.replace(/[:–—,\-\s]+$/, "")
		.trim();
}

/**
 * The parts of a heading, split on the separators used to stack a group and a
 * section into one title (`Money Manager — Handoff`). The rollover writes those
 * titles, so the classifier has to read them: a title it cannot read is carried work
 * the next pass drops.
 */
function headingParts(heading: string): string[] {
	return heading.split(/\s+[—–/]\s+/).map((part) => part.trim()).filter((part) => part !== "");
}

export function isOpenHeading(heading: string): boolean {
	return headingParts(heading).some((part) => OPEN_HEADINGS.has(normalise(part)));
}

export function isSettledHeading(heading: string): boolean {
	return headingParts(heading).some((part) => SETTLED_HEADINGS.has(normalise(part)));
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

/** The provenance line a previous rollover wrote. Stripped before re-rendering, or
it stacks up one per rollover and the file becomes a game of telephone. */
const CARRIED_NOTE = /^\s*_?\(carried from .*?\)_?\s*$/;

function stripCarriedNote(body: string): string {
	return body.split(/\r?\n/).filter((line) => !CARRIED_NOTE.test(line)).join("\n").trim();
}

interface Classified {
	node: Section;
	kind: "open" | "settled" | "group" | "unknown";
}

function classify(node: Section): Classified {
	// A heading with children is a grouping level even when its own words name open
	// work: `## In Progress` holding `### Next Steps` is two levels of one idea, and
	// treating the outer one as a leaf swallowed the inner heading into the body and
	// produced `### In Progress` inside `## In Progress` in the next day's file.
	if (isSettledHeading(node.title)) return { node, kind: "settled" };
	if (node.children.length > 0) return { node, kind: "group" };
	if (isOpenHeading(node.title)) return { node, kind: "open" };
	return { node, kind: "unknown" };
}

/**
 * Open work is decided by name **or position**: under an open heading, a child is
 * open work whatever it is called, because the parent already said so
 * (`## In Progress` / `### Money Manager`). A heading with children groups instead —
 * its own bullets are carried separately, by `ownOpenWork`.
 */
function isOpenWork(node: Section, underOpenHeading: boolean): boolean {
	if (isSettledHeading(node.title) || node.children.length > 0) return false;
	return isOpenHeading(node.title) || underOpenHeading;
}

function ownOpenWork(node: Section, underOpenHeading: boolean): string {
	if (node.lines.length === 0 || (!underOpenHeading && !isOpenHeading(node.title))) return "";
	return node.lines.join("\n").trim();
}

/** Collect open-work leaves under a node, with the group they belong to. */
function collectOpen(node: Section, group?: string, underOpen = false): Array<{ group?: string; heading: string; text: string }> {
	const found: Array<{ group?: string; heading: string; text: string }> = [];
	if (isSettledHeading(node.title)) return found;
	if (isOpenWork(node, underOpen)) {
		const body = sectionText(node);
		if (body !== "") found.push({ group, heading: node.title, text: body });
		return found;
	}
	const own = ownOpenWork(node, underOpen);
	if (own !== "") found.push({ group, heading: node.title, text: own });
	const nextGroup = node.children.length > 0 ? node.title : group;
	for (const child of node.children) found.push(...collectOpen(child, nextGroup, underOpen || isOpenHeading(node.title)));
	return found;
}

function renderCarried(entry: { group?: string; heading: string; text: string }, from: string, ageDays: number | null): string {
	// Provenance is a body line, never part of the heading: an annotation inside a
	// heading stops the next rollover recognising its own output.
	const age = ageDays !== null && ageDays >= 2 ? ` — ${ageDays} days old` : "";
	// A group named with the same words as the section already being written is noise;
	// a project name is not.
	const group = entry.group !== undefined && entry.group !== "" && !isOpenHeading(entry.group) ? entry.group : undefined;
	const title = [group, entry.heading].filter((part) => part !== undefined && part !== "" && !isWrapperHeading(part)).join(" — ").trim();
	const note = `_(carried from ${from}${age})_`;
	// `## In Progress` with work of its own needs no sub-heading repeating itself.
	return title === "" ? [note, "", entry.text].join("\n") : [`### ${title}`, "", note, "", entry.text].join("\n");
}

/** Headings the fresh file already writes at level 2, so repeating them at level 3
 *  says nothing and invites the next pass to nest the same idea twice. */
function isWrapperHeading(heading: string): boolean {
	const key = normalise(heading);
	return key === "in progress" || key === "open work" || key === "carried work";
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

	const carry = (heading: string, body: string, group: string | undefined) => {
		if (body === "") return;
		// Carried item by item: stamped with the day the file was about (never today —
		// that would launder old intentions into fresh work), then aged and capped per
		// section. Everything dropped is returned, not hidden.
		const pruned = pruneDailyBody(body, today, { retireAfterDays: options.retireAfterDays, maxItems: options.maxItems, stampWith: from.source === "missing" ? today : from.date });
		for (const item of pruned.retired) retiredItems.push({ section: heading, item });
		for (const item of pruned.capped) cappedItems.push({ section: heading, item });
		// Prose under an open heading is still open work: a section that says
		// "run the gate:" with a command block carries even with no bullets.
		const hadItems = parseDailyItems(body).some(isItem);
		const keptItems = parseDailyItems(pruned.text).some(isItem);
		if (keptItems || (pruned.text !== "" && !hadItems)) {
			carried.push({ group, heading, text: pruned.text, from: from.source === "missing" ? "undated" : from.date, ageDays: daysBetween(from.date, today), stamped: pruned.stamped });
		}
		if (hadItems && !keptItems) {
			notCarried.push({ heading, reason: `every open item aged out or went past the carry cap (${pruned.retired.length} aged, ${pruned.capped.length} capped) — they are in the archive, not gone` });
		}
	};

	const walk = (node: Section, group?: string, underOpen = false) => {
		const classified = classify(node);
		if (isOpenWork(node, underOpen)) {
			carry(node.title, stripCarriedNote(sectionText(node)), group);
			return;
		}
		if (classified.kind === "settled") {
			notCarried.push({ heading: node.title, reason: "settled work — archived; anything durable belongs in the entry store (memory_write)" });
			return;
		}
		if (classified.kind === "unknown" && node.children.length === 0 && sectionText(node) === "") {
			notCarried.push({ heading: node.title, reason: "empty section — nothing under it to carry or archive" });
			return;
		}
		if (classified.kind === "unknown" && node.children.length === 0 && !underOpen) {
			notCarried.push({ heading: node.title, reason: "unrecognised heading — not carried; if it is open work, name it Next Steps / In Progress / Handoff / Blocked, or move it into one of those" });
			return;
		}
		// A grouping level carries its own bullets (if it has any) before its children,
		// then recurses: `## Money Manager` over `### Handoff` is Money Manager's work.
		const own = ownOpenWork(node, underOpen);
		if (own !== "") carry(node.title, stripCarriedNote(own), group);
		const nextGroup = classified.kind === "group" ? node.title : group;
		for (const child of node.children) walk(child, nextGroup, underOpen || isOpenHeading(node.title));
		if (classified.kind === "group" && node.children.length > 0 && collectOpen(node, group, underOpen).length === 0 && own === "") {
			notCarried.push({ heading: node.title, reason: "no open work under it — archived as a group" });
		}
	};

	for (const node of parsed.nodes) walk(node);
	if (parsed.preamble.join("\n").trim() !== "" && parsed.nodes.length === 0) {
		notCarried.push({ heading: "(document preamble)", reason: "prose before the first heading — nothing under it could be classified" });
	}

	const carriedFrom = from.source === "missing" ? "an undated file (no date field, no modification time)" : from.source === "mtime" ? `${from.date} (recovered from the file's modification time: the file had no date field)` : from.date;
	// The shape is a contract with whatever writes the file next — including the
	// harness's own memory tools, which append under `## Completed` and friends. A
	// fresh file that only the rollover can read is a private format: the day's work
	// would come back unreadable to the thing that writes it. Open work goes under
	// `## In Progress` (a heading the classifier also recognises), with project and
	// origin grouping kept one level down.
	const fresh: string[] = [`# Daily Context — ${today}`, "", `- date: ${today}`, `- carried from: ${carriedFrom}`, ""];
	if (carried.length === 0) {
		fresh.push("## In Progress", "", "_Nothing was carried forward. The previous day's file is archived, and the sections that were not carried are listed with their reasons in the rollover report._", "");
	} else {
		fresh.push("## In Progress", "");
		for (const entry of carried) fresh.push(renderCarried({ heading: entry.heading, group: entry.group, text: entry.text }, entry.from, entry.ageDays), "");
	}
	fresh.push("## Completed", "", "## Key Decisions", "", "## Notes", "");

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
