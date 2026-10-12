import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
	DEFAULT_TICK_MS,
	MIN_TICK_MS,
	paneRegistry,
	type PaneRenderCtx,
	type RichEditorPane,
	RenderScheduler,
} from "./panes.ts";

const ctx: PaneRenderCtx = { width: 80, rowHint: 4, colorize: (s) => s, theme: undefined };

function gutter(id: string, opts: Partial<RichEditorPane> = {}): RichEditorPane {
	return { id, slot: "gutter", render: () => ({ slot: "gutter", width: 8, lines: [] }), ...opts };
}
function banner(id: string, opts: Partial<RichEditorPane> = {}): RichEditorPane {
	return { id, slot: "banner", render: () => ({ slot: "banner", label: id, color: "#fff" }), ...opts };
}

/** Minimal stand-in for vi.fn(): records call count and args. */
function spy(): { fn: (...args: unknown[]) => void; calls: unknown[][] } {
	const calls: unknown[][] = [];
	const fn = (...args: unknown[]) => {
		calls.push(args);
	};
	return { fn, calls };
}

type Registry = ReturnType<typeof paneRegistry>;

function freshRegistry(): Registry {
	delete (globalThis as { __piRichEditorPanes?: unknown }).__piRichEditorPanes;
	return paneRegistry();
}

// ─── RenderScheduler ───────────────────────────────────────────────────────

function withFakeTimers(run: (tick: (ms: number) => void) => void): void {
	// "Date" must be faked too: RenderScheduler compares Date.now() against its
	// last-paint timestamp, exactly as vi.useFakeTimers() + setSystemTime did.
	mock.timers.enable({ apis: ["setInterval", "setTimeout", "setImmediate", "Date"], now: 1_000_000 });
	try {
		run((ms) => mock.timers.tick(ms));
	} finally {
		mock.timers.reset();
	}
}

test("RenderScheduler: paints immediately on the first request (leading edge)", () => {
	withFakeTimers(() => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.request();
		assert.equal(paint.calls.length, 1);
		assert.equal(s.running, false); // nothing pending -> no timer armed
	});
});

test("RenderScheduler: coalesces a burst within one interval into a single trailing paint", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.request(); // leading paint (1)
		assert.equal(paint.calls.length, 1);
		tick(100);
		s.request(); // within interval -> arm trailing
		s.request();
		s.request();
		assert.equal(paint.calls.length, 1); // still coalesced
		assert.equal(s.running, true);
		tick(DEFAULT_TICK_MS);
		assert.equal(paint.calls.length, 2); // one trailing paint for the burst
	});
});

test("RenderScheduler: stops the timer once clean (no further paints when idle)", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.request();
		tick(10);
		s.request(); // arm trailing
		tick(DEFAULT_TICK_MS); // trailing paint, then clean
		assert.equal(paint.calls.length, 2);
		tick(DEFAULT_TICK_MS * 5); // idle -> timer should have stopped
		assert.equal(paint.calls.length, 2);
		assert.equal(s.running, false);
	});
});

test("RenderScheduler: keeps painting each tick while a pane is animated", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.setAnimation(1, 200);
		assert.equal(s.running, true);
		tick(200);
		tick(200);
		tick(200);
		assert.equal(paint.calls.length, 3);
	});
});

test("RenderScheduler: stops animating after setAnimation(0) on the next clean tick", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.setAnimation(1, 200);
		tick(200); // 1
		s.setAnimation(0, DEFAULT_TICK_MS);
		tick(DEFAULT_TICK_MS * 3);
		assert.equal(paint.calls.length, 1); // no more paints; timer stopped
		assert.equal(s.running, false);
	});
});

test("RenderScheduler: restarts at the new cadence when the interval changes while animated", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.setAnimation(1, 1000);
		tick(1000); // 1
		s.setAnimation(1, 200); // faster cadence
		tick(200); // 2
		tick(200); // 3
		assert.equal(paint.calls.length, 3);
	});
});

