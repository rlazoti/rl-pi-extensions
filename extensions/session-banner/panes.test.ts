import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_TICK_MS,
	MIN_TICK_MS,
	paneRegistry,
	type PaneRenderCtx,
	type RichEditorPane,
	RenderScheduler,
} from "./panes.js";

const ctx: PaneRenderCtx = { width: 80, rowHint: 4, colorize: (s) => s, theme: undefined };

function gutter(id: string, opts: Partial<RichEditorPane> = {}): RichEditorPane {
	return { id, slot: "gutter", render: () => ({ slot: "gutter", width: 8, lines: [] }), ...opts };
}
function banner(id: string, opts: Partial<RichEditorPane> = {}): RichEditorPane {
	return { id, slot: "banner", render: () => ({ slot: "banner", label: id, color: "#fff" }), ...opts };
}

describe("RenderScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("paints immediately on the first request (leading edge)", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.request();
		expect(paint).toHaveBeenCalledTimes(1);
		expect(s.running).toBe(false); // nothing pending -> no timer armed
	});

	it("coalesces a burst within one interval into a single trailing paint", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.request(); // leading paint (1)
		expect(paint).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(100);
		s.request(); // within interval -> arm trailing
		s.request();
		s.request();
		expect(paint).toHaveBeenCalledTimes(1); // still coalesced
		expect(s.running).toBe(true);
		vi.advanceTimersByTime(DEFAULT_TICK_MS);
		expect(paint).toHaveBeenCalledTimes(2); // one trailing paint for the burst
	});

	it("stops the timer once clean (no further paints when idle)", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.request();
		vi.advanceTimersByTime(10);
		s.request(); // arm trailing
		vi.advanceTimersByTime(DEFAULT_TICK_MS); // trailing paint, then clean
		expect(paint).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(DEFAULT_TICK_MS * 5); // idle -> timer should have stopped
		expect(paint).toHaveBeenCalledTimes(2);
		expect(s.running).toBe(false);
	});

	it("keeps painting each tick while a pane is animated", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.setAnimation(1, 200);
		expect(s.running).toBe(true);
		vi.advanceTimersByTime(200);
		vi.advanceTimersByTime(200);
		vi.advanceTimersByTime(200);
		expect(paint).toHaveBeenCalledTimes(3);
	});

	it("stops animating after setAnimation(0) on the next clean tick", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.setAnimation(1, 200);
		vi.advanceTimersByTime(200); // 1
		s.setAnimation(0, DEFAULT_TICK_MS);
		vi.advanceTimersByTime(DEFAULT_TICK_MS * 3);
		expect(paint).toHaveBeenCalledTimes(1); // no more paints; timer stopped
		expect(s.running).toBe(false);
	});

	it("restarts at the new cadence when the interval changes while animated", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.setAnimation(1, 1000);
		vi.advanceTimersByTime(1000); // 1
		s.setAnimation(1, 200); // faster cadence
		vi.advanceTimersByTime(200); // 2
		vi.advanceTimersByTime(200); // 3
		expect(paint).toHaveBeenCalledTimes(3);
	});

	it("floors the interval at MIN_TICK_MS", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.setAnimation(1, 0); // asks for 0 -> floored
		vi.advanceTimersByTime(MIN_TICK_MS - 1);
		expect(paint).toHaveBeenCalledTimes(0);
		vi.advanceTimersByTime(1);
		expect(paint).toHaveBeenCalledTimes(1);
	});

	it("setAnimation(0) while clean and idle is a no-op (stays stopped)", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.setAnimation(0, DEFAULT_TICK_MS);
		expect(s.running).toBe(false);
	});

	it("setAnimation(0) keeps the timer armed when a paint is still pending (dirty)", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.request(); // leading paint, clears dirty, lastPaint=now
		vi.advanceTimersByTime(100); // still within the interval
		s.request(); // dirty=true, trailing tick armed (no immediate paint)
		expect(paint).toHaveBeenCalledTimes(1);
		s.setAnimation(0, DEFAULT_TICK_MS); // dirty -> must NOT stop the timer
		expect(s.running).toBe(true);
		vi.advanceTimersByTime(DEFAULT_TICK_MS);
		expect(paint).toHaveBeenCalledTimes(2); // pending paint still lands
	});

	it("survives a throwing paint without dropping the timer", () => {
		const paint = vi.fn(() => {
			throw new Error("boom");
		});
		const s = new RenderScheduler(paint);
		s.setAnimation(1, 200);
		expect(() => vi.advanceTimersByTime(600)).not.toThrow();
		expect(paint).toHaveBeenCalledTimes(3);
	});

	it("dispose stops the timer", () => {
		const paint = vi.fn();
		const s = new RenderScheduler(paint);
		s.setAnimation(1, 200);
		expect(s.running).toBe(true);
		s.dispose();
		expect(s.running).toBe(false);
		vi.advanceTimersByTime(1000);
		expect(paint).toHaveBeenCalledTimes(0);
	});
});

