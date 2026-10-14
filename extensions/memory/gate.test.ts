import assert from "node:assert/strict";
import test from "node:test";
import { parseTopicFile, type TopicFile } from "./schema.ts";
import { buildStore, resolveKey, type MemoryStore } from "./resolver.ts";
import { conflictIdFor, decide, RESOLUTIONS, type EditPlan, type WriteRequest } from "./gate.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const UI = `# ui

## ui.background
- kind: preference
- scope: global
- asOf: 2026-10-02
- status: active
Dark grey.
`;

const APPEARANCE = `# appearance

## ui.background
- kind: preference
- scope: global
- asOf: 2026-06-14
- status: active
Navy.
`;

function storeOf(files: Record<string, string>): MemoryStore {
	return buildStore(Object.entries(files).map(([path, text]) => parseTopicFile(text, path)));
}

/**
 * The default request is a *rival* claim: same key and scope as the entry in UI,
 * but a different revision, so its heading differs. Writing the same heading
 * would be an amend, and amends are not gated — see the amend tests.
 */
function request(overrides: Partial<WriteRequest> = {}): WriteRequest {
	return {
		file: "knowledge/ui.md",
		key: "ui.background",
		scope: "global",
		kind: "preference",
		body: "Charcoal.",
		asOf: "2026-11-01",
		revision: "2026-11-01",
		...overrides,
	};
}

/** Apply a plan in memory and re-parse, so every test checks real round-trip state. */
function applied(store: MemoryStore, plan: EditPlan): MemoryStore {
	const touched = new Set(plan.files.map((file) => file.path));
	const files: TopicFile[] = plan.files.map((file) => parseTopicFile(file.content, file.path));
	for (const [path, file] of store.byPath) if (!touched.has(path)) files.push(file);
	return buildStore(files);
}

function entryHeading(store: MemoryStore, heading: string) {
	return store.entries.find((entry) => entry.heading === heading);
}

// ─── Uncontested writes go straight through ─────────────────────────────────

test("an uncontested new entry is added to an existing topic file", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, request({ key: "ui.foreground", body: "Off-white." }));

	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.equal(result.plan.files.length, 1);
	assert.deepEqual(result.plan.files[0]!.changes, [{ change: "added-entry", heading: "ui.foreground@2026-11-01" }]);

	const after = applied(store, result.plan);
	assert.equal(after.entries.length, 2);
	assert.equal(entryHeading(after, "ui.foreground@2026-11-01")?.body, "Off-white.");
	assert.equal(entryHeading(after, "ui.background")?.body, "Dark grey.", "the existing entry is untouched");
});

test("a missing topic file is created with a title derived from its path", () => {
	const store = storeOf({});
	const result = decide(store, request({ file: "knowledge/appearance.md" }));

	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.deepEqual(result.plan.files[0]!.changes, [{ change: "created-file", heading: "ui.background@2026-11-01" }]);

	const after = applied(store, result.plan);
	const file = after.byPath.get("knowledge/appearance.md")!;
	assert.equal(file.title, "appearance");
	assert.deepEqual(file.issues, []);
});

test("writing a tombstone directly is not treated as a rival claim", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, request({ revision: "2025-01-01", asOf: "2025-01-01", status: "superseded", body: "Black." }));
	assert.equal(result.kind, "plan", "a tombstone asserts nothing, so it cannot contest a live claim");
});

// ─── The gate: rival claims are refused, in every direction ─────────────────

test("a rival claim in the same file is refused and nothing is written", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, request());

	assert.equal(result.kind, "conflict");
	if (result.kind !== "conflict") return;
	assert.match(result.explanation, /Nothing was written/);
	assert.equal(result.candidates.length, 1);
	assert.equal(result.candidates[0]!.body, "Dark grey.");
	assert.equal(result.suggested, "supersede", "the incoming claim is the newest dated");
	assert.match(result.conflictId, /^[0-9a-f]{8}$/);
	assert.equal("plan" in result, false, "a refusal carries no plan at all");
});

test("a rival claim in a DIFFERENT file is refused — the original three-file bug", () => {
	const store = storeOf({ "knowledge/ui.md": UI, "knowledge/appearance.md": APPEARANCE });
	const result = decide(store, request({ file: "knowledge/settings.md" }));

	assert.equal(result.kind, "conflict");
	if (result.kind !== "conflict") return;
	assert.deepEqual(
		result.candidates.map((entry) => entry.path).sort(),
		["knowledge/appearance.md", "knowledge/ui.md"],
	);
	assert.equal(result.suggested, "supersede");
});

test("an older incoming claim is not offered supersede", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, request({ asOf: "2025-01-01" }));
	assert.equal(result.kind === "conflict" ? result.suggested : "none", "merge");
});

test("resolution requires the conflictId of the state the caller was shown", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const refused = decide(store, request());
	assert.equal(refused.kind, "conflict");
	if (refused.kind !== "conflict") return;

	const forgotId = decide(store, { ...request(), resolve: "supersede" });
	assert.equal(forgotId.kind, "reject");
	assert.equal(forgotId.kind === "reject" ? forgotId.reason : "", "stale-conflict");

	const amendedFirst = decide(store, request({ revision: undefined, body: "Slate.", asOf: "2026-10-02" }));
	assert.equal(amendedFirst.kind, "plan");
	if (amendedFirst.kind !== "plan") return;
	const movedOn = decide(applied(store, amendedFirst.plan), { ...request(), resolve: "supersede", conflictId: refused.conflictId });
	assert.equal(movedOn.kind, "reject");
	assert.equal(movedOn.kind === "reject" ? movedOn.reason : "", "stale-conflict", "the store moved on; the old resolution is not applied");
});

test("an unknown resolution is rejected", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, { ...request(), resolve: "vibes" as never });
	assert.equal(result.kind, "reject");
	assert.equal(result.kind === "reject" ? result.reason : "", "bad-resolution");
	assert.match(result.kind === "reject" ? result.explanation : "", new RegExp(RESOLUTIONS.join("|")));
});

test("conflictId is stable for the same contest and changes when either side changes", () => {
	const store = storeOf({ "knowledge/ui.md": UI, "knowledge/appearance.md": APPEARANCE });
	const a = decide(store, request({ file: "knowledge/settings.md" }));
	const b = decide(store, request({ file: "knowledge/settings.md" }));
	const c = decide(store, request({ file: "knowledge/settings.md", body: "Different ask." }));
	assert.equal(a.kind === "conflict" ? a.conflictId : "", b.kind === "conflict" ? b.conflictId : "");
	assert.notEqual(a.kind === "conflict" ? a.conflictId : "", c.kind === "conflict" ? c.conflictId : "");

	const refused = decide(store, request({ file: "knowledge/settings.md" }));
	const other = decide(store, request({ file: "knowledge/settings.md", body: "Different ask." }));
	if (refused.kind !== "conflict" || other.kind !== "conflict") assert.fail("both should conflict");
	assert.notEqual(conflictIdFor(refused.identity, refused.candidates, refused.incoming), conflictIdFor(other.identity, other.candidates, other.incoming));
});

// ─── Applying an accepted resolution ────────────────────────────────────────

test("supersede rewrites every file holding a rival, and leaves exactly one authority", () => {
	const store = storeOf({ "knowledge/ui.md": UI, "knowledge/appearance.md": APPEARANCE });
	const refused = decide(store, request({ file: "knowledge/settings.md" }));
	assert.equal(refused.kind, "conflict");
	if (refused.kind !== "conflict") return;

	const accepted = decide(store, { ...request(), file: "knowledge/settings.md", resolve: "supersede", conflictId: refused.conflictId, note: "user picked charcoal" });
	assert.equal(accepted.kind, "plan");
	if (accepted.kind !== "plan") return;

	assert.deepEqual(accepted.plan.files.map((file) => file.path).sort(), ["knowledge/appearance.md", "knowledge/settings.md", "knowledge/ui.md"]);

	const after = applied(store, accepted.plan);
	assert.equal(resolveKey(after, "ui.background", {})?.winner?.body, "Charcoal.", "one authority for the key");
	assert.deepEqual(after.violations, [], "no duplicate-identity left behind");

	for (const heading of ["ui.background"]) {
		const uiEntry = after.byPath.get("knowledge/ui.md")!.entries.find((entry) => entry.heading === heading)!;
		assert.equal(uiEntry.status, "superseded");
		assert.equal(uiEntry.supersededBy, "knowledge/settings.md#ui.background@2026-11-01");
	}
	const created = after.byPath.get("knowledge/settings.md")!.entries[0]!;
	assert.equal(created.supersedes, "knowledge/appearance.md#ui.background, knowledge/ui.md#ui.background", "references are qualified by file, because two topic files may hold the same heading");
	assert.match(created.fields.resolution ?? "", /^supersede — user picked charcoal$/);
	assert.equal(created.source, undefined, "a note does not overwrite the claim's own provenance");
});

test("keep-both-flagged writes the rival and the identity goes dark until it is resolved", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const refused = decide(store, request());
	if (refused.kind !== "conflict") assert.fail("expected a conflict");

	const accepted = decide(store, { ...request(), resolve: "keep-both-flagged", conflictId: refused.conflictId });
	assert.equal(accepted.kind, "plan");
	if (accepted.kind !== "plan") return;
	assert.match(accepted.plan.warnings.join(" "), /contested/);

	const after = applied(store, accepted.plan);
	assert.ok(after.violations.some((violation) => violation.code === "duplicate-identity"));
	assert.equal(resolveKey(after, "ui.background", {}), null, "the read path fails closed rather than guessing");
});

test("withdraw removes the claims and asserts nothing new", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const refused = decide(store, request());
	if (refused.kind !== "conflict") assert.fail("expected a conflict");

	const accepted = decide(store, { ...request(), resolve: "withdraw", conflictId: refused.conflictId });
	assert.equal(accepted.kind, "plan");
	if (accepted.kind !== "plan") return;

	const after = applied(store, accepted.plan);
	assert.equal(after.entries.length, 1, "no new entry was written");
	assert.equal(after.entries[0]!.status, "withdrawn");
	assert.equal(resolveKey(after, "ui.background", {}), null);
	assert.deepEqual(after.violations, [], "a withdrawn claim is not a duplicate");
});

test("merge needs the merged text, then replaces both claims with one", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const refused = decide(store, request());
	if (refused.kind !== "conflict") assert.fail("expected a conflict");

	const noBody = decide(store, { ...request(), resolve: "merge", conflictId: refused.conflictId });
	assert.equal(noBody.kind, "reject");
	assert.equal(noBody.kind === "reject" ? noBody.reason : "", "missing-merged-body");

	const merged = decide(store, {
		...request(),
		resolve: "merge",
		conflictId: refused.conflictId,
		mergedBody: "Dark grey by default; navy only for the finance module.",
	});
	assert.equal(merged.kind, "plan");
	if (merged.kind !== "plan") return;

	const after = applied(store, merged.plan);
	assert.equal(after.entries.length, 2, "one authority plus one tombstone");
	assert.equal(resolveKey(after, "ui.background", {})?.winner?.body, "Dark grey by default; navy only for the finance module.");
});

test("discard writes nothing and says what remains", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const refused = decide(store, request());
	if (refused.kind !== "conflict") assert.fail("expected a conflict");

	const result = decide(store, { ...request(), resolve: "discard", conflictId: refused.conflictId });
	assert.equal(result.kind, "discarded");
	assert.match(result.kind === "discarded" ? result.explanation : "", /remains the authority/);
});

// ─── Ordinary authoring is not gated ────────────────────────────────────────

test("amending an entry by name is authoring, not a rival claim", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, request({ revision: undefined, asOf: "2026-10-09", body: "Dark grey (confirmed).", source: "PR review" }));

	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.deepEqual(result.plan.files[0]!.changes, [{ change: "amended-entry", heading: "ui.background" }]);

	const after = applied(store, result.plan);
	assert.equal(after.entries.length, 1, "an amend replaces in place");
	assert.equal(after.entries[0]!.body, "Dark grey (confirmed).");
	assert.equal(after.entries[0]!.asOf, "2026-10-09");
	assert.equal(after.entries[0]!.fields.amendedFrom, "2026-10-02", "the date it replaced stays visible");
});

test("an amend with no text change reports unchanged", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, request({ revision: undefined, asOf: "2026-10-02", body: "Dark  grey.", source: "PR review" }));
	assert.equal(result.kind, "unchanged");
});

test("an amend that moves asOf backwards is allowed and warns", () => {
	const store = storeOf({ "knowledge/ui.md": UI });
	const result = decide(store, request({ revision: undefined, asOf: "2026-01-01", body: "Dark grey, corrected date." }));
	assert.equal(result.kind, "plan");
	if (result.kind !== "plan") return;
	assert.match(result.plan.warnings.join(" "), /backwards/);
});

// ─── Refusals that are the writer's fault, not a conflict ───────────────────

test("asOf is required: the gate never invents a date", () => {
	const store = storeOf({});
	const result = decide(store, { ...request(), asOf: undefined });
	assert.equal(result.kind, "reject");
	assert.equal(result.kind === "reject" ? result.reason : "", "missing-asOf");
});

test("a malformed incoming entry is refused rather than defaulted", () => {
	const cases: Array<[Partial<WriteRequest>, string]> = [
		[{ scope: "host:work" }, "bad-scope"],
		[{ key: "UI Background" }, "bad-key"],
		[{ status: "current" }, "bad-status"],
		[{ asOf: "last tuesday" }, "bad-asOf"],
	];
	for (const [overrides, code] of cases) {
		const result = decide(storeOf({}), request(overrides));
		assert.equal(result.kind, "reject", `${JSON.stringify(overrides)} → reject`);
		assert.equal(result.kind === "reject" ? result.reason : "", "invalid-entry");
		assert.ok(result.kind === "reject" ? result.issues.some((issue) => issue.code === code) : false, `${code} reported`);
	}
});

test("only entry stores may be written through the gate", () => {
	const files = ["core/dailyContext.md", "../escape.md", "/abs/ui.md", "knowledge/UI.md", "notes/ui.md", "knowledge/ui.txt", "knowledge/a/b/ui.md"];
	for (const file of files) {
		const result = decide(storeOf({}), request({ file }));
		assert.equal(result.kind, "reject", `${file} is refused`);
		assert.equal(result.kind === "reject" ? result.reason : "", "bad-file-path", `${file} → bad-file-path`);
	}
	const ok = decide(storeOf({}), request({ file: "knowledge/ui.md" }));
	assert.equal(ok.kind, "plan");
});

// ─── Integration: what the gate accepts, the resolver can arbitrate ─────────

test("the gate and the resolver agree: an accepted rival never survives to the read path", () => {
	const store = storeOf({ "knowledge/ui.md": UI, "knowledge/appearance.md": APPEARANCE, "knowledge/palette.md": APPEARANCE });
	assert.equal(resolveKey(store, "ui.background", {}), null, "three live claims: the read path is already dark");
	assert.equal(store.violations.filter((violation) => violation.code === "duplicate-identity").length, 3);

	const refused = decide(store, request({ file: "knowledge/settings.md" }));
	if (refused.kind !== "conflict") assert.fail("expected a conflict");
	const accepted = decide(store, { ...request({ file: "knowledge/settings.md" }), resolve: "supersede", conflictId: refused.conflictId });
	if (accepted.kind !== "plan") assert.fail("expected a plan");

	const after = applied(store, accepted.plan);
	const winner = resolveKey(after, "ui.background", {})!;
	assert.equal(winner.winner?.body, "Charcoal.");
	assert.equal(after.entries.filter((entry) => entry.status === "active").length, 1);
	assert.deepEqual(after.violations, [], "three rivals in three files, and nothing left to arbitrate");
});
