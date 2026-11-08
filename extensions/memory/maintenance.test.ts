import { describe, expect, it } from "vitest";
import { archiveAgeDays, archiveDate, archiveReason, auditCarryForward } from "./maintenance.js";
import { parseSettings } from "./settings.js";
import { MemoryIndex } from "./search.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const now = new Date(2026, 10, 8, 12);
const old = "history/daily/2026-10/2026-10-01-dailyContext.md";
describe("archive injection eligibility", () => {
	it("uses calendar dates, including exact boundaries, not modification age", () => {
		expect(archiveAgeDays(old, now)).toBe(38);
		expect(archiveReason(old, 38, now)).toBeNull(); expect(archiveReason(old, 37, now)).toContain("still searchable");
		expect(archiveReason(old, 0, now)).toBeNull();
		expect(archiveReason("history/daily/2026-11/2026-11-09-dailyContext.md", 1, now)).toBeNull();
		expect(archiveDate("history/daily/2026-02/2026-02-30-dailyContext.md")).toBeNull();
		expect(archiveDate("history/design.md")).toBeNull();
		expect(archiveDate("history/daily/2026-09/2026-10-01-dailyContext.md")).toBeNull();
	});
	it("filters age before the candidate cut and the history score reference", () => {
		const bank = fs.mkdtempSync(path.join(os.tmpdir(), "archive-window-"));
		try {
			const put = (rel: string, text: string) => { const file = path.join(bank, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
			for (let i = 1; i <= 10; i++) put(`history/daily/2020-01/2020-01-${String(i).padStart(2, "0")}-dailyContext.md`, "# Saffroncedar\n\nSaffroncedar archive.\n");
			const recent = "history/daily/2026-11/2026-11-07-dailyContext.md"; put(recent, "# Daily\n\nSaffroncedar.\n");
			const index = new MemoryIndex(bank); index.build();
			expect(index.searchForContext("saffroncedar", 1, undefined, { includeKnowledge: false, filter: (rel) => !archiveReason(rel, 30, now) }).map((r) => r.path)).toEqual([recent]);
		} finally { fs.rmSync(bank, { recursive: true, force: true }); }
	});
	it("rejects fractional/negative windows and keeps unbounded eligibility as the default",  () => {
		expect(parseSettings({ maintenance: { historyMaxDays: -1, carryForwardWarnDays: 0 } }).maintenance).toEqual({ historyMaxDays: 0, carryForwardWarnDays: 14 });
		expect(parseSettings({ maintenance: { historyMaxDays: 0.5 } }).maintenance.historyMaxDays).toBe(0);
	});
});
describe("read-only carry-forward hygiene", () => {
	it("reports old snapshots and duplicates without deciding that work is done", () => {
		const current = "## 2026-11-08\n\n### Carried Forward\n- Review release\n- review  release\n- New task\n\n### Completed\n- Not a carried item\n";
		const archives = [{ path: old, content: "### Carried Forward\n- Review release\n- Not present today\n" }];
		const report = auditCarryForward(current, archives, 14, now);
		expect(report).toEqual([{ item: "Review release", firstSeen: "2026-10-01", ageDays: 38, snapshots: 1, duplicate: true }]);
		expect(current).toContain("- New task"); expect(archives[0].content).toContain("Not present today");
	});
	it("ignores old completed-only entries and ambiguous non-daily files", () => {
		const current = "### Carried Forward\n- Review release\n";
		expect(auditCarryForward(current, [{ path: old, content: "### Completed\n- Review release\n" }, { path: "history/design.md", content: current }], 14, now)).toEqual([]);
		expect(auditCarryForward(current, [{ path: old, content: current }], 39, now)).toEqual([]);
	});
});