describe("paneRegistry", () => {
	beforeEach(() => {
		delete (globalThis as { __piRichEditorPanes?: unknown }).__piRichEditorPanes;
	});

	it("is a process-wide singleton", () => {
		expect(paneRegistry()).toBe(paneRegistry());
	});

	it("re-creates the registry when a stale/incompatible version is present", () => {
		(globalThis as { __piRichEditorPanes?: unknown }).__piRichEditorPanes = { version: 999, panes: new Map() };
		const reg = paneRegistry();
		expect(reg.version).toBe(3);
	});

	it("hasHost reflects whether a host is attached", () => {
		const reg = paneRegistry();
		expect(reg.hasHost()).toBe(false);
		reg.setHost({ requestRender: vi.fn(), onPanesChanged: vi.fn() });
		expect(reg.hasHost()).toBe(true);
		reg.setHost(null);
		expect(reg.hasHost()).toBe(false);
	});

	it("register adds a pane and notifies the host; unregister removes + disposes it", () => {
		const reg = paneRegistry();
		const host = { requestRender: vi.fn(), onPanesChanged: vi.fn() };
		reg.setHost(host);
		host.requestRender.mockClear();
		host.onPanesChanged.mockClear();

		const dispose = vi.fn();
		const unregister = reg.register(gutter("avatar", { dispose }));
		expect(reg.panes.has("avatar")).toBe(true);
		expect(host.onPanesChanged).toHaveBeenCalledTimes(1);
		expect(host.requestRender).toHaveBeenCalledTimes(1);

		unregister();
		expect(reg.panes.has("avatar")).toBe(false);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("unregister of a replaced pane does not clobber the newer pane", () => {
		const reg = paneRegistry();
		const unregisterOld = reg.register(gutter("avatar"));
		const newer = gutter("avatar", { order: 5 });
		reg.register(newer); // replaces id "avatar"
		unregisterOld(); // stale handle: must be a no-op
		expect(reg.panes.get("avatar")).toBe(newer);
	});

	it("changed() reconfigures + repaints via the host, and is a no-op without one", () => {
		const reg = paneRegistry();
		expect(() => reg.changed()).not.toThrow(); // no host yet
		const host = { requestRender: vi.fn(), onPanesChanged: vi.fn() };
		reg.setHost(host);
		host.requestRender.mockClear();
		host.onPanesChanged.mockClear();
		reg.changed();
		expect(host.onPanesChanged).toHaveBeenCalledTimes(1);
		expect(host.requestRender).toHaveBeenCalledTimes(1);
	});

	it("requestRender delegates to the host and is a no-op without one", () => {
		const reg = paneRegistry();
		expect(() => reg.requestRender()).not.toThrow(); // no host yet
		const host = { requestRender: vi.fn(), onPanesChanged: vi.fn() };
		reg.setHost(host);
		host.requestRender.mockClear();
		reg.requestRender();
		expect(host.requestRender).toHaveBeenCalledTimes(1);
		reg.setHost(null);
		expect(() => reg.requestRender()).not.toThrow();
	});

	it("gutters() sorts by order and banner() returns the lowest-order banner", () => {
		const reg = paneRegistry();
		reg.register(gutter("b", { order: 10 }));
		reg.register(gutter("a", { order: 1 }));
		reg.register(banner("banner-hi", { order: 5 }));
		reg.register(banner("banner-lo", { order: 2 }));
		expect(reg.gutters().map((p) => p.id)).toEqual(["a", "b"]);
		expect(reg.banner()?.id).toBe("banner-lo");
	});

	it("banner() is null when no banner pane is registered", () => {
		const reg = paneRegistry();
		reg.register(gutter("a"));
		expect(reg.banner()).toBeNull();
	});

	it("orders panes with no explicit order via the 0 fallback", () => {
		const reg = paneRegistry();
		reg.register(gutter("g1")); // no order -> 0
		reg.register(gutter("g2")); // no order -> 0
		reg.register(banner("bn1")); // no order -> 0
		reg.register(banner("bn2")); // no order -> 0
		expect(reg.gutters().map((p) => p.id)).toEqual(["g1", "g2"]); // stable, comparator hits ?? 0
		expect(reg.banner()?.id).toBe("bn1");
	});

	it("animation() reports animated count + minimum declared interval", () => {
		const reg = paneRegistry();
		reg.register(gutter("still")); // not animated
		reg.register(gutter("slow", { animated: true, intervalMs: 800 }));
		reg.register(gutter("fast", { animated: true, intervalMs: 120 }));
		reg.register(gutter("default-rate", { animated: true })); // no intervalMs -> default
		expect(reg.animation()).toEqual({ count: 3, interval: 120 });
	});

	it("animation() defaults to no animation at the default interval", () => {
		const reg = paneRegistry();
		reg.register(gutter("still"));
		expect(reg.animation()).toEqual({ count: 0, interval: DEFAULT_TICK_MS });
	});

	it("animation() lets a push-model pane (animated:false) tighten the rate cap", () => {
		const reg = paneRegistry();
		// e.g. the avatar: its own timer drives frames, but while talking it wants
		// a faster repaint cap than the 1s ambient default.
		reg.register(gutter("avatar", { animated: false, intervalMs: 120 }));
		expect(reg.animation()).toEqual({ count: 0, interval: 120 });
	});

	it("setHost(null) detaches so provider calls are inert", () => {
		const reg = paneRegistry();
		const host = { requestRender: vi.fn(), onPanesChanged: vi.fn() };
		reg.setHost(host);
		reg.setHost(null);
		const before = host.onPanesChanged.mock.calls.length;
		reg.register(gutter("x"));
		expect(host.onPanesChanged.mock.calls.length).toBe(before); // host not notified
	});

	it("pane.render is callable and typed per slot", () => {
		const reg = paneRegistry();
		reg.register(gutter("g"));
		reg.register(banner("bn"));
		expect(reg.gutters()[0]!.render(ctx)).toEqual({ slot: "gutter", width: 8, lines: [] });
		expect(reg.banner()!.render(ctx)).toEqual({ slot: "banner", label: "bn", color: "#fff" });
	});
});