test("RenderScheduler: floors the interval at MIN_TICK_MS", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.setAnimation(1, 0); // asks for 0 -> floored
		tick(MIN_TICK_MS - 1);
		assert.equal(paint.calls.length, 0);
		tick(1);
		assert.equal(paint.calls.length, 1);
	});
});

test("RenderScheduler: setAnimation(0) while clean and idle is a no-op (stays stopped)", () => {
	withFakeTimers(() => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.setAnimation(0, DEFAULT_TICK_MS);
		assert.equal(s.running, false);
	});
});

test("RenderScheduler: setAnimation(0) keeps the timer armed when a paint is still pending (dirty)", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.request(); // leading paint, clears dirty, lastPaint=now
		tick(100); // still within the interval
		s.request(); // dirty=true, trailing tick armed (no immediate paint)
		assert.equal(paint.calls.length, 1);
		s.setAnimation(0, DEFAULT_TICK_MS); // dirty -> must NOT stop the timer
		assert.equal(s.running, true);
		tick(DEFAULT_TICK_MS);
		assert.equal(paint.calls.length, 2); // pending paint still lands
	});
});

test("RenderScheduler: survives a throwing paint without dropping the timer", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const throwing = () => {
			paint.calls.push([]);
			throw new Error("boom");
		};
		const s = new RenderScheduler(throwing);
		s.setAnimation(1, 200);
		assert.doesNotThrow(() => tick(600));
		assert.equal(paint.calls.length, 3);
	});
});

test("RenderScheduler: dispose stops the timer", () => {
	withFakeTimers((tick) => {
		const paint = spy();
		const s = new RenderScheduler(paint.fn);
		s.setAnimation(1, 200);
		assert.equal(s.running, true);
		s.dispose();
		assert.equal(s.running, false);
		tick(1000);
		assert.equal(paint.calls.length, 0);
	});
});

// ─── paneRegistry ──────────────────────────────────────────────────────────

test("paneRegistry: is a process-wide singleton", () => {
	assert.equal(paneRegistry(), paneRegistry());
});

test("paneRegistry: re-creates the registry when a stale/incompatible version is present", () => {
	(globalThis as { __piRichEditorPanes?: unknown }).__piRichEditorPanes = { version: 999, panes: new Map() };
	const reg = paneRegistry();
	assert.equal(reg.version, 3);
});

test("paneRegistry: hasHost reflects whether a host is attached", () => {
	const reg = freshRegistry();
	assert.equal(reg.hasHost(), false);
	reg.setHost({ requestRender: spy().fn, onPanesChanged: spy().fn });
	assert.equal(reg.hasHost(), true);
	reg.setHost(null);
	assert.equal(reg.hasHost(), false);
});

test("paneRegistry: register adds a pane and notifies the host; unregister removes + disposes it", () => {
	const reg = freshRegistry();
	const requestRender = spy();
	const onPanesChanged = spy();
	reg.setHost({ requestRender: requestRender.fn, onPanesChanged: onPanesChanged.fn });
	requestRender.calls.length = 0;
	onPanesChanged.calls.length = 0;

	const dispose = spy();
	const unregister = reg.register(gutter("avatar", { dispose: dispose.fn }));
	assert.equal(reg.panes.has("avatar"), true);
	assert.equal(onPanesChanged.calls.length, 1);
	assert.equal(requestRender.calls.length, 1);

	unregister();
	assert.equal(reg.panes.has("avatar"), false);
	assert.equal(dispose.calls.length, 1);
});

test("paneRegistry: unregister of a replaced pane does not clobber the newer pane", () => {
	const reg = freshRegistry();
	const unregisterOld = reg.register(gutter("avatar"));
	const newer = gutter("avatar", { order: 5 });
	reg.register(newer); // replaces id "avatar"
	unregisterOld(); // stale handle: must be a no-op
	assert.equal(reg.panes.get("avatar"), newer);
});

test("paneRegistry: changed() reconfigures + repaints via the host, and is a no-op without one", () => {
	const reg = freshRegistry();
	assert.doesNotThrow(() => reg.changed()); // no host yet
	const requestRender = spy();
	const onPanesChanged = spy();
	reg.setHost({ requestRender: requestRender.fn, onPanesChanged: onPanesChanged.fn });
	requestRender.calls.length = 0;
	onPanesChanged.calls.length = 0;
	reg.changed();
	assert.equal(onPanesChanged.calls.length, 1);
	assert.equal(requestRender.calls.length, 1);
});

