import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import factory from "./index.ts";

const execFileAsync = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function fixture(t: TestContext) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-catchup-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
	const set = (path: string, data = "some text\n") => writeFileSync(join(cwd, path), data);
	const commit = (subject: string) => {
		git("add", "-A");
		git("commit", "--quiet", "--allow-empty", "-m", subject);
		return git("rev-parse", "HEAD").slice(0, 7);
	};
	git("init", "--quiet", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.test");
	return { cwd, git, set, commit };
}

const exec: ExtensionAPI["exec"] = async (command, args, options) => {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { ...options, env });
		return { stdout, stderr, code: 0, killed: false, truncated: false };
	} catch (error) {
		const err = error as { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
		if (typeof err.code !== "number") throw error;
		return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code, killed: err.killed ?? false, truncated: false };
	}
};

function entry(entries: SessionEntry[], value: Record<string, unknown>): void {
	entries.push({
		id: String(entries.length + 1),
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date(0).toISOString(),
		...value,
	} as SessionEntry);
}

function message(entries: SessionEntry[], value: Record<string, unknown>) {
	entry(entries, { type: "message", message: { timestamp: 0, ...value } });
}

function edit(entries: SessionEntry[], path: string, isError = false) {
	message(entries, {
		role: "assistant",
		content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path } }],
	});
	message(entries, { role: "toolResult", toolCallId: "edit-1", toolName: "edit", isError });
}

function session(cwd: string, options: {
	entries?: SessionEntry[];
	id?: string;
	exec?: ExtensionAPI["exec"];
	idle?: boolean;
	ephemeral?: boolean;
} = {}) {
	const { entries = [], id = "session-a", idle = true, ephemeral = false } = options;
	const notices: { text: string; type: string }[] = [];
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	factory({
		exec: options.exec ?? exec,
		registerCommand: (name, command) => {
			assert.equal(name, "catchup");
			handler = command.handler;
		},
		appendEntry: (customType, data) => { entry(entries, { type: "custom", customType, data }); },
	} as Pick<ExtensionAPI, "exec" | "registerCommand" | "appendEntry"> as ExtensionAPI);

	async function run(args = "") {
		assert.ok(handler);
		await handler(args, {
			cwd,
			isIdle: () => idle,
			sessionManager: {
				getSessionFile: () => ephemeral ? undefined : "/sessions/test.jsonl",
				getSessionId: () => id,
				getBranch: () => [...entries],
			},
			ui: { notify: (text: string, type: string) => notices.push({ text, type }) },
		} as unknown as ExtensionCommandContext);
		return notices.at(-1)!;
	}
	return { entries, run };
}

test("marks, resumes, prioritizes successful direct and codemode edits, and only advances on mark", async (t) => {
	const repo = fixture(t);
	for (const file of ["tax.ts", "invoice.ts", "failed.ts", "notes.md"]) repo.set(file, "base");
	const base = repo.commit("base");
	const first = session(repo.cwd);
	edit(first.entries, "tax.ts");
	edit(first.entries, "failed.ts", true);
	message(first.entries, {
		role: "toolResult", toolName: "codemode", isError: true,
		nestedCalls: { complete: true, calls: [
			{ id: "nested/1", name: "write", status: "ok", arguments: { path: join(repo.cwd, "invoice.ts") } },
			{ id: "nested/2", name: "write", status: "error", arguments: { path: "failed.ts" } },
			{ id: "nested/3", name: "write", status: "ok", argumentsBytes: 500_000 },
		] },
	});
	assert.match((await first.run()).text, new RegExp(`Checkpoint set on main at ${base}`));
	assert.equal(first.entries.at(-1)?.type, "custom");
	const saved = JSON.parse(JSON.stringify(first.entries)) as SessionEntry[];

	repo.set("tax.ts", "fixed");
	repo.set("invoice.ts", "fixed");
	const overlap = repo.commit("fix billing");
	repo.set("failed.ts", "changed by someone else");
	repo.set("notes.md", "notes");
	const unrelated = repo.commit("update notes");
	const resumed = session(repo.cwd, { entries: saved });
	const before = saved.length;
	const result = await resumed.run();
	assert.equal(result.type, "info");
	assert.match(result.text, /2 new commits on main/);
	assert.match(result.text, /1 overlapping commit in this scan \(checked 2 edited or currently changed paths\)/);
	assert.match(result.text, new RegExp(`${overlap}  fix billing — invoice\\.ts, tax\\.ts`));
	assert.ok(result.text.indexOf(overlap) < result.text.indexOf(unrelated), result.text);
	assert.doesNotMatch(result.text, /failed\.ts/);
	assert.deepEqual(await resumed.run(), result);
	assert.equal(saved.length, before);

	await resumed.run("mark");
	assert.equal(saved.length, before + 1);
	assert.match((await resumed.run()).text, new RegExp(`No new commits on main since ${unrelated}`));
});

