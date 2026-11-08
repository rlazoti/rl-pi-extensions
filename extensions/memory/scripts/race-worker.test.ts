/**
 * Concurrency probe worker — one Pi session, one scenario, driven by env vars.
 *
 * NOT part of the test suite: vitest's include is `*.test.ts` at the repo root,
 * and this file lives in scripts/. Run it through `npm run race`, which starts
 * two of these at once and measures the result from disk. Nothing here asserts,
 * because "who won a race" is not a fact a single process can report reliably —
 * the orchestrator reads the bank afterwards.
 *
 * Env: RACE_BANK (required), RACE_SCENARIO, RACE_ROLE (a|b), RACE_N, RACE_GAP,
 * RACE_BYTES.
 */
import { it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireBankLock } from "../locks.js";

const BANK = process.env.RACE_BANK!;
const SCENARIO = process.env.RACE_SCENARIO ?? "append";
const ROLE = (process.env.RACE_ROLE ?? "a") as "a" | "b";
const N = Number(process.env.RACE_N ?? 20);
const GAP = Number(process.env.RACE_GAP ?? 120);
// A file the size of a real dailyContext.md. Larger is not stricter: a bigger
// write takes longer *and* the loop runs slower, so 200 KB showed 0 torn reads
// while 5 KB showed 5-12 per 300 reads.
const BYTES = Number(process.env.RACE_BYTES ?? 6_000);
const DAILY = "core/dailyContext.md";

process.env.PI_MEMORY_DIR = BANK;

const tools = new Map<string, any>();
const handlers = new Map<string, any>();
const mod = await import("../index.js");
(mod.default as any)(
	{
		on: (event: string, handler: any) => {
			handlers.set(event, handler);
			return () => {};
		},
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: () => {},
	} as any,
);

const notify = { ui: { notify() {} } };
const call = (tool: string, params: any) => tools.get(tool).execute("probe", params);
const signal = (name: string) => fs.writeFileSync(path.join(BANK, `.race-${name}`), "");
const awaitSignal = async (name: string, ms = 10_000) => {
	const deadline = Date.now() + ms;
	while (!fs.existsSync(path.join(BANK, `.race-${name}`))) {
		if (Date.now() > deadline) throw new Error(`${ROLE}: timed out waiting for "${name}"`);
		await new Promise((r) => setTimeout(r, 2));
	}
};
const rest = (ms: number) => new Promise((r) => setTimeout(r, ms));