test("paneRegistry: requestRender delegates to the host and is a no-op without one", () => {
	const reg = freshRegistry();
	assert.doesNotThrow(() => reg.requestRender()); // no host yet
	const requestRender = spy();
	const onPanesChanged = spy();
	reg.setHost({ requestRender: requestRender.fn, onPanesChanged: onPanesChanged.fn });
	requestRender.calls.length = 0;
	reg.requestRender();
	assert.equal(requestRender.calls.length, 1);
	reg.setHost(null);
	assert.doesNotThrow(() => reg.requestRender());
});

test("paneRegistry: gutters() sorts by order and banner() returns the lowest-order banner", () => {
	const reg = freshRegistry();
	reg.register(gutter("b", { order: 10 }));
	reg.register(gutter("a", { order: 1 }));
	reg.register(banner("banner-hi", { order: 5 }));
	reg.register(banner("banner-lo", { order: 2 }));
	assert.deepEqual(reg.gutters().map((p) => p.id), ["a", "b"]);
	assert.equal(reg.banner()?.id, "banner-lo");
});

test("paneRegistry: banner() is null when no banner pane is registered", () => {
	const reg = freshRegistry();
	reg.register(gutter("a"));
	assert.equal(reg.banner(), null);
});

test("paneRegistry: orders panes with no explicit order via the 0 fallback", () => {
	const reg = freshRegistry();
	reg.register(gutter("g1")); // no order -> 0
	reg.register(gutter("g2")); // no order -> 0
	reg.register(banner("bn1")); // no order -> 0
	reg.register(banner("bn2")); // no order -> 0
	assert.deepEqual(reg.gutters().map((p) => p.id), ["g1", "g2"]); // stable, comparator hits ?? 0
	assert.equal(reg.banner()?.id, "bn1");
});

test("paneRegistry: animation() reports animated count + minimum declared interval", () => {
	const reg = freshRegistry();
	reg.register(gutter("still")); // not animated
	reg.register(gutter("slow", { animated: true, intervalMs: 800 }));
	reg.register(gutter("fast", { animated: true, intervalMs: 120 }));
	reg.register(gutter("default-rate", { animated: true })); // no intervalMs -> default
	assert.deepEqual(reg.animation(), { count: 3, interval: 120 });
});

test("paneRegistry: animation() defaults to no animation at the default interval", () => {
	const reg = freshRegistry();
	reg.register(gutter("still"));
	assert.deepEqual(reg.animation(), { count: 0, interval: DEFAULT_TICK_MS });
});

test("paneRegistry: animation() lets a push-model pane (animated:false) tighten the rate cap", () => {
	const reg = freshRegistry();
	// e.g. the avatar: its own timer drives frames, but while talking it wants
	// a faster repaint cap than the 1s ambient default.
	reg.register(gutter("avatar", { animated: false, intervalMs: 120 }));
	assert.deepEqual(reg.animation(), { count: 0, interval: 120 });
});

test("paneRegistry: setHost(null) detaches so provider calls are inert", () => {
	const reg = freshRegistry();
	const requestRender = spy();
	const onPanesChanged = spy();
	reg.setHost({ requestRender: requestRender.fn, onPanesChanged: onPanesChanged.fn });
	reg.setHost(null);
	const before = onPanesChanged.calls.length;
	reg.register(gutter("x"));
	assert.equal(onPanesChanged.calls.length, before); // host not notified
});

test("paneRegistry: pane.render is callable and typed per slot", () => {
	const reg = freshRegistry();
	reg.register(gutter("g"));
	reg.register(banner("bn"));
	assert.deepEqual(reg.gutters()[0]!.render(ctx), { slot: "gutter", width: 8, lines: [] });
	assert.deepEqual(reg.banner()!.render(ctx), { slot: "banner", label: "bn", color: "#fff" });
});
