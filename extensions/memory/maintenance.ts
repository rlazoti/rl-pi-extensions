/** Read-only hygiene and eligibility, never deletion or task-completion inference. */
export const DEFAULT_MAINTENANCE = { historyMaxDays: 0, carryForwardWarnDays: 14 };
export interface MaintenanceConfig { historyMaxDays: number; carryForwardWarnDays: number }
const DAY = 86_400_000;
function ordinal(date: Date): number { return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY); }
export function archiveDate(rel: string): string | null {
	const match = rel.match(/^history\/daily\/(\d{4}-\d{2})\/(\d{4}-\d{2}-\d{2})-dailyContext\.md$/);
	if (!match || match[1] !== match[2].slice(0, 7)) return null;
	const at = new Date(`${match[2]}T12:00:00Z`);
	return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === match[2] ? match[2] : null;
}
export function archiveAgeDays(rel: string, now = new Date()): number | null {
	const day = archiveDate(rel); return day ? ordinal(now) - Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY) : null;
}
export function archiveReason(rel: string, maxDays: number, now = new Date()): string | null {
	if (maxDays <= 0) return null;
	const age = archiveAgeDays(rel, now);
	return age !== null && age > maxDays ? `archive ${age} days old, outside ${maxDays}-day injection window (still searchable)` : null;
}
function carriedItems(text: string): string[] {
	const items: string[] = []; let active = false;
	for (const line of text.split("\n")) {
		if (/^#{2,3}\s+/.test(line)) { active = /^#{2,3}\s+Carried Forward\s*$/.test(line); continue; }
		if (!active || /^\s*<!--/.test(line)) continue;
		const bullet = line.match(/^\s*[-*]\s+(.+)/);
		if (bullet) items.push(bullet[1].trim());
		else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += " " + line.trim();
	}
	return items;
}
const normalize = (item: string) => item.trim().toLowerCase().replace(/\s+/g, " ");
export interface CarryFinding { item: string; firstSeen: string | null; ageDays: number | null; snapshots: number; duplicate: boolean }
export function auditCarryForward(current: string, archives: Array<{ path: string; content: string }>, warnDays: number, now = new Date()): CarryFinding[] {
	const first = new Map<string, { day: string; snapshots: number }>();
	for (const file of archives) {
		const day = archiveDate(file.path); if (!day) continue;
		for (const key of new Set(carriedItems(file.content).map(normalize))) {
			const previous = first.get(key);
			first.set(key, { day: previous && previous.day < day ? previous.day : day, snapshots: (previous?.snapshots ?? 0) + 1 });
		}
	}
	const items = carriedItems(current), counts = new Map<string, number>();
	for (const item of items) counts.set(normalize(item), (counts.get(normalize(item)) ?? 0) + 1);
	const findings: CarryFinding[] = [], emitted = new Set<string>();
	for (const item of items) {
		const key = normalize(item); if (emitted.has(key)) continue; emitted.add(key);
		const seen = first.get(key), duplicate = counts.get(key)! > 1;
		const ageDays = seen ? ordinal(now) - Math.floor(Date.parse(`${seen.day}T00:00:00Z`) / DAY) : null;
		if (duplicate || (ageDays !== null && ageDays >= warnDays)) findings.push({ item, firstSeen: seen?.day ?? null, ageDays, snapshots: seen?.snapshots ?? 0, duplicate });
	}
	return findings;
}
