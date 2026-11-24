import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readRequestChanges } from "./changes.ts";
import { renderChanges } from "./text.ts";

const readTool = { name: "read", description: "Read a file", parameters: { type: "object" } };
const writeTool = { name: "write", description: "Write a file", parameters: { type: "object" } };
const searchTool = { name: "search", description: "Find text", parameters: { type: "object" } };

function respond(session: SessionManager, stopReason: AssistantMessage["stopReason"] = "stop") {
	return session.appendMessage({
		role: "assistant", content: [{ type: "text", text: "Done" }], api: "openai-completions", provider: "openai",
		model: "fixture", stopReason, timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
}

async function report(session: SessionManager) {
	return renderChanges(await readRequestChanges(session.getBranch()));
}

test("reports section patches and same-name tool schema changes as edits", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({
		role: "system", timestamp: 1, content: "Base", sections: { tools: "old", skills: "skill list", cwd: "/project" },
		toolsAdded: [readTool, writeTool],
	});
	const previous = respond(session);
	session.appendMessage({
		role: "system", timestamp: 2, content: "One more instruction",
		sections: { tools: "new", skills: null, extra: "hello" },
		toolsRemoved: [{ name: "read" }, { name: "write" }],
		toolsAdded: [{ ...readTool, parameters: { type: "object", required: ["path"] } }, searchTool],
	});
	const latest = respond(session);
	const { hint, lines } = await report(session);
	assert.match(hint, /4 prompt changes · 3 tool changes/);
	assert.match(lines.join("\n"), new RegExp(`Previous +#${previous}.*\\nLatest +#${latest}`));
	assert.match(lines.join("\n"), /Changed +Unsectioned instructions\n  Changed +tools\n  Removed +skills\n  Added +extra/);
	assert.match(lines.join("\n"), /Changed +read\n  Removed +write\n  Added +search/);
	assert.doesNotMatch(lines.join("\n"), /cwd|Read a file|One more instruction/);
});

test("compares the last two responses, not the last two system patches", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "system", content: "", sections: { policy: "first" }, timestamp: 1 });
	respond(session);
	session.appendMessage({ role: "system", content: "", sections: { policy: "second" }, timestamp: 2 });
	const previous = respond(session);
	const latest = respond(session, "aborted");
	session.appendMessage({ role: "system", content: "", sections: { policy: "not yet used" }, timestamp: 3 });
	const { hint, lines } = await report(session);
	assert.match(hint, /^0 prompt changes · 0 tool changes/);
	assert.match(lines.join("\n"), new RegExp(`Previous +#${previous}.*\\nLatest +#${latest}.*\\(aborted\\)`));
});

test("only reads the selected branch, even if another branch has a newer response", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "system", content: "Base", timestamp: 1 });
	const root = respond(session);
	session.appendMessage({ role: "system", content: "", sections: { left: "left" }, timestamp: 2 });
	const left = respond(session);
	session.branch(root);
	session.appendMessage({ role: "system", content: "", sections: { right: "right" }, timestamp: 3 });
	respond(session);
	session.branch(left);
	const { lines } = await report(session);
	assert.match(lines.join("\n"), /Added +left/);
	assert.doesNotMatch(lines.join("\n"), /right/);
});

test("replays compaction at each response and separates later compaction", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "system", content: "Base", toolsAdded: [readTool], timestamp: 1 });
	respond(session);
	session.appendCompaction("Summary", null, 100);
	respond(session);
	session.appendCompaction("Later summary", null, 200);
	const { hint, lines } = await report(session);
	assert.equal(hint, "0 prompt changes · 0 tool changes · 1 compaction between responses");
	assert.match(lines.join("\n"), /1 between responses\n  1 after the latest response \(not compared\)/);
});

test("uses the actual compaction checkpoint rather than dropping pre-compaction changes", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({ role: "system", content: "Base", sections: { guidance: "old" }, timestamp: 1 });
	const previous = respond(session);
	session.appendMessage({ role: "system", content: "", sections: { guidance: "new" }, toolsAdded: [readTool], timestamp: 2 });
	session.appendCompaction("Summary", previous, 100);
	respond(session);
	const { lines } = await report(session);
	assert.match(lines.join("\n"), /Changed +guidance/);
	assert.match(lines.join("\n"), /Added +read/);
});

test("distinguishes a missing prior loadout from an unchanged request", async () => {
	const session = SessionManager.inMemory();
	respond(session);
	assert.match((await report(session)).lines.join("\n"), /needs two recorded assistant responses/);
	session.appendCompaction("Old summary without system checkpoint", null, 100);
	session.appendMessage({ role: "system", content: "First recorded prompt", timestamp: 2 });
	respond(session);
	const { hint, lines } = await report(session);
	assert.match(hint, /No recorded loadout baseline/);
	assert.match(lines.join("\n"), /not record a system prompt and tool loadout for both responses/);
	assert.match(lines.join("\n"), /1 between responses/);
	assert.doesNotMatch(lines.join("\n"), /No recorded changes/);
});
