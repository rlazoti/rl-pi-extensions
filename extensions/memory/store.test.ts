import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	archiveFile,
	archiveText,
	backupBank,
	bankPaths,
	ensureBankDirs,
	findContested,
	inspectBank,
	moveToHistory,
	readClaims,
	removeClaim,
	storeFileFor,
	acquireLock,
	FileLocked,
	releaseLock,
	StoreUnreadable,
	upsertClaim,
	writeAtomic,
	writeJson,
	readJson,
	type ExecFn,
} from "./store.ts";
import { renderStore, type Claim } from "./grammar.ts";
import { parallelWriters } from "./test-support/writers.ts";

function scratch(): { dir: string; paths: ReturnType<typeof bankPaths>; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "memory-bank-"));
	const paths = bankPaths(dir);
	ensureBankDirs(paths);
	return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function claim(overrides: Partial<Claim> = {}): Claim {
	return {
		key: "git-standards.branch-naming",
		kind: "rule",
		scope: "global",
		asOf: "2026-05-02",
		source: "AGENTS.md §6",
		body: "Branches are named rl-<MM>-<DD>-<short_description>.",
		aliases: [],
		tags: ["git"],
		links: [],
		origin: "agent",
		state: "approved",
		...overrides,
	};
}

test("store: the bank layout is created and named", () => {
	const { paths, cleanup } = scratch();
	try {
		for (const dir of [paths.claims, paths.rules, paths.facts, paths.history, paths.daily, paths.dailyArchive, paths.archive, paths.migration, paths.metrics]) {
			assert.ok(existsSync(dir), dir);
		}
		assert.equal(paths.config, join(paths.root, "config.json"));
		assert.ok(!paths.backups.includes(paths.root), "backups live outside the bank they back up");
	} finally {
		cleanup();
	}
});

test("store: bankPaths honours PI_MEMORY_DIR and takes an explicit root for tests", () => {
	const previous = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = "/tmp/some-bank";
	try {
		assert.equal(bankPaths().root, "/tmp/some-bank");
		assert.equal(bankPaths("/tmp/other").root, "/tmp/other");
	} finally {
		if (previous === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = previous;
	}
});

test("store: a claim is written to a file named after its namespace, with a preamble", () => {
	const { paths, cleanup } = scratch();
	try {
		const written = upsertClaim(paths, claim());
		assert.equal(written.file, join(paths.rules, "git-standards.md"));
		assert.equal(written.replaced, false);
		const text = readFileSync(written.file, "utf8");
		assert.match(text, /^# rule claims about git-standards\n/);
		assert.match(text, /## git-standards\.branch-naming/);
		// What was written is what the reader sees, and re-writing it changes nothing.
		const parsed = readClaims(paths);
		assert.equal(parsed.claims.length, 1);
		assert.deepEqual(parsed.errors, []);
		const again = upsertClaim(paths, parsed.claims[0]!);
		assert.equal(readFileSync(again.file, "utf8"), text, "write → read → write is byte-stable (R6)");
	} finally {
		cleanup();
	}
});

test("store: facts and rules live apart, and two scopes of one key coexist", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "tests.runner", kind: "fact", scope: "global", body: "npm test runs everything." }));
		upsertClaim(paths, claim({ key: "tests.runner", kind: "fact", scope: "path:extensions/**", body: "npm test one file there." }));
		const parsed = readClaims(paths);
		assert.deepEqual(parsed.errors, []);
		assert.equal(parsed.claims.length, 2);
		assert.equal(readdirSync(paths.facts).join(","), "tests.md");
	} finally {
		cleanup();
	}
});

test("store: an occupied namespace slot takes the next free slot beside it", () => {
	const { paths, cleanup } = scratch();
	try {
		// A hand-made file squatting on the slot for "git" with another namespace.
		writeFileSync(join(paths.rules, "git.md"), `${renderStore("# hand written", [claim({ key: "git-cli.pull", body: "Someone else's claim." })])}`);
		const slot = storeFileFor(paths, claim({ key: "git-standards.branch-naming" }));
		assert.equal(slot.file, join(paths.rules, "git-standards.md"), "the name is derived from this claim's namespace, not the squatter's");
		const shared = storeFileFor(paths, claim({ key: "git-cli.push", body: "Another git-cli claim." }));
		assert.equal(shared.file, join(paths.rules, "git.md"), "same namespace: the existing file is the file");
		const third = storeFileFor(paths, claim({ key: "git.other-thing", body: "The git slot is held twice over." }));
		assert.equal(third.file, join(paths.rules, "git-2.md"));
		writeFileSync(join(paths.rules, "git-2.md"), renderStore("# other", [claim({ key: "notes.something", body: "Not a git claim." })]));
		const blocked = storeFileFor(paths, claim({ key: "git.another", body: "Wants the git slot." }));
		assert.equal(blocked.file, join(paths.rules, "git-3.md"), "the derived slot and the one beside it are held, so the next free slot takes it");
		assert.equal(blocked.slot, 3);
		const identity = storeFileFor(paths, claim({ key: "git.another", body: "Wants the git slot." }));
		assert.equal(identity.file, blocked.file, "an identity resolves to the file it is already in");
	} finally {
		cleanup();
	}
});

