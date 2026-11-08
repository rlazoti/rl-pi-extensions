import { describe, expect, it } from "vitest";
import { DEFAULT_RETRIEVAL, relevanceReason, TopicContext } from "./retrieval.js";
import { changeSetting, defaultSettings, parseSettings } from "./settings.js";
import type { MemoryIndex } from "./search.js";
const balanced = { ...DEFAULT_RETRIEVAL, mode: "balanced" as const };

describe("explicit relevance policy", () => {
	it("floors rank one too, with a positive-score requirement and inclusive boundaries", () => {
		expect(relevanceReason(0, 0, 0, balanced)).toContain("per-content-term");
		expect(relevanceReason(9, 9, 2, balanced)).toContain("per-content-term");
		expect(relevanceReason(10, 10, 2, balanced)).toBeNull();
		expect(relevanceReason(24, 100, 1, balanced)).toContain("relative");
		expect(relevanceReason(25, 100, 1, balanced)).toBeNull();
		expect(relevanceReason(0, 100, 20, DEFAULT_RETRIEVAL)).toBeNull();
	});
	it("inherits a referential query, not an arbitrary short query, and clears it", () => {
		const index = { search: () => [], documentCount: 20 } as unknown as MemoryIndex;
		const topic = new TopicContext(); topic.remember("orchid callback naming", true);
		expect(topic.resolve("What are its goods, bads and possible improvements?", index, balanced)).toEqual({ query: "orchid callback naming", continuation: true });
		expect(topic.resolve("Postgres", index, balanced).query).toBe("Postgres");
		expect(topic.resolve("Switch topics: 2 + 2?", index, balanced)).toEqual({ query: "2 + 2?", continuation: false });
		topic.clear(); expect(topic.resolve("Do it.", index, balanced).query).toBe("");
	});
	it("keeps experimental settings off by default and validates every numeric boundary", () => {
		expect(defaultSettings().retrieval.mode).toBe("legacy");
		expect(parseSettings({ retrieval: { mode: "unknown", minScorePerTerm: -1, minRelativeScore: Infinity, topicStickiness: "false" } })).toEqual(defaultSettings());
		expect(changeSetting(defaultSettings(), "retrieval.mode", "balanced").retrieval.mode).toBe("balanced");
		expect(changeSetting(defaultSettings(), "retrieval.topicStickiness", "false").retrieval.topicStickiness).toBe(false);
		for (const [key, value] of [["retrieval.minScorePerTerm", "-1"], ["retrieval.minRelativeScore", "1.1"], ["retrieval.topicStickiness", "off"], ["unknown", "1"]]) {
			expect(() => changeSetting(defaultSettings(), key, value)).toThrow();
		}
	});
});
