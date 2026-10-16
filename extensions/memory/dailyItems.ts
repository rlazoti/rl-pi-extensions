/**
 * Item-level provenance for the daily file (Phase 6b).
 *
 * Carrying whole sections is not enough: a `Next Steps` list is a pile of
 * intentions written on different days, and a rollover that cannot tell them apart
 * either keeps all of them forever or drops all of them. So each open item carries
 * the day it was written — visible in the file, machine-readable for the rollover:
 *
 *     - (2026-10-11) verify the simulator build
 *
 * Stamping an *undated* item uses the date of the file it was found in, not today:
 * an item written yesterday in yesterday's file must not be laundered into fresh
 * work by a rollover that runs this morning.
 *
 * Ageing is conservative by default and always reported. Retiring too early loses
 * real work; the archive keeps everything, so the safe failure is to keep too much
 * for one more cycle and say so.
 */

import { BULLET, FENCE } from "./markdown.js";

export interface DailyItem {
	/** The day the item was written, when the file says so. */
	date: string | null;
	/** Item text with the date marker removed. */
	text: string;
	/** Exactly as written, so a rewrite never invents formatting. */
	raw: string;
	indent: string;
}

export interface AgeingOptions {
	/** Items older than this stop being carried. */
	retireAfterDays?: number;
	/** Per section: carry at most this many items, newest first. */
	maxItems?: number;
}

export interface AgeingResult<T> {
	carry: T[];
	retired: T[];
	capped: T[];
}

export const DEFAULT_RETIRE_AFTER_DAYS = 21;
export const DEFAULT_MAX_ITEMS = 30;

const ITEM_DATE = /^\(\s*(\d{4}-\d{2}-\d{2})\s*\)\s*/;

/**
 * Split a section body into items and non-item prose. Only top-level bullets are
 * items; deeper bullets belong to the item above them.
 */
export function parseDailyItems(body: string): Array<DailyItem | { prose: string }> {
	const out: Array<DailyItem | { prose: string }> = [];
	let fence: string | null = null;
	let current: DailyItem | null = null;

	for (const line of body.split(/\r?\n/)) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			if (current) current.raw += `\n${line}`;
			else out.push({ prose: line });
			continue;
		}
		const bullet = fence === null ? BULLET.exec(line) : null;
		const indent = /^\s*/.exec(line)![0];
		// Only unindented bullets are items of the list. An indented bullet belongs to
		// the item above it, which is how a sub-point survives without becoming a task.
		if (bullet && indent.length === 0) {
			const rest = line.slice(bullet[0]!.length);
			const dated = ITEM_DATE.exec(rest);
			current = {
				date: dated ? dated[1]! : null,
				text: dated ? rest.slice(dated[0].length) : rest,
				raw: line,
				indent: "",
			};
			out.push(current);
			continue;
		}
		if (current && line.trim() !== "" && (line.match(/^\s{2,}/) !== null || fence !== null)) {
			current.raw += `\n${line}`;
			current.text += `\n${line.trim()}`;
			continue;
		}
		current = null;
		out.push({ prose: line });
	}

	return out;
}

export function isItem(value: DailyItem | { prose: string }): value is DailyItem {
	return (value as DailyItem).raw !== undefined;
}

/** Give every undated item in a body the day the file claims to be about. */
export function stampDailyItems(body: string, date: string): string {
	const parsed = parseDailyItems(body);
	const lines: string[] = [];
	for (const entry of parsed) {
		if (!isItem(entry)) {
			lines.push(entry.prose);
			continue;
		}
		lines.push(entry.date === null ? `${entry.indent}${BULLET.exec(entry.raw)![1]} (${date}) ${entry.text.trim()}` : entry.raw);
	}
	return lines.join("\n").trimEnd();
}

function ageDays(from: string, today: string): number | null {
	const start = Date.parse(`${from}T00:00:00Z`);
	const end = Date.parse(`${today}T00:00:00Z`);
	if (Number.isNaN(start) || Number.isNaN(end)) return null;
	return Math.round((end - start) / 86_400_000);
}