test("store: upsert replaces the claim with the same identity and nothing else", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "a.one", body: "first" }));
		upsertClaim(paths, claim({ key: "a.two", body: "second" }));
		const updated = upsertClaim(paths, claim({ key: "a.one", body: "first, revised", asOf: "2026-06-01" }));
		assert.equal(updated.replaced, true);
		const parsed = readClaims(paths);
		assert.deepEqual(parsed.claims.map((c) => c.body).sort(), ["first, revised", "second"]);
		assert.equal(parsed.claims.find((c) => c.key === "a.one")!.asOf, "2026-06-01");
	} finally {
		cleanup();
	}
});

test("store: removeClaim drops one identity and keeps the file", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "a.one", body: "first" }));
		upsertClaim(paths, claim({ key: "a.two", body: "second" }));
		assert.equal(removeClaim(paths, claim({ key: "a.one" })), true);
		assert.equal(removeClaim(paths, claim({ key: "a.missing" })), false);
		assert.deepEqual(readClaims(paths).claims.map((c) => c.key), ["a.two"]);
	} finally {
		cleanup();
	}
});

test("store: supersession moves the old claim to history word for word (R13)", () => {
	const { paths, cleanup } = scratch();
	try {
		const old = claim({ key: "git.flow", body: "Rebase onto master.", origin: "migration", proposedAt: "2026-01-01" });
		const file = moveToHistory(paths, old, { field: "supersededAt", day: "2026-10-16" });
		assert.equal(file, join(paths.history, "git.flow.md"));
		const text = readFileSync(file, "utf8");
		assert.match(text, /supersededAt: 2026-10-16/);
		assert.match(text, /origin: migration/);
		assert.match(text, /proposedAt: 2026-01-01/);
		assert.match(text, /Rebase onto master\./);
		// A second superseded claim on the same key does not overwrite the record.
		const second = moveToHistory(paths, claim({ key: "git.flow", body: "Merge instead." }), { field: "supersededAt", day: "2026-11-01" });
		assert.equal(second, join(paths.history, "git.flow-2.md"));
		// Identical bytes mean the record already exists.
		const same = moveToHistory(paths, old, { field: "supersededAt", day: "2026-10-16" });
		assert.equal(same, file);
	} finally {
		cleanup();
	}
});

test("store: a rejected pending claim is history, not deletion", () => {
	const { paths, cleanup } = scratch();
	try {
		const file = moveToHistory(paths, claim({ key: "a.b", state: "pending", proposedAt: "2026-10-01", body: "Not approved." }), { field: "rejectedAt", day: "2026-10-16" });
		const text = readFileSync(file, "utf8");
		assert.match(text, /rejectedAt: 2026-10-16/);
		assert.ok(!text.includes("state: pending"), "history records are not pending claims any more");
	} finally {
		cleanup();
	}
});

test("store: archiving never overwrites (R39)", () => {
	const { paths, cleanup } = scratch();
	try {
		const source = join(paths.root, "knowledge", "old.md");
		mkdirSync(join(paths.root, "knowledge"), { recursive: true });
		writeFileSync(source, "# old prose\n");
		const first = archiveFile(paths, source);
		assert.equal(first.file, join(paths.archive, "old.md"));
		assert.ok(!existsSync(source), "the source moves, it is not copied and left behind");
		writeFileSync(join(paths.root, "knowledge", "old.md"), "# second prose\n");
		const second = archiveFile(paths, join(paths.root, "knowledge", "old.md"));
		assert.equal(second.file, join(paths.archive, "old-2.md"));
		const text = archiveText(paths, "status text/2026 W42", "merged 2026-10-14 in #1284");
		assert.equal(text.file, join(paths.archive, "status-text-2026-W42.md"));
		const again = archiveText(paths, "status text/2026 W42", "different text");
		assert.equal(again.file, join(paths.archive, "status-text-2026-W42-2.md"));
	} finally {
		cleanup();
	}
});

