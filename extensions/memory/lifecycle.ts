/**
 * The bank's own calendar: first-run scaffolding and the daily rollover.
 *
 * Rollover is deliberately boring — archive the finished day, carry the unfinished lines
 * forward, write the template. It does not summarise, judge or delete, because a day that
 * was quietly rewritten is worse than a day that is merely long. Both files it touches go
 * through the caller's managed writer and lock, so recovery history covers rollover too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CORE_DIR, HISTORY_DIR, KNOWLEDGE_DIR, readIfExists, writeBankFile } from "./bank.js";
import { fileDay, today } from "./calendar.js";
import { extractSection } from "./sections.js";

export interface LifecycleDeps {
	/** Back up whatever is there, then replace it atomically (revision store → rename). */
	managedWrite: (file: string, content: string) => Promise<void>;
	acquireLock: (file: string) => Promise<(() => void) | null>;
}
/** Create the bank's directories if this is a first run. */
export function ensureDirs() {
	for (const dir of [CORE_DIR, KNOWLEDGE_DIR, HISTORY_DIR]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}
/**
 * Write the default core files into an empty bank, so a first session has the
 * structure the guidelines assume. Existing files are never touched.
 */
export function scaffold() {
	ensureDirs();

	const activeProjectsPath = path.join(CORE_DIR, "activeProjects.md");
	if (!fs.existsSync(activeProjectsPath)) {
		writeBankFile(
			activeProjectsPath,
			[
				"# Active Projects",
				"",
				"<!-- Format: - [Project Name] (P0-P4) - path/or/description - [aliases] -->",
				"",
				"## P0 — Critical",
				"",
				"## P1 — High",
				"",
				"## P2 — Medium",
				"",
				"## P3 — Low",
				"",
			].join("\n"),
		);
	}

	const dailyContextPath = path.join(CORE_DIR, "dailyContext.md");
	if (!fs.existsSync(dailyContextPath)) {
		writeBankFile(
			dailyContextPath,
			[
				`## ${today()}`,
				"",
				"### In Progress",
				"",
				"### Completed",
				"",
				"### Key Decisions",
				"",
				"### Context for Tomorrow",
				"",
			].join("\n"),
		);
	}
}
/**
 * Unfinished work to carry into the new day, from either place it can live.
 *
 * "Context for Tomorrow" is what the agent writes during the day; "Carried
 * Forward" is what this rollover itself writes into the fresh file. Reading
 * only the first meant an item survived exactly one rollover: it arrived as
 * "Carried Forward", nobody re-wrote it into "Context for Tomorrow", and the
 * next day it went out with the archive. Union of the two, de-duplicated on the
 * trimmed line, carried forward first so an item already carried keeps its spot.
 */
export function carryForwardLines(content: string): string[] {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const heading of ["Carried Forward", "Context for Tomorrow"]) {
		const section = extractSection(content, heading);
		if (!section) continue;
		for (const raw of section.split("\n")) {
			const line = raw.trimEnd();
			const key = line.trim();
			if (!key || seen.has(key)) continue;
			seen.add(key);
			lines.push(line);
		}
	}
	return lines;
}
/**
 * Move a finished day into `history/daily/YYYY-MM/` and start the live file again.
 *
 * Which day is finished comes from `fileDay`: the heading it carries, or the file's
 * modification time when it has none. Returns `{ archived: false }` when the live
 * file is already today's, which is the normal case on every session after the first.
 * A lock held by a writer makes it refuse rather than steal the lock, leaving the
 * live file untouched for the caller to report.
 */
export async function archiveDailyContext(deps: LifecycleDeps): Promise<{ archived: boolean; archivePath?: string; dateSource: "heading" | "mtime" }> {
	const dailyPath = path.join(CORE_DIR, "dailyContext.md");
	const content = readIfExists(dailyPath);
	if (!content) return { archived: false, dateSource: "heading" };

	const { date: fileDate, source } = fileDay(content, dailyPath);
	// Only a file from an *earlier* day is history. A future date happens: an agent
	// runs `date -u`, a laptop flies west, a heading gets typed by hand. Archiving
	// one filed that day's notes under a day that has not arrived and emptied the
	// live file, which is the loss this function exists to prevent.
	if (fileDate >= today()) return { archived: false, dateSource: source };

	// Archive to history/daily/YYYY-MM/YYYY-MM-DD-dailyContext.md
	const ym = fileDate.slice(0, 7);
	const archiveDir = path.join(HISTORY_DIR, ym);
	fs.mkdirSync(archiveDir, { recursive: true });

	const archivePath = path.join(archiveDir, `${fileDate}-dailyContext.md`);
	const releaseArchive = await deps.acquireLock(archivePath);
	if (!releaseArchive) throw new Error("Daily archive is locked; rollover left the live file unchanged");
	try { await deps.managedWrite(archivePath, content); } finally { releaseArchive(); }

	// Reset dailyContext with today's date and carry-forward section
	const carried = carryForwardLines(content);
	const fresh = [
		`## ${today()}`,
		"",
		...(carried.length > 0 ? ["### Carried Forward", ...carried, ""] : []),
		"### In Progress",
		"",
		"### Completed",
		"",
		"### Key Decisions",
		"",
		"### Context for Tomorrow",
		"",
	].join("\n");

	await deps.managedWrite(dailyPath, fresh);
	return { archived: true, archivePath, dateSource: source };
}
