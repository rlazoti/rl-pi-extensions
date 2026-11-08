/**
 * The bank-isolation harness is itself a behaviour, so it is tested.
 *
 * On 2026-11-08 a handler suite statically imported a module that reaches
 * bank.ts. ES imports hoist above the test file's `process.env.PI_MEMORY_DIR =
 * tmpdir()`, so bank.ts evaluated with no override, cached the operator's real
 * bank in the module registry, and the suite wrote its fixtures into
 * ~/.pi/memory3. Nothing failed. These tests fail instead.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { guardBank } from "./vitest.bank-guard.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JITI = path.join(ROOT, "node_modules", ".bin", "jiti");
const BANK_MODULE = path.join(ROOT, "bank.ts");

/** Load bank.ts in a fresh process, with the env the caller controls. */
function loadBank(opts: { vitest: boolean; bank?: string }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-guard-"));
	const probe = path.join(dir, "probe.ts");
	fs.writeFileSync(probe, `import { MEMORY_ROOT } from ${JSON.stringify(BANK_MODULE)};\nconsole.log(MEMORY_ROOT);\n`);
	const env: Record<string, string | undefined> = { ...process.env };
	// Deleting, not blanking: bank.ts reads the var with ??, so "" would be a root.
	delete env.PI_MEMORY_DIR;
	delete env.PI_MEMORY_TEST_DIR;
	if (opts.vitest) env.VITEST = "1";
	else delete env.VITEST;
	if (opts.bank) env.PI_MEMORY_DIR = opts.bank;
	const child = spawnSync(JITI, [probe], { encoding: "utf-8", env });
	fs.rmSync(dir, { recursive: true, force: true });
	return child;
}

describe("test bank isolation", () => {
	it("runs inside a temp bank that the setup hook created", () => {
		const dir = process.env.PI_MEMORY_DIR ?? "";
		expect(dir).toBeTruthy();
		expect(fs.existsSync(dir)).toBe(true);
		expect(path.resolve(dir, "..")).toBe(path.resolve(os.tmpdir()));
		expect(fs.existsSync(path.join(dir, "core"))).toBe(true);
		expect(dir).not.toBe(path.join(os.homedir(), ".pi", "memory3"));
	});

	it("isolates the worker home and inherited subprocess default bank", () => {
		const suite = process.env.PI_MEMORY_TEST_SUITE_ROOT!;
		expect(suite).toBeTruthy();
		expect(os.homedir()).toBe(path.join(suite, "home"));
		expect(process.env.USERPROFILE).toBe(os.homedir());
		const child = loadBank({ vitest: false });
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout.trim()).toBe(path.join(suite, "home", ".pi", "memory3"));
	});

	it.each(["unchanged", "added", "overwritten", "deleted", "new bank"])("checks %s paths in the teardown guard", (mode) => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-guard-check-"));
		const bank = path.join(base, "bank"), file = path.join(bank, "existing.md");
		try {
			if (mode !== "new bank") { fs.mkdirSync(bank); fs.writeFileSync(file, "original"); }
			const check = guardBank(bank);
			if (mode === "added") fs.writeFileSync(path.join(bank, "added.md"), "new");
			if (mode === "overwritten") fs.writeFileSync(file, "replaced");
			if (mode === "deleted") fs.unlinkSync(file);
			if (mode === "new bank") { fs.mkdirSync(bank); fs.writeFileSync(file, "new"); }
			if (mode === "unchanged") expect(check).not.toThrow();
			else expect(check).toThrow(/bank isolation leak/);
		} finally { fs.rmSync(base, { recursive: true, force: true }); }
	});

	it("checks file changes through an original bank root symlink", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-guard-alias-"));
		try {
			const real = path.join(base, "real"), alias = path.join(base, "alias");
			fs.mkdirSync(real); fs.symlinkSync(real, alias, "dir");
			fs.writeFileSync(path.join(real, "note.md"), "before");
			const check = guardBank(alias);
			fs.writeFileSync(path.join(real, "note.md"), "after");
			expect(check).toThrow(/bank isolation leak/);
		} finally { fs.rmSync(base, { recursive: true, force: true }); }
	});

	it.each([false, true])("global setup protects original banks with explicit override=%s", (override) => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-global-check-"));
		const home = path.join(base, "original-home"), originalBank = path.join(home, ".pi", "memory3"), explicit = path.join(base, "explicit-bank");
		fs.mkdirSync(originalBank, { recursive: true }); fs.mkdirSync(explicit);
		const target = path.join(override ? explicit : originalBank, "existing.md"); fs.writeFileSync(target, "original");
		const probe = path.join(base, "global.ts");
		fs.writeFileSync(probe, `
import setup from ${JSON.stringify(path.join(ROOT, "vitest.bank-guard.ts"))};
import * as fs from 'node:fs';
const oldHome = process.env.HOME, oldBank = process.env.PI_MEMORY_DIR;
const teardown = setup();
const suite = process.env.PI_MEMORY_TEST_SUITE_ROOT;
if (process.env.HOME === oldHome || process.env.PI_MEMORY_DIR === oldBank) throw new Error('not sandboxed');
fs.writeFileSync(${JSON.stringify(target)}, 'clobbered');
let detected = false;
try { teardown(); } catch (e) { detected = String(e).includes('bank isolation leak'); }
if (!detected) throw new Error('missed original bank overwrite');
if (fs.existsSync(suite)) throw new Error('sandbox leaked after guard failure');
if (process.env.HOME !== oldHome || process.env.PI_MEMORY_DIR !== oldBank) throw new Error('environment not restored');
console.log('guarded');
`);
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
		delete env.PI_MEMORY_GUARD;
		if (override) env.PI_MEMORY_DIR = explicit; else delete env.PI_MEMORY_DIR;
		try {
			const child = spawnSync(JITI, [probe], { encoding: "utf8", env });
			expect(child.status, child.stderr).toBe(0); expect(child.stdout.trim()).toBe("guarded");
		} finally { fs.rmSync(base, { recursive: true, force: true }); }
	});

	it("refuses to bind the operator's bank in a test process", () => {
		const child = loadBank({ vitest: true });
		const text = `${child.stdout}${child.stderr}`;
		expect(child.status, text).not.toBe(0);
		expect(text).toMatch(/imported bank\.ts with no PI_MEMORY_DIR/);
		expect(text).not.toContain(path.join(os.homedir(), ".pi", "memory3"));
	});

	it("binds whatever bank a test process does name", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-named-"));
		const child = loadBank({ vitest: true, bank: dir });
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout.trim()).toBe(dir);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("says nothing in a real session, where PI_MEMORY_DIR may legitimately be unset", () => {
		const child = loadBank({ vitest: false });
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout.trim()).toBe(path.join(os.homedir(), ".pi", "memory3"));
	});
});
