/**
 * Days, as this machine counts them.
 *
 * Every date this extension writes or compares is a local calendar date. `toISOString()` is
 * UTC, which runs a day ahead of most of the Americas in the evening and once archived a day
 * that had not finished yet (see the note on `dayString`). Rollover, doctor and the archive
 * window all read dates from here, so they cannot disagree about what "today" is.
 */
import * as fs from "node:fs";
/**
 * Calendar date (YYYY-MM-DD) that an instant falls on, in the machine's own
 * timezone.
 *
 * This was `toISOString().slice(0, 10)`, which is UTC. Days are a local concept,
 * so on a UTC-5 machine the day rolled over at 19:00: a session opened at 19:01
 * on the 27th read today() as the 28th, archived the 27th's dailyContext, and
 * titled the fresh one for a day that had not started yet.
 */
export function dayString(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}
export function today(): string {
	return dayString(new Date());
}
export function extractDate(content: string): string | null {
	const match = content.match(/^##?\s*(?:Date:?\s*)?(\d{4}-\d{2}-\d{2})/m);
	return match?.[1] ?? null;
}
/**
 * Which day a dailyContext.md belongs to, and how we worked it out.
 *
 * Normally the heading the extension wrote (`## 2026-10-27`). Agents rewrite
 * that file freely, though: a `# Daily Context` title with a prose "Date:
 * 2026-10-19" line made extractDate return null, which the rollover read as
 * "nothing to do". Every later day then overwrote the same file — no archive,
 * no warning, and no way back. Falling back to the file's own modification
 * time turns a rewritten heading into a warning instead of silent data loss.
 */
export function fileDay(content: string, filePath: string): { date: string; source: "heading" | "mtime" } {
	const heading = extractDate(content);
	if (heading) return { date: heading, source: "heading" };

	let mtime = new Date();
	try {
		mtime = fs.statSync(filePath).mtime;
	} catch {
		// Unstatable file: treat it as today, which means "leave it alone".
	}
	return { date: dayString(mtime), source: "mtime" };
}
