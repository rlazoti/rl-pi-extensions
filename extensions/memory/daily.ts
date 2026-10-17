/**
 * The daily log: the one place project status is allowed to live.
 *
 *     # Daily log — 2026-10-16
 *
 *     ## in_progress
 *     - (2026-10-16 21:05) Wire the injector.
 *
 *     ## carry
 *     - (2026-10-15 17:30) inbox GC is still unowned.
 *
 * Two rules the shape enforces:
 *
 *  - Every item carries a stamp, and the extension writes it (R15). An item with
 *    no stamp — written by another tool, or by hand — is still read, but dated
 *    from the file and counted as undated, so its age is known to be coarse
 *    rather than silently wrong.
 *  - The file's own header day is the truth about which day it is. That is what
 *    makes rollover safe when a clock changes: a log stamped with a future day is
 *    never archived, because archiving it would delete today's work.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dayOf, isDay, monthOf, stampOf, systemClock, type Clock } from "./time.js";
import { markdownFiles, type BankPaths } from "./store.js";

export const DAILY_SECTIONS = ["completed", "in_progress", "carry", "decision", "note"] as const;
export type DailySection = (typeof DAILY_SECTIONS)[number];

/** What the injector puts in the "daily open items" section (R27.2). */
export const OPEN_SECTIONS: DailySection[] = ["in_progress", "carry"];

export interface DailyItem {
	section: DailySection;
	/** `YYYY-MM-DD HH:MM` when stamped, `YYYY-MM-DD` when dated from the file. */
	stamp: string;
	day: string;
	text: string;
	line: number;
	undated: boolean;
}

export interface DailyIssue {
	file: string;
	line: number;
	message: string;
}

export interface DailyLog {
	file: string;
	/** The day this log claims to be, from its header. */
	day: string;
	items: DailyItem[];
	issues: DailyIssue[];
}

