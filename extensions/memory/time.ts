/**
 * Calendar time, in the machine's local day.
 *
 * Every date in this component answers one question: "which day on Rodrigo's
 * clock?" — so every day is derived from local fields, never from an ISO string.
 * `new Date().toISOString().slice(0, 10)` rolls the day over at UTC midnight,
 * which between local midnight and the UTC offset stamps the daily log with
 * tomorrow's date and makes the next turn read its own file as stale. R15 (the
 * extension stamps the date) and R27.2 (open items come from today) are both
 * wrong under a UTC day, so the helper lives here and nothing else formats a date.
 */

/** Injectable for tests: everything date-related takes an explicit clock. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** `YYYY-MM-DD` for the local calendar day of `when`. */
export function dayOf(when: Date): string {
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

/** `YYYY-MM-DD HH:MM` — the stamp `memory_log` puts on every item (R15). */
export function stampOf(when: Date): string {
	return `${dayOf(when)} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/** Month directory for the daily archive: `YYYY-MM`. */
export function monthOf(day: string): string {
	return day.slice(0, 7);
}

export function isDay(value: string): boolean {
	if (!DAY.test(value)) return false;
	const [y, m, d] = value.split("-").map(Number);
	if (!m || m < 1 || m > 12) return false;
	// Round-trip check: "2026-02-30" parses as a number triple but is not a day.
	const probe = new Date(value);
	return !Number.isNaN(probe.getTime()) && probe.getUTCDate() === d && probe.getUTCMonth() === m - 1;
}

/**
 * Whole calendar days from `from` to `to` (negative when `from` is in the
 * future). Day arithmetic on `YYYY-MM-DD` strings is done in UTC so daylight
 * saving cannot make a day 23 or 25 hours long.
 */
export function daysBetween(from: string, to: string): number {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (Number.isNaN(a) || Number.isNaN(b)) return 0;
	return Math.round((b - a) / 86_400_000);
}

/** Human age for a date: "today", "3 days", "2 weeks", "3 months". */
export function describeAge(day: string, today: string): string {
	const days = daysBetween(day, today);
	if (days <= 0) return "today";
	if (days === 1) return "1 day";
	if (days < 14) return `${days} days`;
	if (days < 60) return `${Math.round(days / 7)} weeks`;
	return `${Math.round(days / 30)} months`;
}