test("overlap uses all current nonignored changes even from a subdirectory, without refreshing the index", async (t) => {
	const repo = fixture(t);
	repo.set(".gitignore", "ignored.txt\n");
	repo.set("staged");
	repo.set("unstaged");
	repo.set("gone");
	const subdir = join(repo.cwd, "src");
	mkdirSync(subdir);
	repo.set("src/nested.ts");
	repo.commit("base");
	const pi = session(subdir);
	edit(pi.entries, "@nested.ts");
	await pi.run("mark");

	// A mixed commit touches paths that are staged, unstaged, untracked, and ignored at check time.
	repo.set("staged", "incoming");
	repo.set("unstaged", "incoming");
	repo.set("src/nested.ts", "incoming");
	repo.set("gone", "incoming");
	repo.set("ignored.txt", "incoming");
	repo.git("add", "-f", "ignored.txt");
	repo.commit("incoming");
	repo.git("rm", "--quiet", "gone", "ignored.txt");
	repo.commit("remove obsolete files");
	repo.set("staged", "local staged");
	repo.git("add", "staged");
	repo.set("unstaged", "local unstaged");
	repo.set("gone", "local untracked");
	repo.set("ignored.txt", "local ignored");
	const index = join(repo.cwd, ".git", "index");
	const bytes = readFileSync(index);
	const mtime = statSync(index).mtimeMs;

	const result = await pi.run();
	assert.match(result.text, /checked 4 edited or currently changed paths/);
	assert.match(result.text, /remove obsolete files — gone/);
	assert.match(result.text, /incoming — gone, src\/nested\.ts, staged, \+1 more/);
	assert.doesNotMatch(result.text, /ignored\.txt/);
	assert.deepEqual(readFileSync(index), bytes);
	assert.equal(statSync(index).mtimeMs, mtime);
	assert.equal(readFileSync(join(repo.cwd, "unstaged"), "utf8"), "local unstaged");
});

test("reports path touches through merges, reverts, renames, and empty commits", async (t) => {
	const repo = fixture(t);
	const odd = "\nstrange\u001b.txt";
	repo.set(odd, "base");
	repo.commit("base");
	const pi = session(repo.cwd);
	edit(pi.entries, odd);
	await pi.run("mark");

	repo.git("switch", "--quiet", "-c", "parallel");
	repo.set(odd, "parallel");
	repo.commit("parallel edit");
	repo.git("switch", "--quiet", "main");
	repo.git("merge", "--quiet", "--no-ff", "-m", "land parallel", "parallel");
	repo.set(odd, "base");
	repo.commit("restore original content");
	repo.git("mv", "--", odd, "normal.txt");
	repo.commit("rename");
	repo.commit("empty");
	const result = await pi.run();
	assert.match(result.text, /4 new commits/);
	assert.match(result.text, /3 overlapping commits/);
	for (const subject of ["land parallel", "restore original content", "rename"]) {
		assert.ok(result.text.includes(subject + " — \\nstrange\\u{1b}.txt"), result.text);
	}
	assert.doesNotMatch(result.text, /parallel edit|\u001b/);
	assert.match(result.text, /  empty$/);
});

