import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approve, defer, describePending, editPending, listPending, propose, queueCounts, reject } from "./queue.ts";
import { bankPaths, ensureBankDirs, readClaims, upsertClaim, markdownFiles } from "./store.ts";
import { parseStore, renderStore, type Claim } from "./grammar.ts";

function scratch(): { paths: ReturnType<typeof bankPaths>; cleanup: () => void } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "memory-queue-")));
	const paths = bankPaths(dir);
	ensureBankDirs(paths);
	return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function claim(overrides: Partial<Claim> = {}): Claim {
	return {
		key: "git.flow",
		kind: "rule",
		scope: "global",
		asOf: "2026-10-16",
		source: "Rodrigo, in session",
		body: "Merge with --no-ff and a squashed feature branch.",
		aliases: [],
		tags: ["git"],
		links: [],
		origin: "agent",
		state: "pending",
		...overrides,
	};
}

const FLAGS = { pendingFlagDays: 14 };

test("queue: a proposal is stored pending and never touches the approved claim (R17)", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ state: "approved", body: "Rebase onto master.", asOf: "2025-01-01" }));
		const result = propose(paths, claim(), "2026-10-16");
		assert.equal(result.file, join(paths.rules, "git.md"));
		assert.equal(result.against?.body, "Rebase onto master.");
		const snapshot = readClaims(paths);
		const approved = snapshot.claims.filter((entry) => entry.state === "approved");
		const pending = snapshot.claims.filter((entry) => entry.state === "pending");
		assert.equal(approved.length, 1);
		assert.equal(approved[0]!.body, "Rebase onto master.", "the approved claim still says what it said");
		assert.equal(pending.length, 1);
		assert.equal(pending[0]!.proposedAt, "2026-10-16", "the proposal date is stamped, not invented by the agent");
	} finally {
		cleanup();
	}
});

test("queue: one identity holds at most one pending claim, and the replaced draft survives in history (R11)", () => {
	const { paths, cleanup } = scratch();
	try {
		propose(paths, claim({ body: "first draft" }), "2026-10-16");
		const second = propose(paths, claim({ body: "second draft" }), "2026-10-17");
		assert.ok(second.replacedDraft);
		const snapshot = readClaims(paths);
		assert.deepEqual(snapshot.claims.filter((entry) => entry.state === "pending").map((entry) => entry.body), ["second draft"]);
		const history = readFileSync(second.replacedDraft!.file, "utf8");
		assert.match(history, /first draft/);
		assert.match(history, /rejectedAt: 2026-10-17/);
		assert.deepEqual(snapshot.entries.filter((entry) => entry.claim.state === "approved"), []);
	} finally {
		cleanup();
	}
});

test("queue: proposals for different scopes are different identities", () => {
	const { paths, cleanup } = scratch();
	try {
		propose(paths, claim({ scope: "global" }), "2026-10-16");
		propose(paths, claim({ scope: "path:extensions/**" }), "2026-10-16");
		assert.equal(listPending(readClaims(paths), { today: "2026-10-16", ...FLAGS }).length, 2);
	} finally {
		cleanup();
	}
});

test("queue: approval moves the old claim to history word for word (R13)", () => {
	const { paths, cleanup } = scratch();
	try {
		const old = claim({ state: "approved", body: "Rebase onto master.", asOf: "2025-01-01", source: "AGENTS.md §6", origin: "migration", tags: [] });
		upsertClaim(paths, old);
		propose(paths, claim(), "2026-10-16");
		const outcome = approve(paths, "git.flow", "global", "2026-10-17");
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.ok(outcome.historyFile);
		const archived = readFileSync(outcome.historyFile, "utf8");
		// Word for word: the stored history entry is the old claim plus one date.
		const parsed = parseStore(archived, outcome.historyFile);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.entries.length, 1);
		assert.deepEqual(parsed.entries[0]!.claim, { ...old, supersededAt: "2026-10-17" });
		assert.match(archived, /supersededAt: 2026-10-17/);
		assert.match(archived, /Rebase onto master\./);
		const snapshot = readClaims(paths);
		assert.deepEqual(snapshot.claims.map((entry) => `${entry.state}:${entry.body}`), ["approved:Merge with --no-ff and a squashed feature branch."]);
		assert.equal(listPending(readClaims(paths), { today: "2026-10-17", ...FLAGS }).length, 0);
	} finally {
		cleanup();
	}
});

test("queue: approving a claim for a new identity creates it without a history record", () => {
	const { paths, cleanup } = scratch();
	try {
		propose(paths, claim({ key: "tests.gate", body: "npm test and npm run typecheck both gate a commit." }), "2026-10-16");
		const outcome = approve(paths, "tests.gate", "global", "2026-10-16");
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.equal(outcome.historyFile, undefined);
		assert.deepEqual(markdownFiles(paths.history, paths.root), []);
	} finally {
		cleanup();
	}
});

test("queue: a rejection is a record, not a deletion (R21)", () => {
	const { paths, cleanup } = scratch();
	try {
		const proposal = claim({ body: "Always squash." });
		propose(paths, proposal, "2026-10-16");
		const outcome = reject(paths, "git.flow", "global", "2026-10-16");
		assert.equal(outcome.ok, true);
		if (!outcome.ok) return;
		assert.deepEqual(readClaims(paths).claims, []);
		const archived = readFileSync(outcome.historyFile!, "utf8");
		assert.match(archived, /rejectedAt: 2026-10-16/);
		assert.match(archived, /Always squash\./);
	} finally {
		cleanup();
	}
});

