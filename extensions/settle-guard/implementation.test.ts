/**
 * settle-guard implementation tests.
 *
 * The fake Pi drives the hooks without a model: it reports a thinking level,
 * records every level change, counts notifications, and refuses a settle it
 * would refuse in real life. What the boundary does with the answer — running a
 * second provider request or not — is pinned separately against a real Pi, in
 * the live-harness test at the bottom.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rm, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import settleGuard, {
	CUTOFF_NUDGE,
	lastTurnSnapshot,
	logDirInUse,
	nudgeFor,
	newState,
	readConfig,
	RETRY_NUDGE,
	setLogDirForTesting,
	statusLines,
} from "./implementation.ts";

/** The shape the real failure has: reasoning, a clean stop, no answer, no tool call. */
const EMPTY = {
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "thinking", thinking: "let me think about this at length" }],
};

const TOOLCALL = {
	role: "assistant",
	stopReason: "toolUse",
	content: [{ type: "toolCall", name: "bash" }],
};

const ANSWERED = {
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text: "Here is what I found." }],
};

/**
 * A settle boundary as Pi 1.4.0 projects it: no `message` field, the last turn
 * read off the projected context, and canContinue false in exactly the state the
 * guard exists for. `canContinue: true` on the event itself keeps the fake from
 * refusing the settle the way Pi refuses one that is not actionable.
 */
function settle(message: Record<string, unknown> = EMPTY) {
	return {
		type: "agent_before_settle",
		outcome: "completed",
		context: { canContinue: false, contextMessages: [{ role: "user" }, message] },
		canContinue: true,
	};
}

/** The end of a request, which is where a saved thinking level goes back. */
function turnEnd(message: Record<string, unknown>) {
	return {
		type: "turn_end",
		outcome: "completed",
		context: { canContinue: true },
		message: { ...message },
		canContinue: true,
	};
}

/** A settle boundary Pi itself says is not actionable right now. */
const SETTLE_BLOCKED = { ...settle(), canContinue: false };

function harness(options: { level?: string; enabled?: boolean } = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const commands = new Map<string, { handler?: (args: string, ctx: unknown) => unknown }>();
	const notifies: string[] = [];
	const setLevels: string[] = [];
	let level = options.level ?? "medium";
	let logDir: string | undefined;

	const pi: any = {
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		getThinkingLevel: () => level,
		setThinkingLevel(next: string) {
			setLevels.push(next);
			level = next;
		},
		getModel: () => ({ id: "qwen3.6-27b", provider: "strata", name: "Qwen" }),
	};
	const ctx = {
		model: undefined as { id: string; provider: string; name?: string } | undefined,
		ui: { notify(message: string) { notifies.push(message); } },
	};
	ctx.model = pi.getModel();

	settleGuard(pi);

	const state = {
		currentLevel: () => level,
		setLevels,
		notifies,
		commands,
		logDir() {
			return logDirInUse();
		},
		/** Deliver one event exactly as Pi would, and return what the handler said. */
		async emit(event: Record<string, unknown>): Promise<any> {
			const handler = handlers.get(event.type as string);
			if (!handler) throw new Error(`the extension never subscribed to ${String(event.type)}`);
			// A boundary that cannot continue must not be reached at all.
			if (event.type === "agent_before_settle" && event.canContinue === false) {
				throw new Error("Pi refused the settle: not actionable");
			}
			return handler(event, ctx);
		},
		emitBlocked() {
			return state.emit(SETTLE_BLOCKED);
		},
		setLevel(next: string) {
			level = next;
		},
		async runCommand(name: string, args = "") {
			const command = commands.get(name);
			if (!command?.handler) throw new Error(`no command named ${name}`);
			return command.handler(args, ctx);
		},
		logRecords(): Record<string, unknown>[] {
			const dir = state.logDir();
			if (!dir) return [];
			const file = join(dir, "log.jsonl");
			if (!existsSync(file)) return [];
			return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
		},
	};
	return state;
}