it(SCENARIO, async () => {
	if (SCENARIO === "update") {
		// The realistic shape: read through the tool, compose for a beat, write the
		// whole file back. On a refusal, re-read and re-apply — which is what an agent
		// is told to do, and the part worth measuring: the guard is only worth
		// anything if the recovery actually recovers.
		const mine = (await call("memory_read", { file: DAILY })).content[0].text;
		signal(`${ROLE}-read`);
		await awaitSignal(ROLE === "a" ? "b-read" : "a-read");
		await rest(ROLE === "a" ? 200 : 400);
		const result = await call("memory_update", { file: DAILY, content: `${mine.trimEnd()}\n- decision from ${ROLE}\n` });
		const refused = String(result.content[0].text).startsWith("Refused:");
		if (refused) {
			const now = (await call("memory_read", { file: DAILY })).content[0].text;
			await call("memory_update", { file: DAILY, content: `${now.trimEnd()}\n- decision from ${ROLE}\n` });
		}
		fs.appendFileSync(path.join(BANK, ".race-result"), `${ROLE} refused=${refused}\n`);
		if (ROLE === "b") await rest(400);
	}

	if (SCENARIO === "append") {
		if (ROLE === "b") await awaitSignal("a-start");
		signal(`${ROLE}-start`);
		for (let i = 0; i < N; i++) {
			await call("memory_append", { file: DAILY, section: "Completed", text: `- ${ROLE}-${i}` });
			await rest(GAP + Math.random() * GAP);
		}
		if (ROLE === "b") await rest(2_000);
	}

	if (SCENARIO === "mixed") {
		if (ROLE === "b") {
			const original = (await call("memory_read", { file: DAILY })).content[0].text;
			signal("b-read");
			await awaitSignal("a-ready");
			signal("mixed-go");
			let result = await call("memory_update", { file: DAILY, content: `${original.trimEnd()}\n- update by b\n` });
			if (result.isError) {
				const current = (await call("memory_read", { file: DAILY })).content[0].text;
				result = await call("memory_update", { file: DAILY, content: `${current.trimEnd()}\n- update by b\n` });
			}
			if (result.isError) throw new Error("update failed after re-read");
		} else {
			await awaitSignal("b-read");
			signal("a-ready");
			await awaitSignal("mixed-go");
			const result = await call("memory_append", { file: DAILY, section: "Completed", text: "- appended by a" });
			if (result.isError) throw new Error("append failed");
		}
	}

	if (SCENARIO === "index") {
		// B builds its index at session start; A then creates a knowledge file. B's
		// search is served from its own process's index, so it can report nothing
		// while the same bank lists the file — "not recorded" and "not indexed"
		// look identical to the caller.
		if (ROLE === "a") {
			// A must not write until B's index is built, or the scenario measures
			// nothing but process startup order.
			await awaitSignal("b-indexed");
			await call("memory_update", {
				file: "knowledge/probe-rule.md",
				content: "# Probe rule (probe, sentinel, background color)\n\nUse blue.\n",
			});
			signal("a-written");
		} else {
			await handlers.get("session_start")({ type: "session_start", reason: "new" }, notify);
			signal("b-indexed");
			await awaitSignal("a-written");
			await rest(300);
			const search = await call("memory_search", { query: "probe sentinel background color" });
			const listed = await call("memory_list", { directory: "knowledge" });
			fs.writeFileSync(
				path.join(BANK, ".race-result"),
				`search=${search.content[0].text.includes("probe-rule.md")} list=${listed.content[0].text.includes("probe-rule.md")}\n`,
			);
		}
	}

	if (SCENARIO === "rollover") {
		// Two Pi sessions start on the same morning. Rollover should produce exactly
		// one archive and carry the plan forward once — this one is a check, not a
		// measurement: the orchestrator fails if it does not hold.
		await awaitSignal("go");
		await handlers.get("session_start")({ type: "session_start", reason: "new" }, notify);
		signal(`${ROLE}-started`);
		if (ROLE === "b") await awaitSignal("a-started", 5_000).catch(() => {});
	}

	if (SCENARIO === "revisions") {
		// Each role owns one note and rewrites it N times with recovery enabled, so the
		// shared store lock, capture and pruning run under real contention. The
		// orchestrator verifies checksums and bounds from disk; a worker that saw an
		// error throws, but "who won" is never a worker's claim.
		const file = `knowledge/recovery-${ROLE}.md`;
		const original = (await call("memory_read", { file })).content[0].text;
		signal(`${ROLE}-read`);
		await awaitSignal(ROLE === "a" ? "b-read" : "a-read");
		for (let i = 1; i <= N; i++) {
			const content = `# Recovery ${ROLE}\n\nversion ${i}\n${"x".repeat(6000)}\n`;
			const result = await call("memory_update", { file, content });
			if (result.isError) throw new Error(`${ROLE}: update ${i} refused — ${result.content[0].text}`);
			await rest(GAP / 12);
		}
		if (ROLE === "b") await rest(1_000);
		void original;
	}

	if (SCENARIO === "case-aliases") {
		const file = "knowledge/case.md", created = "knowledge/created.md";
		const insensitive = process.env.RACE_CASE_INSENSITIVE === "true";
		if (ROLE === "a") {
			const release = await acquireBankLock(BANK, file);
			if (!release) throw new Error("could not hold target");
			try { signal("case-held"); await awaitSignal("case-checked"); } finally { release(); }
			signal("case-released"); await awaitSignal("case-updated");
			const releaseNew = await acquireBankLock(BANK, created);
			if (!releaseNew) throw new Error("could not hold creation");
			try {
				signal("creation-held"); await awaitSignal("creation-attempted");
				await rest(150); fs.writeFileSync(path.join(BANK, created), "created by a");
				await rest(100);
			} finally { releaseNew(); }
		} else {
			const alias = insensitive ? "knowledge/CASE.MD" : file;
			await call("memory_read", { file: alias }); await awaitSignal("case-held");
			const blocked = await call("memory_update", { file: alias, content: "after" });
			signal("case-checked"); await awaitSignal("case-released");
			const updated = await call("memory_update", { file: alias, content: "after" });
			signal("case-updated"); await awaitSignal("creation-held");
			const pending = call("memory_update", { file: insensitive ? "knowledge/CREATED.MD" : created, content: "unseen replacement" });
			signal("creation-attempted"); const creation = await pending;
			let internal = true;
			for (const file of [".REVISIONS/sentinel.md", ".WRITE-LOCKS/sentinel.md"]) {
				const result = await call("memory_update", { file, content: "poison", allowUnread: true });
				internal &&= !!result.isError && !fs.existsSync(path.join(BANK, file));
			}
			fs.writeFileSync(path.join(BANK, ".race-result"), `held=${blocked.details.refused === "lock-busy"} updated=${!updated.isError} creation=${creation.details.refused === "stale-base"} internal=${internal}`);
		}
	}

	if (SCENARIO === "alias-locks") {
		// A uses the original root, B a symlink to it. Exercise both the target lock
		// and the store lock with the shipped acquisition code in separate processes.
		const file = "knowledge/alias.md";
		if (ROLE === "a") {
			for (const [target, marker] of [[file, "target"], [".revisions", "store"]]) {
				const release = await acquireBankLock(BANK, target);
				if (!release) throw new Error(`could not acquire ${marker}`);
				try { signal(`${marker}-held`); await awaitSignal(`${marker}-checked`); }
				finally { release(); }
			}
			signal("locks-released");
		} else {
			await call("memory_read", { file });
			await awaitSignal("target-held");
			const target = await call("memory_update", { file, content: "after" });
			signal("target-checked");
			await awaitSignal("store-held");
			const store = await call("memory_update", { file, content: "after" });
			signal("store-checked");
			await awaitSignal("locks-released");
			const recovered = await call("memory_update", { file, content: "after" });
			fs.writeFileSync(path.join(BANK, ".race-result"), `target=${target.details.refused === "lock-busy"} store=${!!store.isError && store.content[0].text.includes("Recovery store is locked")} recovered=${!recovered.isError}`);
		}
	}

	if (SCENARIO === "torn") {
		// writeFileSync truncates then writes, so a reader can in principle open the
		// file in between. Count it, at a size far past any real bank file.
		// 200 lines of whatever length hits RACE_BYTES, so the probe can measure a
		// file the size of a real dailyContext.md and one absurdly larger than it.
		const pad = Math.max(1, Math.floor(BYTES / 200) - 8);
		const body = `# Probe\n\n` + Array.from({ length: 200 }, (_, i) => `l${i} ${"x".repeat(pad)}`).join("\n");
		if (ROLE === "a") {
			await call("memory_update", { file: "knowledge/probe-big.md", content: body });
			signal("a-ready");
			for (let i = 0; i < 300; i++) {
				await call("memory_update", { file: "knowledge/probe-big.md", content: body });
			}
			signal("a-done");
		} else {
			await call("memory_update", { file: "knowledge/probe-big.md", content: body });
			await awaitSignal("a-ready");
			const lengths: number[] = [];
			for (let i = 0; i < 300; i++) {
				const r = await call("memory_read", { file: "knowledge/probe-big.md" });
				lengths.push((r.details.bytes as number) ?? -1);
			}
			const expected = lengths.sort((x, y) => y - x)[0];
			const wrong = lengths.filter((l) => l !== expected).length;
			const empty = lengths.filter((l) => l === 0).length;
			fs.writeFileSync(path.join(BANK, ".race-result"), `reads=300 wrong=${wrong} empty=${empty} full=${expected}\n`);
			await awaitSignal("a-done", 20_000).catch(() => {});
		}
	}
}, 120_000);