test("keeps a checkpoint on branch change, detached HEAD, or rewritten history", async (t) => {
	const repo = fixture(t);
	const initial = repo.commit("base");
	const base = repo.commit("old checkpoint");
	const pi = session(repo.cwd);
	await pi.run("mark");

	repo.git("switch", "--quiet", "-c", "other");
	assert.match((await pi.run()).text, /different checkout or branch/);
	assert.equal(pi.entries.length, 1);
	repo.git("switch", "--quiet", "--detach", "HEAD");
	assert.match((await pi.run("mark")).text, /HEAD is detached/);
	assert.equal(pi.entries.length, 1);

	repo.git("switch", "--quiet", "main");
	repo.git("reset", "--quiet", "--hard", initial);
	repo.commit("replacement");
	assert.match((await pi.run()).text, /not an ancestor/);
	assert.equal(pi.entries.length, 1);
	repo.git("reset", "--quiet", "--hard", base);
	assert.match((await pi.run()).text, /No new commits/);
});

test("forks ignore inherited checkpoints; another checkout cannot use the original one", async (t) => {
	const repo = fixture(t);
	repo.commit("base");
	const pi = session(repo.cwd);
	await pi.run();
	const other = fixture(t);
	other.commit("other");
	const moved = session(other.cwd, { entries: [...pi.entries] });
	assert.match((await moved.run()).text, /different checkout or branch/);
	assert.equal(moved.entries.length, 1);

	const fork = session(other.cwd, { id: "fork", entries: [...pi.entries] });
	assert.match((await fork.run()).text, /Checkpoint set on main/);
	assert.equal(fork.entries.length, 2);
});

test("usage and busy guards run no Git, and first mark describes memory-only persistence", async (t) => {
	const repo = fixture(t);
	const noGit: ExtensionAPI["exec"] = async () => assert.fail("must not run Git");
	const busy = session(repo.cwd, { exec: noGit, idle: false });
	assert.match((await busy.run("bogus")).text, /catchup mark/);
	assert.match((await busy.run()).text, /Wait for the session/);
	assert.equal(busy.entries.length, 0);

	const fresh = session(repo.cwd);
	assert.match((await fresh.run()).text, /no commits to checkpoint/);
	assert.equal(fresh.entries.length, 0);
	repo.commit("base");
	assert.match((await fresh.run()).text, /after the first conversation message/);
	const ephemeral = session(repo.cwd, { ephemeral: true });
	assert.match((await ephemeral.run()).text, /In-memory session only/);
});

test("a truncated Git result does not become a checkpoint or a misleading report", async (t) => {
	const repo = fixture(t);
	repo.commit("base");
	const pi = session(repo.cwd);
	await pi.run("mark");
	repo.commit("next");
	const capped = session(repo.cwd, {
		entries: pi.entries,
		exec: (command, args, options) => args.includes("log")
			? Promise.resolve({ stdout: "partial", stderr: "", code: 1, killed: true, truncated: true })
			: exec(command, args, options),
	});
	assert.deepEqual(await capped.run(), {
		text: "/catchup: Git log produced too much output; no result was reported.", type: "warning",
	});
	assert.equal(capped.entries.length, 1);
	assert.match((await pi.run()).text, /1 new commit/);
});

test("large histories state the scan and display bounds instead of implying full coverage", async (t) => {
	const repo = fixture(t);
	repo.set("overlap", "base");
	repo.commit("base");
	const pi = session(repo.cwd);
	edit(pi.entries, "overlap");
	await pi.run("mark");
	repo.set("overlap", "incoming");
	repo.commit("outside scan");
	const tree = repo.git("rev-parse", "HEAD^{tree}");
	let parent = repo.git("rev-parse", "HEAD");
	for (let n = 1; n <= 201; n++) parent = repo.git("commit-tree", tree, "-p", parent, "-m", `commit ${n}`);
	repo.git("update-ref", "refs/heads/main", parent);
	const { text } = await pi.run();
	assert.match(text, /At least 201 new commits \(checked newest 200\)/);
	assert.match(text, /0 overlapping commits in this scan/);
	assert.doesNotMatch(text, /outside scan/);
	assert.match(text, /192 more scanned commits not shown/);
});