const HEADING = /^#\s*Daily log\s*[—-]\s*(\d{4}-\d{2}-\d{2})\s*$/;
const SECTION = /^##\s+(\S+)\s*$/;
const ITEM = /^-\s+\((\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?\)\s*(.*)$/;

export function dailyFile(paths: BankPaths): string {
	return join(paths.daily, "today.md");
}

export function isDailySection(value: string): value is DailySection {
	return (DAILY_SECTIONS as readonly string[]).includes(value);
}

/** Parse a daily log. Section order and item order are preserved (R6). */
export function parseDaily(text: string, file: string, fallbackDay?: string): DailyLog {
	const lines = text.split("\n");
	const issues: DailyIssue[] = [];
	let day = fallbackDay ?? "";
	const headerAt = lines.findIndex((line) => HEADING.test(line));
	if (headerAt >= 0) {
		day = HEADING.exec(lines[headerAt]!)![1]!;
	} else if (fallbackDay === undefined) {
		issues.push({ file, line: 1, message: 'no "# Daily log — YYYY-MM-DD" header and no file name to date it from' });
	}

	const items: DailyItem[] = [];
	let section: DailySection | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const sectionMatch = SECTION.exec(line);
		if (sectionMatch) {
			const name = sectionMatch[1]!;
			if (!isDailySection(name)) {
				issues.push({ file, line: i + 1, message: `unknown section "${name}" (known: ${DAILY_SECTIONS.join(", ")})` });
				section = undefined;
				continue;
			}
			section = name;
			continue;
		}
		if (/^#\s/.test(line)) continue; // the title line
		if (line.trim() === "") continue;
		if (section === undefined) {
			issues.push({ file, line: i + 1, message: `"${line.trim().slice(0, 40)}" is outside any section` });
			continue;
		}
		const item = ITEM.exec(line);
		if (item) {
			items.push({
				section,
				stamp: item[2] ? `${item[1]} ${item[2]}` : item[1]!,
				day: item[1]!,
				text: item[3] ?? "",
				line: i + 1,
				undated: false,
			});
			continue;
		}
		if (line.startsWith("- ")) {
			// An item with no stamp: readable, but its age is only as good as the file.
			items.push({ section, stamp: day, day, text: line.slice(2).trim(), line: i + 1, undated: true });
			continue;
		}
		const previous = items[items.length - 1];
		if (previous && previous.line === i) {
			// A wrapped continuation of the item above: join it, so the rewrite is one line.
			previous.text = `${previous.text} ${line.trim()}`;
			previous.line = i + 1;
			continue;
		}
		issues.push({ file, line: i + 1, message: `"${line.trim().slice(0, 40)}" is not an item line ("- (YYYY-MM-DD HH:MM) text")` });
	}

	return { file, day, items, issues };
}

/** Render a daily log: header, then every section in the fixed order. */
export function renderDaily(log: DailyLog): string {
	const lines = [`# Daily log — ${log.day}`];
	for (const section of DAILY_SECTIONS) {
		const inSection = log.items.filter((item) => item.section === section);
		if (inSection.length === 0) continue;
		lines.push("", `## ${section}`);
		for (const item of inSection) lines.push(item.undated ? `- ${item.text}` : `- (${item.stamp}) ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

export function readDaily(paths: BankPaths, today: string): DailyLog {
	const file = dailyFile(paths);
	const text = readOrNull(file);
	if (text === undefined) return { file, day: today, items: [], issues: [] };
	// No fallback: today.md claiming a day is the file's own statement. A file
	// that cannot say which day it is gets reported, not dated by the reader.
	return parseDaily(text, file);
}

function readOrNull(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** The open work a session should be told about (R27.2), oldest first. */
export function openItems(log: DailyLog): DailyItem[] {
	return log.items.filter((item) => OPEN_SECTIONS.includes(item.section));
}

export function formatItem(item: DailyItem): string {
	return `- (${item.stamp}) ${item.text}`;
}

/**
 * Append one item, stamped by the extension (R15). The agent chooses the section
 * and the text; the date and time are never the agent's to set.
 */
export function appendDailyItem(paths: BankPaths, input: { section: string; text: string; clock?: Clock }): { file: string; item: DailyItem; log: DailyLog } {
	const clock = input.clock ?? systemClock;
	const now = clock();
	const today = dayOf(now);
	if (!isDailySection(input.section)) {
		throw new Error(`section must be one of ${DAILY_SECTIONS.join(", ")} (got "${input.section}")`);
	}
	const text = input.text.replace(/\s+/g, " ").trim();
	if (text === "") throw new Error("text is required");
	const log = readDaily(paths, today);
	log.items.push({ section: input.section, stamp: stampOf(now), day: today, text, line: 0, undated: false });
	writeDaily(paths, log);
	return { file: log.file, item: log.items[log.items.length - 1]!, log };
}

export function writeDaily(paths: BankPaths, log: DailyLog): void {
	if (!existsSync(paths.daily)) mkdirSync(paths.daily, { recursive: true });
	writeFileSync(log.file, renderDaily(log), "utf8");
}

export interface RolloverResult {
	/** Set when the previous day's log was moved to the archive. */
	archivedTo?: string;
	/** Open items carried into the new day. */
	carried: number;
	/** Why nothing happened, when nothing happened. */
	reason?: string;
	/** A log stamped in the future is never archived (and never rolled). */
	futureDated: boolean;
}

/**
 * Move `daily/today.md` into `daily/archive/YYYY-MM/YYYY-MM-DD.md` and start the
 * new day with the work that was still open.
 *
 * Called before any write or injection on a new day. A file whose header is a
 * future day is left alone and reported: switching clocks backwards must not
 * turn today's log into an archive entry.
 */
export function rolloverDaily(paths: BankPaths, opts: { today: string }): RolloverResult {
	const file = dailyFile(paths);
	const text = readOrNull(file);
	if (text === undefined) return { carried: 0, reason: "no daily log yet", futureDated: false };
	const log = parseDaily(text, file);
	if (!isDay(log.day)) return { carried: 0, reason: `daily log does not say which day it is (${file})`, futureDated: false };
	if (log.day > opts.today) {
		return { carried: 0, reason: `daily log is dated ${log.day}, after today (${opts.today}) — not archived`, futureDated: true };
	}
	if (log.day === opts.today) return { carried: 0, reason: "already today's log", futureDated: false };

	if (!existsSync(paths.daily)) mkdirSync(paths.daily, { recursive: true });
	const monthDir = join(paths.dailyArchive, monthOf(log.day));
	if (!existsSync(monthDir)) mkdirSync(monthDir, { recursive: true });
	let target = join(monthDir, `${log.day}.md`);
	// A second log for one day takes the next free slot beside it: an archive
	// record is never overwritten, and a name collision must not make a file
	// impossible to archive.
	for (let slot = 2; existsSync(target); slot++) target = join(monthDir, `${log.day}-${slot}.md`);
	writeFileSync(target, renderDaily(log), "utf8");

	const carried = openItems(log);
	const fresh: DailyLog = { file, day: opts.today, items: carried.map((item) => ({ ...item, line: 0 })), issues: [] };
	writeDaily(paths, fresh);
	return { archivedTo: target, carried: carried.length, futureDated: false };
}

/** Every archived daily file, oldest name first. Search-only, never injected (D12). */
export function dailyArchiveFiles(paths: BankPaths): string[] {
	return markdownFiles(paths.dailyArchive, paths.root);
}

/** How fresh the daily log is, for `/memory` status output. */
export function dailyStatus(paths: BankPaths, today: string): { day: string; fresh: boolean; open: number; undated: number; issues: DailyIssue[]; futureDated: boolean } {
	const log = readDaily(paths, today);
	return {
		day: log.day,
		fresh: log.day === today,
		open: openItems(log).length,
		undated: log.items.filter((item) => item.undated).length,
		issues: log.issues,
		futureDated: log.day > today,
	};
}
