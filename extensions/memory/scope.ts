/** Path-derived eligibility, not authority, shadowing, or a privacy boundary. */
import * as fs from "node:fs";
import * as path from "node:path";
export interface ScopeConfig { mode: "off" | "auto" | "explicit"; name: string }
export const DEFAULT_SCOPE: ScopeConfig = { mode: "off", name: "" };
export interface ActiveScope { mode: ScopeConfig["mode"]; name: string | null; source: "off" | "explicit" | "git" | "cwd" | "unavailable" }
export function validScopeName(name: string): boolean {
	return name.length > 0 && name.length <= 100 && name.trim() === name && ![".", "..", "shared"].includes(name) && !/[\\/\p{Cc}]/u.test(name);
}
export function detectScope(config: ScopeConfig, cwd: string): ActiveScope {
	if (config.mode === "off") return { mode: "off", name: null, source: "off" };
	if (validScopeName(config.name)) return { mode: config.mode, name: config.name, source: "explicit" };
	if (config.mode === "explicit") return { mode: config.mode, name: null, source: "unavailable" };
	let at = path.resolve(cwd);
	for (;;) {
		try {
			const marker = fs.lstatSync(path.join(at, ".git"));
			if (marker.isDirectory() || marker.isFile()) {
				const name = path.basename(at);
				return { mode: config.mode, name: validScopeName(name) ? name : null, source: validScopeName(name) ? "git" : "unavailable" };
			}
		} catch {}
		const parent = path.dirname(at); if (parent === at) break; at = parent;
	}
	const name = path.basename(path.resolve(cwd));
	return { mode: config.mode, name: validScopeName(name) ? name : null, source: validScopeName(name) ? "cwd" : "unavailable" };
}
/** Null means global; flat and shared notes stay compatible with existing banks. */
export function fileScope(rel: string): string | null {
	const parts = rel.split("/");
	return parts[0] === "knowledge" && parts.length > 2 && parts[1] !== "shared" ? parts[1] : null;
}
export function scopeLabel(rel: string): string { const name = fileScope(rel); return name ? `project:${name}` : "global"; }
export function scopeReason(rel: string, active: ActiveScope): string | null {
	if (active.mode === "off") return null;
	const name = fileScope(rel);
	return name !== null && name !== active.name ? `scope ${name} is outside ${active.name ?? "unresolved explicit scope"} (still searchable)` : null;
}
export function describeScope(active: ActiveScope): string {
	return `scope: ${active.name ?? (active.mode === "off" ? "off" : "unresolved")} (${active.source}; mode ${active.mode})`;
}
export function scopeFolders(files: string[], active: ActiveScope): string[] {
	const groups = new Map<string, { count: number; eligible: boolean }>();
	for (const rel of files) {
		const label = scopeLabel(rel), previous = groups.get(label);
		groups.set(label, { count: (previous?.count ?? 0) + 1, eligible: !scopeReason(rel, active) });
	}
	return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([label, group]) => `${label}: ${group.count} file(s), ${group.eligible ? "eligible" : "not injected here"}`);
}
