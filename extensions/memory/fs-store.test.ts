import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderTopicFile } from "./schema.ts";

import { applyEdits, foreignMemoryExtension, listBankFiles, listKnowledgeFiles, loadKnowledgeStore, memoryPaths, readBankFileChecked, readBankSlice, resolveInBank, type MemoryPaths } from "./fs-store.ts";

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

// ─── The read surface: everything in the bank that is not an entry store ─────
//
// `knowledge/` is what the authority machinery reads. `core/` and `history/` are the
// working and archived state, and a model with no way to open them cannot answer
// "what was I working on in September" no matter how many archives exist.

function seedBank(paths: MemoryPaths, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const target = join(paths.root, name);
		mkdirSync(target.split("/").slice(0, -1).join("/"), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
}

const PROJECTS = "# Active Projects\n\n## rl-pi-extensions\n- v1.4.1 released\n";
const ARCHIVE = "# Daily Context — 2026-10-14\n\n- date: 2026-10-14\n\n## In Progress\n- verify the simulator build\n";

test("read reaches the files the entry-store loader deliberately ignores", () => {
	const paths = scratch();
	try {
		seedBank(paths, { "knowledge/ui.md": UI, "core/activeProjects.md": PROJECTS, "history/daily/2026-10/2026-10-14-dailyContext.md": ARCHIVE });

		assert.deepEqual(listKnowledgeFiles(paths), ["knowledge/ui.md"], "the authority surface is still only knowledge/*.md");
		for (const file of ["core/activeProjects.md", "history/daily/2026-10/2026-10-14-dailyContext.md"]) {
			const outcome = readBankFileChecked(paths, file);
			assert.equal(outcome.kind, "read", file);
			if (outcome.kind === "read") assert.ok(outcome.slice.text.includes("simulator build") || outcome.slice.text.includes("v1.4.1"));
		}
	} finally {
		paths.cleanup();
	}
});

test("a slice reports its window and how to continue, because a truncation the reader cannot see is a lie", () => {
	const paths = scratch();
	try {
		seedBank(paths, { "core/activeProjects.md": PROJECTS });
		const first = readBankFileChecked(paths, "core/activeProjects.md");
		if (first.kind !== "read") throw new Error("expected a read");
		const rest = readBankSlice(paths, "core/activeProjects.md", { offset: 20, maxChars: 10 });
		if (rest === null) throw new Error("expected a read");

		assert.equal(first.slice.totalChars, PROJECTS.length);
		assert.equal(first.slice.truncated, false, "the default window covers a file this size");
		assert.equal(rest.text, PROJECTS.slice(20, 30));
		assert.equal(rest.truncated, true);
		assert.equal(rest.offset + rest.shownChars < rest.totalChars, true);
	} finally {
		paths.cleanup();
	}
});

test("offsets count graphemes, so a window boundary never splits an emoji in half", () => {
	const paths = scratch();
	try {
		seedBank(paths, { "core/activeProjects.md": "a🧑‍💻b😀c" });
		const slice = readBankSlice(paths, "core/activeProjects.md", { offset: 1, maxChars: 1 });
		if (slice === null) throw new Error("expected a read");
		// The ZWJ sequence is one grapheme: a byte offset splits it into mojibake and a
		// UTF-16 offset splits it into a lone surrogate, and neither reads as broken.
		assert.equal(slice.text, "🧑‍💻");
		assert.equal(slice.totalChars, 5, "a, the ZWJ person, b, the emoji, c — what a reader counts, not what UTF-16 stores");
	} finally {
		paths.cleanup();
	}
});

test("missing, directory and outside are three different answers, so the tool can say which", () => {
	const paths = scratch();
	try {
		seedBank(paths, { "core/activeProjects.md": PROJECTS, "knowledge/ui.md": UI });
		assert.equal(readBankFileChecked(paths, "core/nope.md").kind, "missing");
		assert.equal(readBankFileChecked(paths, "core").kind, "directory");
		assert.equal(readBankFileChecked(paths, "../etc/passwd").kind, "outside", "\"..\" never resolves out of the bank");
		assert.equal(readBankFileChecked(paths, "/etc/passwd").kind, "outside");
		assert.equal(readBankFileChecked(paths, "core/../core/activeProjects.md").kind, "outside", "a path with a \"..\" segment is refused even when it lands back inside");
	} finally {
		paths.cleanup();
	}
});

test("a symlink inside the bank pointing outside it is refused, not followed", () => {
	const paths = scratch();
	const outside = mkdtempSync(join(tmpdir(), "outside-bank-"));
	try {
		mkdirSync(join(paths.root, "core"), { recursive: true });
		const secret = join(outside, "secret.md");
		writeFileSync(secret, "not in the bank", "utf8");
		symlinkSync(secret, join(paths.root, "core", "leak.md"));

		assert.equal(readBankFileChecked(paths, "core/leak.md").kind, "outside", "the text path is inside; the real target is not");

		mkdirSync(join(outside, "sneaky"), { recursive: true });
		symlinkSync(join(outside, "sneaky"), join(paths.root, "core", "dirlink"));
		const listing = listBankFiles(paths, "core");
		if (listing.kind !== "listed") throw new Error("expected a listing");
		assert.deepEqual(listing.listing.entries.map((entry) => entry.path), [], "the walk does not follow links out of the bank either");
	} finally {
		rmSync(outside, { recursive: true, force: true });
		paths.cleanup();
	}
});

test("the listing covers working state and archives, with sizes and dates", () => {
	const paths = scratch();
	try {
		seedBank(paths, {
			"knowledge/ui.md": UI,
			"core/activeProjects.md": PROJECTS,
			"history/daily/2026-10/2026-10-14-dailyContext.md": ARCHIVE,
		});
		const outcome = listBankFiles(paths);
		if (outcome.kind !== "listed") throw new Error("expected a listing");
		const listed = outcome.listing.entries.map((entry) => entry.path);

		assert.ok(listed.includes("core/"));
		assert.ok(listed.includes("history/"));
		assert.ok(listed.includes("core/activeProjects.md"));
		assert.ok(listed.includes("history/daily/2026-10/2026-10-14-dailyContext.md"));
		assert.ok(outcome.listing.entries.find((entry) => entry.path === "knowledge/ui.md")?.chars === UI.length);
		assert.equal(outcome.listing.truncated, false);
	} finally {
		paths.cleanup();
	}
});

test("the queue and half-written temp files are not listed, and a stopped walk says so", () => {
	const paths = scratch();
	try {
		seedBank(paths, {
			"knowledge/a.md": UI,
			"knowledge/b.md": UI,
			"knowledge/c.md": UI,
			".pending/deadbeef.json": "{}",
			"knowledge/a.md.tmp-123": "half written",
		});
		const all = listBankFiles(paths);
		if (all.kind !== "listed") throw new Error("expected a listing");
		const listed = all.listing.entries.map((entry) => entry.path);
		assert.equal(listed.some((p) => p.includes(".pending")), false, "the queue is reported by the doctor, not by a file listing");
		assert.ok(listed.includes("knowledge/a.md.tmp-123"), "a temp sibling is listed, not hidden: it means a write was interrupted");

		const narrow = listBankFiles(paths, "knowledge", { limit: 2 });
		if (narrow.kind !== "listed") throw new Error("expected a listing");
		assert.equal(narrow.listing.entries.length, 2);
		assert.equal(narrow.listing.truncated, true);
		assert.equal(narrow.listing.truncatedBecause, "limit");
	} finally {
		paths.cleanup();
	}
});

test("listing refuses a path outside the bank and a path that is not a directory", () => {
	const paths = scratch();
	try {
		seedBank(paths, { "knowledge/ui.md": UI });
		assert.equal(listBankFiles(paths, "..").kind, "outside");
		assert.equal(listBankFiles(paths, "/etc").kind, "outside");
		assert.equal(listBankFiles(paths, "knowledge/ui.md").kind, "not-a-directory");
		assert.equal(listBankFiles(paths, "nope").kind, "missing");
	} finally {
		paths.cleanup();
	}
});

test("the window options reach the checked read, not only the raw slice", () => {
	// A tool that clamps `maxChars` and then has it ignored is a tool that lies about
	// the size of what it returned.
	const paths = scratch();
	try {
		seedBank(paths, { "core/activeProjects.md": "0123456789abcdefghij" });
		const outcome = readBankFileChecked(paths, "core/activeProjects.md", { offset: 5, maxChars: 5 });
		assert.equal(outcome.kind, "read");
		if (outcome.kind !== "read") return;
		assert.equal(outcome.slice.text, "56789");
		assert.equal(outcome.slice.totalChars, 20);
		assert.equal(outcome.slice.truncated, true);
	} finally {
		paths.cleanup();
	}
});
