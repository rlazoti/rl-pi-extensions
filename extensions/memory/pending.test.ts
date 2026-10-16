import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseTopicFile } from "./schema.ts";
import { buildStore, type MemoryStore } from "./resolver.ts";
import { decide, type WriteRequest } from "./gate.ts";
import type { MemoryPaths } from "./fs-store.ts";
import { deleteConflict, listConflicts, loadConflict, renderConflict, saveConflict, type ConflictRefusal } from "./pending.ts";

function scratch(): MemoryPaths & { cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "memory-pending-"));
	const paths: MemoryPaths = { root, knowledge: join(root, "knowledge"), pending: join(root, ".pending"), extensionsDir: join(root, "extensions") };
	return { ...paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const UI = `# ui

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- source: design review
- status: active
Use dark grey for the UI background.
`;

const REQUEST: WriteRequest = {
	file: "knowledge/appearance.md",
	key: "ui.background",
	scope: "global",
	kind: "preference",
	body: "Charcoal, with the palette file kept as history.",
	asOf: "2026-11-01",
	revision: "2026-11-01",
	source: "user request",
	fields: { ticket: "MEM-14" },
};

function storeWith(...sources: Array<[string, string]>): MemoryStore {
	return buildStore(sources.map(([path, text]) => parseTopicFile(text, path)));
}

function refusal(store: MemoryStore): ConflictRefusal {
	const result = decide(store, REQUEST);
	if (result.kind !== "conflict") assert.fail(`expected a conflict, got ${result.kind}`);
	return result;
}

const BANK: () => MemoryStore = () => storeWith(["knowledge/ui.md", UI]);

// ─── The queue holds what the gate produced ─────────────────────────────────

test("a refusal round-trips through the queue without losing a field", () => {
	const paths = scratch();
	try {
		const saved = saveConflict(paths, refusal(BANK()), REQUEST, "2026-11-01T09:00:00.000Z");
		const { conflicts, corrupt } = listConflicts(paths);
		assert.deepEqual(corrupt, []);
		assert.equal(conflicts.length, 1);
		const loaded = conflicts[0]!;
		assert.equal(loaded.id, saved.id);
		assert.deepEqual(loaded.request, REQUEST, "the request must be re-submittable exactly as it was sent");
		assert.deepEqual(loaded.candidates.map((entry) => [entry.path, entry.heading, entry.asOf, entry.source]), [["knowledge/ui.md", "ui.background", "2026-10-02", "design review"]]);
		assert.equal(loaded.incoming.body, REQUEST.body);
		assert.equal(loaded.suggested, "supersede");
		assert.equal(loaded.createdAt, "2026-11-01T09:00:00.000Z");
	} finally {
		paths.cleanup();
	}
});

test("the stored request replays to the same conflictId — the queue cannot drift from the gate", () => {
	const paths = scratch();
	try {
		const original = refusal(BANK());
		saveConflict(paths, original, REQUEST);
		const stored = loadConflict(paths, original.conflictId)!;
		const replayed = refusal(BANK());
		assert.equal(stored.id, replayed.conflictId);

		// And the queued write is answerable straight from the record.
		const answered = decide(BANK(), { ...stored.request, resolve: "supersede", conflictId: stored.id });
		assert.equal(answered.kind, "plan");
	} finally {
		paths.cleanup();
	}
});

test("re-refusing the same contest updates one record instead of piling up", () => {
	const paths = scratch();
	try {
		const store = BANK();
		saveConflict(paths, refusal(store), REQUEST, "2026-11-01T09:00:00.000Z");
		saveConflict(paths, refusal(store), REQUEST, "2026-11-01T09:05:00.000Z");
		assert.deepEqual(readdirSync(paths.pending), [`${refusal(store).conflictId}.json`]);
		assert.equal(listConflicts(paths).conflicts[0]!.createdAt, "2026-11-01T09:05:00.000Z");
	} finally {
		paths.cleanup();
	}
});

// ─── Reading the queue must not crash on a bad queue ────────────────────────

test("no queue directory means no pending conflicts, not an error", () => {
	const paths = scratch();
	try {
		const empty = listConflicts(paths);
		assert.deepEqual(empty.conflicts, []);
		assert.deepEqual(empty.corrupt, []);
	} finally {
		paths.cleanup();
	}
});

test("a queue file nobody can read is reported, never guessed at", () => {
	const paths = scratch();
	try {
		mkdirSync(paths.pending, { recursive: true });
		writeFileSync(join(paths.pending, "aaaa1111.json"), "{ not json", "utf8");
		writeFileSync(join(paths.pending, "bbbb2222.json"), JSON.stringify({ version: 99, id: "bbbb2222" }), "utf8");
		writeFileSync(join(paths.pending, "cccc3333.json"), JSON.stringify({ version: 1, id: "cccc3333", request: { file: "knowledge/ui.md" }, candidates: [] }), "utf8");
		saveConflict(paths, refusal(BANK()), REQUEST, "2026-11-01T09:00:00.000Z");

		const { conflicts, corrupt } = listConflicts(paths);
		assert.equal(conflicts.length, 1, "the good record is still surfaced");
		assert.deepEqual(corrupt.map((problem) => problem.file), ["aaaa1111.json", "bbbb2222.json", "cccc3333.json"]);
		assert.match(corrupt[1]!.error, /unsupported pending version/);
		assert.match(corrupt[2]!.error, /missing key or file/);
	} finally {
		paths.cleanup();
	}
});

test("ids are ids: anything else is refused before it reaches the filesystem", () => {
	const paths = scratch();
	try {
		mkdirSync(paths.pending, { recursive: true });
		writeFileSync(join(paths.pending, "..", "outside.json"), "{}", "utf8");
		for (const id of ["../outside", "AAAA1111", "1234567", "123456789", ""]) {
			assert.equal(loadConflict(paths, id), null, `${id} loads nothing`);
			assert.equal(deleteConflict(paths, id), false, `${id} deletes nothing`);
		}
		assert.equal(deleteConflict(paths, "deadbeef"), false, "an absent but well-formed id is simply not there");
	} finally {
		paths.cleanup();
	}
});

test("the queue is a worklist: oldest first, stable underneath", () => {
	const paths = scratch();
	try {
		mkdirSync(paths.pending, { recursive: true });
		saveConflict(paths, refusal(BANK()), REQUEST, "2026-11-03T00:00:00.000Z");
		writeFileSync(join(paths.pending, "00000001.json"), JSON.stringify({ version: 1, id: "00000001", identity: "a", file: "knowledge/a.md", createdAt: "2026-11-01T00:00:00.000Z", request: { file: "knowledge/a.md", key: "a", body: "x" }, candidates: [], incoming: { heading: "a" }, suggested: "merge", explanation: "" }), "utf8");
		writeFileSync(join(paths.pending, "00000002.json"), JSON.stringify({ version: 1, id: "00000002", identity: "b", file: "knowledge/b.md", createdAt: "2026-11-02T00:00:00.000Z", request: { file: "knowledge/b.md", key: "b", body: "x" }, candidates: [], incoming: { heading: "b" }, suggested: "merge", explanation: "" }), "utf8");

		assert.deepEqual(listConflicts(paths).conflicts.map((conflict) => conflict.createdAt), ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z"]);
	} finally {
		paths.cleanup();
	}
});

test("resolving clears the queue", () => {
	const paths = scratch();
	try {
		const store = BANK();
		const original = refusal(store);
		saveConflict(paths, original, REQUEST);
		assert.equal(deleteConflict(paths, original.conflictId), true);
		const after = listConflicts(paths);
		assert.deepEqual(after.conflicts, []);
		assert.deepEqual(after.corrupt, []);
	} finally {
		paths.cleanup();
	}
});

// ─── What the human sees ────────────────────────────────────────────────────

test("the rendered conflict carries everything needed to decide", () => {
	const paths = scratch();
	try {
		const text = renderConflict(saveConflict(paths, refusal(BANK()), REQUEST, "2026-11-01T09:00:00.000Z"));
		assert.match(text, /^Conflict [0-9a-f]{8} — ui\.background in scope global$/m, "identities are rendered for a human, NUL separator and all");
		assert.match(text, /aimed at knowledge\/appearance\.md/);
		// The human deciding must see both claims and the reason, not just the options.
		assert.match(text, /Being written:\nui\.background@2026-11-01 · asOf 2026-11-01 · source: user request · in knowledge\/appearance\.md:\n {2}Charcoal, with the palette file kept as history\./);
		assert.match(text, /In the bank now:\nui\.background · asOf 2026-10-02 · source: design review · in knowledge\/ui\.md:\n {2}Use dark grey for the UI background\./);
		assert.match(text, /Why this is refused:\n {2}.*competes with/s);
		assert.match(text, /Suggested: supersede/);
		assert.match(text, /Re-invoke with resolve:/);
		assert.equal(readFileSync(join(paths.pending, readdirSync(paths.pending)[0]!), "utf8").includes("\"ticket\": \"MEM-14\""), true, "custom fields survive in the stored request");
	} finally {
		paths.cleanup();
	}
});