test("store: atomic writes leave a named temp sibling if they die, and nothing else", () => {
	const { paths, cleanup } = scratch();
	try {
		const file = join(paths.rules, "atomic.md");
		writeAtomic(file, "# atomic\n");
		assert.equal(readFileSync(file, "utf8"), "# atomic\n");
		writeFileSync(`${file}.tmp-123`, "half a file");
		const snapshot = readClaims(paths);
		assert.deepEqual(snapshot.tempFiles, [join(paths.rules, "atomic.md.tmp-123")]);
		assert.deepEqual(snapshot.claims.map((c) => c.key), []);
		const health = inspectBank(snapshot, paths);
		assert.equal(health.tempFiles.length, 1);
	} finally {
		cleanup();
	}
});

test("store: an unreadable store is reported, and the rest of the bank still reads (R30)", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "a.one", body: "fine" }));
		const unreadable = join(paths.facts, "locked.md");
		writeFileSync(unreadable, "## a.locked\nkind: fact\nscope: global\nasOf: 2026-01-01\nsource: x\n\nBody.\n");
		chmodSync(unreadable, 0o000);
		symlinkSync(join(paths.facts, "nowhere.md"), join(paths.facts, "broken.md"));
		const snapshot = readClaims(paths);
		chmodSync(unreadable, 0o600);
		assert.equal(snapshot.unreadable.length, 1);
		assert.match(snapshot.unreadable[0]!.file, /locked\.md$/);
		assert.deepEqual(snapshot.outsideLinks.map((link) => link.reason), ["a symlink with nothing behind it"]);
		assert.deepEqual(snapshot.claims.map((c) => c.key), ["a.one"]);
	} finally {
		cleanup();
	}
});

test("store: a symlink out of the bank is skipped and named, never read as memory", () => {
	const { dir, paths, cleanup } = scratch();
	try {
		const outside = mkdtempSync(join(tmpdir(), "outside-bank-"));
		writeFileSync(join(outside, "secrets.md"), "## leak.one\nkind: fact\nscope: global\nasOf: 2026-01-01\nsource: elsewhere\n\nNot this bank's business.\n");
		symlinkSync(join(outside, "secrets.md"), join(paths.rules, "linked.md"));
		// A link that stays inside the bank is fine.
		writeFileSync(join(paths.rules, "real.md"), renderStore("# inside", [claim({ key: "a.one", body: "inside the bank" })]));
		symlinkSync(join(paths.rules, "real.md"), join(paths.rules, "alias.md"));
		const snapshot = readClaims(paths);
		assert.deepEqual(snapshot.claims.map((c) => c.key), ["a.one"], "the outside file is never read");
		assert.equal(snapshot.outsideLinks.length, 1);
		assert.match(snapshot.outsideLinks[0]!.reason, /symlink out of the bank/);
		assert.ok(snapshot.outsideLinks[0]!.file.endsWith("linked.md"));
		assert.ok(readClaims(paths).claims.length === 1, "repeated reads stay stable");
		void dir;
		void outside;
	} finally {
		cleanup();
	}
});

test("store: health counts claims, flags malformed entries and contested identities (R12)", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "a.one", kind: "rule", body: "first" }));
		upsertClaim(paths, claim({ key: "b.one", kind: "fact", body: "fact" }));
		upsertClaim(paths, claim({ key: "c.one", state: "pending", proposedAt: "2026-10-01", body: "waiting" }));
		// A hand edit puts a second approved claim on one identity.
		writeFileSync(join(paths.rules, "a-2.md"), renderStore("# hand edit", [claim({ key: "a.one", body: "rival" })]));
		writeFileSync(join(paths.rules, "broken.md"), "## a.bad\nkind: rule\nscope: global\n\nno fields\n");
		writeFileSync(join(paths.rules, "loose.md"), renderStore("# loose", [claim({ key: "d.one", scope: "path:**/*.ts", body: "unrooted" })]));
		const health = inspectBank(readClaims(paths), paths);
		assert.deepEqual(health.claims, { approved: 4, pending: 1, byKind: { rule: 4, fact: 1 } });
		assert.equal(health.malformed.length, 1);
		assert.match(health.malformed[0]!.message, /missing required field "asOf"/);
		assert.deepEqual(health.contested.map((c) => `${c.key}@${c.scope}`), ["a.one@global"]);
		assert.equal(health.contested[0]!.files.length, 2);
		assert.deepEqual(health.unrooted, ["d.one @ path:**/*.ts"]);
		assert.ok(health.historyFiles === 0 && health.archiveFiles === 0);
	} finally {
		cleanup();
	}
});