describe("settle-guard: configuration", () => {
	const keys = ["PI_SETTLE_GUARD", "PI_SETTLE_GUARD_RETRIES", "PI_SETTLE_GUARD_THINKING", "PI_SETTLE_GUARD_DIR"];
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of keys) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const key of keys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("defaults to on, two retries, reasoning off on the retry", () => {
		const config = readConfig();
		assert.equal(config.enabled, true);
		assert.equal(config.config.maxRetries, 2);
		assert.equal(config.config.thinkingOnRetry, "off");
	});

	it("disables with off", () => {
		process.env.PI_SETTLE_GUARD = "off";
		assert.equal(readConfig().enabled, false);
	});

	it("clamps retries instead of trusting the environment", () => {
		process.env.PI_SETTLE_GUARD_RETRIES = "99";
		assert.equal(readConfig().config.maxRetries, 5);
		process.env.PI_SETTLE_GUARD_RETRIES = "not a number";
		assert.equal(readConfig().config.maxRetries, 2);
		process.env.PI_SETTLE_GUARD_RETRIES = "-4";
		assert.equal(readConfig().config.maxRetries, 2, "a negative budget is nonsense, not zero retries");
	});

	it("takes the log directory from the environment, and expands a ~", () => {
		process.env.PI_SETTLE_GUARD_DIR = "~/somewhere";
		assert.equal(readConfig().logDir, join(homedir(), "somewhere"));
		process.env.PI_SETTLE_GUARD_DIR = "relative/path";
		assert.equal(readConfig().logDir, undefined, "a relative path would mean a different log per cwd");
	});
});

describe("settle-guard: lastTurnSnapshot reads the boundary it is given", () => {
	it("takes the last assistant turn off a settle boundary's projected context", () => {
		assert.deepEqual(lastTurnSnapshot({
			outcome: "completed",
			context: { canContinue: false, contextMessages: [{ role: "user" }, EMPTY] },
		}), { role: "assistant", stopReason: "stop", content: EMPTY.content, outcome: "completed" });
	});

	it("also accepts a turn_end event, which carries the message directly", () => {
		const snap = lastTurnSnapshot({ outcome: "completed", message: { ...EMPTY } });
		assert.equal(snap.stopReason, "stop");
		assert.equal(snap.content?.length, 1);
	});

	it("marks an event it cannot read so the rule stands down", () => {
		const snap = lastTurnSnapshot({});
		assert.equal(snap.role, undefined);
		assert.equal(snap.outcome, undefined);
	});
});

describe("settle-guard: status lines", () => {
	it("report mode, budget, and streak", () => {
		const lines = statusLines({ enabled: true, config: { maxRetries: 2, maxTruncationRetries: 1, thinkingOnRetry: "off" } }, {
			streak: { empties: 1, truncations: 2 },
			empties: 1,
			cutOff: 2,
			retries: 3,
			saved: "low",
			gaveUp: { empty: false, truncation: true },
			awaitingRetry: false,
		});
		assert.equal(lines.length, 5);
		const text = lines.join("\n");
		assert.match(text, /\bon\b/);
		assert.match(text, /1 empty, 2 cut off/);
		assert.match(text, /gave up/);
		assert.match(text, /nowhere|\.jsonl/, "the status always says where the log is");
	});
});