test("queue: defer keeps the wait and says so; edit rewords without approving", () => {
	const { paths, cleanup } = scratch();
	try {
		propose(paths, claim({ body: "Merge with --no-ff." }), "2026-10-16");
		defer(paths, "git.flow", "global", "2026-10-20");
		let pending = listPending(readClaims(paths), { today: "2026-10-20", ...FLAGS });
		assert.equal(pending.length, 1);
		assert.equal(pending[0]!.claim.deferredAt, "2026-10-20");

		const edited = editPending(paths, "git.flow", "global", { body: "Merge with  --no-ff,  squash first.", tags: ["git", "always"] });
		assert.equal(edited.ok, true);
		if (!edited.ok) return;
		pending = listPending(readClaims(paths), { today: "2026-10-21", ...FLAGS });
		assert.equal(pending[0]!.claim.state, "pending", "an edit is still a proposal");
		assert.equal(pending[0]!.claim.body, "Merge with --no-ff, squash first.");
		assert.deepEqual(pending[0]!.claim.tags, ["git", "always"]);
		assert.equal(editPending(paths, "git.flow", "global", { body: "   " }).ok, false);
	} finally {
		cleanup();
	}
});

test("queue: an unknown key is reported instead of silently doing nothing", () => {
	const { paths, cleanup } = scratch();
	try {
		for (const action of [approve, reject, defer]) {
			const outcome = action(paths, "no.such.key", "", "2026-10-16");
			assert.equal(outcome.ok, false);
			if (outcome.ok) continue;
			assert.match(outcome.problem, /no pending claim for "no\.such\.key"/);
		}
	} finally {
		cleanup();
	}
});

test("queue: an old pending claim is flagged, kept, and listed by age (R20, R21)", () => {
	const { paths, cleanup } = scratch();
	try {
		propose(paths, claim({ key: "a.old", body: "Waiting since June." }), "2026-06-01");
		propose(paths, claim({ key: "a.fresh", body: "Waiting since yesterday." }), "2026-10-15");
		const pending = listPending(readClaims(paths), { today: "2026-10-16", ...FLAGS });
		assert.deepEqual(pending.map((entry) => entry.claim.key), ["a.old", "a.fresh"]);
		assert.equal(pending[0]!.ageDays, 137);
		assert.equal(pending[0]!.flagged, true);
		assert.equal(pending[1]!.flagged, false);
		// Ten years on, it is still there.
		const later = listPending(readClaims(paths), { today: "2036-10-16", ...FLAGS });
		assert.equal(later.length, 2);
		assert.ok(later.every((entry) => entry.flagged));
	} finally {
		cleanup();
	}
});

test("queue: a hand-written pending claim dates from asOf, and that is said out loud", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ state: "pending", proposedAt: undefined, asOf: "2026-10-10" }));
		const pending = listPending(readClaims(paths), { today: "2026-10-16", ...FLAGS });
		assert.equal(pending[0]!.dateSource, "asOf");
		assert.equal(pending[0]!.ageDays, 6);
		assert.equal(describePending(pending[0]!, "2026-10-16").some((line) => /age is coarse/.test(line)), true);
	} finally {
		cleanup();
	}
});

test("queue: the notice counts new proposals, migration backlog and contests separately (R20, D9)", () => {
	const { paths, cleanup } = scratch();
	try {
		propose(paths, claim({ key: "a.new", origin: "agent" }), "2026-10-16");
		propose(paths, claim({ key: "a.old", origin: "agent" }), "2026-06-01");
		propose(paths, claim({ key: "m.one", origin: "migration" }), "2026-10-14");
		propose(paths, claim({ key: "m.two", origin: "migration" }), "2026-10-15");
		// Two hand-written approved claims on one identity: contested.
		writeContest(paths);
		const counts = queueCounts(readClaims(paths), { today: "2026-10-16", ...FLAGS });
		assert.deepEqual(
			{ agentProposals: counts.agentProposals, migrationBacklog: counts.migrationBacklog, contested: counts.contested.map((c) => c.key), flagged: counts.flagged.map((e) => e.claim.key), total: counts.total },
			{ agentProposals: 2, migrationBacklog: 2, contested: ["z.contest"], flagged: ["a.old"], total: 4 },
		);
	} finally {
		cleanup();
	}
});

function writeContest(paths: ReturnType<typeof bankPaths>): void {
	// The hand edit a human makes by accident: two approved entries with the same
	// key and scope in one file.
	writeFileSync(join(paths.rules, "z.md"), renderStore("# hand edit", [claim({ key: "z.contest", state: "approved", body: "first" }), claim({ key: "z.contest", state: "approved", body: "second" })]));
}

test("queue: describePending shows the claim next to what it replaces", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ state: "approved", body: "Rebase onto master.", asOf: "2025-01-01", source: "AGENTS.md §6" }));
		propose(paths, claim({ statusOverride: "the sha is an example" }), "2026-10-16");
		const [entry] = listPending(readClaims(paths), { today: "2026-10-16", ...FLAGS });
		const lines = describePending(entry!, "2026-10-16");
		assert.match(lines[0]!, /^git\.flow @ global — rule, agent, waiting today/);
		assert.ok(lines.some((line) => line.includes("replaces: Rebase onto master.")));
		assert.ok(lines.some((line) => line.includes("as of 2025-01-01, from AGENTS.md §6")));
		assert.ok(lines.some((line) => line.includes("status-check overridden: the sha is an example")));
		assert.ok(lines.some((line) => line.includes("tags: git")));
	} finally {
		cleanup();
	}
});