test("store: findContested ignores pending claims, which are allowed to wait beside an approved one (R11)", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "a.one", body: "approved" }));
		upsertClaim(paths, claim({ key: "a.one", body: "proposed", state: "pending", proposedAt: "2026-10-16", origin: "agent" }));
		assert.deepEqual(findContested(readClaims(paths).entries), []);
	} finally {
		cleanup();
	}
});

test("store: a backup is only real once it lists back (R37)", async () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim());
		const calls: string[][] = [];
		const fake: ExecFn = (command, args) => {
			assert.equal(command, "tar");
			calls.push(args);
			if (args[0] === "-czf") writeFileSync(args[1]!, "pretend bytes");
			return Promise.resolve({ code: 0, stdout: "./\n./claims/rules/git-standards.md\n", stderr: "" });
		};
		const backup = await backupBank(paths, { exec: fake, day: "2026-10-16", clock: () => new Date(2026, 9, 16, 9, 8, 7) });
		assert.match(backup.file, /memory-2026-10-16-09-08-07\.tar\.gz$/);
		assert.ok(backup.file.startsWith(paths.backups));
		assert.equal(backup.entries, 1);
		assert.deepEqual(calls.map((args) => args[0]), ["-czf", "-tzf"], "it writes, then lists the tarball back");
		assert.equal(calls[0]![1], backup.file);
		assert.equal(calls[0]![2], "-C");
		assert.equal(calls[0]![3], paths.root);
	} finally {
		cleanup();
	}
});

test("store: a backup that fails or lists nothing is refused", async () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim());
		await assert.rejects(
			backupBank(paths, { day: "2026-10-16", exec: () => Promise.resolve({ code: 2, stdout: "", stderr: "tar: cannot open" }) }),
			/backup failed: tar: cannot open/,
		);
		await assert.rejects(
			backupBank(paths, { day: "2026-10-16", exec: (_c, args) => { if (args[0] === "-czf") writeFileSync(args[1]!, "x"); return Promise.resolve({ code: 0, stdout: "./\n", stderr: "" }); } }),
			/contains no files/,
		);
		await assert.rejects(
			backupBank(paths, { day: "2026-10-16", exec: (_c, args) => {
				if (args[0] === "-czf") writeFileSync(args[1]!, "x");
				return Promise.resolve({ code: args[0] === "-tzf" ? 1 : 0, stdout: "", stderr: args[0] === "-tzf" ? "gzip: corrupt" : "" });
			} }),
			/could not be listed back: gzip: corrupt/,
		);
		await assert.rejects(backupBank(bankPaths(join(paths.root, "nope")), { day: "2026-10-16" }), /no memory bank to back up/);
	} finally {
		cleanup();
	}
});

test("store: json state files round-trip and a corrupt one reads as absent", () => {
	const { paths, cleanup } = scratch();
	try {
		const file = join(paths.migration, "state.json");
		writeJson(file, { step: "rules", done: ["a.md"] });
		assert.deepEqual(readJson<{ step: string; done: string[] }>(file), { step: "rules", done: ["a.md"] });
		writeFileSync(file, "{ not json");
		assert.equal(readJson(file), undefined);
		assert.ok(existsSync(`${file}`));
	} finally {
		cleanup();
	}
});

const UNREADABLE_STORE = `# rule claims about git

## git.flow
kind: rule
scope: global
asOf: 2026-01-01
source: probe

A healthy rule.

## git.broken
kind: opinion
scope: global
asOf: 2026-01-01
source: a typo in the field value

A rule the parser refused, which the docs say is reported and left alone.

## Notes — not a key
Just prose under a heading the grammar cannot read.
`;