describe("settle-guard: the hook", () => {
	let logDir: string;

	beforeEach(() => {
		logDir = mkdtempSync(join(tmpdir(), "settle-guard-test-"));
		// The seam, not the environment: a test that reaches for the environment
		// and then forgets it writes 1,267 records into the real log, which is what
		// happened once. See setLogDirForTesting.
		setLogDirForTesting(logDir);
		delete process.env.PI_SETTLE_GUARD;
		delete process.env.PI_SETTLE_GUARD_RETRIES;
		delete process.env.PI_SETTLE_GUARD_TRUNC;
	});
	afterEach(() => {
		setLogDirForTesting(null);
		rm(logDir, { recursive: true, force: true }, () => undefined);
	});

	it("never writes the real default log while the seam is installed", () => {
		// The whole point of the seam: no environment variable has to be remembered.
		delete process.env.PI_SETTLE_GUARD_DIR;
		setLogDirForTesting(logDir);
		assert.equal(logDirInUse(), logDir);
		settleGuard({ on() {}, registerCommand() {}, getThinkingLevel: () => "off", setThinkingLevel() {}, getModel: () => undefined } as never);
		assert.notEqual(logDirInUse(), join(homedir(), ".pi", "settle-guard"));
		assert.equal(logDirInUse(), logDir);
	});

	it("runs on load", async () => {
		const h = harness();
		await h.emit({ type: "session_start", sessionId: "s", cwd: "/tmp", model: { provider: "strata", id: "m" } });
		assert.equal(h.commands.has("settle-guard"), true);
	});

	it("retries an empty turn, with reasoning off and the level saved", async () => {
		const h = harness({ level: "high" });
		const result = await h.emit(settle());
		assert.deepEqual(h.setLevels, ["off"], "the retry asks for no reasoning");
		assert.equal(result.continue, true, "the ask is what makes Pi run the request again");
	});

	it("asks with the entry that makes the continuation runnable", async () => {
		// Measured on Pi 1.4.0: a bare `{ continue: true }` is refused at both
		// boundaries — "requested continuation without runnable model context".
		const result = await harness().emit(settle());
		assert.equal(result.entries.length, 1);
		assert.equal(result.entries[0].type, "custom_message");
		assert.equal(result.entries[0].customType, "settle-guard/retry");
		assert.equal(result.entries[0].content, RETRY_NUDGE);
		assert.equal(result.entries[0].display, false, "the nudge stays out of the transcript");
	});

	it("waits for the human while the boundary is not actionable", async () => {
		// A settle Pi itself refuses is not ours to argue with: we must not reach it.
		const h = harness();
		await assert.rejects(() => h.emitBlocked(), /refused the settle/);
		assert.deepEqual(h.setLevels, [], "no retry was asked for");
	});

	it("gives up after the budget and says so once", async () => {
		const h = harness();
		await h.emit(settle());
		await h.emit(settle());
		const third = await h.emit(settle());
		assert.equal(third, undefined, "the third empty turn in a row is left alone");
		const givenUp = h.notifies.filter((m) => m.includes("settle-guard:"));
		assert.equal(givenUp.length, 3, "two retries plus the give-up");
		assert.match(givenUp[2], /[Ss]topped retrying/);
	});

	it("counts a model's own refusal marker as an empty turn, and logs it as one", async () => {
		const h = harness();
		await h.emit(settle({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "[refusal]" }] }));
		assert.deepEqual(h.setLevels, ["off"]);
		assert.equal(h.logRecords()[0].code, "refusal");
	});

	it("retries a cut-off answer with its own nudge", async () => {
		const cut = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "let me check the tokens for the tag and `" }],
		};
		const h = harness();
		const result = await h.emit(settle(cut));
		assert.equal(result.continue, true);
		assert.equal(result.entries[0].customType, "settle-guard/retry-cutoff");
		assert.equal(result.entries[0].content, CUTOFF_NUDGE);
		assert.equal(h.logRecords()[0].code, "truncated-text");
		assert.match(h.notifies[0], /cut off mid-answer/);
	});

	it("tells the model not to write the delimiter tags, because that is what killed the turn", () => {
		// The nudge is the only place this instruction can go: the turn that died
		// died by emitting those bytes, and asking again without saying so puts the
		// same text back in front of the same model.
		assert.match(CUTOFF_NUDGE, /never write .*delimiter tags .*literally/i);
		assert.match(CUTOFF_NUDGE, /code spans/i);
		assert.doesNotMatch(CUTOFF_NUDGE, /</, "the nudge must not itself contain a tag");
		assert.equal(nudgeFor("empty"), RETRY_NUDGE);
		assert.equal(nudgeFor("truncation"), CUTOFF_NUDGE);
	});

	it("spends the two budgets separately", async () => {
		const cut = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "still going and `" }] };
		const h = harness();
		// empty, empty, then cut off: the empty budget is spent, the cut-off is not
		await h.emit(settle());
		await h.emit(settle());
		const third = await h.emit(settle());
		assert.equal(third, undefined, "the empty budget gave up");
		const cutOver = await h.emit(settle(cut));
		assert.equal(cutOver.continue, true, "and a cut-off turn still gets its one retry");
	});

	it("leaves a turn that did something alone, and treats it as progress", async () => {
		const h = harness();
		await h.emit(settle(TOOLCALL));
		await h.emit(settle(ANSWERED));
		await h.emit(settle({ role: "assistant", stopReason: "aborted", content: [] }));
		assert.deepEqual(h.setLevels, [], "nothing was retried");
	});

	it("counts our own retry as the same question, not a new one", async () => {
		// Live against Pi 1.4.0, a continuation starts a new agent run. Resetting
		// the streak there made the budget unreachable and looped 1,102 times.
		const h = harness();
		for (let i = 0; i < 12; i += 1) {
			await h.emit({ type: "agent_start", sessionId: "s", prompt: "hi" });
			const result = await h.emit(settle());
			if (result) continue;
			assert.ok(h.notifies.some((m) => /Stopped retrying/i.test(m)), "the budget tripped");
			break;
		}
		const retries = h.notifies.filter((m) => /retrying \(/.test(m));
		assert.equal(retries.length, 2, "two retries, then it stops asking");
	});

	it("breaks the streak when the human actually asks something new", async () => {
		const h = harness();
		await h.emit(settle());
		await h.emit(settle());
		await h.emit({ type: "input", text: "actually, try a different approach", images: [] });
		await h.emit({ type: "agent_start", sessionId: "s", prompt: "actually, try a different approach" });
		const result = await h.emit(settle());
		assert.equal(result.continue, true, "a fresh question gets its own full budget");
	});

	it("breaks the streak on a tool call, and on an answer", async () => {
		const h = harness();
		await h.emit(settle());
		await h.emit(settle(TOOLCALL));
		await h.emit(settle());
		const last = await h.emit(settle(ANSWERED));
		assert.equal(last, undefined);
		assert.equal(h.notifies.filter((m) => /retrying \(/.test(m)).length, 2, "each streak retried once");
	});

	it("restores the thinking level after the retry, and does not clobber a manual change", async () => {
		const h = harness({ level: "high" });
		await h.emit(settle());
		assert.deepEqual(h.setLevels, ["off"], "the retry ran with reasoning off");

		// the human moved the level during the retry: theirs to keep
		h.setLevel("minimal");
		await h.emit(turnEnd(ANSWERED));
		assert.equal(h.currentLevel(), "minimal");

		const h2 = harness({ level: "medium" });
		await h2.emit(settle());
		await h2.emit(turnEnd(ANSWERED));
		assert.equal(h2.currentLevel(), "medium", "restored when nothing else touched it");
	});

	it("leaves the level alone when the retry was not reasoning-heavy anyway", async () => {
		const h = harness({ level: "off" });
		await h.emit(settle());
		assert.deepEqual(h.setLevels, [], "already off, so nothing to save or restore");
	});

	it("names the model in the notification, once per streak", async () => {
		const h = harness();
		await h.emit(settle());
		await h.emit(settle());
		const retrying = h.notifies.filter((m) => m.includes("retrying ("));
		assert.equal(retrying.length, 2);
		assert.match(retrying[0], /Qwen|qwen/);
		assert.equal(retrying[0].split("gave an empty turn").length - 1, 1);
	});

	it("keeps quiet when disabled, and does not touch the level", async () => {
		process.env.PI_SETTLE_GUARD = "off";
		const h = harness();
		await h.emit(settle());
		assert.deepEqual(h.setLevels, []);
		assert.deepEqual(h.notifies, []);
	});

	it("never breaks the session, whatever the event holds", async () => {
		const h = harness();
		for (const junk of [{}, { message: null }, { context: 3 }, { message: { content: "not an array" }, outcome: "completed" }]) {
			await h.emit({ type: "agent_before_settle", outcome: "completed", canContinue: true, ...junk });
		}
		assert.ok(true, "reached here without throwing");
	});

	it("logs one record per retry, and one per give-up", async () => {
		const h = harness();
		await h.emit(settle());
		await h.emit(settle());
		const records = h.logRecords();
		assert.equal(records.length, 2);
		assert.equal(records[0].action, "retry");
		assert.equal(records[0].code, "reasoned-empty", "the code is what a parser greps");
		assert.match(String(records[0].reason), /reasoned for \d+ characters and answered nothing/);
		assert.equal(records[0].thinking, "medium");
		assert.equal(records[0].provider, "strata");
		assert.equal(records[1].attempts, 2);
	});

	it("caps the log instead of growing without bound", async () => {
		const h = harness();
		for (let i = 0; i < 4000; i += 1) {
			await h.emit(settle());
			await h.emit(settle(ANSWERED)); // reset the streak so each one retries again
		}
		const bytes = statSync(join(logDir, "log.jsonl")).size;
		assert.ok(bytes <= 300_000, `the log stopped growing at ${bytes} bytes`);
		const lines = readFileSync(join(logDir, "log.jsonl"), "utf8").trim().split("\n");
		assert.ok(lines.length > 100, "the cap is generous, not silent truncation at one page");
	});

	it("survives a log directory that cannot be written", async () => {
		process.env.PI_SETTLE_GUARD_DIR = "/proc/settle-guard-nope";
		const h = harness();
		await h.emit(settle());
		assert.equal(h.notifies.length, 1, "the retry still happened");
	});
});

describe("settle-guard: /settle-guard", () => {
	beforeEach(() => {
		process.env.PI_SETTLE_GUARD_DIR = mkdtempSync(join(tmpdir(), "settle-guard-cmd-"));
	});
	afterEach(() => {
		rm(process.env.PI_SETTLE_GUARD_DIR ?? "", { recursive: true, force: true }, () => undefined);
		delete process.env.PI_SETTLE_GUARD_DIR;
	});

	it("reports status without asking for a retry", async () => {
		const h = harness();
		await h.emit(settle());
		const before = h.notifies.length;
		await h.runCommand("settle-guard");
		assert.equal(h.notifies.length, before + 1);
		assert.match(h.notifies.at(-1) ?? "", /settle-guard — on/);
	});
});

describe("settle-guard: state", () => {
	it("starts clean", () => {
		// No "have I nagged yet" field on purpose: that flag gets reset in one
		// place and forgotten in another, which is how a guard starts nagging.
		assert.deepEqual(newState(), {
			streak: { empties: 0, truncations: 0 },
			empties: 0,
			cutOff: 0,
			retries: 0,
			gaveUp: { empty: false, truncation: false },
			saved: null,
			awaitingRetry: false,
		});
	});
});
