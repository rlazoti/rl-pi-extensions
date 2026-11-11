/**
 * Reciprocal rank fusion of two ranked lists. Pure: a table of orders.
 *
 * What the tests hold the line on is the one property the design leans on: a file that
 * BOTH lists found outranks a file only one list found, so a loosely related vector hit
 * (which has no relevance floor) can never push a keyword match out of the top.
 */
import { describe, it, expect } from "vitest";
import { RRF_K, fuse } from "./fusion.js";

const paths = (r: ReturnType<typeof fuse>) => r.map((x) => x.path);

describe("fuse", () => {
	it("returns the keyword list unchanged, labelled bm25, when there are no semantic hits", () => {
		const r = fuse(["a", "b", "c"], [], 5);
		expect(paths(r)).toEqual(["a", "b", "c"]);
		expect(r.every((x) => x.via === "bm25")).toBe(true);
	});

	it("returns the semantic list, labelled semantic, when keywords found nothing", () => {
		const r = fuse([], ["x", "y"], 5);
		expect(paths(r)).toEqual(["x", "y"]);
		expect(r.every((x) => x.via === "semantic")).toBe(true);
	});

	it("ranks a file found by both lists above files found by only one, whatever their own ranks", () => {
		// "m" is only 3rd in each list; "a" is 1st in keywords, "x" is 1st in semantic.
		const r = fuse(["a", "b", "m"], ["x", "y", "m"], 5);
		expect(paths(r)[0]).toBe("m");
		expect(r.find((x) => x.path === "m")?.via).toBe("both");
	});

	it("keeps each list's own order among files only that list found", () => {
		const r = fuse(["a", "b", "c"], ["x", "y"], 10);
		const order = paths(r);
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
		expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
		expect(order.indexOf("x")).toBeLessThan(order.indexOf("y"));
	});

	it("breaks a tie by putting the keyword hit first, then by path, so the output is deterministic", () => {
		// a is bm25 rank 1, x is semantic rank 1: equal fused score.
		expect(paths(fuse(["a"], ["x"], 5))).toEqual(["a", "x"]);
		// Two files with identical scores from symmetric positions.
		expect(paths(fuse(["a", "b"], ["b", "a"], 5))).toEqual(["a", "b"]);
	});

	it("counts a file once when a list repeats it, using its best rank", () => {
		const r = fuse(["a", "a", "b"], [], 5);
		expect(paths(r)).toEqual(["a", "b"]);
	});

	it("respects the limit and a limit of zero", () => {
		expect(fuse(["a", "b", "c"], ["d", "e"], 2)).toHaveLength(2);
		expect(fuse(["a"], ["b"], 0)).toEqual([]);
	});

	it("scores are the documented reciprocal-rank sums", () => {
		const r = fuse(["a"], ["a"], 1);
		expect(r[0].fused).toBeCloseTo(2 / (RRF_K + 1), 12);
	});
});
