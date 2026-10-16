import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderTopicFile } from "./schema.ts";

import { applyEdits, foreignMemoryExtension, listKnowledgeFiles, loadKnowledgeStore, memoryPaths, resolveInBank, type MemoryPaths } from "./fs-store.ts";

// ─── Scratch banks only ─────────────────────────────────────────────────────
// Every test runs against a temp root: the live ~/.pi/memory is never an input
// to a test, and a test that could rewrite it would be worse than no test.

function scratch(): MemoryPaths & { cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "memory-bank-"));
	const paths: MemoryPaths = {
		root,
		knowledge: join(root, "knowledge"),
		pending: join(root, ".pending"),
		extensionsDir: join(root, "agent", "extensions"),
	};
	return { ...paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const UI = `# ui

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- status: active
Use dark grey for the UI background.
`;

function seed(paths: MemoryPaths, files: Record<string, string>): void {
	mkdirSync(paths.knowledge, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(paths.knowledge, name), content, "utf8");
}

// ─── Where the bank lives ───────────────────────────────────────────────────

test("the bank lives under the agent dir unless overridden", () => {
	const paths = memoryPaths({ HOME: "/home/tester" });
	assert.equal(paths.root, join("/home/tester", ".pi", "memory"), "same default as the live memory extension — cutover replaces that bank, it does not move it");
	assert.equal(paths.knowledge, join(paths.root, "knowledge"));
	assert.equal(paths.pending, join(paths.root, ".pending"));
	assert.equal(paths.extensionsDir, join("/home/tester", ".pi", "agent", "extensions"));
});

test("PI_MEMORY_DIR and PI_CODING_AGENT_DIR move the bank and the extensions dir", () => {
	const paths = memoryPaths({ PI_MEMORY_DIR: "/tmp/scratch-bank", PI_CODING_AGENT_DIR: "/tmp/scratch-agent" });
	assert.equal(paths.root, "/tmp/scratch-bank");
	assert.equal(paths.knowledge, "/tmp/scratch-bank/knowledge");
	assert.equal(paths.extensionsDir, "/tmp/scratch-agent/extensions");
});

test("relocating the agent dir does not relocate the bank", () => {
	const paths = memoryPaths({ PI_CODING_AGENT_DIR: "/tmp/agent", HOME: "/home/tester" });
	assert.equal(paths.root, join("/home/tester", ".pi", "memory"));
	assert.equal(paths.extensionsDir, "/tmp/agent/extensions");
});

// ─── Reading ────────────────────────────────────────────────────────────────

test("an absent bank is an empty store, not an error", () => {
	const paths = scratch();
	try {
		assert.deepEqual(listKnowledgeFiles(paths), []);
		const loaded = loadKnowledgeStore(paths);
		assert.equal(loaded.store.entries.length, 0);
		assert.deepEqual(loaded.unreadable, []);
	} finally {
		paths.cleanup();
	}
});

test("entry stores are the markdown files directly under knowledge/, in name order", () => {
	const paths = scratch();
	try {
		seed(paths, { "ui.md": UI, "appearance.md": UI, "index.csv": "a,b\n", ".hidden.md": UI, "notes.txt": "x" });
		mkdirSync(join(paths.knowledge, "nested.md"), { recursive: true });
		assert.deepEqual(listKnowledgeFiles(paths), ["knowledge/appearance.md", "knowledge/nested.md", "knowledge/ui.md"], "a directory named *.md still shows up; the reader reports it as unreadable");
	} finally {
		paths.cleanup();
	}
});

test("a store is keyed by its memory-bank-relative path, which is what the gate addresses", () => {
	const paths = scratch();
	try {
		seed(paths, { "ui.md": UI });
		const { store } = loadKnowledgeStore(paths);
		assert.deepEqual([...store.byPath.keys()], ["knowledge/ui.md"]);
		assert.equal(store.entries[0]!.path, "knowledge/ui.md");
	} finally {
		paths.cleanup();
	}
});

test("a file that cannot be read is reported, not silently skipped", () => {
	const paths = scratch();
	try {
		seed(paths, { "ui.md": UI });
		mkdirSync(join(paths.knowledge, "broken.md"));
		const loaded = loadKnowledgeStore(paths);
		assert.equal(loaded.store.entries.length, 1);
		assert.deepEqual(loaded.unreadable.map((problem) => problem.path), ["knowledge/broken.md"]);
		assert.match(loaded.unreadable[0]!.error, /.+/);
	} finally {
		paths.cleanup();
	}
});

// ─── Writing ────────────────────────────────────────────────────────────────

test("paths outside knowledge/ are refused before anything is touched", () => {
	const paths = scratch();
	try {
		for (const file of ["../escape.md", "/abs/x.md", "core/dailyContext.md", "knowledge/a/b/x.md", "knowledge/x.txt", "knowledge/Ui.md"]) {
			assert.equal(resolveInBank(paths, file), null, `${file} resolves to nothing`);
		}
		assert.equal(resolveInBank(paths, "knowledge/ui.md"), join(paths.knowledge, "ui.md"));
	} finally {
		paths.cleanup();
	}
});

test("applyEdits writes the rendered bytes, creates the directory, and leaves no temp files", () => {
	const paths = scratch();
	try {
		const written = applyEdits(paths, [{ path: "knowledge/ui.md", content: UI, changes: [{ change: "created-file", heading: "ui.background" }] }]);
		assert.deepEqual(written, ["knowledge/ui.md"]);
		assert.equal(readFileSync(join(paths.knowledge, "ui.md"), "utf8"), UI);
		assert.deepEqual(readdirSync(paths.knowledge), ["ui.md"], "no .tmp- leftovers");
	} finally {
		paths.cleanup();
	}
});

test("applyEdits refuses an escaping path and writes nothing", () => {
	const paths = scratch();
	try {
		assert.throws(() => applyEdits(paths, [{ path: "knowledge/ok.md", content: UI, changes: [] }, { path: "../outside.md", content: "nope", changes: [] }]), /outside the memory bank/);
		assert.equal(existsSync(join(paths.root, "outside.md")), false);
	} finally {
		paths.cleanup();
	}
});

test("what is written is what comes back: gate output survives the disk round trip", () => {
	const paths = scratch();
	try {
		seed(paths, { "ui.md": UI });
		const before = loadKnowledgeStore(paths);
		const file = before.store.byPath.get("knowledge/ui.md")!;
		const entry = file.entries[0]!;
		entry.body = "Use charcoal for the UI background.";
		entry.asOf = "2026-11-01";
		entry.fields.amendedFrom = "2026-10-02";

		// The canonical renderer, exactly as the gate hands it over.
		applyEdits(paths, [{ path: "knowledge/ui.md", content: renderTopicFile(file), changes: [{ change: "amended-entry", heading: "ui.background" }] }]);

		const after = loadKnowledgeStore(paths);
		assert.deepEqual(after.unreadable, []);
		assert.equal(after.store.entries.length, 1);
		assert.equal(after.store.entries[0]!.body, "Use charcoal for the UI background.");
		assert.equal(after.store.entries[0]!.asOf, "2026-11-01");
		assert.equal(after.store.entries[0]!.fields.amendedFrom, "2026-10-02", "provenance survives the disk");
		assert.deepEqual(after.store.violations, []);
	} finally {
		paths.cleanup();
	}
});

// ─── Single-instance guard ──────────────────────────────────────────────────

test("the guard sees a real memory directory as another memory extension", () => {
	const paths = scratch();
	try {
		assert.equal(foreignMemoryExtension(paths), null, "nothing enabled yet");
		mkdirSync(paths.extensionsDir, { recursive: true });
		mkdirSync(join(paths.extensionsDir, "memory"));
		assert.equal(foreignMemoryExtension(paths), join(paths.extensionsDir, "memory"));
		rmSync(join(paths.extensionsDir, "memory"), { recursive: true });
		symlinkSync(join(paths.root, "..", "repo", "extensions", "memory"), join(paths.extensionsDir, "memory"));
		assert.equal(foreignMemoryExtension(paths), null, "our own component is enabled by symlink, which is not a collision");
		assert.equal(lstatSync(join(paths.extensionsDir, "memory")).isSymbolicLink(), true);
	} finally {
		paths.cleanup();
	}
});
