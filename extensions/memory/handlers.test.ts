/**
 * Handler-level tests for index.ts.
 *
 * index.ts exports the config helpers but not its event handlers — they are
 * closures handed to `pi.on(...)`. So these tests load the extension against a
 * fake ExtensionAPI, capture the handlers, and drive them directly. That is the
 * only way to reach the two behaviours that broke against Pi 1.4.0: the
 * `before_agent_start` event no longer always carries a `prompt`, and tool
 * `execute` results must carry `details`.
 *
 * PI_MEMORY_DIR is read when index.ts is imported, so the temp bank is created
 * and the env var set before the dynamic imports below — and nothing that
 * reaches bank.ts may be imported statically, because ES imports hoist above
 * those statements and would bind the module graph to the default bank.
 * setupFiles (vitest.isolate-bank.ts) keeps the default bank out of reach
 * regardless, and vitest.bank-guard.ts fails the run if a suite writes to it.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BANK = fs.mkdtempSync(path.join(os.tmpdir(), "memory-handlers-"));
process.env.PI_MEMORY_DIR = BANK;

/* Imported here rather than at the top: these read the bank root at evaluation time. */
const { dayString } = await import("./calendar.js");
const { logEvent, logFilePath, summarizeLog } = await import("./usage-log.js");
const { default: memoryExtension } = await import("./index.js");

/** Mirrors MAX_READ_LINES in index.ts (not exported; the cap is a guard rail). */
const MAX_READ = 2000;

type Handler = (event: any, ctx: any) => any;

const handlers = new Map<string, Handler>();
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const notifications: Array<{ message: string; level: string }> = [];

memoryExtension({
	on(event: string, handler: Handler) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
	registerTool(tool: any) {
		tools.set(tool.name, tool);
	},
	registerCommand(name: string, cmd: any) {
		commands.set(name, cmd);
	},
} as unknown as ExtensionAPI);

const ctx = { ui: { notify: (message: string, level: string) => notifications.push({ message, level }) } };

function emit(event: string, payload: any, overrideCtx?: any): any {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`extension did not register a ${event} handler`);
	return handler(payload, overrideCtx ?? ctx);
}

function write(rel: string, content: string) {
	const full = path.join(BANK, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf-8");
}

function read(rel: string): string {
	return fs.readFileSync(path.join(BANK, rel), "utf-8");
}

/** A Pi 1.4.0 before_agent_start event for a submitted user prompt. */
function userEvent(prompt: string) {
	return { type: "before_agent_start", messageType: "user", prompt, systemPrompt: "" };
}

/** The other arm of the union: an idle custom message, which has no prompt. */
function customEvent(customType = "some-other-extension") {
	return {
		type: "before_agent_start",
		messageType: "custom",
		message: { role: "custom", customType, content: "fired while idle", display: false },
		systemPrompt: "",
	};
}

beforeAll(() => {
	write("core/activeProjects.md", "# Active Projects\n\n## P0 — Critical\n- pi-memory3 (P0) - this repo\n");
	write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	write("knowledge/webhook-naming.md", "# Webhook Naming\n\nWebhooks are named `past.<entity>.<event>`.\n\n## Source\n- Rodrigo, 2026-10-02\n");
	emit("session_start", { type: "session_start", reason: "new" });
});

afterAll(() => {
	fs.rmSync(BANK, { recursive: true, force: true });
});

/** Reload config.json and reset the per-turn injection flags, as a new session does. */
async function freshSession() {
	await emit("session_start", { type: "session_start", reason: "reload" });
}

async function injectedContent(event: any): Promise<string> {
	const result = await emit("before_agent_start", event);
	return result?.message?.content ?? "";
}

describe("before_agent_start", () => {
	it("injects the core files for a user prompt", async () => {
		await freshSession();
		const content = await injectedContent(userEvent("what was I doing on pi-memory3"));
		expect(content).toContain("# Memory Bank Context");
		expect(content).toContain("## Active Projects");
		expect(content).toContain("pi-memory3 (P0)");
		expect(content).toContain("## Daily Context");
	});

	it("injects a core file once, not again as a search result", async () => {
		await freshSession();
		// Core files ride along on every prompt, so search refuses them as results.
		// Pinned end to end because reading the code and asserting the opposite once
		// produced a confident, wrong claim.
		const content = await injectedContent(userEvent("what was I doing on pi-memory3, this repo"));
		expect(content.split("pi-memory3 (P0)").length - 1).toBe(1);
		const knowledge = content.split("## Relevant Knowledge")[1] ?? "";
		expect(knowledge).not.toContain("core/activeProjects.md");
		expect(knowledge).not.toContain("core/dailyContext.md");
	});

	it("does not throw on a custom-message run, which has no prompt field", async () => {
		await freshSession();
		// Pi 1.4.0 made before_agent_start a union: the custom arm has `message`,
		// not `prompt`. Reading event.prompt here threw on every such run.
		await expect(emit("before_agent_start", customEvent())).resolves.not.toThrow();
	});

	it("still injects core files, but no searched knowledge, for a custom-message run", async () => {
		await freshSession();
		const content = await injectedContent(customEvent());
		expect(content).toContain("## Active Projects");
		expect(content).not.toContain("Relevant Knowledge");
	});

	it("injects the whole knowledge file when the prompt matches it", async () => {
		await freshSession();
		const content = await injectedContent(userEvent("how should I name webhooks again"));
		expect(content).toContain("## Relevant Knowledge");
		expect(content).toContain("knowledge/webhook-naming.md");
		expect(content).toContain("past.<entity>.<event>");
	});

	// ── delta injection (docs/injection-cost-design.md §3.1) ────────────────────
	// 39 % of injected bytes were a repeat of the previous prompt, so the second copy
	// became a pointer. Most of these tests are about when the body has to come back:
	// a pointer to text the model no longer holds is worse than the bytes it saved.
	it("sends a core section by reference the second time this session asks for it", async () => {
		write("core/dailyContext.md", `## Daily Context\n\n${"A long note about widget sizing.\n".repeat(40)}\n`);
		await freshSession();
		const first = await injectedContent(userEvent("how large should a widget be in pixels"));
		expect(first).toContain("A long note about widget sizing.");

		const second = await injectedContent(userEvent("and what about its label"));
		expect(second, "the body went in twice").not.toContain("A long note about widget sizing.");
		expect(second).toContain("`core/dailyContext.md` unchanged since earlier in this session");
		expect(second, "a pointer the model cannot act on is just a cut").toContain('memory_read "core/dailyContext.md"');
	});

	it("sends a knowledge file by reference the second time, and its body again once it changes", async () => {
		// A file of this size, not the two-line fixture: a pointer to a two-line file would
		// cost more than the file, which is the case the next test pins down.
		write("knowledge/webhook-conventions.md", `${"Why the convention is worth keeping.\n".repeat(20)}\n`);
		await freshSession();
		expect(await injectedContent(userEvent("how do we name webhooks"))).toContain("worth keeping");

		const second = await injectedContent(userEvent("webhooks, once more"));
		expect(second).toContain("`knowledge/webhook-conventions.md` unchanged since earlier in this session");

		// The file changed, so the copy in the transcript is now wrong — the one thing this
		// feature must never leave standing.
		write("knowledge/webhook-conventions.md", `# Webhook conventions\n\nRenamed to present tense.\n${"Why the rename is worth it.\n".repeat(20)}\n`);
		const third = await injectedContent(userEvent("how do we name webhooks"));
		expect(third).toContain("Why the rename is worth it");
		expect(third, "a changed file is not unchanged").not.toContain("`knowledge/webhook-conventions.md` unchanged");
	});

	it("leaves a small section alone, because a pointer to it is not cheaper", async () => {
		// A section near the pointer's own length is cheaper to send than to describe, and
		// the constant below is what separates it from a real one; without that floor the
		// block fills with pointers to paragraphs.
		const twoHundred = "A section a little longer than the pointer that would replace it. ".repeat(4);
		write("core/dailyContext.md", `## Daily Context\n\n${twoHundred}\n`);
		await freshSession();
		expect(await injectedContent(userEvent("how do we name webhooks"))).toContain(twoHundred.trim());
		const second = await injectedContent(userEvent("webhooks, once more"));
		expect(second, "a body this size is already smaller than the note about it").toContain(twoHundred.trim());
	});

	it("sends everything whole again after an event that rewrites the transcript", async () => {
		write("core/dailyContext.md", `## Daily Context\n\n${"A long note about widget sizing.\n".repeat(40)}\n`);
		await freshSession();
		await injectedContent(userEvent("how large should a widget be in pixels"));
		expect(await injectedContent(userEvent("and what about its label"))).toContain("unchanged since earlier");

		// Compaction summarizes the older turns away; tree navigation moves to a branch
		// where the section may never have been sent. Either way the pointer is a lie.
		await emit("session_compact", { type: "session_compact" });
		expect(await injectedContent(userEvent("and what about its margins"))).toContain("A long note about widget sizing.");

		await emit("session_compact", { type: "session_compact" });
		await emit("before_agent_start", userEvent("and what about its margins"));
		await emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "x" });
		expect(await injectedContent(userEvent("and what about its borders"))).toContain("A long note about widget sizing.");
	});

	it("starts a new session with whole sections, not pointers", async () => {
		// Another session in this process saw the same text. Starting on a pointer would
		// refer to a transcript this session does not have.
		write("core/dailyContext.md", `## Daily Context\n\n${"A long note about widget sizing.\n".repeat(40)}\n`);
		await freshSession();
		expect(await injectedContent(userEvent("how large should a widget be in pixels"))).toContain("A long note about widget sizing.");
		await freshSession();
		expect(await injectedContent(userEvent("how large should a widget be in pixels"))).toContain("A long note about widget sizing.");
	});
	// ── character cap on injected files (§3.2) ──────────────────────
	it("caps an injected file in characters, not only in lines", async () => {
		// 100 lines is 14 KB when the lines are long, which is how a line-only cap failed:
		// this file is under the line cap and over the character cap — and it loses a fifth
		// of itself, so it still arrives as a file rather than as a name (§3.5).
		const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${"widget padding ".repeat(12)}`.slice(0, 120)).join("\n");
		write("knowledge/long-notes.md", `# Long notes (widget, pixels)\n\n${long}\n`);
		await freshSession();
		const content = await injectedContent(userEvent("how large should a widget be in pixels"));
		expect(content).toContain("knowledge/long-notes.md");
		expect(content).toContain("not shown — memory_read \"knowledge/long-notes.md\" for the whole file");
		expect(content).not.toContain("is not in this prompt");
		expect(content.length, "the cap is the point of the cap").toBeLessThan(12000);
	});

	it("does not cut a file that fits", async () => {
		await freshSession();
		const content = await injectedContent(userEvent("how do we name webhooks"));
		expect(content).toContain("past.<entity>.<event>");
		expect(content).not.toContain("not shown — memory_read");
	});

	it("cuts a file that is over the character cap and says by how much", async () => {
		// A line cap misses this file: 30 lines of 250 characters is 7,500 characters of
		// prose and nowhere near 100 lines.
		write("knowledge/giraffe-notes.md", `# Giraffe notes (giraffe, sizing)\n\n${Array.from({ length: 30 }, () => "y".repeat(250)).join("\n")}\n`);
		await freshSession();
		const content = await injectedContent(userEvent("giraffe sizing"));
		expect(content).toMatch(/… [\d,]+ more characters not shown — memory_read "knowledge\/giraffe-notes\.md"/);
	});

	it("does not cut a file for a small overage", async () => {
		// 6,000 characters against a 6,000 cap: the note explaining the cut would cost more
		// than the cut saves, and the model gets a file with a truncated tail for nothing.
		// 6,302 characters against a 6,000 cap: over it, but under the 500-character minimum
		// that makes a cut worth describing.
		write("knowledge/hyena-notes.md", `# Hyena notes (hyena, sizing)\n\n${Array.from({ length: 25 }, () => "z".repeat(250)).join("\n")}\n`);
		await freshSession();
		const content = await injectedContent(userEvent("hyena sizing"));
		expect(content).toContain("Hyena notes");
		// Scoped to this file: the fixture next door is deliberately over the cap, and a
		// bank-wide "no cut anywhere" assertion would be a test about test ordering.
		expect(content).not.toMatch(/more characters not shown — memory_read "knowledge\/hyena-notes\.md"/);
	});

	it("counts the characters a cap kept out of the prompt", async () => {
		// 48 lines of 186 characters: over the 6,000-character cap and under the half that
		// §3.5 withholds, so this is the case the log's `cu` is about.
		const long = "A knowledge file whose lines are sentences rather than words. ".repeat(3);
		write("knowledge/long-notes.md", `# Long notes (widget, pixels)\n\n${Array.from({ length: 48 }, () => long).join("\n")}\n`);
		write("config.json", JSON.stringify({ log: true }));
		await freshSession();
		await emit("before_agent_start", userEvent("how large should a widget be in pixels"));
		const logged = fs
			.readdirSync(path.join(BANK, "logs"))
			.flatMap((f) => fs.readFileSync(path.join(BANK, "logs", f), "utf8").split("\n"))
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		const inject = logged.find((e) => e.t === "inject");
		expect(inject?.cu, "a cap with no number on it cannot be checked against anything").toBeGreaterThan(0);
	});



	// ── recency of injected records ────────────────────────────────
	// A bank accumulates statements and BM25 has no time term, so a carefully
	// written old decision outscores the revision that replaced it. The extension
	// cannot tell which one still stands; it can at least say when each was written.
	describe("injected records are dated", () => {
		const day = (n: number) => dayString(new Date(Date.now() - n * 86_400_000));
		const stamp = (rel: string, daysAgo: number) => {
			const t = new Date(Date.now() - daysAgo * 86_400_000);
			fs.utimesSync(path.join(BANK, rel), t, t);
		};

		// Additive: the shared fixtures stay in place, because other tests in this
		// describe read them. Removing these two files afterwards is the cleanup.
		beforeEach(async () => {
			// Monday, written carefully: rich aliases, dated source.
			write(
				"knowledge/app-background.md",
				"# App background (background, color, colour, app background, UI)\n\nThe app background must be blue.\n\n## Source\n- Rodrigo, Monday, design review\n",
			);
			stamp("knowledge/app-background.md", 1);
			// Tuesday, reversed in a hurry: fewer aliases.
			write(
				"knowledge/app-colour-green.md",
				"# App colour green (app colour, green, background)\n\nUse green for the app background.\n\n## Source\n- Rodrigo, today\n",
			);
			await freshSession();
		});

		afterAll(async () => {
			fs.rmSync(path.join(BANK, "knowledge", "app-background.md"), { force: true });
			fs.rmSync(path.join(BANK, "knowledge", "app-colour-green.md"), { force: true });
			// Rebuild, or the index keeps offering files that are no longer there.
			await freshSession();
		});

		it("dates every injected record", async () => {
			const content = await injectedContent(userEvent("what color should the app background be?"));
			expect(content).toMatch(/--- knowledge\/app-background\.md \(score: \d+, updated \d{4}-\d{2}-\d{2}\) ---/);
			expect(content).toContain(`updated ${day(1)}`);
		});

		it("tells the model what to do when two records disagree", async () => {
			const content = await injectedContent(userEvent("what color should the app background be?"));
			expect(content).toContain("point-in-time record");
			expect(content).toContain("follow the most recent");
		});

		it("says nothing about recency when nothing matched", async () => {
			const content = await injectedContent(userEvent("totally unrelated zebra topic"));
			expect(content).not.toContain("point-in-time");
		});

		it("still ranks the stale, better-written record first", async () => {
			// Documents the hole the date exists to cover rather than pretending it
			// is closed: blue wins the ranking, and only the dates resolve it.
			const content = await injectedContent(userEvent("what color should the app background be?"));
			const blue = content.indexOf("app-background.md");
			const green = content.indexOf("app-colour-green.md");
			expect(blue).toBeGreaterThan(-1);
			expect(green).toBeGreaterThan(-1);
			expect(blue, "the older record still wins on score").toBeLessThan(green);
			expect(content.indexOf(`updated ${day(1)}`)).toBeLessThan(content.indexOf(`updated ${day(0)}`));
		});
	});

	it("returns nothing at all when every content type is off", async () => {
		write("config.json", JSON.stringify({ injection: {
			activeProjects: "off", dailyContext: "off", knowledge: "off", history: "off",
		} }));
		await freshSession();
		expect(await emit("before_agent_start", userEvent("webhooks"))).toBeUndefined();
	});

	it("injects first-turn content once, then stops until the next session", async () => {
		write("config.json", JSON.stringify({ injection: {
			activeProjects: "first-turn", dailyContext: "first-turn", knowledge: "off", history: "off",
		} }));
		await freshSession();
		expect(await injectedContent(userEvent("one"))).toContain("## Active Projects");
		expect(await injectedContent(userEvent("two"))).not.toContain("## Active Projects");
		await freshSession();
		expect(await injectedContent(userEvent("three"))).toContain("## Active Projects");
	});

	it("re-adds first-turn content after compaction", async () => {
		write("config.json", JSON.stringify({ injection: {
			activeProjects: "first-turn", dailyContext: "first-turn", knowledge: "off", history: "off",
		} }));
		await freshSession();
		await injectedContent(userEvent("one"));
		await emit("session_compact", { type: "session_compact" });
		expect(await injectedContent(userEvent("two"))).toContain("## Active Projects");
	});

	afterAll(async () => {
		fs.rmSync(path.join(BANK, "config.json"), { force: true });
		await freshSession();
	});
});

/**
 * Every tool that takes a path, and the parameters that aim it outside the bank.
 *
 * The invariant test below is the reason this is a table: a new tool with a
 * `file` or `directory` parameter fails that test until it appears here, so "all
 * tools are containment-tested" stays a statement about the tools that exist
 * rather than about the four that existed when the tests were written.
 *
 * `outside` is a path relative to the bank root. It is always a temp directory,
 * never a real system path: a containment test that writes is one regression away
 * from overwriting /etc.
 */
const ESCAPE_CASES: Record<string, (outside: string) => Record<string, unknown>> = {
	memory_read: (outside) => ({ file: `${outside}/secret.md` }),
	memory_update: (outside) => ({ file: `${outside}/pwned.md`, content: "x\n" }),
	memory_append: (outside) => ({ file: `${outside}/secret.md`, section: "Completed", text: "x" }),
	memory_list: (outside) => ({ directory: outside }),
};

