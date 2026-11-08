/** Verify distinct-file behavior even when the host volume is case-insensitive. */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { resolveBankPath } from "./paths.js";
import { acquireBankLock } from "./locks.js";

vi.mock("node:fs", async () => {
	const { createFsFromVolume, Volume } = await import("memfs");
	const fake = createFsFromVolume(new Volume());
	return { ...fake, default: fake };
});

describe("identity on a simulated case-sensitive filesystem", () => {
	it.each([
		["case", "/case", "note.md", "NOTE.MD"],
		["Unicode", "/unicode", "caf\u00e9.md", "cafe\u0301.md"],
	])("does not conflate distinct %s spellings or their locks", async (_label, root, name, other) => {
		fs.mkdirSync(root + "/knowledge", { recursive: true });
		const a = "knowledge/" + name, b = "knowledge/" + other;
		fs.writeFileSync(root + "/" + a, "first"); fs.writeFileSync(root + "/" + b, "second");
		expect(resolveBankPath(root, a)!.rel).toBe(a); expect(resolveBankPath(root, b)!.rel).toBe(b);
		const releaseA = await acquireBankLock(root, a);
		try {
			const releaseB = await acquireBankLock(root, b);
			expect(releaseB).not.toBeNull(); releaseB?.();
		} finally { releaseA?.(); }
		expect(fs.readFileSync(root + "/" + a, "utf8")).toBe("first");
		expect(fs.readFileSync(root + "/" + b, "utf8")).toBe("second");
	});
});