test("store: a write refuses a file it cannot reproduce, and deletes nothing (P1)", () => {
	const { paths, cleanup } = scratch();
	try {
		const file = join(paths.rules, "git.md");
		writeFileSync(file, UNREADABLE_STORE);
		const before = readFileSync(file, "utf8");
		// The bug: proposing an unrelated claim rebuilt the file from the entries that
		// parsed, which silently deleted the two entries the parser had refused.
		assert.throws(
			() => upsertClaim(paths, claim({ key: "git.new", state: "pending" })),
			(error: unknown) => {
				assert.ok(error instanceof StoreUnreadable, `expected StoreUnreadable, got ${String(error)}`);
				assert.match(error.message, /git\.md:11: kind must be rule \| fact/);
				assert.match(error.message, /git\.md:19: ## Notes — not a key/);
				assert.match(error.message, /nothing was written/i);
				return true;
			},
		);
		assert.equal(readFileSync(file, "utf8"), before, "the file is byte-identical: nothing was deleted to get the write through");
	} finally {
		cleanup();
	}
});

test("store: removeClaim refuses the same file for the same reason (P1)", () => {
	const { paths, cleanup } = scratch();
	try {
		const file = join(paths.rules, "git.md");
		writeFileSync(file, UNREADABLE_STORE);
		assert.throws(() => removeClaim(paths, claim({ key: "git.flow" })), StoreUnreadable);
		assert.match(readFileSync(file, "utf8"), /git\.broken/);
	} finally {
		cleanup();
	}
});

test("store: a file the writer can reproduce still writes (P1)", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "git.flow" }));
		const before = readFileSync(join(paths.rules, "git.md"), "utf8");
		upsertClaim(paths, claim({ key: "git.other", state: "pending" }));
		assert.match(readFileSync(join(paths.rules, "git.md"), "utf8"), new RegExp(before.trim().replaceAll(".", "\\.").replace(/\n/g, "\\n")));
	} finally {
		cleanup();
	}
});

test("store: health names the lines that block a write (P1)", () => {
	const { paths, cleanup } = scratch();
	try {
		writeFileSync(join(paths.rules, "git.md"), UNREADABLE_STORE);
		const health = inspectBank(readClaims(paths), paths);
		assert.equal(health.malformed.length, 1, "one entry the grammar refused");
		assert.deepEqual(
			health.unwritable.map((problem) => problem.line).sort((a, b) => a - b),
			[11, 19],
		);
	} finally {
		cleanup();
	}
});

test("store: a live lock refuses the write and writes nothing (P2)", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "git.flow" }));
		const file = join(paths.rules, "git.md");
		const before = readFileSync(file, "utf8");
		const held = acquireLock(file);
		try {
			assert.throws(
				() => upsertClaim(paths, claim({ key: "git.other", state: "pending" })),
				(error: unknown) => {
					assert.ok(error instanceof FileLocked, `expected FileLocked, got ${String(error)}`);
					assert.match(error.message, new RegExp(`another memory write holds it \\(${String(process.pid)}`));
					assert.match(error.message, /Nothing was written/);
					return true;
				},
			);
			assert.equal(readFileSync(file, "utf8"), before);
		} finally {
			releaseLock(held);
		}
		// Released: the same write goes through.
		upsertClaim(paths, claim({ key: "git.other", state: "pending" }));
		assert.match(readFileSync(file, "utf8"), /## git\.other/);
	} finally {
		cleanup();
	}
});

test("store: a lock left by a dead writer is taken over, not waited on forever (P2)", () => {
	const { paths, cleanup } = scratch();
	try {
		upsertClaim(paths, claim({ key: "git.flow" }));
		const file = join(paths.rules, "git.md");
		const lock = `${file}.lock`;
		writeFileSync(lock, `${process.pid} long ago\n`);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		upsertClaim(paths, claim({ key: "git.other", state: "pending" }));
		assert.match(readFileSync(file, "utf8"), /## git\.other/, "a stale lock must not lock the bank forever");
		assert.ok(!existsSync(lock), "the taken-over lock is gone once the write finishes");
	} finally {
		cleanup();
	}
});

test("store: two processes writing one store keep both claims (P2)", async () => {
	const { dir, paths, cleanup } = scratch();
	try {
		// The real race: two Pi sessions, each read-modify-writing the same file.
		// Before the lock, whichever session wrote last replaced the other's claim.
		const results = await parallelWriters(dir, "store", ["alpha", "beta"]);
		assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join("\n"));
		const text = readFileSync(join(paths.rules, "git.md"), "utf8");
		for (let i = 0; i < 6; i++) {
			assert.match(text, new RegExp(`## git\\.alpha${i}`), `session alpha's claim ${i} survived`);
			assert.match(text, new RegExp(`## git\\.beta${i}`), `session beta's claim ${i} survived`);
		}
		assert.deepEqual(readdirSync(paths.rules).filter((name) => name.endsWith(".lock")), [], "no lock is left behind");
	} finally {
		cleanup();
	}
});
