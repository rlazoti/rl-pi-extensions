import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "./index.ts";

/**
 * Pins that the unfinished memory extension cannot interfere with the memory
 * bank that is actually live: it must export a factory and must not register
 * tools, commands, or event handlers until its phase lands.
 */
test("memory extension: entry point is a factory that registers nothing yet", () => {
	assert.equal(typeof factory, "function");

	const registered: string[] = [];
	const pi = {
		on: (event: string) => {
			registered.push(`on:${event}`);
			return () => {};
		},
		registerTool: (tool: { name: string }) => {
			registered.push(`tool:${tool.name}`);
		},
		registerCommand: (name: string) => {
			registered.push(`command:${name}`);
		},
	} as unknown as ExtensionAPI;

	factory(pi);
	assert.deepEqual(registered, [], `expected no registrations, got ${registered.join(", ")}`);
});