/**
 * Decide which items still deserve to be carried. Undated items are never retired:
 * their age is unknown, and guessing an age to justify dropping work is exactly the
 * kind of silent loss this file exists to prevent.
 */
export function ageItems(items: readonly DailyItem[], today: string, options: AgeingOptions = {}): AgeingResult<DailyItem> {
	const retireAfter = options.retireAfterDays ?? DEFAULT_RETIRE_AFTER_DAYS;
	const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

	const dated = items.filter((item) => item.date !== null);
	const undated = items.filter((item) => item.date === null);

	const retired: DailyItem[] = [];
	const live: DailyItem[] = [];
	for (const item of dated) {
		const age = ageDays(item.date!, today);
		if (age !== null && age > retireAfter) retired.push(item);
		else live.push(item);
	}

	// Newest first for the cap, then restored to document order for reading.
	const ordered = [...live].sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0));
	const kept = ordered.slice(0, maxItems);
	const capped = ordered.slice(maxItems);
	const keep = new Set(kept);

	return { carry: [...live.filter((item) => keep.has(item)), ...undated], retired, capped };
}

/**
 * One pass over a section body: stamp what has no date, then decide what still
 * deserves carrying. Returns the rewritten body plus what was dropped, so the
 * caller can report every loss instead of discovering it next month.
 */
export interface PrunedBody {
	text: string;
	stamped: number;
	retired: DailyItem[];
	capped: DailyItem[];
}

export function pruneDailyBody(body: string, today: string, options: AgeingOptions & { stampWith?: string } = {}): PrunedBody {
	const parsed = parseDailyItems(body);
	const items = parsed.filter(isItem);
	const stampWith = options.stampWith ?? today;

	let stamped = 0;
	for (const item of items) {
		if (item.date === null) {
			item.date = stampWith;
			item.raw = `${item.indent}${BULLET.exec(item.raw)![1]} (${stampWith}) ${item.text.trim()}`;
			stamped += 1;
		}
	}

	const aged = ageItems(items, today, options);
	const lines: string[] = [];
	for (const entry of parsed) {
		if (!isItem(entry)) {
			lines.push(entry.prose);
			continue;
		}
		if (aged.carry.includes(entry)) lines.push(entry.raw);
	}

	return { text: lines.join("\n").trimEnd(), stamped, retired: aged.retired, capped: aged.capped };
}

/**
 * Stamp a whole daily file in place: only undated top-level bullets inside sections
 * that read as open work get a date, and everything else is left byte for byte. A
 * rewrite that reformats the file would make every future diff a lie.
 */
export function stampDailyFile(text: string, date: string, isOpen: (heading: string) => boolean): { text: string; stamped: number } {
	const out: string[] = [];
	let openLevel: number | null = null;
	let fence: string | null = null;
	let stamped = 0;

	for (const line of text.split(/\r?\n/)) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1]!;
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			out.push(line);
			continue;
		}
		const heading = fence === null ? /^ {0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line) : null;
		if (heading) {
			// Position counts, not just the name: `## In Progress` followed by
			// `### Money Manager` is still open work, and the next heading at the same
			// level (or shallower) closes the section.
			const level = heading[1]!.length;
			if (isOpen(heading[2]!.trim())) openLevel = level;
			else if (openLevel !== null && level <= openLevel) openLevel = null;
			out.push(line);
			continue;
		}
		const bullet = fence === null ? BULLET.exec(line) : null;
		if (openLevel !== null && bullet && /^\s*/.exec(line)![0] === "") {
			const rest = line.slice(bullet[0]!.length);
			if (ITEM_DATE.test(rest) || rest.trim() === "") {
				out.push(line);
				continue;
			}
			stamped += 1;
			out.push(`${line.slice(0, bullet[0]!.length)}(${date}) ${rest.trim()}`);
			continue;
		}
		out.push(line);
	}

	return { text: out.join("\n"), stamped };
}

/** Re-render items the way they were written, with their dates kept. */
export function renderItems(items: readonly DailyItem[]): string {
	return items.map((item) => item.raw).join("\n");
}

export function itemAge(item: DailyItem, today: string): number | null {
	return item.date === null ? null : ageDays(item.date, today);
}