describe("tool results", () => {
	it("register the five tools and the /memory command", () => {
		expect([...tools.keys()].sort()).toEqual(
			["memory_append", "memory_list", "memory_read", "memory_search", "memory_update"],
		);
		expect(commands.has("memory")).toBe(true);
	});

	// Pi 1.4.0 requires `details` on every AgentToolResult. Returning an object
	// without it type-checks only until something reads the result.
	it("every tool returns a details field alongside content", async () => {
		const calls: Array<[string, any]> = [
			["memory_read", { file: "core/activeProjects.md" }],
			["memory_list", {}],
			["memory_search", { query: "webhooks" }],
			["memory_update", { file: "knowledge/tool-probe.md", content: "# Probe\n" }],
			["memory_append", { file: "core/dailyContext.md", section: "Completed", text: "- probe entry" }],
		];
		for (const [name, params] of calls) {
			const result = await tools.get(name).execute("tc-1", params);
			expect(result, `${name} content`).toHaveProperty("content");
			expect(result, `${name} details`).toHaveProperty("details");
			expect(Array.isArray(result.content), `${name} content array`).toBe(true);
		}
	});

	it("report what a read acted on through details, not through content", async () => {
		const result = await tools.get("memory_read").execute("tc-2", { file: "knowledge/webhook-naming.md" });
		expect(result.content[0].text).toContain("past.<entity>.<event>");
		expect(result.details).toEqual({ file: "knowledge/webhook-naming.md", bytes: result.content[0].text.length });
	});

	/** Create a directory outside the bank; return it as a path relative to the bank. */
	function makeOutside(abs: string): { rel: string; abs: string } {
		fs.mkdirSync(abs, { recursive: true });
		fs.writeFileSync(path.join(abs, "secret.md"), "NOT MEMORY\n");
		return { rel: path.relative(BANK, abs), abs };
	}

	const plainOutside = () => makeOutside(path.join(path.dirname(BANK), "memory-outside"));
	// Helper for the prefix bug: this path starts with the bank's own path.
	const siblingOutside = () => makeOutside(`${BANK}-evil`);

	/**
	 * Drive every escape case at `outside` and require each tool to refuse it.
	 *
	 * The message is asserted, not just isError: any error satisfies isError, and
	 * memory_append legitimately errors for unrelated reasons ("Section not found")
	 * — which is exactly how a removed containment guard passed this test unnoticed
	 * when it only looked at the flag.
	 */
	async function expectAllRefuseOutside(outside: { rel: string; abs: string }, tcId: string) {
		try {
			for (const [name, build] of Object.entries(ESCAPE_CASES)) {
				const result = await tools.get(name).execute(tcId, build(outside.rel));
				expect(result.isError, `${name} must refuse ${outside.rel}`).toBe(true);
				expect(result.content[0].text, `${name} must blame containment, not something else`)
					.toContain("must be within the memory bank directory");
				expect(result.details, `${name} details`).toBeDefined();
			}
			expect(fs.existsSync(path.join(outside.abs, "pwned.md")), "nothing may be written outside the bank").toBe(false);
		} finally {
			fs.rmSync(outside.abs, { recursive: true, force: true });
		}
	}

	/**
	 * The check that keeps the table honest: every registered tool whose
	 * parameters include a path must have an escape case above.
	 *
	 * Introspecting the parameter schema is what makes this a gate. Asserting the
	 * tool count instead would only prove somebody remembered to edit a second list.
	 */
	it("have a containment case for every tool that takes a path", () => {
		const pathTaking = [...tools.keys()]
			.filter((name) => {
				const props = tools.get(name).parameters?.properties ?? {};
				return "file" in props || "directory" in props;
			})
			.sort();
		expect(Object.keys(ESCAPE_CASES).sort()).toEqual(pathTaking);
	});

	it("refuse every path that leaves the bank", async () => {
		await expectAllRefuseOutside(plainOutside(), "tc-esc-1");
	});

	// The regression this fixture exists for: ~/.pi/memory3 used to accept
	// ../memory3-evil/x.md, because that resolved path *starts with* the string
	// ~/.pi/memory3.
	it("refuse a sibling directory whose name extends the bank's name", async () => {
		const outside = siblingOutside();
		// The whole point of the fixture: `../memory-handlers-XXX-evil` resolves to a
		// path that *starts with* the bank's own path.
		expect(outside.rel).toBe(`../${path.basename(BANK)}-evil`);
		expect(path.resolve(BANK, outside.rel).startsWith(BANK)).toBe(true);
		await expectAllRefuseOutside(outside, "tc-esc-2");
	});

	it("refuse absolute paths and climbs past the temp root", async () => {
		for (const target of ["/etc/passwd", "../../../../etc/passwd", "../../.."]) {
			const result = await tools.get("memory_read").execute("tc-esc-3", { file: target });
			expect(result.isError, `read must refuse ${target}`).toBe(true);
		}
	});

	it("still allow the bank root and paths nested below it", async () => {
		const listed = await tools.get("memory_list").execute("tc-esc-5", { directory: "." });
		expect(listed.isError).toBe(false);
		const nested = await tools.get("memory_update").execute("tc-esc-6", {
			file: "knowledge/nested/deep-note.md",
			content: "# Deep note\n\nFine.\n",
		});
		expect(nested.isError).toBe(false);
		expect(read("knowledge/nested/deep-note.md")).toContain("Fine.");
	});

	it("keep a written file and its index entry in step", async () => {
		await tools.get("memory_update").execute("tc-4", {
			file: "knowledge/git-rules.md",
			content: "# Git Rules\n\nCommit messages are imperative and lower case.\n",
		});
		expect(read("knowledge/git-rules.md")).toContain("imperative and lower case");
		const hit = await tools.get("memory_search").execute("tc-5", { query: "commit message style" });
		expect(hit.content[0].text).toContain("knowledge/git-rules.md");
		expect(hit.details.results.map((r: any) => r.path)).toContain("knowledge/git-rules.md");
	});

	it("append into a section without disturbing the next one", async () => {
		write(
			"core/dailyContext.md",
			"## 2026-10-27\n\n### Completed\n- Wired up tests\n\n### Key Decisions\n\n- Keep MiniSearch as the only backend\n",
		);
		await tools.get("memory_append").execute("tc-6", {
			file: "core/dailyContext.md",
			section: "Completed",
			text: "- Added handler tests",
		});
		const after = read("core/dailyContext.md");
		// The entry lands inside Completed, ahead of the next heading, and
		// neither neighbouring section is touched.
		expect(after).toMatch(/### Completed\n- Wired up tests\n- Added handler tests\n\n### Key Decisions/);
		expect(after).toContain("Keep MiniSearch as the only backend");
	});

	/**
	 * Four results name a place, and those are the four that can send an agent looking
	 * for a file it just wrote. A bare `knowledge/x.md` is read as "it is in the bank",
	 * because the bank is what that path is relative to — and when the write was a
	 * harness `write` from a project cwd, that reading is wrong. Measured 2026-10-29:
	 * `write knowledge/example-port.md` from a project session confirmed the
	 * relative path, and 45 minutes later a broad search cost 179 s
	 * to locate the agent's own note. Pi echoes the path it was handed, so this
	 * extension cannot fix *that* confirmation. What it can do is never leave the same
	 * doubt in a result of its own.
	 */
	describe("results that name a place name the whole place", () => {
		const text = (result: any) => result.content[0].text as string;

		it("says in full which file memory_update wrote", async () => {
			const result = await tools.get("memory_update").execute("tc-loc-1", {
				file: "knowledge/located.md",
				content: "# Located\n\nHere.\n",
			});
			expect(text(result)).toContain(`Updated knowledge/located.md`);
			expect(text(result)).toContain(path.join(BANK, "knowledge/located.md"));
			// Spacing is part of the announcement: `→/Users/x` reads as one odd token.
			expect(text(result)).toContain(`→ ${path.join(BANK, "knowledge/located.md")}`);
			// The API does not change shape: details keep the relative key.
			expect(result.details).toEqual({ file: "knowledge/located.md", bytes: "# Located\n\nHere.\n".length });
		});

		it("says in full which file memory_append wrote", async () => {
			const result = await tools.get("memory_append").execute("tc-loc-2", {
				file: "core/dailyContext.md",
				section: "Completed",
				text: "- one more entry",
			});
			expect(text(result)).toContain(`Appended to "Completed" in core/dailyContext.md`);
			expect(text(result)).toContain(path.join(BANK, "core/dailyContext.md"));
			expect(result.details).toEqual({ file: "core/dailyContext.md", section: "Completed" });
		});

		/**
		 * The branch that starts hunts: "File not found: knowledge/x.md" names the bank's
		 * layout and hides its location, so the file is nowhere and the agent has no root
		 * to doubt. Seen in a May session after `memory_append` answered `Section … not
		 * found in core/activeProjects.md`: the agent concluded the *path* was wrong, went
		 * to the harness `edit` with the same relative path, got ENOENT, and ran `pwd`.
		 */
		it("says in full where it looked when the file is not there", async () => {
			const result = await tools.get("memory_read").execute("tc-loc-3", { file: "knowledge/missing.md" });
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("File not found: knowledge/missing.md");
			expect(text(result)).toContain(path.join(BANK, "knowledge/missing.md"));
			// And it points at the tool that answers the real question, in the bank.
			expect(text(result)).toContain("memory_list");
		});

		it("says the file exists when only the section is missing", async () => {
			write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- x\n`);
			const result = await tools.get("memory_append").execute("tc-loc-4", {
				file: "core/dailyContext.md",
				section: "Key Decisions",
				text: "- y",
			});
			expect(result.isError).toBe(true);
			expect(text(result)).toContain('Section "Key Decisions" not found in core/dailyContext.md');
			// This one is not a location problem, and says so — the full path is what
			// proves it, because it points at a file that is definitely there.
			expect(text(result)).toContain(path.join(BANK, "core/dailyContext.md"));
			expect(text(result)).toContain("the file is there");
		});

		it("put the bank root in no result that is not about a place", async () => {
			// The announcement is for the four strings above, not a prefix on every
			// result: a read returns the file, and a line above it would not be the file.
			const read = await tools.get("memory_read").execute("tc-loc-5", { file: "knowledge/webhook-naming.md" });
			expect(text(read)).toBe(fs.readFileSync(path.join(BANK, "knowledge/webhook-naming.md"), "utf-8"));
			const search = await tools.get("memory_search").execute("tc-loc-6", { query: "webhook naming" });
			expect(text(search)).not.toContain(BANK);
			expect(text(search)).toContain("Path: knowledge/webhook-naming.md"); // still relative, by design
		});
	});

	it("say so when a search matches nothing", async () => {
		const result = await tools.get("memory_search").execute("tc-7", { query: "zzzzqqq-nothing-matches" });
		expect(result.content[0].text).toContain("No results found");
		// `semantic` joined the details when meaning-based search did: it says whether that half ran.
		expect(result.details).toMatchObject({ query: "zzzzqqq-nothing-matches", results: [], semantic: { used: false } });
		expect(result.isError).toBe(false);
	});
});

describe("first-run scaffold", () => {
	it("creates the two core files and an empty knowledge directory", () => {
		expect(fs.existsSync(path.join(BANK, "core", "activeProjects.md"))).toBe(true);
		expect(fs.existsSync(path.join(BANK, "core", "dailyContext.md"))).toBe(true);
		expect(fs.existsSync(path.join(BANK, "knowledge"))).toBe(true);
	});

	it("re-scaffolds a core file deleted since startup", async () => {
		// Scaffolding used to run only at module load, so a deleted daily file stayed
		// gone for the rest of the run and the block silently omitted it — while
		// doctor told the reader to do exactly this to fix it.
		fs.rmSync(path.join(BANK, "core", "dailyContext.md"), { force: true });
		await emit("session_start", { type: "session_start", reason: "reload" });
		expect(read("core/dailyContext.md")).toContain(dayString(new Date()));
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	});

	it("writes no trigger-word index", () => {
		// knowledge/index.csv was the pre-search routing table. Nothing reads it,
		// so nothing writes it — a stale one is inert, not consulted.
		expect(fs.existsSync(path.join(BANK, "knowledge", "index.csv"))).toBe(false);
	});
});

describe("heading aliases", () => {
	// Search has no synonym bridge, so a file only ever surfaces for words it
	// contains, and the heading is the heaviest place to put them: the whole file
	// text is indexed including its H1, and the H1 additionally gets its own index
	// field at 3x weight. Measured against these two tests: removing `title` from
	// the indexed fields inverts the ranking test below (score 6.90 -> 1.73), while
	// lowering the boost alone leaves it passing, because field-length
	// normalisation independently favours a short heading.
	it("injects a knowledge file whose only match is a heading alias", async () => {
		write(
			"knowledge/merge-policy.md",
			"# Merge policy (squash, rebase, trunk-based)\n\nEvery pull request lands as a single commit.\n",
		);
		await freshSession();
		const content = await injectedContent(userEvent("should I rebase or squash this"));
		expect(content).toContain("knowledge/merge-policy.md");
		expect(content).toContain("Every pull request lands as a single commit");
	});

	it("ranks a heading match above a body match of the same word", async () => {
		// "canary" appears exactly once in each file, in a different field.
		write(
			"knowledge/canary-rollout.md",
			"# Canary cohort rollout (dark launch, progressive delivery, staged)\n\nHold for a day before the rest.\n",
		);
		write("knowledge/incident-review.md", "# Incident review\n\nWe blamed the canary process.\n");
		await freshSession();
		const result = await tools.get("memory_search").execute("tc-8", { query: "canary" });
		const ranked = result.details.results.map((r: any) => r.path);
		expect(ranked[0]).toBe("knowledge/canary-rollout.md");

		// The margin, not only the order: order survives a title boost of 0.2, which a
		// mutation run found. Here one term occurs once in each field, and the observed
		// ratio is 4.18 at the current 3x (above 3 because the title is shorter, and short
		// documents are penalised less) against 1.06 at 0.2x. The bound sits between them,
		// so it fails on a real weakening without pretending to measure 3 exactly.
		const scores = result.details.results.map((r: any) => r.score);
		expect(scores[0] / scores[1], `title and body scored ${scores[0]} and ${scores[1]}`).toBeGreaterThan(1.5);
	});
});

describe("query terms", () => {
	const paths = (result: any) => (result.details.results ?? []).map((r: any) => r.path);

	it("does not let a one-character word prefix-match an unrelated file", async () => {
		write("knowledge/inventory.md", "# Inventory service\n\nStock levels and warehouse counts.\n");
		await freshSession();

		// Prefix search used to apply to every term, so the "i" in this prompt
		// prefix-matched "inventory" and pulled an unrelated knowledge file into the
		// context. The prompt is deliberately free of any other reachable word:
		// "stuck" would not do, because it fuzzy-matches "stock" at 0.2 tolerance,
		// which is the fuzzy feature working and a different question.
		const contentless = "how do i feel about this";
		const hit = await tools.get("memory_search").execute("qt-1", { query: contentless });
		expect(paths(hit), JSON.stringify(paths(hit))).not.toContain("knowledge/inventory.md");

		const single = await tools.get("memory_search").execute("qt-1b", { query: "i" });
		expect(paths(single), JSON.stringify(paths(single))).toEqual([]);

		const block = await injectedContent(userEvent(contentless));
		expect(block).not.toContain("knowledge/inventory.md");
	});

	it("does not admit a file merely because a function word is in it", async () => {
		// "the" is in this body, and in most prompts. Before function words were dropped
		// from queries, that was enough: an above-zero score is the only admission test,
		// and a prompt sharing no content word with the bank pulled a whole file in.
		write("knowledge/warehouse.md", "# Warehouse layout\n\nThe pallets are stored by aisle.\n");
		await freshSession();

		const noise = await tools.get("memory_search").execute("fw-1", { query: "when should the crew sweep it" });
		expect(paths(noise), JSON.stringify(paths(noise))).toEqual([]);

		// The same file is still found when a content word is present. A filter that
		// quietly cost recall would look like this test failing and nothing else.
		const real = await tools.get("memory_search").execute("fw-2", { query: "sweep the pallets" });
		expect(paths(real)).toContain("knowledge/warehouse.md");
	});

	it("says so when a query contained no searchable word", async () => {
		// "No results" for a query that was never run reads like "nothing is stored",
		// which is the answer that makes an agent write the note a second time. "do" is a
		// function word here, so this query has nothing left to search for.
		write("knowledge/warehouse.md", "# Warehouse layout\n\nThe pallets are stored by aisle.\n");
		await freshSession();

		const empty = await tools.get("memory_search").execute("fw-3", { query: "what did we do about it then" });
		expect(empty.details.results).toEqual([]);
		expect(empty.content[0].text).toContain("common word");

		const absent = await tools.get("memory_search").execute("fw-4", { query: "zzzzqqq-kafka-rebalance" });
		expect(absent.content[0].text).toBe('No results found for "zzzzqqq-kafka-rebalance"');
	});

	it("still matches a content word that sounds generic", async () => {
		// The line between a function word and a content word is the whole design, so it
		// needs a test on the other side: "file" and "change" are common, they carry the
		// meaning in a query like "what changed this file", and dropping them would turn
		// a stopword list into a relevance floor nobody can see.
		write("knowledge/changelog.md", "# Changelog policy (release notes)\n\nEvery user-visible change gets a file.\n");
		await freshSession();

		for (const query of ["file", "change"]) {
			const hit = await tools.get("memory_search").execute("cw-" + query, { query });
			expect(paths(hit), query).toContain("knowledge/changelog.md");
		}
	});

	it("still prefix-matches a long stem", async () => {
		const hit = await tools.get("memory_search").execute("qt-2", { query: "webh" });
		expect(paths(hit)).toContain("knowledge/webhook-naming.md");
	});

	it("still fuzzy-matches a typo in a long word", async () => {
		const hit = await tools.get("memory_search").execute("qt-3", { query: "webhoook naming" });
		expect(paths(hit)).toContain("knowledge/webhook-naming.md");
	});

	afterAll(() => {
		fs.rmSync(path.join(BANK, "knowledge", "inventory.md"), { force: true });
		freshSession();
	});
});

describe("size caps", () => {
	const huge = `# Huge planning budget\n\n${Array.from({ length: 800 }, (_, i) => `line ${i} planning budget`).join("\n")}\n`;

	it("withholds a record whose first 100 lines are an eighth of it, and says so", async () => {
		// §3.5. 100 of 803 lines is not a summary, it is an accident of the cap: what used
		// to arrive was the opening of a note, presented as the note. Past half withheld the
		// file is named instead, because a name the model can act on beats a fragment it has
		// to trust — and the tail of one of these files is its `## Source`.
		write("knowledge/huge.md", huge);
		await freshSession();
		const block = await injectedContent(userEvent("what about the planning budget"));

		expect(block).toContain("knowledge/huge.md");
		expect(block).toContain("is not in this prompt");
		expect(block).toContain('memory_read "knowledge/huge.md" for the whole file');
		expect(block).not.toContain("line 0 planning budget");
		expect(block).not.toContain("more lines not shown");
		// Nothing arrived, so the heading stops promising records and the recency note —
		// which is about disagreement between them — stays out of the prompt too.
		expect(block).toContain("## Relevant knowledge was not included");
		expect(block).not.toContain("Each file below is a point-in-time record");
	});

	it("still cuts a long file, with a marker, when most of it arrives", async () => {
		// The line cap on its own: 130 short lines is 3,400 characters, and 100 of them is
		// most of the file. That is a cut with a marker, not a withheld record: the share
		// that survives decides which, not the bare fact that a cap applied.
		const many = `# Many lines planning budget\n\n${Array.from({ length: 130 }, (_, i) => `line ${i} planning budget`).join("\n")}\n`;
		write("knowledge/many-lines.md", many);
		await freshSession();
		const block = await injectedContent(userEvent("what about the planning budget"));

		expect(block).toContain("line 0 planning budget");
		expect(block).not.toContain("line 129 planning budget");
		expect(block).toMatch(/more lines not shown — memory_read "knowledge\/many-lines\.md"/);
		// Scoped to this file: the 800-line file the previous test left behind matches the
		// same prompt and *is* withheld, and that is not what this test is about.
		expect(block).not.toMatch(/many-lines\.md[^\n]*is not in this prompt/);
		expect(block).toContain("Each file below is a point-in-time record");
		fs.rmSync(path.join(BANK, "knowledge", "many-lines.md"), { force: true });
	});

	it("caps an oversized core file, and says what it hid", async () => {
		// Knowledge was capped at 100 lines; core was capped at nothing, and core is
		// the part injected on every prompt regardless of topic. A 500-line day cost
		// 500 lines per prompt, silently, for the rest of the day.
		write(
			"core/dailyContext.md",
			`## ${dayString(new Date())}\n\n` +
				Array.from({ length: 500 }, (_, i) => `- note ${i}`).join("\n"),
		);
		await freshSession();
		const block = await injectedContent(userEvent("what is the capital of Zambia"));

		expect(block).toContain("## Daily Context");
		expect(block).toContain("- note 0\n");
		expect(block).not.toContain("- note 499");
		// One section, 500 lines: the section caps bite first, and they report characters,
		// because that is the unit a prompt pays for.
		const marker = block.match(/… ([\d,]+) characters \((\d+) lines\) of "[^"]+" not shown — memory_read "core\/dailyContext\.md"/);
		expect(marker, `no section marker in:\n${block.slice(-400)}`).not.toBeNull();
		expect(Number(marker![1].replace(/,/g, ""))).toBeGreaterThan(4000);
		expect(Number(marker![2])).toBeGreaterThan(400);
		expect(block.length).toBeLessThan(3000);
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	});

	// A line budget does not bound a cost. 150 lines is 13 KB when the entries run 90
	// characters, and `### Carried Forward` was 4,412 characters of today's 4,522 —
	// compliant, and the bulk of every prompt. So the caps are in characters too, and
	// they are per section: measured here, a section cap that keeps every section beats
	// a whole-file cut, because a whole-file cut drops whichever section the template
	// put last — `Context for Tomorrow`, the one that says what to do next.
	it("caps one fat section and keeps its neighbours", async () => {
		const fat = Array.from({ length: 200 }, (_, i) => `- task ${i} with enough words in it to be worth keeping`).join("\n");
		write(
			"core/dailyContext.md",
			`## ${dayString(new Date())}\n\n### Carried Forward\n- keep me\n\n### Tasks\n${fat}\n\n### Context for Tomorrow\n- and me\n`,
		);
		await freshSession();
		const block = await injectedContent(userEvent("what is the capital of Zambia"));

		expect(block).toContain("### Carried Forward\n- keep me");
		// The section a whole-file cut would have thrown away is still here.
		expect(block).toContain("### Context for Tomorrow\n- and me");
		expect(block).toContain("- task 0 ");
		expect(block).not.toContain("- task 199 ");
		expect(block).toMatch(/… [\d,]+ characters \(\d+ lines\) of "Tasks" not shown — memory_read "core\/dailyContext\.md"/);
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	});

	it("reserves the daily budget for the handoff before carried-forward material", async () => {
		const section = (name: string) => `### ${name}\n` + Array.from({ length: 40 }, (_, i) => `- ${name} ${i} ${"x".repeat(55)}`).join("\n") + "\n";
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n` + ["Carried Forward", "Completed", "Key Decisions", "In Progress", "Context for Tomorrow"].map(section).join("\n"));
		await freshSession();
		const block = await injectedContent(userEvent("what is the capital of Zambia"));
		expect(block).toContain("### Context for Tomorrow");
		expect(block).toContain("### In Progress");
		expect(block).toMatch(/section.*not shown/);
	});

	it("caps the file when every section is big, and names the ones it dropped", async () => {
		// Every section under the section cap can still add up past what a prompt should
		// pay. When the file cap bites it drops whole sections — never part of one, since
		// each is already self-limited — and says which, rather than stopping mid-file.
		const section = (n: string) =>
			`### ${n}\n` + Array.from({ length: 40 }, (_, i) => `- ${n} item ${i} with padding text`).join("\n") + "\n";
		const bloated = `## ${dayString(new Date())}\n\n` + ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map(section).join("\n");
		write("core/dailyContext.md", bloated);
		await freshSession();
		const block = await injectedContent(userEvent("what is the capital of Zambia"));

		const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
		const kept = names.filter((n) => block.includes(`### ${n}`));
		const dropped = names.filter((n) => !block.includes(`### ${n}`));
		expect(kept.length).toBeGreaterThanOrEqual(2);
		expect(dropped.length).toBeGreaterThan(0);
		// Smaller than the file it came from, and under the cap by more than the two
		// marker lines add: that is the whole job of this cap.
		expect(block.length).toBeLessThan(bloated.length);
		expect(block.length).toBeLessThan(8000);
		expect(block).toMatch(new RegExp(`more sections not shown \\(${dropped.map((d) => `"${d}"`).join(", ")}\\)`));
		expect(block).toMatch(/memory_read "core\/dailyContext\.md"/);
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	});

	it("leaves a day within the budgets whole", async () => {
		// The other half of a cap: a compliant file is never the one that gets cut. Sizes
		// here are the real bank's — 4.5-6.2 KB days, largest section 2.3 KB.
		const day = `## ${dayString(new Date())}\n\n` + [
			`### Carried Forward\n${Array.from({ length: 8 }, (_, i) => `- carried item ${i} with a normal amount of detail in it`).join("\n")}`,
			`### Completed\n${Array.from({ length: 12 }, (_, i) => `- done thing ${i} described in fifteen to twenty words as the rule asks`).join("\n")}`,
			`### Key Decisions\n${Array.from({ length: 10 }, (_, i) => `- decided ${i} for a reason that fits in one line`).join("\n")}`,
			`### Context for Tomorrow\n${Array.from({ length: 5 }, (_, i) => `- tomorrow ${i} needs a decision, not a guess`).join("\n")}`,
		].join("\n\n") + "\n";
		write("core/dailyContext.md", day);
		await freshSession();
		const block = await injectedContent(userEvent("what is the capital of Zambia"));

		expect(block).toContain("### Context for Tomorrow");
		expect(block).toContain("- tomorrow 4 needs a decision, not a guess");
		expect(block).not.toContain("not shown");
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	});

	it("leaves a read under the cap untouched and marks one over it", async () => {
		const whole = await tools.get("memory_read").execute("cap-1", { file: "core/activeProjects.md" });
		expect(whole.content[0].text).not.toContain("file not shown in full");
		const longLine = "😀".repeat(6000);
		write("knowledge/long-byte-line.md", `# Long\n${longLine}`);
		const byteCut = await tools.get("memory_read").execute("cap-byte", { file: "knowledge/long-byte-line.md" });
		expect(byteCut.details.byteLimited).toBe(true);
		expect(byteCut.content[0].text).toContain("file not shown in full");
		const update = await tools.get("memory_update").execute("cap-byte-update", { file: "knowledge/long-byte-line.md", content: "# replace" });
		expect(update.isError).toBe(true);

		write("knowledge/oversize.md", Array.from({ length: MAX_READ + 50 }, (_, i) => `r${i}`).join("\n"));
		const capped = await tools.get("memory_read").execute("cap-2", { file: "knowledge/oversize.md" });
		expect(capped.content[0].text).toContain("file not shown in full");
		expect(capped.content[0].text).toContain("targeted edit");
		expect(capped.details.hiddenLines).toBe(50);
	});

	afterAll(() => {
		fs.rmSync(path.join(BANK, "knowledge", "huge.md"), { force: true });
		fs.rmSync(path.join(BANK, "knowledge", "oversize.md"), { force: true });
		fs.rmSync(path.join(BANK, "knowledge", "deep-note.md"), { recursive: true, force: true });
		freshSession();
	});
});

describe("section append", () => {
	const daily = () => read("core/dailyContext.md");

	it("prefers the deeper heading when a file has both levels", async () => {
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n## Completed\n- h2 section\n\n### Completed\n- h3 section\n`);
		await tools.get("memory_append").execute("sec-1", { file: "core/dailyContext.md", section: "Completed", text: "- appended" });
		// The template writes `###`, so the `###` section is the live one. Before
		// this, one `###?` pattern took the first match in the file — the h2.
		expect(daily()).toMatch(/### Completed\n- h3 section\n- appended/);
		expect(daily()).toMatch(/## Completed\n- h2 section\n\n### Completed/);
	});

	it("treats a heading with regex metacharacters as literal text", async () => {
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### WIP (2026)\n- parenthesised\n\n### Completed\n- done\n`);
		const parens = await tools.get("memory_append").execute("sec-2", {
			file: "core/dailyContext.md", section: "WIP (2026)", text: "- added",
		});
		// Interpolated raw, "WIP (2026)" compiled to a capture group and matched
		// nothing, so this call used to report "Section not found".
		expect(parens.isError, parens.content[0].text).toBe(false);
		expect(daily()).toMatch(/### WIP \(2026\)\n- parenthesised\n- added/);

		// An unbalanced bracket used to throw SyntaxError out of the tool.
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### WIP [2026\n- bracketed\n`);
		const brackets = await tools.get("memory_append").execute("sec-3", {
			file: "core/dailyContext.md", section: "WIP [2026", text: "- added",
		});
		expect(brackets.isError, brackets.content[0].text).toBe(false);
		expect(daily()).toContain("- added");
	});

	it("still refuses a section that is not there", async () => {
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- only this\n`);
		const missing = await tools.get("memory_append").execute("sec-4", {
			file: "core/dailyContext.md", section: "Key Decisions", text: "- nope",
		});
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toContain('Section "Key Decisions" not found');
		expect(daily()).not.toContain("- nope");
	});
});

describe("a record too big to send (docs/rl-port-plan.md §3.5)", () => {
	// 300 lines of 35 characters: the line cap keeps 100 of them, which is a third of the
	// file. A third of a note, with no marker where the rest was, is the failure this rule
	// exists for — the model cannot tell a fragment from a summary.
	const fat = (title: string, aliases: string) =>
		`# ${title} (${aliases})\n\n${Array.from({ length: 300 }, (_, i) => `line ${i} of the wombat planning budget`).join("\n")}\n`;
	const WOMBAT = "knowledge/wombat-notes.md";
	const KDIR = path.join(BANK, "knowledge");
	// Which file is in the top three depends on every file the earlier suites left in the
	// bank, and this describe's whole subject is which files did not make it. So the
	// directory is emptied for these tests and put back afterwards.
	const stash = new Map<string, string>();
	beforeAll(() => {
		for (const f of fs.readdirSync(KDIR)) {
			const full = path.join(KDIR, f);
			if (!fs.statSync(full).isFile()) continue;
			stash.set(f, fs.readFileSync(full, "utf8"));
			fs.rmSync(full);
		}
	});
	afterAll(() => {
		for (const [f, text] of stash) fs.writeFileSync(path.join(KDIR, f), text);
	});
	// The newest inject line, since other suites write to the same month file.
	const lastInject = () => {
		const lines = fs.existsSync(logFilePath())
			? fs.readFileSync(logFilePath(), "utf8").split("\n").filter((l) => l.trim())
			: [];
		const evs = lines.map((l) => JSON.parse(l) as Record<string, any>).filter((e) => e.t === "inject");
		return evs[evs.length - 1];
	};

	beforeEach(() => {
		write("core/activeProjects.md", "# Active Projects\n\n## P0 — Critical\n- pi-memory3 (P0) - this repo\n");
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	});
	afterEach(async () => {
		// The config lives in memory between events: leaving debug on here is a gift to
		// the next suite, which asserts that debug prints nothing by default.
		fs.rmSync(path.join(BANK, "config.json"), { force: true });
		await freshSession();
	});

	it("names the withheld file and still sends the one that fits", async () => {
		write(WOMBAT, fat("Wombat budget", "wombat, planning, budget"));
		write("knowledge/wombat-sizing.md", "# Wombat sizing (wombat, planning, budget)\n\nA wombat is measured in hands.\n");
		await freshSession();
		const block = await injectedContent(userEvent("what is the wombat planning budget"));

		expect(block).toContain("A wombat is measured in hands.");
		// A record arrived, so the section keeps its heading and its recency note — the note
		// is about disagreement between records, and there is one to disagree with.
		expect(block).toContain("## Relevant Knowledge");
		expect(block).toContain("Each file below is a point-in-time record");
		expect(block).toMatch(/wombat-notes\.md \([\d,]+ characters\) is not in this prompt: \d+ %/);
		expect(block).toContain('memory_read "knowledge/wombat-notes.md" for the whole file');
		expect(block).not.toContain("line 0 of the wombat planning budget");
		fs.rmSync(path.join(BANK, WOMBAT), { force: true });
		fs.rmSync(path.join(BANK, "knowledge/wombat-sizing.md"), { force: true });
	});

	it("never sends a withheld file as a pointer to text this session has", async () => {
		// §3.1 replaces text the model already has with a line saying so. That is a claim
		// about the transcript, and for a withheld file the claim is false: it was named,
		// never sent. So the second prompt names it again rather than citing the first.
		write(WOMBAT, fat("Wombat budget", "wombat, planning, budget"));
		await freshSession();
		await injectedContent(userEvent("what is the wombat planning budget"));
		const second = await injectedContent(userEvent("and the wombat planning budget again"));

		expect(second).toContain("is not in this prompt");
		expect(second).not.toContain("unchanged since earlier");
		fs.rmSync(path.join(BANK, WOMBAT), { force: true });
	});

	it("refuses to replace a file this session has only seen the name of", async () => {
		// The whole-file write tool refuses when what it would drop has not been seen — the
		// same rule §3.2 applies to a truncated file, now with a stronger reason: here the
		// session read none of it.
		write(WOMBAT, fat("Wombat budget", "wombat, planning, budget"));
		await freshSession();
		await injectedContent(userEvent("what is the wombat planning budget"));

		const res = await tools.get("memory_update").execute("s5-1", {
			file: WOMBAT,
			content: "# Wombat budget\n\nreplaced from a name\n",
		});
		expect(res.isError, res.content[0].text).toBe(true);
		expect(res.content[0].text).toContain("only part of");
		fs.rmSync(path.join(BANK, WOMBAT), { force: true });
	});

	it("does not turn a partial view into a full view after append", async () => {
		write(WOMBAT, fat("Wombat budget", "wombat, planning, budget") + "\n## Notes\n- original\n");
		await freshSession();
		await injectedContent(userEvent("what is the wombat planning budget"));
		const appended = await tools.get("memory_append").execute("append-partial", { file: WOMBAT, section: "Notes", text: "- added" });
		expect(appended.isError).not.toBe(true);
		const res = await tools.get("memory_update").execute("replace-partial", { file: WOMBAT, content: "# replacement\n" });
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("only part of");
		fs.rmSync(path.join(BANK, WOMBAT), { force: true });
	});

	it("names it in the log as not-shown, with the characters it saved", async () => {
		// `in` is what the model saw. A log that counts a withheld file as injected makes
		// every number downstream — injected most often, cost per file — quietly wrong.
		write(WOMBAT, fat("Wombat budget", "wombat, planning, budget"));
		write("config.json", JSON.stringify({ log: true }));
		await freshSession();
		await emit("before_agent_start", userEvent("what is the wombat planning budget"));

		const inject = lastInject();
		expect(inject.in.map((h: any) => h.f)).not.toContain(WOMBAT);
		const out = inject.out.find((o: any) => o.f === WOMBAT);
		expect(out, JSON.stringify(inject.out)).toBeTruthy();
		expect(out.why).toMatch(/% of it is past the injection cap/);
		expect(inject.wc).toBe(1);
		expect(inject.wch).toBeGreaterThan(6000);
		// One line, however it was chosen — the bound that keeps an append atomic.
		for (const l of fs.readFileSync(logFilePath(), "utf8").split("\n").filter((x) => x.trim())) {
			expect(Buffer.byteLength(l)).toBeLessThan(2048);
		}
		fs.rmSync(path.join(BANK, WOMBAT), { force: true });
	});

	it("counts a withheld file in a log, and says so in /memory log stats", async () => {
		// A month file of its own, because other suites write to the same file. The last
		// line has no `wc` at all: that is a line from before the rule, and reading its
		// absence as \"none happened\" is the error the `legacy` counter exists for.
		fs.mkdirSync(path.join(BANK, "logs"), { recursive: true });
		const at = (n: number, extra: Record<string, unknown>) =>
			JSON.stringify({
				ts: `2026-01-0${n}T00:00:00.000Z`, t: "inject", p: "wombat planning", sid: "s", ch: `hash${n}`,
				cc: 1000, core: ["dailyContext.md"], in: [{ f: "knowledge/wombat-sizing.md", s: 9 }], out: [],
				chars: 12000 + n, ...extra,
			});
		fs.writeFileSync(logFilePath(), [at(1, { wc: 1, wch: 8000 }), at(2, { wc: 2, wch: 15000 }), at(3, {})].join("\n") + "\n");

		const { cost } = summarizeLog(logFilePath());
		expect(cost.measured).toBe(3);
		expect(cost.withheld).toBe(3);
		expect(cost.withheldChars).toBe(23000);
		// Sized from the prompts, not reconstructed: 11,000-odd of each line's 12,000
		// chars, and nearest-rank percentiles, so p50 of three values is the second.

		notifications.length = 0;
		await commands.get("memory").handler("log stats", ctx);
		const stats = notifications.map((n) => n.message).join("\n");
		expect(stats).toContain("knowledge per prompt: p50 11,002");
		expect(stats).toContain("withheld: 3 file(s) named instead of sent, 23,000 chars");
	});

	it("reports the rule in the debug line using the injector's own numbers", async () => {
		write(WOMBAT, fat("Wombat budget", "wombat, planning, budget"));
		write("config.json", JSON.stringify({ debug: true }));
		await freshSession();
		notifications.length = 0;
		await injectedContent(userEvent("what is the wombat planning budget"));

		const line = notifications.map((n) => n.message).find((m) => m.startsWith("memory →"));
		expect(line).toMatch(/wombat-notes\.md [\d.]+ \(not sent: \d+ % of it is past the cap\)/);
		fs.rmSync(path.join(BANK, WOMBAT), { force: true });
	});
});

describe("injection debug", () => {
	const resetConfig = async () => {
		fs.rmSync(path.join(BANK, "config.json"), { force: true });
		await freshSession();
	};

	const run = async (prompt = "how should I name webhooks") => {
		notifications.length = 0;
		await emit("before_agent_start", userEvent(prompt));
		return notifications.map((n) => n.message).filter((m) => m.startsWith("memory →"));
	};

	// Its own core fixtures: the debug line names the core files exactly, and
	// inheriting whatever an earlier suite left behind made these tests sensitive
	// to a long daily file written three describes away.
	beforeEach(() => {
		write("core/activeProjects.md", "# Active Projects\n\n## P0 — Critical\n- pi-memory3 (P0) - this repo\n");
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
		fs.rmSync(path.join(BANK, "config.json"), { force: true });
	});

	afterEach(resetConfig);

	it("prints nothing by default", async () => {
		expect(await run()).toEqual([]);
	});

	it("marks a capped core file in the debug line", async () => {
		write("core/activeProjects.md", Array.from({ length: 400 }, (_, i) => `project ${i}`).join("\n"));
		write("config.json", JSON.stringify({ debug: true }));
		await freshSession();
		await emit("before_agent_start", userEvent("anything"));
		const line = notifications.map((n) => n.message).filter((m) => m.startsWith("memory →"))[0];
		// The label names the unit, because "100" of what used to be the ambiguous part.
		expect(line).toMatch(/activeProjects\.md \([\d,]+ chars hidden\)/);
		write("core/activeProjects.md", "# Active Projects\n\n## P0 — Critical\n- pi-memory3 (P0) - this repo\n");
		fs.rmSync(path.join(BANK, "config.json"), { force: true });
		await freshSession();
	});

	it("names the injected files and the block size when on", async () => {
		write("config.json", JSON.stringify({ debug: true }));
		await freshSession();
		const [line] = await run();
		expect(line).toBeDefined();
		expect(line).toContain("core: activeProjects.md, dailyContext.md");
		expect(line).toContain("webhook-naming.md"); // knowledge path shortened, no directory
		expect(line).toMatch(/\d+\.\d/); // a score
		expect(line).toMatch(/\d+ lines, \d+ chars/);
	});

	it("explains what it turned down, using the injector's own rule", async () => {
		write("config.json", JSON.stringify({ debug: true }));
		await freshSession();
		// The prompt names the project as well, so activeProjects.md becomes a search
		// candidate. It is always refused — core files already ride along in full —
		// and the line has to say that rather than leave it looking like a miss.
		const [line] = await run("webhook naming rules for pi-memory3");
		expect(line).toContain("turned down:");
		expect(line).toContain("activeProjects.md");
		expect(line).toContain("core is injected directly");
	});

	it("says so when no prompt is available to search", async () => {
		write("config.json", JSON.stringify({ debug: true }));
		await freshSession();
		notifications.length = 0;
		await emit("before_agent_start", customEvent());
		const line = notifications.map((n) => n.message).find((m) => m.startsWith("memory →"));
		expect(line).toContain("skipped, no prompt (custom run)");
	});

	it("toggles and persists through the command", async () => {
		const cmd = commands.get("memory");
		notifications.length = 0;
		await cmd.handler("debug on", ctx);
		expect(JSON.parse(read("config.json")).debug).toBe(true);
		expect(notifications.some((n) => n.message.includes("Injection debug on"))).toBe(true);

		// The setting survives the session it was set in — no restart needed.
		expect((await run()).length).toBe(1);

		await cmd.handler("debug off", ctx);
		expect(JSON.parse(read("config.json")).debug).toBe(false);
		expect((await run())).toEqual([]);
	});

	it("keeps debug when writing injection frequencies, and reports state in /memory", async () => {
		const cmd = commands.get("memory");
		await cmd.handler("debug on", ctx);
		await cmd.handler("config history first-turn", ctx);
		const saved = JSON.parse(read("config.json"));
		expect(saved.debug).toBe(true);
		expect(saved.injection.history).toBe("first-turn");

		notifications.length = 0;
		await cmd.handler("", ctx);
		expect(notifications.some((n) => n.message.includes("debug:             on"))).toBe(true);
	});

	it("refuses a nonsense toggle value", async () => {
		notifications.length = 0;
		await commands.get("memory").handler("debug maybe", ctx);
		expect(notifications.some((n) => n.level === "error" && n.message.includes('Unknown value "maybe"'))).toBe(true);
		expect(fs.existsSync(path.join(BANK, "config.json"))).toBe(false);
	});
});

describe("day rollover", () => {
	const daysAgo = (n: number) => dayString(new Date(Date.now() - n * 864e5));

	function setMtimeDaysAgo(rel: string, days: number) {
		const t = Date.now() - days * 864e5;
		fs.utimesSync(path.join(BANK, rel), new Date(t), new Date(t));
	}

	function archivesFor(day: string): string[] {
		const dir = path.join(BANK, "history", "daily", day.slice(0, 7));
		return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(day)) : [];
	}

	it("archives a stale day from its heading, and resets the live file", async () => {
		const stale = daysAgo(2);
		write("core/dailyContext.md", `## ${stale}\n\n### Completed\n- archived by heading\n`);
		notifications.length = 0;
		await emit("session_start", { type: "session_start", reason: "reload" });

		expect(archivesFor(stale), "a file dated by heading must archive").toContain(`${stale}-dailyContext.md`);
		const archived = read(`history/daily/${stale.slice(0, 7)}/${stale}-dailyContext.md`);
		expect(archived).toContain("archived by heading");
		const live = read("core/dailyContext.md");
		expect(live).not.toContain("archived by heading");
		expect(live).toContain("### In Progress");
		expect(notifications.some((n) => n.message.includes("Archived previous dailyContext"))).toBe(true);
		expect(notifications.some((n) => n.level === "warning")).toBe(false);
	});

	it("still archives when the date heading was rewritten, using mtime, and warns", async () => {
		const stale = daysAgo(3);
		// An agent-authored shape extractDate cannot read: title first, date in prose.
		write("core/dailyContext.md", "# Daily Context\n\nDate: " + stale + "\n\n### Completed\n- survived the rewrite\n");
		setMtimeDaysAgo("core/dailyContext.md", 3);
		notifications.length = 0;
		await emit("session_start", { type: "session_start", reason: "reload" });

		// Before the fix this asserted nothing at all: the rollover bailed out, and
		// every following day overwrote the same file with no archive and no noise.
		expect(archivesFor(dayString(new Date(Date.now() - 3 * 864e5))).length, "mtime must drive the archive").toBe(1);
		const warning = notifications.find((n) => n.level === "warning");
		expect(warning?.message).toContain("no `## YYYY-MM-DD` heading");
		expect(read("core/dailyContext.md")).not.toContain("survived the rewrite");
	});

	it("leaves a file alone when its mtime is today", async () => {
		write("core/dailyContext.md", "# Daily Context\n\nundated but fresh\n");
		notifications.length = 0;
		await emit("session_start", { type: "session_start", reason: "reload" });
		expect(read("core/dailyContext.md")).toContain("undated but fresh");
		expect(notifications.some((n) => n.message.includes("Archived previous dailyContext"))).toBe(false);
	});

	it("keeps a carried item across a second rollover", async () => {
		write(
			"core/dailyContext.md",
			`## ${daysAgo(2)}\n\n### Completed\n- day one\n\n### Context for Tomorrow\n- ASK ABOUT THE VACATION\n`,
		);
		await emit("session_start", { type: "session_start", reason: "reload" });
		const after1 = read("core/dailyContext.md");
		expect(after1).toContain("ASK ABOUT THE VACATION");

		// A day passes. The agent added nothing to "Context for Tomorrow" — the item
		// is sitting in the "Carried Forward" section this rollover itself wrote.
		// Before the fix, rollover read only "Context for Tomorrow", so the item
		// survived exactly one day and then left with the archive.
		fs.writeFileSync(path.join(BANK, "core/dailyContext.md"), after1.replace(/^## .+$/m, `## ${daysAgo(1)}`));
		await emit("session_start", { type: "session_start", reason: "reload" });

		const after2 = read("core/dailyContext.md");
		expect(after2).toContain("### Carried Forward");
		expect(after2).toContain("ASK ABOUT THE VACATION");
	});

	it("is not blocked by the write gates: an over-cap day still rolls over", async () => {
		// The gates guard the two tools, not rollover, and this pins that it stays so: refusing
		// an archive would leave a stale day unarchivable forever, which is the worse failure —
		// its staleness warning then fires every turn. The cost of the exemption is visible
		// instead: /memory doctor warns on the size, and the next growing write meets the gate.
		const stale = daysAgo(2);
		const carried = Array.from(
			{ length: 90 },
			(_, i) => `- carried item ${i} with enough words in the line to make the section cost real characters`,
		).join("\n");
		expect(carried.length, "the fixture must really exceed the 6,000-character gate").toBeGreaterThan(6000);
		write("core/dailyContext.md", `## ${stale}\n\n### Carried Forward\n${carried}\n`);
		notifications.length = 0;
		await emit("session_start", { type: "session_start", reason: "reload" });

		expect(archivesFor(stale), "an over-cap day must still be archived").toContain(`${stale}-dailyContext.md`);
		const live = read("core/dailyContext.md");
		// Assert the reset happened, not just that bytes remain: the stale file would satisfy a
		// size/substring check unchanged if rollover bailed out on the way.
		expect(live, "the live file must carry today's date").toContain(`## ${dayString(new Date())}`);
		expect(live, "the stale day must have left the live file").not.toContain(stale);
		expect(live).toContain("### In Progress"); // the empty sections only the reset writes
		expect(live).toContain("carried item 89"); // nothing dropped to make the size fit
		expect(live.length, "the fresh file starts over the gate, and that is the accepted cost").toBeGreaterThan(6000);
		expect(notifications.some((n) => n.level === "error"), "rollover must not report a gate refusal").toBe(false);
	});

	it("leaves a daily file dated in the future alone", async () => {
		const tomorrow = dayString(new Date(Date.now() + 86_400_000));
		write("core/dailyContext.md", `## ${tomorrow}\n\n### Completed\n- notes written by a UTC clock\n`);
		await emit("session_start", { type: "session_start", reason: "reload" });

		// "!== today" archived these: a heading ahead of the local day is not a
		// finished day, and filing it put the notes under a date that has not come.
		expect(archivesFor(tomorrow), "a future date must not be treated as history").toEqual([]);
		expect(read("core/dailyContext.md")).toContain("notes written by a UTC clock");
		write("core/dailyContext.md", `## ${daysAgo(0)}\n\n### Completed\n- back to today\n`);
	});

	it("carries an item that appears in both sections only once", async () => {
		write(
			"core/dailyContext.md",
			`## ${daysAgo(2)}\n\n### Carried Forward\n- SHIPPED ON FRIDAY\n\n### Context for Tomorrow\n- SHIPPED ON FRIDAY\n`,
		);
		await emit("session_start", { type: "session_start", reason: "reload" });
		const live = read("core/dailyContext.md");
		expect(live.match(/SHIPPED ON FRIDAY/g)).toHaveLength(1);
	});
});

// ── usage log ────────────────────────────────────────────────────

describe("usage log", () => {
	const monthFile = () => path.join(BANK, "logs", `usage-${new Date().toISOString().slice(0, 7)}.jsonl`);
	const events = () => {
		if (!fs.existsSync(monthFile())) return [];
		return fs
			.readFileSync(monthFile(), "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	};
	const clean = () => {
		fs.rmSync(path.join(BANK, "logs"), { recursive: true, force: true });
		fs.rmSync(path.join(BANK, "config.json"), { force: true });
	};

	beforeEach(() => {
		clean();
		// Four files sharing the prompt's words, so the top-3 cut is guaranteed something
		// to reject and the log has a "why" to record. Four, not three: with three, the
		// bank in this test has nothing left over, and the assertion below only passed
		// because a different test had left a knowledge file behind.
		write("knowledge/widget-audit.md", "# Widget audits (widget, large, pixels, layout, bug)\n\nAudit any widget that is large. Pixels decide whether the layout is a bug.\n");
		write("knowledge/widget-sizing.md", "# Widget sizing (widget, pixels, oversized)\n\nSize widgets in rem. A widget over 800 pixels is a layout bug.\n");
		write("knowledge/widget-colours.md", "# Widget colours (widget, pixels, contrast)\n\nHold contrast at 4.5. Scale pixels, not tokens.\n");
		write("knowledge/widget-copy.md", "# Widget copy (widget, label, pixels)\n\nTwo words per label. A widget label over three pixels of tracking is unreadable.\n");
	});
	afterEach(async () => {
		clean();
		await freshSession();
	});

	it("writes nothing until it is turned on", async () => {
		await freshSession();
		await emit("before_agent_start", userEvent("how big should a widget be in pixels"));
		expect(fs.existsSync(path.join(BANK, "logs"))).toBe(false);
	});

	it("records the prompt, what went in, and why the rest did not", async () => {
		write("config.json", JSON.stringify({ log: true }));
		await freshSession();
		await emit("before_agent_start", userEvent("how large should a widget be before its pixels make it a layout bug"));

		const ev = events();
		expect(ev[0].t).toBe("session");
		// The header carries the caps and settings, so a later line can be replayed
		// against a fixture bank without guessing how the session was configured.
		// The header carries every cap the injector applies, §3.5's share included, so a
		// log line can be replayed against a fixture bank without guessing the constants.
		expect(ev[0].caps).toEqual({ files: 3, lines: 100, fileChars: 6000, core: 300, coreChars: 8000, section: { lines: 60, chars: 2500 }, withheld: 0.5 });

		const inject = ev.find((e) => e.t === "inject");
		expect(inject.p).toContain("widget");
		expect(inject.in.map((h: any) => h.f)).toContain("knowledge/widget-sizing.md");
		expect(inject.core).toEqual(expect.arrayContaining(["activeProjects.md", "dailyContext.md"]));
		expect(inject.ms).toBeLessThan(1000);
		expect(inject.out.length, "the top-3 cut should have left a candidate behind").toBeGreaterThan(0);
		for (const o of inject.out) {
			expect(typeof o.f).toBe("string");
			expect(typeof o.s).toBe("number");
			// The rule's own reason for a knowledge file is the word "knowledge", which is
			// why the log names the cut instead. Caught by reading a real log line.
			expect(o.why, "a rejection with the bare category name is not usable").not.toBe("knowledge");
			expect(o.why.length, o.why).toBeGreaterThan(3);
		}
		expect(inject.out.some((o: any) => o.why.includes("top")), JSON.stringify(inject.out)).toBe(true);
	});

	it("keeps prompt text out when asked to, and keeps the decisions", async () => {
		write("config.json", JSON.stringify({ log: true, logPrompts: false }));
		await freshSession();
		await emit("before_agent_start", userEvent("how large should a widget be"));
		const inject = events().find((e) => e.t === "inject");
		expect(inject.p).toBe("[redacted]");
		expect(inject.in.length).toBeGreaterThan(0);
	});

	it("prices what a prompt cost twice, so the cost has a number in it", async () => {
		// The whole point of `cc`/`ch` is that "did the last prompt pay for this text
		// already?" is answerable from the log and not only from a session dump —
		// docs/injection-cost-design.md §2.1 measured 39 % of injected bytes that way.
		// Big enough that a pointer is worth more than the text it replaces: the guard in
		// deltaSection() refuses the trade below 200 characters, and this bank's core is
		// otherwise a couple of lines.
		write("core/dailyContext.md", `## Daily Context\n\n${"A long-running note about widget sizing.\n".repeat(40)}\n`);
		write("config.json", JSON.stringify({ log: true }));
		await freshSession();
		await emit("before_agent_start", userEvent("how large should a widget be in pixels"));
		await emit("before_agent_start", userEvent("and what about its label"));

		const injects = events().filter((e) => e.t === "inject");
		expect(injects.length).toBe(2);
		for (const e of injects) {
			expect(e.ch, "core hash").toMatch(/^[0-9a-f]{8}$/);
			expect(e.cc).toBeGreaterThan(0);
			expect(e.cc, "core cannot be bigger than the block").toBeLessThanOrEqual(e.chars);
			expect(e.sid, "two processes share one file").toBeTruthy();
		}
		// Two prompts, one session, nothing edited: §3.1 means the second one must not pay
		// for the core again, and the log has to show that it did not. `coreRepeated` is the
		// regression guard for exactly this — before §3.1 it was 39 % of injected bytes.
		expect(injects[1].ch, "a re-sent core would hash the same").not.toBe(injects[0].ch);
		expect(injects[1].pt, "the unchanged core came back as a body, not a pointer").toBeGreaterThan(0);
		expect(injects[1].sv).toBeGreaterThan(0);
		// The long dailyContext became a pointer; the two-line activeProjects did not, which
		// is the 200-character guard: a pointer is cheaper than a paragraph, not than a line.
		expect(injects[1].core, JSON.stringify(injects[1].core)).toContain("dailyContext.md (pointer)");
		expect(injects[1].core, JSON.stringify(injects[1].core)).toContain("activeProjects.md");
		expect(injects[1].cc, "a prompt of pointers costs less than a prompt of core").toBeLessThan(injects[0].cc);

		const { cost } = summarizeLog(monthFile());
		expect(cost.measured).toBe(2);
		expect(cost.coreRepeated).toBe(0);
		expect(cost.pointers).toBe(injects[1].pt);
		expect(cost.pointerChars).toBe(injects[1].sv);
		// Prompt text is on here, so the tail slots are measurable per term.
		expect(cost.normSamples).toBeGreaterThan(0);

		notifications.length = 0;
		await commands.get("memory").handler("log stats", ctx);
		const stats = notifications.map((n) => n.message).join("\n");
		expect(stats, "the re-send number has to reach the human").toContain("re-sent core 0x");
		expect(stats, "and so does the number for what delta injection saved").toContain(`${injects[1].pt} section(s) sent by reference`);
		expect(stats).toContain("scored nothing");
	});

	it("counts an old line as old instead of counting it as a change", async () => {
		// Lines written before `ch` existed cannot show a repeat, and silently reading
		// them as "the core changed" would put the baseline in the wrong direction.
		fs.mkdirSync(path.join(BANK, "logs"), { recursive: true });
		const older = JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", t: "inject", p: "widget", core: ["dailyContext.md"], in: [{ f: "knowledge/widget-sizing.md", s: 0 }], chars: 900 });
		const newer = JSON.stringify({ ts: "2026-01-02T00:00:00.000Z", t: "inject", p: "widget", sid: "x1", ch: "deadbeef", cc: 400, core: ["dailyContext.md"], in: [{ f: "knowledge/widget-sizing.md", s: 3 }], chars: 1200 });
		const again = JSON.stringify({ ts: "2026-01-03T00:00:00.000Z", t: "inject", p: "widget", sid: "x1", ch: "deadbeef", cc: 400, core: ["dailyContext.md"], in: [{ f: "knowledge/widget-sizing.md", s: 3 }], chars: 1200 });
		fs.writeFileSync(monthFile(), `${older}\n${newer}\n${again}\n`);

		const { cost } = summarizeLog(monthFile());
		expect(cost.legacy).toBe(1);
		expect(cost.measured).toBe(2);
		expect(cost.coreRepeated).toBe(1);
		expect(cost.coreRepeatedChars).toBe(400);
		// The same knowledge set, twice, is the other half of the same waste.
		expect(cost.knowledgeRepeated).toBe(1);
		expect(cost.knowledgeRepeatedChars).toBe(800);
		// One injected file per line here, so there is no rank-2 slot to price a floor on.
		expect(cost.normSamples).toBe(0);
	});

	it("says so when the filler cannot be measured", async () => {
		fs.mkdirSync(path.join(BANK, "logs"), { recursive: true });
		const line = JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", t: "inject", p: "[redacted]", sid: "y", ch: "aaaaaaaa", cc: 10, in: [{ f: "a.md", s: 40 }, { f: "b.md", s: 1 }], chars: 500 });
		fs.writeFileSync(monthFile(), `${line}\n`);
		const { cost } = summarizeLog(monthFile());
		// Tail slot, no prompt text: it is unmeasurable, and "0" would read as "no filler".
		expect(cost.normSamples).toBe(0);
		expect(cost.normUnavailable).toBe(1);
		expect(cost.normTailP50).toBeNull();
	});

	it("writes one bounded line per event, whatever the prompt size", async () => {
		// Two sessions share one log file. One append is one write, and that only keeps
		// lines intact while a line stays small — so a 50 KB prompt must not become a
		// 50 KB line.
		write("config.json", JSON.stringify({ log: true }));
		await freshSession();
		await emit("before_agent_start", userEvent("widget pixels ".repeat(4000)));

		const raw = fs.readFileSync(monthFile(), "utf-8").trim().split("\n");
		expect(raw.length).toBe(events().length);
		expect(Math.max(...raw.map((l) => Buffer.byteLength(l)))).toBeLessThan(2048);
	});

	it("records a search, and a write it refused", async () => {
		write("config.json", JSON.stringify({ log: true }));
		await freshSession();
		await tools.get("memory_search").execute("log-1", { query: "widget sizing" });

		// A refused write is the interesting event: it means two writers met.
		await tools.get("memory_read").execute("log-2", { file: "knowledge/widget-sizing.md" });
		write("knowledge/widget-sizing.md", "# Widget sizing (widget, pixels)\n\nChanged on disk by hand.\n");
		await tools.get("memory_update").execute("log-3", { file: "knowledge/widget-sizing.md", content: "# Widget sizing\n\nMine now.\n" });

		const ev = events();
		const search = ev.find((e) => e.t === "search");
		expect(search.q).toBe("widget sizing");
		expect(search.n).toBeGreaterThan(0);
		const refused = ev.find((e) => e.t === "write");
		expect(refused).toMatchObject({ f: "knowledge/widget-sizing.md", refused: "stale-base" });
	});

	it("starts recording when the command turns it on, with no new session", async () => {
		await freshSession();
		notifications.length = 0;
		await commands.get("memory").handler("log on", ctx);
		expect(JSON.parse(read("config.json")).log).toBe(true);

		await emit("before_agent_start", userEvent("how large should a widget be"));
		expect(events().some((e) => e.t === "inject")).toBe(true);

		await commands.get("memory").handler("log prompts off", ctx);
		expect(JSON.parse(read("config.json")).logPrompts).toBe(false);
		expect(JSON.parse(read("config.json")).log).toBe(true);

		notifications.length = 0;
		await commands.get("memory").handler("log stats", ctx);
		expect(notifications.some((n) => n.message.includes("events in usage-"))).toBe(true);

		await commands.get("memory").handler("log off", ctx);
		notifications.length = 0;
		await commands.get("memory").handler("", ctx);
		expect(notifications.some((n) => n.message.includes("log:               off"))).toBe(true);
	});

	it("refuses a nonsense log toggle value", async () => {
		notifications.length = 0;
		await commands.get("memory").handler("log maybe", ctx);
		expect(notifications.some((n) => n.level === "error" && n.message.includes('Unknown value "maybe"'))).toBe(true);
		expect(fs.existsSync(path.join(BANK, "logs"))).toBe(false);
	});

	it("counts a line it cannot parse instead of failing on it", () => {
		const file = path.join(BANK, "logs", "broken.jsonl");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{"t":"inject","in":[{"f":"a.md"}]}\nnot json {"t":\n{"t":"search","n":0}\n');
		const s = summarizeLog(file);
		expect(s.events).toBe(2);
		expect(s.broken).toBe(1);
		expect(s.byType.search).toBe(1);
		expect(s.injectedNothing).toBe(0);
	});

	it("stops at the size cap instead of filling the disk", () => {
		const file = logFilePath(new Date(Date.UTC(2001, 0, 1)));
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
		const res = logEvent({ enabled: true, prompts: true }, { t: "inject" }, new Date(Date.UTC(2001, 0, 1)));
		expect(res.written).toBe(false);
		expect(res.reason).toContain("bytes");
		fs.rmSync(file, { force: true });
	});
});

// ── /memory doctor ───────────────────────────────────────────────

describe("/memory doctor", () => {
	const day = (n: number) => dayString(new Date(Date.now() - n * 86_400_000));

	// Deliberately does NOT start a session first: session_start runs rollover,
	// which repairs a stale daily file and would erase what a test just planted.
	const doctor = async () => {
		notifications.length = 0;
		await commands.get("memory").handler("doctor", ctx);
		const last = notifications[notifications.length - 1];
		return { text: last.message as string, level: last.level };
	};

	// The bank is only reset inside the rollover describe, so doctor needs its
	// own: otherwise it reports whatever the rollover tests archived.
	beforeEach(async () => {
		fs.rmSync(BANK, { recursive: true, force: true });
		fs.mkdirSync(BANK, { recursive: true });
		write("core/activeProjects.md", "# Active Projects\n\n## P0 — Critical\n- pi-memory3 (P0) - this repo\n");
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
		write("knowledge/webhook-naming.md", "# Webhook Naming\n\nWebhooks are named `past.<entity>.<event>`.\n");
		await freshSession();
	});

	it("refuses on an abandoned lock and recovers after manual removal", async () => {
		const file = "core/dailyContext.md";
		const full = path.resolve(BANK, file);
		// The bank-relative target has one identity through every configured root alias.
		const lock = path.join(BANK, ".write-locks", createHash("sha256").update(file).digest("hex") + ".lock");
		// A separate process holds the same mkdir lock and is killed without cleanup.
		// This exercises an abandoned directory, not the extension's acquisition code.
		const child = spawn(process.execPath, ["-e", "require('fs').mkdirSync(process.argv[1], {recursive:true}); console.log('ready'); setInterval(() => {}, 1000)", lock]);
		await new Promise<void>((resolve, reject) => {
			child.stdout.once("data", () => resolve());
			child.once("error", reject);
		});
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
		try {
			const result = await tools.get("memory_append").execute("busy", { file, section: "Completed", text: "- no write" });
			expect(result.isError).toBe(true);
			expect(result.details.refused).toBe("lock-busy");
			expect(fs.readFileSync(full, "utf8")).not.toContain("- no write");
		} finally { fs.rmdirSync(lock); }
		const result = await tools.get("memory_append").execute("recovered", { file, section: "Completed", text: "- recovered" });
		expect(result.isError).not.toBe(true);
	}, 8000);

	it("lists all commands in status and help, and reports unknown commands", async () => {
		for (const arg of ["", "status", "help", "typo"]) {
			notifications.length = 0;
			await commands.get("memory").handler(arg, ctx);
			const message = notifications[notifications.length - 1];
			for (const command of ["/memory help", "/memory doctor", "/memory refresh", "/memory config", "/memory debug", "/memory log", "/memory log prompts"]) {
				expect(message.message).toContain(command);
			}
			if (arg === "typo") expect(message.level).toBe("error");
		}
	});

	it("flags nothing on a healthy bank", async () => {
		const { text, level } = await doctor();
		expect(text).toContain("nothing to flag");
		expect(text).not.toContain("warn  ");
		expect(level).toBe("info");
	});

	it("says when a long daily file is past the injection cap, not just the budget", async () => {
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n` + Array.from({ length: 320 }, (_, i) => `l${i}`).join("\n"));
		const { text } = await doctor();
		expect(text).toContain("over the 150-line budget and the 300-line injection cap");
	});

	it("names the section it trims, because the marker alone does not say why", async () => {
		// A 4 KB section under a 6 KB file budget is invisible to every other check and
		// still loses two thirds of itself on every prompt.
		write(
			"core/dailyContext.md",
			`## ${dayString(new Date())}\n\n### Carried Forward\n` +
				Array.from({ length: 40 }, (_, i) => `- an old item ${i} with a hundred and fifty characters of detail in it, kept forever`).join("\n") +
				`\n\n### Context for Tomorrow\n- one line\n`,
		);
		const { text } = await doctor();
		expect(text).toMatch(/dailyContext\.md has a [\d,]+-character section \("Carried Forward"\), trimmed to 2,500 in every prompt/);
	});

	it("flags a daily file dated in the future, without calling it stale", async () => {
		const tomorrow = dayString(new Date(Date.now() + 86_400_000));
		write("core/dailyContext.md", `## ${tomorrow}\n\n### Completed\n- future\n`);
		const { text } = await doctor();
		expect(text).toContain(`dated ${tomorrow}, a future day`);
		// The past-day wording promises an archive that will now never happen.
		expect(text).not.toContain("rollover will archive it");
	});

	it("reports what it looked at, including notes that are not problems", async () => {
		const { text } = await doctor();
		expect(text).toContain("no config.json"); // true: defaults, not a fault
		expect(text).toContain("no daily archives yet");
		expect(text).toMatch(/bank size: [\d,]+ characters across \d+ files/);
	});

	it("warns when dailyContext.md has no date heading — rollover is guessing", async () => {
		write("core/dailyContext.md", "# Notes\n\nno heading at all\n");
		const { text, level } = await doctor();
		expect(text).toContain("has no `## YYYY-MM-DD` heading");
		expect(text).toContain("rollover is guessing");
		expect(level).toBe("warning");
	});

	it("warns when dailyContext.md is dated in the past", async () => {
		write("core/dailyContext.md", `## ${day(1)}\n\n- stale\n`);
		const { text } = await doctor();
		expect(text).toContain(`dated ${day(1)}, not ${day(0)}`);
	});

	it("warns when a knowledge file is big enough to be truncated at injection", async () => {
		write("knowledge/big.md", `# Big\n\n${Array.from({ length: 140 }, (_, i) => `- line ${i}`).join("\n")}`);
		const { text } = await doctor();
		expect(text).toContain("knowledge/big.md is 142 lines");
		expect(text).toContain("injection truncates it at 100");
	});

	it("names the character cap when a file is short in lines and long in characters", async () => {
		// 40 lines is nowhere near the 100-line cap and 9,600 characters is well past the 6,000-
		// character one — the shape of a bank file whose bullets are paragraphs. A line-only check
		// calls this file healthy while every prompt loses a third of it.
		const para = "a paragraph-shaped bullet with a hundred and fifty characters of detail in it, twice over, so the file is short in lines and long in characters";
		write("knowledge/paragraphs.md", `# Paragraphs\n\n${Array.from({ length: 55 }, (_, i) => `- ${para} ${i}`).join("\n")}`);
		const { text } = await doctor();
		expect(text).toMatch(/knowledge\/paragraphs\.md is [\d,]+ characters — injection cuts it at the 6,000-character cap/);
		// Not the line wording: 41 lines would tell the reader the file is fine.
		expect(text).not.toMatch(/paragraphs\.md is \d+ lines/);
	});

	it("says so when a file is past the point where injection sends nothing of it", async () => {
		// Ten 2,000-character lines: the character cap walks back to the last newline before 6,000,
		// which is near the top — so §3.5 withholds the file whole, and "truncated" would be a lie.
		write("knowledge/wall.md", `# Wall\n\n${Array.from({ length: 10 }, (_, i) => "x".repeat(2000) + ` ${i}`).join("\n")}`);
		const { text } = await doctor();
		expect(text).toMatch(/knowledge\/wall\.md is [\d,]+ characters — [5-9][0-9] % of it is past the cap, so injection sends its name/);
		expect(text).toContain("§3.5");
	});

	it("reports actual outcomes for both-cap and small character cuts", async () => {
		write("knowledge/both.md", "# Both\n" + Array.from({ length: 200 }, () => "x".repeat(120)).join("\n"));
		write("knowledge/slightly.md", "# Slightly\n" + "x".repeat(6100));
		const { text } = await doctor();
		expect(text).toMatch(/knowledge\/both\.md.*injection sends its name/);
		expect(text).toMatch(/knowledge\/slightly\.md.*sent whole/);
	});

	it("warns when a core file blows its own line budget", async () => {
		write("core/dailyContext.md", `## ${day(0)}\n\n${Array.from({ length: 160 }, (_, i) => `- item ${i}`).join("\n")}`);
		const { text } = await doctor();
		expect(text).toContain("over the 150-line budget");
	});

	it("warns when knowledge has gone stale", async () => {
		const old = new Date(Date.now() - 40 * 86_400_000);
		fs.utimesSync(path.join(BANK, "knowledge", "webhook-naming.md"), old, old);
		const { text } = await doctor();
		expect(text).toContain("last written 40 days ago");
		expect(text).toContain("quiet for a month");
	});

	it("refreshes edited documents even when the number of files is unchanged", async () => {
		write("knowledge/webhook-naming.md", "# Quokka orchestra\n\nA unique quokka orchestra record.\n");
		const before = await tools.get("memory_search").execute("refresh-before", { query: "quokka orchestra" });
		expect(before.content[0].text).toContain("knowledge/webhook-naming.md"); // incremental reconciliation already found the edit
		await commands.get("memory").handler("refresh", ctx);
		const after = await tools.get("memory_search").execute("refresh-after", { query: "quokka orchestra" });
		expect(after.content[0].text).toContain("knowledge/webhook-naming.md");
	});

	it("reconciles external additions before the doctor compares counts", async () => {
		// Written after the index was built; doctor now refreshes its in-memory view.
		write("knowledge/outside.md", "# Outside\n\nadded with an editor\n");
		const { text } = await doctor();
		expect(text).toContain("index matches the bank (4 documents)");
		expect(text).not.toContain("index holds");
	});

	it("warns when config.json cannot be parsed", async () => {
		write("config.json", "{not json");
		const { text } = await doctor();
		expect(text).toContain("not valid JSON");
		expect(text).toContain("defaults are in use");
	});

	it("warns when nothing has been captured yet", async () => {
		fs.rmSync(path.join(BANK, "knowledge"), { recursive: true, force: true });
		const { text } = await doctor();
		expect(text).toContain("no knowledge files");
	});

	it("flags files deeper than the indexer reads", async () => {
		// Past INDEX_MAX_DEPTH the file is on disk for good and never searched, so
		// say which of the two invisible cases you are in.
		write("knowledge/a/b/c/d/e/deep.md", "# Deep\n\nnever indexed\n");
		await freshSession(); // rebuild so the index-vs-disk count check itself passes
		const { text } = await doctor();
		expect(text).toContain("below the indexer's reach");
		expect(text).toContain("never searched");
	});

	// The overlap check exists because a reversed decision written as a second file
	// gets retrieved alongside the original, and the older one can rank first.
	describe("topic overlap", () => {
		const day = (n: number) => dayString(new Date(Date.now() - n * 86_400_000));
		const stamp = (rel: string, daysAgo: number) => {
			const t = new Date(Date.now() - daysAgo * 86_400_000);
			fs.utimesSync(path.join(BANK, rel), t, t);
		};

		it("flags a decision that was rewritten as a second file", async () => {
			write("knowledge/app-background.md", "# App background (background, color, colour, app background, UI)\n\nThe app background must be blue.\n");
			stamp("knowledge/app-background.md", 1);
			write("knowledge/app-colour-green.md", "# App colour green (app colour, green, background)\n\nUse green for the app background.\n");
			await freshSession(); // the index is what answers the question
			const { text } = await doctor();
			expect(text).toContain("look like one topic");
			expect(text).toContain("app-background.md");
			expect(text).toContain("app-colour-green.md");
			// Dates, because which of the two still stands is the whole question.
			expect(text).toContain(`(${day(1)} vs ${day(0)})`);
			expect(text).toContain("the older can rank first");
		});

		it("does not flag different topics that share an ordinary word", async () => {
			// Measured at 0.07 against the 0.35 threshold: the false-positive floor
			// this check has to stay under.
			write("knowledge/cache-policy.md", "# Cache policy (cache, caching, ttl, policy)\n\nCache policy: five minutes.\n");
			write("knowledge/deploy-policy.md", "# Deploy policy (deploy, rollout, policy, approval)\n\nDeploy policy: approvals required.\n");
			await freshSession();
			const { text } = await doctor();
			expect(text).not.toContain("look like one topic");
			expect(text).toContain("no two knowledge files look like the same topic");
		});

		it("flags a near-duplicate", async () => {
			write("knowledge/tone.md", "# Proposal tone (proposals, pitches, hedging)\n\nConfident and direct, no hedging words.\n");
			write("knowledge/proposal-tone.md", "# Proposal tone (proposals, pitches, hedging)\n\nBe confident and direct. Avoid hedging words.\n");
			await freshSession();
			const { text } = await doctor();
			expect(text).toContain("look like one topic");
		});

		it("caps how many pairs it reports and says how many it hid", async () => {
			for (const name of ["tone-a.md", "tone-b.md", "tone-c.md", "tone-d.md"]) {
				write(`knowledge/${name}`, "# Proposal tone (proposals, pitches, hedging)\n\nConfident, no hedging.\n");
			}
			await freshSession();
			const { text } = await doctor();
			expect(text.match(/look like one topic/g)?.length).toBe(3); // four files, six pairs
			expect(text).toContain("and 3 more possible topic overlaps");
		});
	});

	it("leaves /memory itself free of health reporting", async () => {
		// Deliberate split: /memory is "is it loaded", doctor is "is it working".
		write("knowledge/big.md", `# Big\n\n${Array.from({ length: 140 }, (_, i) => `- line ${i}`).join("\n")}`);
		notifications.length = 0;
		await commands.get("memory").handler("", ctx);
		const status = notifications.map((n) => n.message).join("\n");
		expect(status).toContain("knowledge files:");
		expect(status).not.toContain("warn");
		expect(status).not.toContain("truncates");
	});
});

// ── memory_list ──────────────────────────────────────────────────

describe("memory_list", () => {
	// A day is local here (see config.test.ts), so fixtures must not use UTC: between midnight
	// and the UTC offset the two differ by a day, and a fixture dated tomorrow is a stale file
	// as far as rollover is concerned — which is how this suite went red on its own at 19:00.
	const ym = () => dayString(new Date()).slice(0, 7);
	const today = () => dayString(new Date());

	const list = async (directory?: string) => {
		const r = await tools.get("memory_list").execute("tc-list", directory === undefined ? {} : { directory });
		return { text: r.content[0].text as string, details: r.details as any, isError: !!r.isError };
	};

	beforeEach(async () => {
		fs.rmSync(BANK, { recursive: true, force: true });
		fs.mkdirSync(BANK, { recursive: true });
		write("core/activeProjects.md", "# Active\n\n- pi-memory3\n");
		write("core/dailyContext.md", `## ${today()}\n\n- x\n`);
		write("knowledge/webhook-naming.md", "# Webhook naming\n");
		write(`history/daily/${ym()}/${today()}-dailyContext.md`, "## done\n");
		write("knowledge/team/platform/arch.md", "# Arch\n");
		await freshSession();
	});

	it("lists archived daily files from the root", async () => {
		const { text } = await list();
		expect(text).toContain(`history/daily/${ym()}/${today()}-dailyContext.md`);
	});

	it("answers the same question wherever the walk starts", async () => {
		// The depth counter used to restart per call, so this file was listed from
		// "knowledge" and hidden from the root — an omission that reads as absence.
		const fromRoot = await list();
		const fromAbove = await list("knowledge");
		expect(fromRoot.text).toContain("knowledge/team/platform/arch.md");
		expect(fromAbove.text).toContain("knowledge/team/platform/arch.md");
	});

	it("reaches a tree far deeper than either cap allowed", async () => {
		write("knowledge/a/b/c/d/e/f/g/h/i/deep.md", "# Deep\n");
		const { text } = await list();
		expect(text).toContain("knowledge/a/b/c/d/e/f/g/h/i/deep.md");
	});

	it("bounds the listing by entry count and says what it hid", async () => {
		// Shallow and wide is the shape the old depth cap could not bound: every one
		// of these used to be listable, and so was all 600 of them at once.
		for (let i = 0; i < 600; i++) write(`knowledge/wide/note-${i}.md`, `# note ${i}\n`);
		const { text, details } = await list();
		expect(details.entries.length).toBe(500);
		expect(details.hiddenEntries).toBeGreaterThan(100);
		expect(text).toContain("more entries not shown");
		expect(text).toContain("narrow the walk");
	});

	it("does not descend a symlinked directory", async () => {
		// Why the uncapped walk cannot loop: readdir reports a symlink to a
		// directory as a link, so it is listed and never entered.
		try {
			fs.symlinkSync(BANK, path.join(BANK, "knowledge", "loop"));
		} catch {
			return; // platform without symlink support
		}
		const { text } = await list();
		expect(text).toContain("knowledge/loop");
		expect(text).not.toContain("knowledge/loop/");
	});

	it("still reports a missing directory as missing", async () => {
		const { text, isError } = await list("nope");
		expect(isError).toBe(true);
		expect(text).toContain("Directory not found: nope");
	});

	it("reports an empty directory as empty", async () => {
		fs.mkdirSync(path.join(BANK, "knowledge", "empty"), { recursive: true });
		const { text } = await list("knowledge/empty");
		expect(text).toBe("(empty)");
	});

	it("lists an unreadable subdirectory without failing the whole listing", async () => {
		const locked = path.join(BANK, "knowledge", "locked");
		fs.mkdirSync(locked, { recursive: true });
		fs.writeFileSync(path.join(locked, "secret.md"), "# secret\n");
		fs.chmodSync(locked, 0o000);
		let readable = true;
		try {
			fs.readdirSync(locked); // runs as a user that can read anything
		} catch {
			readable = false;
		}
		const listing = readable ? null : await list(); // must not throw
		fs.chmodSync(locked, 0o755); // always restore: a 000 dir left behind breaks teardown
		if (readable || !listing) return;
		expect(listing.text).toContain("knowledge/locked/");
		expect(listing.text).not.toContain("knowledge/locked/secret.md");
	});

	it("lists in lexical order, not creation order", async () => {
		// Created out of order on purpose: filesystem order is neither stable nor
		// lexical, and the agent should not have to see the same bank differently.
		for (const name of ["zeta.md", "alpha.md", "mid.md"]) write(`knowledge/order/${name}`, `# ${name}\n`);
		const { text } = await list("knowledge/order");
		expect(text.split("\n")).toEqual(["knowledge/order/alpha.md", "knowledge/order/mid.md", "knowledge/order/zeta.md"]);
	});
});

// ── prompt guidelines ────────────────────────────────────────────

describe("refusing to overwrite what this session has not seen", () => {
	// A second Pi session, a hand edit in an editor, and this extension's own day
	// rollover all look the same way: the file on disk is no longer the text the
	// agent was shown. memory_update replaces whole files, so it is where that
	// becomes silent data loss. `npm run race` measures what it used to cost.
	const foreignWrite = (rel: string, content: string) => {
		const full = path.join(BANK, rel);
		fs.writeFileSync(full, content, "utf-8");
		// Bumped deliberately: a same-millisecond write would be indistinguishable
		// from no change, and this has to catch one that fast.
		const t = new Date(Date.now() + 2000);
		fs.utimesSync(full, t, t);
	};

	it("refuses an overwrite of a file another writer changed, and changes nothing", async () => {
		await freshSession();
		await injectedContent(userEvent("what was I doing on pi-memory3")); // serves activeProjects.md
		foreignWrite("core/activeProjects.md", "# Active Projects\n\n- written by the other session\n");

		const result = await tools.get("memory_update").execute("stale-1", {
			file: "core/activeProjects.md",
			content: "# Active Projects\n\n- my edit\n",
		});
		expect(result.content[0].text).toContain("Refused:");
		expect(result.content[0].text).toContain("core/activeProjects.md changed on disk");
		expect(result.details).toMatchObject({ refused: "stale-base" });
		expect(read("core/activeProjects.md")).toContain("written by the other session");
		expect(read("core/activeProjects.md")).not.toContain("my edit");
	});

	it("allows the write again once the agent has read what is there now", async () => {
		await freshSession();
		await injectedContent(userEvent("what was I doing on pi-memory3"));
		foreignWrite("core/activeProjects.md", "# Active Projects\n\n- written by the other session\n");

		const fresh = await tools.get("memory_read").execute("stale-2a", { file: "core/activeProjects.md" });
		expect(fresh.content[0].text).toContain("written by the other session");
		const result = await tools.get("memory_update").execute("stale-2b", {
			file: "core/activeProjects.md",
			content: `${fresh.content[0].text.trimEnd()}\n- my edit, re-applied\n`,
		});
		expect(result.content[0].text).toContain("Updated core/activeProjects.md");
		expect(read("core/activeProjects.md")).toContain("my edit, re-applied");
	});

	it("refuses to replace a knowledge file this session only saw truncated", async () => {
		write(
			"knowledge/long-rule.md",
			`# Long rule (zebra audit probe)\n\n` + Array.from({ length: 200 }, (_, i) => `rule ${i}`).join("\n"),
		);
		await freshSession();
		await injectedContent(userEvent("what about the zebra audit")); // injected, truncated at 100 lines
		const result = await tools.get("memory_update").execute("stale-3", {
			file: "knowledge/long-rule.md",
			content: "# Long rule\n\nrewritten from a truncated view\n",
		});
		// The file never moved. The copy in hand is the problem: 100 of 200 lines.
		expect(result.content[0].text).toContain("only part of knowledge/long-rule.md");
		expect(result.content[0].text).toContain("memory_read");
		expect(read("knowledge/long-rule.md")).toContain("rule 199");
		fs.rmSync(path.join(BANK, "knowledge", "long-rule.md"), { force: true });
	});

	it("does not refuse its own previous write", async () => {
		// The sequence that matters: read, write, and write again later in the same
		// session. Our own write has to count as the current copy, or every second
		// edit of a file this session is editing becomes a refusal.
		write("knowledge/log.md", "read me first\n");
		await tools.get("memory_read").execute("stale-4pre", { file: "knowledge/log.md" });
		const first = await tools.get("memory_update").execute("stale-4a", { file: "knowledge/log.md", content: "a\n" });
		expect(first.content[0].text).toContain("Updated");
		const second = await tools.get("memory_update").execute("stale-4b", { file: "knowledge/log.md", content: "b\n" });
		expect(second.content[0].text).not.toContain("Refused");
		expect(second.content[0].text).toContain("Updated");
		fs.rmSync(path.join(BANK, "knowledge", "log.md"), { force: true });
	});

	it("counts an injected copy as the copy in hand", async () => {
		// Nothing else in this file serves knowledge/injected-only.md, so a refusal
		// here can only have come from the injection below.
		write("knowledge/injected-only.md", "# Injected only (giraffe census probe)\n\n- count the giraffes\n");
		await freshSession();
		await injectedContent(userEvent("how do I count the giraffes"));
		foreignWrite("knowledge/injected-only.md", "# Injected only (giraffe census probe)\n\n- rewritten by the other session\n");

		const result = await tools.get("memory_update").execute("stale-7", { file: "knowledge/injected-only.md", content: "- my edit\n" });
		expect(result.content[0].text).toContain("Refused:");
		expect(read("knowledge/injected-only.md")).toContain("rewritten by the other session");
		fs.rmSync(path.join(BANK, "knowledge", "injected-only.md"), { force: true });
	});

	it("does not let a finished session's copy block a new session's write", async () => {
		// The guard protects the copy in hand. A new session never had the old one,
		// so refusing it would punish an agent for something it cannot see.
		write("core/activeProjects.md", "# Active Projects\n\n- v1\n");
		await freshSession();
		await injectedContent(userEvent("what was I doing on pi-memory3"));
		foreignWrite("core/activeProjects.md", "# Active Projects\n\n- v2 from the other session\n");
		await freshSession();
		await tools.get("memory_read").execute("stale-8-read", { file: "core/activeProjects.md" });

		const result = await tools.get("memory_update").execute("stale-8", { file: "core/activeProjects.md", content: "# Active Projects\n\n- v3\n" });
		expect(result.content[0].text).toContain("Updated");
	});

	it("does not refuse an update that follows its own append", async () => {
		// The everyday sequence: append a note, then rewrite the file properly. An
		// append that changed the file counts as the current copy, or this becomes a
		// refusal with no explanation the agent can act on.
		await freshSession();
		await injectedContent(userEvent("what was I doing on pi-memory3"));
		const appended = await tools.get("memory_append").execute("stale-9a", {
			file: "core/dailyContext.md",
			section: "Completed",
			text: "- appended a note",
		});
		expect(appended.content[0].text).toContain("Appended");
		const updated = await tools.get("memory_update").execute("stale-9b", {
			file: "core/dailyContext.md",
			content: "## rewritten day\n\n### Completed\n- appended a note\n- and then restructured\n",
		});
		expect(updated.content[0].text).not.toContain("Refused");
		expect(updated.content[0].text).toContain("Updated");
	});

	it("leaves no scratch files behind, since writes land by rename", async () => {
		await tools.get("memory_update").execute("atomic-1", { file: "knowledge/atomic.md", content: "## Notes\n" });
		await tools.get("memory_append").execute("atomic-2", { file: "knowledge/atomic.md", section: "Notes", text: "- appended" });
		expect(read("knowledge/atomic.md")).toContain("- appended");
		const leftovers = fs.readdirSync(path.join(BANK, "knowledge")).filter((f) => f.includes(".tmp-"));
		expect(leftovers).toEqual([]);
		fs.rmSync(path.join(BANK, "knowledge", "atomic.md"), { force: true });
	});

	it("requires explicit permission to replace an existing file never read", async () => {
		write("knowledge/untouched.md", "# Untouched\n\nwritten outside\n");
		const params = { file: "knowledge/untouched.md", content: "overwritten explicitly\n" };
		const refused = await tools.get("memory_update").execute("stale-5", params);
		expect(refused.isError).toBe(true);
		expect(read(params.file)).toContain("written outside");
		const result = await tools.get("memory_update").execute("stale-5-explicit", { ...params, allowUnread: true });
		expect(result.content[0].text).toContain("Updated");
		expect(read(params.file)).toBe(params.content);
		fs.rmSync(path.join(BANK, "knowledge", "untouched.md"), { force: true });
	});

	it("stops an agent from undoing another session's day rollover", async () => {
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- today so far\n`);
		await freshSession();
		const yesterday = await injectedContent(userEvent("what was I doing today")); // serves the day's file
		expect(yesterday).toContain("today so far");
		// Another session starts on the 21st: it archives and writes a fresh day. The
		// old version used to go down in silence and the day came back dated yesterday.
		foreignWrite("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Carried Forward\n- from the other session\n`);
		const result = await tools.get("memory_update").execute("stale-6", {
			file: "core/dailyContext.md",
			content: `## ${dayString(new Date(Date.now() - 86_400_000))}\n\n### Completed\n- today so far\n- resurrected\n`,
		});
		expect(result.content[0].text).toContain("Refused:");
		expect(read("core/dailyContext.md")).toContain("from the other session");
	});

	afterEach(() => {
		write("core/activeProjects.md", "# Active Projects\n\n## P0 — Critical\n- pi-memory3 (P0) - this repo\n");
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n`);
	});
});

describe("bank writes made by the harness file tools", () => {
	// A file created with the harness `write` tool used not to exist as far as search
	// was concerned: an agent making a new knowledge file has no copy it was shown, so
	// memory_update loses to a tool that never refuses. Measured 2026-10-28 — 7 of 9
	// knowledge files reached the index a session late, and two prompts in the real log
	// searched for a file already on disk. These tests are the fix and its edges.
	const seenByDoctor = async () => {
		notifications.length = 0;
		await commands.get("memory").handler("doctor", ctx);
		return (notifications[notifications.length - 1] as { message: string }).message;
	};

	/** Write into the bank the way the harness does, then report the call as pi would. */
	const harnessCall = async (
		rel: string,
		content: string,
		opts: { tool?: "write" | "edit"; cwd?: string; isError?: boolean; onDisk?: boolean } = {},
	) => {
		const full = path.join(BANK, rel);
		if (opts.onDisk !== false) {
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf-8");
		}
		const target = opts.cwd ? path.relative(opts.cwd, full) : full;
		return emit(
			"tool_result",
			{
				type: "tool_result",
				toolName: opts.tool ?? "write",
				input: { path: target, content },
				content: [{ type: "text", text: `Successfully wrote to ${target}` }],
				isError: opts.isError ?? false,
			},
			opts.cwd ? { cwd: opts.cwd } : undefined,
		);
	};

	const search = async (query: string) => (await tools.get("memory_search").execute("fw-" + query, { query })).details
		.results as Array<{ path: string }>;

	beforeEach(async () => {
		fs.rmSync(BANK, { recursive: true, force: true });
		fs.mkdirSync(BANK, { recursive: true });
		await freshSession();
	});

	it("indexes a knowledge file the moment the harness write tool makes it", async () => {
		const result = await harnessCall(
			"knowledge/fenwick-notes.md",
			"# Fenwick tree notes\n\nPrefix sums over a bit array.\n",
			);
		// Watching must not disturb the tool's own result — it returns nothing.
		expect(result).toBeUndefined();
		expect((await search("fenwick")).map((r) => r.path)).toContain("knowledge/fenwick-notes.md");

		// Unannounced editor/bash writes now reconcile on the next search too.
		write("knowledge/quiet-note.md", "# Galvanised note\n\nDeliberately unannounced.\n");
		expect((await search("galvanised")).map((r) => r.path)).toContain("knowledge/quiet-note.md");
	});

	it("reports no index drift for either watched or unannounced disk writes",  async () => {
		await harnessCall("knowledge/watched.md", "# Watched (watched probe)\n\nAnnounced.\n");
		expect(await seenByDoctor()).not.toContain("index holds");

		write("knowledge/unwatched.md", "# Unwatched (unwatched probe)\n\nQuiet.\n");
		const text = await seenByDoctor();
		expect(text).not.toContain("index holds");
		expect(text).toContain("index matches the bank");
	});

	it("replaces edits and follows actual disk content even when a tool reports failure",  async () => {
		await harnessCall("knowledge/widget.md", "# Widget (widget probe)\n\nThe alpha7 design won.\n");
		expect((await search("alpha7")).length).toBe(1);

		await harnessCall("knowledge/widget.md", "# Widget (widget probe)\n\nThe beta7 design won.\n", { tool: "edit" });
		expect((await search("beta7")).map((r) => r.path)).toContain("knowledge/widget.md");
		expect(await search("alpha7")).toEqual([]); // the discarded entry is gone, not duplicated

		await harnessCall("knowledge/widget.md", "# Widget (widget probe)\n\nThe gamma7 design won.\n", {
			isError: true,
			onDisk: true,
		});
		expect((await search("gamma7")).map((r) => r.path)).toContain("knowledge/widget.md");
		await harnessCall("knowledge/failed.md", "# Nonexistent delta9\n", { isError: true, onDisk: false });
		expect(await search("delta9")).toEqual([]);
	});

	it("resolve relative paths against the session cwd, which is not the bank", async () => {
		// A Pi session started inside knowledge/ is the case that matters, and the only
		// one that tells the two resolution rules apart: from the bank root, a path
		// relative to /tmp happens to land in the same file either way, and a fixture
		// like that passes for the wrong reason.
		const cwd = path.join(BANK, "knowledge");
		await harnessCall("knowledge/cwd-probe.md", "# Cwd probe\n\nResolved from a subdirectory.\n", { cwd });
		expect((await search("resolved from a subdirectory")).map((r) => r.path)).toContain("knowledge/cwd-probe.md");
	});

	it("ignore anything outside the bank and anything that is not markdown", async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memory-outside-"));
		fs.writeFileSync(path.join(outside, "elsewhere.md"), "# Elsewhere probe\n\nNot ours.\n");
		await emit("tool_result", {
			type: "tool_result",
			toolName: "write",
			input: { path: path.join(outside, "elsewhere.md") },
			content: [],
			isError: false,
		});
		expect(await search("elsewhere probe")).toEqual([]);

		await harnessCall("knowledge/notes.txt", "Plaintext probe.\n");
		expect(await search("plaintext probe")).toEqual([]);
		fs.rmSync(outside, { recursive: true, force: true });
	});

	it("take a read of a bank file as nothing at all", async () => {
		// Reconciliation may see changed bytes; neither that nor a generic harness read
		// may bless them as the complete memory_read version the model holds.
		write("knowledge/log.md", "# Log\n\nVersion one.\n");
		await freshSession();
		await tools.get("memory_read").execute("fw-read-only-1", { file: "knowledge/log.md" });

		fs.writeFileSync(path.join(BANK, "knowledge/log.md"), "# Log\n\nquietly7 stays put.\n");
		await emit("tool_result", {
			type: "tool_result",
			toolName: "read",
			input: { path: path.join(BANK, "knowledge/log.md") },
			content: [],
			isError: false,
		});

		expect((await search("quietly7")).map((r) => r.path)).toContain("knowledge/log.md"); // search reconciles, but does not stage a served version
		const result = await tools.get("memory_update").execute("fw-read-only-2", {
			file: "knowledge/log.md",
			content: "# Log\n\nMine.\n",
		});
		expect(result.content[0].text).toContain("Refused:"); // and does not clear the stale base
	});

	it("treat a harness write as a copy in hand, and a harness edit as not", async () => {
		write("knowledge/held.md", "# Held\n\nFirst text.\n");
		await tools.get("memory_read").execute("fw-read", { file: "knowledge/held.md" });

		// The agent authored every byte of the new file, so replacing it again is not blind.
		await harnessCall("knowledge/held.md", "# Held\n\nRewritten by hand.\n");
		const afterWrite = await tools.get("memory_update").execute("fw-after-write", {
			file: "knowledge/held.md",
			content: "# Held\n\nRewritten by the tool.\n",
		});
		expect(afterWrite.content[0].text).toContain("Updated knowledge/held.md");

		// An edit only touches the parts it names; the rest is still unseen, and a
		// whole-file replace would drop it.
		await tools.get("memory_read").execute("fw-read-2", { file: "knowledge/held.md" });
		await harnessCall("knowledge/held.md", "# Held\n\nEdited by hand, with a long tail nobody read.\n", {
			tool: "edit",
		});
		const afterEdit = await tools.get("memory_update").execute("fw-after-edit", {
			file: "knowledge/held.md",
			content: "# Held\n\nWhole-file replace.\n",
		});
		expect(afterEdit.content[0].text).toContain("Refused:");
		expect(read("knowledge/held.md")).toContain("long tail nobody read");
	});
	it("log a watched write as its own event, and skip a file the index cannot hold", async () => {
		// The first day of the log needed exactly this line to explain itself: seven of
		// nine knowledge files had been created outside the tools, and that was only
		// visible because the write events named the two that were not. Without this
		// signal the same question next month has to be answered by guessing.
		const monthFile = () => path.join(BANK, "logs", `usage-${new Date().toISOString().slice(0, 7)}.jsonl`);
		write("config.json", JSON.stringify({ log: true }));
		await freshSession();

		await harnessCall("knowledge/watched-log.md", "# Watched log (watchedlog)\n\nAnnounced.\n");
		await harnessCall("knowledge/notes.txt", "Not markdown, not ours.\n");

		const events = fs
			.readFileSync(monthFile(), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const indexed = events.filter((e: any) => e.t === "index");
		expect(indexed.length, `expected one index event, got ${JSON.stringify(indexed)}`).toBe(1);
		expect(indexed[0]).toMatchObject({ t: "index", f: "knowledge/watched-log.md", via: "write" });
	});
});

describe("opt-in relevance and topic continuity", () => {
	let previousConfig: string;
	beforeEach(async () => {
		previousConfig = fs.existsSync(path.join(BANK, "config.json")) ? read("config.json") : "{}";
		write("config.json", JSON.stringify({ injection: { activeProjects: "off", dailyContext: "off", history: "off" }, retrieval: { mode: "balanced" } }));
		write("knowledge/orchid-policy.md", "# Orchid callback naming (orchid, callback, naming)\n\n" + "Callbacks use the payment entity name. ".repeat(25));
		write("knowledge/quasar-postgres.md", "# Quasar Postgres migrations (quasar, postgres, migration)\n\nUse concurrent indexes.\n");
		await freshSession();
	});
	afterEach(async () => {
		fs.rmSync(path.join(BANK, "knowledge/orchid-policy.md"), { force: true });
		fs.rmSync(path.join(BANK, "knowledge/quasar-postgres.md"), { force: true });
		write("config.json", previousConfig); await freshSession();
	});
	it("retains long and short follow-ups, while producing a pointer for unchanged context", async () => {
		expect(await injectedContent(userEvent("Explain Orchid callback naming."))).toContain("Callbacks use");
		const follow = await emit("before_agent_start", userEvent("What are its goods, bads, possible improvements, your assessment and recommendation?"));
		expect(follow.message.details.continuation).toBe(true);
		expect(follow.message.details.files.map((h: any) => h.path)).toContain("knowledge/orchid-policy.md");
		expect(follow.message.content).toContain("unchanged since earlier");
		expect((await emit("before_agent_start", userEvent("Do it."))).message.details.continuation).toBe(true);
	});
	it("lets a new named subject override a pronoun and allows an explicit empty result", async () => {
		await injectedContent(userEvent("Explain Orchid callback naming."));
		const switched = await emit("before_agent_start", userEvent("Does it work with Quasar Postgres migrations?"));
		expect(switched.message.details.continuation).toBe(false);
		expect(switched.message.details.files.map((h: any) => h.path)).toContain("knowledge/quasar-postgres.md");
		expect(await injectedContent(userEvent("Switch topics: what is 2 + 2?"))).not.toContain("orchid-policy");
		expect(await injectedContent(userEvent("And what are its tradeoffs?"))).not.toContain("orchid-policy");
	});
	it.each(["session_compact", "session_tree"])("clears continuity at %s", async (event) => {
		await injectedContent(userEvent("Explain Orchid callback naming."));
		await emit(event, { type: event, newLeafId: null, oldLeafId: "x" });
		expect(await injectedContent(userEvent("Do it."))).not.toContain("orchid-policy");
	});
	it("persists validated policy settings without losing unrelated config", async () => {
		await commands.get("memory").handler("config retrieval.minRelativeScore 0.4", ctx);
		expect(JSON.parse(read("config.json"))).toMatchObject({ injection: { activeProjects: "off" }, retrieval: { mode: "balanced", minRelativeScore: 0.4 } });
		const valid = read("config.json");
		await commands.get("memory").handler("config retrieval.minRelativeScore 2", ctx);
		expect(read("config.json")).toBe(valid);
		expect(notifications.at(-1)?.level).toBe("error");
	});
});

describe("maintenance policies", () => {
	const archive = "history/daily/2020-01/2020-01-01-dailyContext.md";
	let previousConfig: string, previousDaily: string;
	beforeEach(async () => {
		previousConfig = fs.existsSync(path.join(BANK, "config.json")) ? read("config.json") : "{}";
		previousDaily = read("core/dailyContext.md");
		write("config.json", JSON.stringify({ injection: { knowledge: "off" }, maintenance: { historyMaxDays: 30, carryForwardWarnDays: 14 } }));
		write(archive, "## 2020-01-01\n\n### Carried Forward\n- Review narwhal retirement\n\n### Completed\n- Narwhal retirement policy recorded.\n");
		await freshSession();
	});
	afterEach(async () => {
		fs.rmSync(path.join(BANK, archive), { force: true });
		write("core/dailyContext.md", previousDaily); write("config.json", previousConfig); await freshSession();
	});
	it("withholds old archives from automatic context but leaves them discoverable and readable", async () => {
		expect(await injectedContent(userEvent("narwhal retirement"))).not.toContain(archive);
		const result = await tools.get("memory_search").execute("old-archive", { query: "narwhal retirement" });
		expect(result.content[0].text).toContain(archive); expect(result.content[0].text).toContain("outside 30-day injection window");
		expect((await tools.get("memory_read").execute("old-read", { file: archive })).content[0].text).toContain("policy recorded");
		await commands.get("memory").handler("config maintenance.historyMaxDays 0", ctx);
		expect(await injectedContent(userEvent("narwhal retirement"))).toContain(archive);
	});
	it("reports recurring and duplicated carry-forward entries without changing the bank", async () => {
		write("core/dailyContext.md", `## ${dayString(new Date())}\n\n### Carried Forward\n- Review narwhal retirement\n- Review narwhal retirement\n`);
		const before = read("core/dailyContext.md"), savedArchive = read(archive);
		await commands.get("memory").handler("doctor", ctx);
		const report = notifications.at(-1)!.message;
		expect(report).toContain("duplicate in today's section"); expect(report).toContain("earliest 2020-01-01");
		expect(report).toContain("not automatically completed");
		expect(read("core/dailyContext.md")).toBe(before); expect(read(archive)).toBe(savedArchive);
	});
});

describe("scope eligibility in the real handler", () => {
	let previousConfig: string;
	const files = ["knowledge/scope-a/luminary.md", "knowledge/scope-b/luminary.md", "knowledge/scope-flat.md", "knowledge/shared/scope-common.md"];
	beforeEach(async () => {
		previousConfig = fs.existsSync(path.join(BANK, "config.json")) ? read("config.json") : "{}";
		write("config.json", JSON.stringify({ injection: { history: "off" }, scope: { mode: "explicit", name: "scope-a" }, debug: true }));
		write(files[0], "# Luminary procedures\n\nAlphaOnly luminary procedure.\n");
		write(files[1], "# Luminary procedures\n\nBetaOnly luminary procedure.\n");
		write(files[2], "# Luminary flat\n\nGlobal luminary guidance.\n");
		write(files[3], "# Luminary common\n\nShared luminary guidance.\n");
		await freshSession();
	});
	afterEach(async () => { for (const file of files) fs.rmSync(path.join(BANK, file), { force: true }); write("config.json", previousConfig); await freshSession(); });
	it("injects flat/shared/current-project files, labels explicit cross-project search, and explains exclusions", async () => {
		const content = await injectedContent(userEvent("luminary procedure"));
		expect(content).toContain("scope: scope-a (explicit"); expect(content).toContain("AlphaOnly");
		expect(content).toContain("Global luminary"); expect(content).toContain("Shared luminary"); expect(content).not.toContain("BetaOnly");
		expect(notifications.at(-1)?.message).toContain("scope scope-b is outside scope-a");
		const search = await tools.get("memory_search").execute("scope-search", { query: "BetaOnly" });
		expect(search.content[0].text).toContain("project:scope-b"); expect(search.details.results[0].path).toBe(files[1]);
	});
	it("reports orphan folders and fails closed when explicit scope has no name", async () => {
		await commands.get("memory").handler('config scope.name ""', ctx);
		const content = await injectedContent(userEvent("luminary"));
		expect(content).not.toContain("AlphaOnly"); expect(content).not.toContain("BetaOnly"); expect(content).toContain("Global luminary");
		await commands.get("memory").handler("scope", ctx); expect(notifications.at(-1)?.message).toContain("not injected here");
		await commands.get("memory").handler("doctor", ctx); expect(notifications.at(-1)?.message).toContain("scope is unresolved");
	});
	it("keeps scope-off model context byte-compatible with missing scope config", async () => {
		write("config.json", JSON.stringify({ scope: { mode: "off" } })); await freshSession();
		const off = await injectedContent(userEvent("BetaOnly")); expect(off).toContain("BetaOnly"); expect(off).not.toContain("scope:");
		write("config.json", "{}"); await freshSession(); expect(await injectedContent(userEvent("BetaOnly"))).toBe(off);
	});
});

describe("managed revisions and explicit recovery", () => {
	const file = "knowledge/recovery probe.md";
	const original = "# Recovery probe\n\n### Log\n- original\n";
	let previousConfig: string;
	const snapshots = () => fs.existsSync(path.join(BANK, ".revisions")) ? fs.readdirSync(path.join(BANK, ".revisions"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(BANK, ".revisions", f), "utf8"))) : [];
	beforeEach(async () => {
		previousConfig = fs.existsSync(path.join(BANK, "config.json")) ? read("config.json") : "{}";
		fs.rmSync(path.join(BANK, ".revisions"), { recursive: true, force: true });
		write("config.json", JSON.stringify({ revisions: { enabled: true } })); write(file, original); await freshSession();
	});
	afterEach(async () => {
		fs.rmSync(path.join(BANK, ".revisions"), { recursive: true, force: true }); fs.rmSync(path.join(BANK, file), { force: true });
		write("config.json", previousConfig); await freshSession();
	});
	it("backs up update/append, restores paths with spaces, and invalidates the agent's old write base", async () => {
		await tools.get("memory_read").execute("recovery-read", { file });
		await tools.get("memory_update").execute("recovery-update", { file, content: original.replace("original", "version-one") });
		await tools.get("memory_append").execute("recovery-append", { file, section: "Log", text: "- version-two" });
		const current = read(file), history = snapshots(); expect(history).toHaveLength(2);
		const first = history.find((r) => r.content === original)!; expect(first.path).toBe(file);
		await commands.get("memory").handler(`revisions ${file}`, ctx); expect(notifications.at(-1)?.message).toContain(first.id);
		await commands.get("memory").handler("config revisions.enabled false", ctx);
		await commands.get("memory").handler(`restore ${file} ${first.id}`, ctx); expect(read(file)).toBe(original);
		const backup = snapshots().find((r) => r.content === current)!; expect(backup).toBeDefined();
		const search = await tools.get("memory_search").execute("restored-search", { query: "original" }); expect(search.details.results.some((r: any) => r.path === file)).toBe(true);
		const stale = await tools.get("memory_update").execute("restore-unread", { file, content: "not read" }); expect(stale.isError).toBe(true); expect(read(file)).toBe(original);
		await commands.get("memory").handler(`restore ${file} ${backup.id}`, ctx); expect(read(file)).toBe(current);
	});
	it("refuses update/append when a safety snapshot cannot fit, leaving the note unchanged", async () => {
		const huge = original + "x".repeat(80000); write(file, huge);
		await commands.get("memory").handler("config revisions.maxTotalBytes 65536", ctx);
		const update = await tools.get("memory_update").execute("backup-too-large", { file, content: "small replacement", allowUnread: true });
		expect(update.isError).toBe(true); expect(update.content[0].text).toContain("revision byte budget"); expect(read(file)).toBe(huge);
		const append = await tools.get("memory_append").execute("backup-append-too-large", { file, section: "Log", text: "- extra" });
		expect(append.isError).toBe(true); expect(read(file)).toBe(huge);
	});
	it("never lets ordinary memory tools overwrite internal history/lock files", async () => {
		for (const target of [".revisions/manual.md", ".write-locks/manual.md"]) {
			const result = await tools.get("memory_update").execute("internal-write", { file: target, content: "bad", allowUnread: true });
			expect(result.isError).toBe(true); expect(result.content[0].text).toContain("internal recovery/lock");
			expect(fs.existsSync(path.join(BANK, target))).toBe(false);
		}
	});
	it("keeps symlinked history and lock directories from writing outside the bank", async () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-escape-"));
		try {
			fs.symlinkSync(outside, path.join(BANK, ".revisions"), "dir");
			await tools.get("memory_read").execute("recovery-link-read", { file });
			const result = await tools.get("memory_update").execute("recovery-link-write", { file, content: "changed" });
			expect(result.isError).toBe(true); expect(read(file)).toBe(original); expect(fs.readdirSync(outside)).toEqual([]);
			fs.rmSync(path.join(BANK, ".revisions"));
			fs.rmSync(path.join(BANK, ".write-locks"), { recursive: true, force: true }); fs.symlinkSync(outside, path.join(BANK, ".write-locks"), "dir");
			await expect(tools.get("memory_update").execute("lock-link-write", { file, content: "changed" })).rejects.toThrow("within the memory bank");
			expect(read(file)).toBe(original); expect(fs.readdirSync(outside)).toEqual([]);
		} finally {
			fs.rmSync(path.join(BANK, ".write-locks"), { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("prompt guidelines", () => {
	// Guidelines are the only thing between a reversed decision and a second file
	// asserting the opposite, and the only thing keeping memory_update's whole-file
	// write from deleting whatever it did not restate. Neither is enforceable in
	// code, so the wording is the contract and gets pinned.
	it("names every heading its templates write into a daily file", async () => {
		// Templates and guidelines live in two places and are read by one agent. It
		// was shown "### Current Session" for weeks with no rule for it, and
		// "### Carried Forward" — which rollover reads back — likewise.
		const guidelines: string = tools.get("memory_update").promptGuidelines.join("\n");
		const headingsOf = (rel: string) =>
			(read(rel).match(/^### +(.+)$/gm) ?? []).map((line) => line.replace(/^### +/, ""));

		// Scaffold: the file is only written when missing.
		fs.rmSync(path.join(BANK, "core", "dailyContext.md"), { force: true });
		await emit("session_start", { type: "session_start", reason: "reload" });
		const scaffolded = headingsOf("core/dailyContext.md");
		expect(scaffolded.length).toBeGreaterThan(0);

		// Rollover: a finished day becomes a fresh file, with carried work in it.
		const yesterday = dayString(new Date(Date.now() - 86_400_000));
		write("core/dailyContext.md", `## ${yesterday}\n\n### Context for Tomorrow\n- a carried item\n`);
		await emit("session_start", { type: "session_start", reason: "reload" });
		const rolled = headingsOf("core/dailyContext.md");
		expect(rolled).toContain("Carried Forward");

		for (const heading of new Set([...scaffolded, ...rolled])) {
			expect(guidelines, `the guidelines never mention "${heading}", which a template writes`).toContain(heading);
		}
		fs.rmSync(path.join(BANK, "history"), { recursive: true, force: true });
	});

	it("offer memory_update as the way to create a bank file, and say why", () => {
		// The reason files bypassed the tools is that no verb said "create": an agent
		// with a new knowledge file and nothing to read reaches for the harness write
		// tool, which never refuses. The description is the only place that can say so.
		const update = tools.get("memory_update");
		expect(update.description).toContain("creates the file when the path does not exist yet");
		expect((update.parameters as any).properties.file.description).toContain("does not exist yet creates the file");

		const guidelines: string = tools.get("memory_update").promptGuidelines.join("\n");
		const rule = guidelines.match(/Write bank files with memory_update[^\n]*/)?.[0] ?? "";
		expect(rule).toContain("not the harness file tools");
		expect(rule).toContain("checked against what this session was shown");
	});

	it("tells the agent to supersede a record rather than duplicate it", () => {
		const guidelines: string[] = tools.get("memory_update").promptGuidelines;
		const rule = guidelines.find((g) => g.includes("Before storing a preference or decision"));
		expect(rule, "a guideline about what to do when a decision is reversed").toBeDefined();
		expect(rule).toContain("memory_search"); // look for the existing record first
		expect(rule).toContain("memory_read");   // and read it before overwriting the file
		expect(rule).toContain("rather than creating a second file");
	});
});

describe("write gates on core/dailyContext.md", () => {
	const DAILY = "core/dailyContext.md";
	const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
	const append = (text: string, section = "Completed") =>
		tools.get("memory_append").execute("gate-append", { file: DAILY, section, text });
	const update = (content: string, file = DAILY) =>
		tools.get("memory_update").execute("gate-update", { file, content, allowUnread: true });
	const snapshots = () => {
		const dir = path.join(BANK, ".revisions");
		if (!fs.existsSync(dir)) return [] as string[];
		return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".json"));
	};
	const dailyText = (extra = "") => `## ${dayString(new Date())}\n\n### Completed\n- Wired up tests\n\n### Key Decisions\n${extra}`;
	let previousConfig: string;
	let previousDaily: string;

	beforeEach(async () => {
		previousConfig = fs.existsSync(path.join(BANK, "config.json")) ? read("config.json") : "{}";
		previousDaily = read(DAILY);
		fs.rmSync(path.join(BANK, ".revisions"), { recursive: true, force: true });
		write("config.json", JSON.stringify({ revisions: { enabled: true } }));
		write(DAILY, dailyText());
		await freshSession();
	});
	afterEach(async () => {
		write("config.json", previousConfig);
		write(DAILY, previousDaily);
		fs.rmSync(path.join(BANK, ".revisions"), { recursive: true, force: true });
		await freshSession();
	});

	it("refuses an over-long bullet, leaves the file byte-identical and takes no recovery snapshot", async () => {
		const before = read(DAILY);
		const result = await append(words(31));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("31 words > 30");
		expect(result.details.refused).toBe("gate");
		expect(read(DAILY)).toBe(before);
		expect(snapshots()).toEqual([]);
	});

	it("accepts a bullet at the limit", async () => {
		const result = await append(`- ${words(30)}`);
		expect(result.isError).toBe(false);
		expect(read(DAILY)).toContain("w29");
	});

	it("accepts the third identical attempt with a warning, and the lock is free for the next write", async () => {
		const long = words(31);
		expect((await append(long)).isError).toBe(true);
		expect((await append(long)).isError).toBe(true);
		const third = await append(long);
		expect(third.isError).toBe(false);
		expect(third.content[0].text).toContain("Accepted over-limit write");
		expect(read(DAILY)).toContain("w30");
		// Counters reset on the accepted write: the next long bullet is refused again, not waved through.
		expect((await append(words(32))).isError).toBe(true);
		// ...and a clean write still goes through, so no lock was left behind.
		expect((await append("a short one")).isError).toBe(false);
	});

	it("a new session starts with fresh counters", async () => {
		const long = words(31);
		await append(long);
		await append(long);
		await freshSession();
		const first = await append(long);
		expect(first.isError).toBe(true);
		expect(first.content[0].text).toContain("rejection 1 of 2");
	});

	it("checks Key Decisions against its own, smaller limit", async () => {
		const result = await append(words(26), "Key Decisions");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("[Key Decisions: 26 words > 25]");
	});

	it("memory_update is gated too, and judges only the bullets it adds", async () => {
		const oldLong = words(40);
		write(DAILY, dailyText(`- ${oldLong}\n`));
		await freshSession();
		// Rewriting the file with the old long bullet untouched plus one short new one passes.
		const ok = await update(dailyText(`- ${oldLong}\n- brief\n`));
		expect(ok.isError).toBe(false);
		// A brand-new long bullet does not.
		const refused = await update(dailyText(`- ${oldLong}\n- brief\n- ${words(26)}\n`));
		expect(refused.isError).toBe(true);
	});

	it("refuses a write that grows dailyContext past the character cap, naming the numbers", async () => {
		const huge = dailyText() + "x".repeat(6000);
		const result = await update(huge);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`${huge.length.toLocaleString()} characters`);
		expect(result.content[0].text).toContain("6,000-character cap");
	});

	it("lets an over-cap file shrink, even though it is still over the cap", async () => {
		write(DAILY, dailyText() + "x".repeat(9000));
		await freshSession();
		const shorter = dailyText() + "x".repeat(7000);
		expect((await update(shorter)).isError).toBe(false);
	});

	it("never gates another file, however long", async () => {
		const result = await update("# Big note\n\n" + "y".repeat(20_000), "knowledge/gate-other.md");
		expect(result.isError).toBe(false);
		fs.rmSync(path.join(BANK, "knowledge/gate-other.md"), { force: true });
	});

	it("is configurable and can be switched off", async () => {
		await commands.get("memory").handler("config gates.completedWords 5", ctx);
		expect((await append(words(6))).isError).toBe(true);
		await commands.get("memory").handler("config gates.completedWords 0", ctx);
		expect((await append(words(60))).isError).toBe(false);
		await commands.get("memory").handler("config gates.enabled false", ctx);
		await commands.get("memory").handler("config gates.completedWords 5", ctx);
		expect((await append(words(60))).isError).toBe(false);
	});

	it("refuses a bad setting value with the expected shape", async () => {
		await commands.get("memory").handler("config gates.dailyContextMaxChars lots", ctx);
		expect(notifications.at(-1)?.message).toContain("gates.dailyContextMaxChars: expected integer");
	});

	it("shows the gates in /memory doctor and warns when the file is already over the cap", async () => {
		await commands.get("memory").handler("doctor", ctx);
		expect(notifications.at(-1)?.message).toContain("write gates on dailyContext: 30 words per Completed bullet");
		write(DAILY, dailyText() + "x".repeat(7000));
		await commands.get("memory").handler("doctor", ctx);
		expect(notifications.at(-1)?.message).toContain("over the 6,000-character gate");
	});

	it("tells the agent about the limits it will be held to", () => {
		const guidelines: string[] = tools.get("memory_update").promptGuidelines;
		expect(guidelines.some((g) => g.includes("Writes to dailyContext.md are checked") && g.includes("30 words"))).toBe(true);
	});
});

describe("memory_search: keywords, plus meaning when qmd answers", () => {
	const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "fake-qmd.mjs");
	const KEYS = ["PI_MEMORY_QMD", "FAKE_QMD_LOG", "FAKE_QMD_MODE", "FAKE_QMD_HITS"];
	const saved: Record<string, string | undefined> = {};
	const files = ["knowledge/rubber duck.md", "knowledge/duck pond.md", "knowledge/pair programming.md"];
	let dir: string;
	let log: string;
	let previousConfig: string;

	const search = (query: string, limit = 5) => tools.get("memory_search").execute("sem-search", { query, limit });
	const hits = (...rels: string[]) => { process.env.FAKE_QMD_HITS = JSON.stringify(rels.map((r) => `qmd://bank/${r}`)); };
	const qmdCalls = (): string[][] => fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).args) : [];

	beforeEach(async () => {
		for (const k of KEYS) saved[k] = process.env[k];
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-sem-handler-"));
		log = path.join(dir, "calls.log");
		fs.writeFileSync(path.join(dir, "qmd"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
		process.env.PI_MEMORY_QMD = path.join(dir, "qmd");
		process.env.FAKE_QMD_LOG = log;
		previousConfig = fs.existsSync(path.join(BANK, "config.json")) ? read("config.json") : "{}";
		write("config.json", "{}");
		write(files[0], "# Rubber duck\n\nDebugging by explaining code aloud to a toy duck.\n");
		write(files[1], "# Duck pond\n\nWhere the ducks swim.\n");
		write(files[2], "# Pair programming\n\nTalk through the problem with a colleague at one keyboard.\n");
		await freshSession();
	});
	afterEach(async () => {
		for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
		for (const f of files) fs.rmSync(path.join(BANK, f), { force: true });
		write("config.json", previousConfig);
		fs.rmSync(dir, { recursive: true, force: true });
		await freshSession();
	});

	it("fuses meaning with keywords: a file both found leads, and a file only meaning found is added and labelled", async () => {
		hits("knowledge/pair-programming.md", "knowledge/rubber-duck.md");
		const r = await search("duck");
		const byPath = Object.fromEntries(r.details.results.map((x: any) => [x.path, x]));
		expect(r.details.results[0].path).toBe(files[0]);
		expect(byPath[files[0]].via).toBe("both");
		expect(byPath[files[1]].via).toBe("bm25");
		expect(byPath[files[2]].via).toBe("semantic");
		expect(r.details.semantic).toEqual({ tried: true, used: true });
		const text: string = r.content[0].text;
		expect(text).toContain(`Path: ${files[0]} | Score: `);
		expect(text).toContain("| via: both");
		expect(text).toMatch(/Path: knowledge\/pair programming\.md \| Score: 0\.\d\d \(meaning\) \| via: semantic/);
		// The snippet and title of a file only meaning found come from the file itself.
		expect(text).toContain("**Pair programming**");
	});

	it("asks qmd for a vector search against this bank's index, and never for the slow query mode", async () => {
		hits("knowledge/rubber-duck.md");
		await search("duck");
		const call = qmdCalls().find((a) => a.includes("vsearch"))!;
		expect(call[0]).toBe("--index");
		expect(call[1]).toMatch(/^pi-memory-[0-9a-f]{8}$/);
		expect(call).toContain("--json");
		expect(qmdCalls().flat()).not.toContain("query");
	});

	it("answers from keywords alone, in the text it always had, when qmd is not there", async () => {
		process.env.PI_MEMORY_QMD = path.join(dir, "no-such-qmd");
		const without = await search("duck");
		expect(without.isError).toBe(false);
		expect(without.content[0].text).not.toContain("via:");
		expect(without.content[0].text).not.toContain("meaning");
		expect(without.details.semantic).toMatchObject({ tried: true, used: false, reason: "missing" });
		// Byte-compatible with search.semantic off: switching it off changes nothing for the reader.
		await commands.get("memory").handler("config search.semantic off", ctx);
		const off = await search("duck");
		expect(off.content[0].text).toBe(without.content[0].text);
		expect(off.details.semantic).toEqual({ tried: false, used: false });
		expect(qmdCalls()).toEqual([]);
	});

	for (const mode of ["fail", "garbage", "notready"]) {
		it(`falls back to the same keyword answer, without an error, when qmd is in ${mode} mode`, async () => {
			const baseline = await (async () => { await commands.get("memory").handler("config search.semantic off", ctx); const b = await search("duck"); await commands.get("memory").handler("config search.semantic auto", ctx); return b; })();
			process.env.FAKE_QMD_MODE = mode;
			const r = await search("duck");
			expect(r.isError).toBe(false);
			expect(r.content[0].text).toBe(baseline.content[0].text);
			expect(r.details.semantic.used).toBe(false);
		});
	}

	it("gives up at search.semanticTimeoutMs instead of waiting on a slow qmd", async () => {
		process.env.FAKE_QMD_MODE = "slow";
		await commands.get("memory").handler("config search.semanticTimeoutMs 300", ctx);
		const started = Date.now();
		const r = await search("duck");
		expect(Date.now() - started).toBeLessThan(2500);
		expect(r.isError).toBe(false);
		expect(r.details.semantic).toMatchObject({ used: false, reason: "timeout" });
		expect(r.details.results.length).toBeGreaterThan(0);
	});

	it("leaves a query of only common words to the keyword path, which says why nothing was searched", async () => {
		hits("knowledge/pair-programming.md");
		const r = await search("what about the");
		expect(r.content[0].text).toContain("Nothing searched");
		expect(qmdCalls()).toEqual([]);
	});

	it("ignores a semantic hit for a file the bank no longer has", async () => {
		hits("knowledge/deleted-long-ago.md", "knowledge/rubber-duck.md");
		const r = await search("duck");
		expect(r.details.results.map((x: any) => x.path)).not.toContain("knowledge/deleted-long-ago.md");
		expect(r.details.semantic.used).toBe(true);
	});

	it("respects the limit after fusion", async () => {
		hits("knowledge/pair-programming.md", "knowledge/rubber-duck.md");
		const r = await search("duck", 2);
		expect(r.details.results).toHaveLength(2);
	});

	it("reports the last attempt in /memory doctor", async () => {
		await search("duck");
		await commands.get("memory").handler("doctor", ctx);
		expect(notifications.at(-1)?.message).toContain("semantic search: the last search answered");
		process.env.FAKE_QMD_MODE = "fail";
		await search("duck");
		await commands.get("memory").handler("doctor", ctx);
		expect(notifications.at(-1)?.message).toContain("fell back to keywords — failed: boom");
	});

	it("keeps injection on keywords: a prompt never starts qmd", async () => {
		hits("knowledge/pair-programming.md");
		await injectedContent(userEvent("tell me about the duck"));
		expect(qmdCalls().filter((a) => a.includes("vsearch"))).toEqual([]);
	});
});

describe("the semantic index keeps itself fresh", () => {
	const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "fake-qmd.mjs");
	const KEYS = ["PI_MEMORY_QMD", "FAKE_QMD_LOG", "FAKE_QMD_MODE", "FAKE_QMD_HITS", "FAKE_QMD_EMBED", "FAKE_QMD_DELAY_MS", "FAKE_QMD_TOTAL", "FAKE_QMD_PENDING"];
	const saved: Record<string, string | undefined> = {};
	const DAILY = "core/dailyContext.md";
	let dir: string;
	let log: string;
	let previousConfig: string;
	let previousDaily: string;

	const verbs = (): string[] => !fs.existsSync(log) ? [] : fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => {
		const args: string[] = JSON.parse(l).args;
		const rest = args[0] === "--index" ? args.slice(2) : args;
		return rest[0] === "collection" ? "collection add" : rest[0];
	});
	const embeds = () => verbs().filter((v) => v === "embed").length;
	async function until(check: () => boolean, ms = 5000): Promise<void> {
		const end = Date.now() + ms;
		while (!check()) {
			if (Date.now() > end) throw new Error(`timed out; qmd was called with: ${verbs().join(", ") || "(nothing)"}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	}
	const memory = (args: string) => commands.get("memory").handler(args, ctx);
	const lockFile = () => path.join(BANK, ".write-locks", "semantic-refresh.lock");

	beforeEach(async () => {
		for (const k of KEYS) saved[k] = process.env[k];
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-sem-refresh-"));
		log = path.join(dir, "calls.log");
		fs.writeFileSync(path.join(dir, "qmd"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
		process.env.PI_MEMORY_QMD = path.join(dir, "qmd");
		process.env.FAKE_QMD_LOG = log;
		previousConfig = fs.existsSync(path.join(BANK, "config.json")) ? read("config.json") : "{}";
		previousDaily = read(DAILY);
		// A short wait after a write keeps these tests fast; the default (30 s) is what a person gets.
		write("config.json", JSON.stringify({ search: { refreshDelayMs: 60 } }));
		await freshSession();
	});
	afterEach(async () => {
		await emit("session_shutdown", { type: "session_shutdown" });
		for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
		write("config.json", previousConfig);
		write(DAILY, previousDaily);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(path.join(BANK, ".write-locks", "semantic-refresh.lock"), { force: true });
		await freshSession();
	});

	it("builds the index after a session starts: collection, update, embed", async () => {
		await until(() => embeds() === 1);
		expect(verbs()).toEqual(["--version", "collection add", "update", "embed"]);
		// The pass is still finishing when embed is first seen; the lock goes when it does.
		await until(() => !fs.existsSync(lockFile()));
	});

	it("does nothing at all when semantic search is off", async () => {
		write("config.json", JSON.stringify({ search: { semantic: "off", refreshDelayMs: 60 } }));
		await freshSession();
		await memory("config search.semantic off");
		await new Promise((r) => setTimeout(r, 400));
		expect(verbs()).toEqual([]);
	});

	it("refreshes once after a burst of writes, not once per write", async () => {
		await until(() => embeds() === 1);
		for (let i = 0; i < 3; i++) await tools.get("memory_append").execute(`burst-${i}`, { file: DAILY, section: "Completed", text: `- burst ${i}` });
		await until(() => embeds() === 2);
		await new Promise((r) => setTimeout(r, 400));
		expect(embeds()).toBe(2);
	});

	it("refreshes after memory_update too, and after a harness write into the bank", async () => {
		await until(() => embeds() === 1);
		await tools.get("memory_update").execute("upd", { file: "knowledge/refresh probe.md", content: "# Refresh probe\n\nx\n", allowUnread: true });
		await until(() => embeds() === 2);
		write("knowledge/refresh probe 2.md", "# Probe two\n\nx\n");
		await emit("tool_result", { toolName: "write", isError: false, input: { path: path.join(BANK, "knowledge/refresh probe 2.md") } });
		await until(() => embeds() === 3);
		for (const f of ["knowledge/refresh probe.md", "knowledge/refresh probe 2.md"]) fs.rmSync(path.join(BANK, f), { force: true });
	});

	it("builds the index when a search finds none, if nothing has tried yet this session", async () => {
		write("config.json", JSON.stringify({ search: { semantic: "off", refreshDelayMs: 60 } }));
		await freshSession();
		expect(verbs()).toEqual([]);
		await memory("config search.semantic auto");
		process.env.FAKE_QMD_MODE = "notready";
		write("knowledge/probe note.md", "# Probe note\n\nsearchable words\n");
		await tools.get("memory_search").execute("nr", { query: "searchable" });
		await until(() => embeds() === 1);
		fs.rmSync(path.join(BANK, "knowledge/probe note.md"), { force: true });
	});

	it("/memory refresh starts a semantic refresh and says so", async () => {
		await until(() => embeds() === 1);
		await memory("refresh");
		expect(notifications.at(-1)?.message).toContain("(semantic index refresh started)");
		await until(() => embeds() === 2);
	});

	it("a session that ends cancels a running refresh, frees the lock, and the next session starts its own", async () => {
		process.env.FAKE_QMD_EMBED = "slow"; process.env.FAKE_QMD_DELAY_MS = "4000";
		await freshSession();
		await until(() => verbs().includes("update") && fs.existsSync(lockFile()));
		const started = Date.now();
		await emit("session_shutdown", { type: "session_shutdown" });
		await until(() => !fs.existsSync(lockFile()), 2500);
		expect(Date.now() - started).toBeLessThan(3000);
		process.env.FAKE_QMD_EMBED = "ok";
		const before = embeds();
		await freshSession();
		await until(() => embeds() > before);
	});

	it("shows the qmd version, the index counts and the last refresh in /memory doctor", async () => {
		process.env.FAKE_QMD_TOTAL = "12"; process.env.FAKE_QMD_PENDING = "0";
		await until(() => embeds() === 1);
		await memory("doctor");
		const text = notifications.at(-1)!.message;
		expect(text).toMatch(/ok\s+qmd 2\.5\.1 at .*qmd, index pi-memory-[0-9a-f]{8}/);
		expect(text).toContain("qmd index: 12 files, all embedded");
		expect(text).toContain("index refreshed");
	});

	it("warns in /memory doctor when files have no vectors yet", async () => {
		process.env.FAKE_QMD_TOTAL = "12"; process.env.FAKE_QMD_PENDING = "5";
		await memory("doctor");
		expect(notifications.at(-1)!.message).toContain("warn  qmd index: 12 files, 5 without vectors");
	});

	it("says in /memory doctor that semantic search is idle when qmd is not installed", async () => {
		process.env.PI_MEMORY_QMD = path.join(dir, "no-such-qmd");
		await memory("doctor");
		expect(notifications.at(-1)!.message).toContain("semantic search is idle");
	});

	it("shows semantic search in /memory status", async () => {
		await memory("status");
		expect(notifications.at(-1)!.message).toMatch(/semantic search:\s+auto \(qmd\)/);
		await memory("config search.semantic off");
		await memory("status");
		expect(notifications.at(-1)!.message).toMatch(/semantic search:\s+off \(keywords only\)/);
	});
});
