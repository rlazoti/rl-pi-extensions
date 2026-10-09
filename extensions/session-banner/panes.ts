/**
 * Cross-extension pane registry + coalesced render scheduler for rich-editor.
 *
 * rich-editor owns the single pi editor slot (`setEditorComponent` is
 * last-writer-wins), so presentational panes drawn inside the editor border —
 * the avatar column, the session banner — cannot be their own editor-owning
 * extensions. Instead they register descriptors here and rich-editor (the
 * *host*) composes them in its `render()`.
 *
 * There is no inter-extension API bus in pi, so the contract is an in-process
 * `globalThis` registry (the same provider/consumer pattern `guard` uses for
 * `__piCommandReviewHook`/`__piFetchReviewHook`). Providers mutate the registry
 * and call `requestRender()`; the host drains it on each paint and degrades to
 * the plain editor when no panes are present.
 *
 * Repaints are coalesced by {@link RenderScheduler}: any provider may request a
 * render at any frequency, but the host repaints at most once per tick and only
 * when something is dirty (or an animated pane is live). The tick is the minimum
 * declared interval across animated panes (default 1000ms), so ambient panes
 * collapse to ~1 Hz while a fast pane (the avatar's ~120ms talk flap) keeps its
 * cadence. A leading+trailing throttle makes the first change after an idle
 * period paint immediately instead of waiting up to a full interval.
 *
 * DUPLICATION: this file is intentionally copied byte-for-byte into every
 * extension that participates in the registry — currently rich-editor,
 * pi-avatars, and session-banner — because each is loaded as a standalone
 * module with no shared import path (only the globalThis object is shared).
 * All copies MUST stay identical; `extensions/pane-registry-sync.test.ts`
 * enforces this. Any shape change (e.g. a new method like `hasHost()`) must
 * bump REGISTRY_VERSION so a stale object surviving `/reload` is rebuilt.
 */

/** Floor on the coalescing interval; guards against a pane asking for 0ms. */
export const MIN_TICK_MS = 80;
/** Interval used for ambient (non-fast) panes and when nothing declares one. */
export const DEFAULT_TICK_MS = 1000;

export interface PaneRenderCtx {
	/** Full editor width in cells. */
	width: number;
	/** Suggested body height (host's best guess) for panes that size to it. */
	rowHint: number;
	/** Apply the editor's border color to a string (for dividers/placeholders). */
	colorize: (s: string) => string;
	/** The live coding-agent theme (markdown roles etc.); may be undefined. */
	theme: unknown;
}

/** A left gutter column (e.g. the avatar), drawn left of the editor body. */
export interface GutterOutput {
	slot: "gutter";
	/** Column width in cells. */
	width: number;
	/** Top-aligned content lines (already colored/placeheld). */
	lines: string[];
	/** One-time terminal bytes to emit once, prepended to the first body line. */
	transmitOnce?: string;
}

/** The session banner row above the editor body. */
export interface BannerOutput {
	slot: "banner";
	/** Optional leading emoji; when present the host draws a `┬`/`┴` divider. */
	emoji?: string;
	label: string;
	/** Hex color for the label. */
	color: string;
}

export type PaneOutput = GutterOutput | BannerOutput;

export interface RichEditorPane {
	/** Stable unique id; re-registering with the same id replaces the pane. */
	id: string;
	slot: "gutter" | "banner";
	/** Gutters render left→right by ascending order; lowest-order banner wins. */
	order?: number;
	/** When true the host keeps the tick alive so frames advance. */
	animated?: boolean;
	/** Desired repaint cadence while animated (ms); floored at {@link MIN_TICK_MS}. */
	intervalMs?: number;
	/** Return the current output, or null to render nothing this frame. */
	render(ctx: PaneRenderCtx): PaneOutput | null;
	/** Optional cleanup when the pane is unregistered or the host tears down. */
	dispose?(): void;
}

/**
 * Coalescing repaint scheduler (host-owned). `request()` marks dirty and either
 * paints immediately (leading edge, if a full interval has elapsed) or arms the
 * trailing tick. The timer is lazy: it starts on demand and stops itself once
 * clean and no pane is animated, so an idle editor does zero wakeups.
 */
export class RenderScheduler {
	private dirty = false;
	private animated = 0;
	private interval = DEFAULT_TICK_MS;
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastPaint = Number.NEGATIVE_INFINITY; // first request always paints immediately

	constructor(private readonly paint: () => void) {}

	/** Update the animated-pane count + desired interval; (re)arms/stops the tick. */
	setAnimation(animatedCount: number, minIntervalMs: number): void {
		const next = Math.max(MIN_TICK_MS, minIntervalMs);
		const intervalChanged = next !== this.interval;
		this.interval = next;
		this.animated = Math.max(0, animatedCount);
		if (this.animated > 0) {
			if (intervalChanged) this.stop(); // restart at the new cadence
			this.ensure();
		} else if (!this.dirty) {
			this.stop();
		}
	}

	/** Request a repaint (idempotent, any frequency). */
	request(): void {
		this.dirty = true;
		const now = Date.now();
		if (now - this.lastPaint >= this.interval) this.flush(now); // leading edge
		else this.ensure(); // trailing tick will paint
	}

	private ensure(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.onTick(), this.interval);
		this.timer.unref?.();
	}

	private onTick(): void {
		if (this.animated > 0 || this.dirty) this.flush(Date.now());
		else this.stop();
	}

	private flush(now: number): void {
		this.dirty = false;
		this.lastPaint = now;
		try {
			this.paint();
		} catch {
			/* a paint failure must not kill the timer */
		}
	}

	private stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** True while the coalescing timer is armed (for tests/introspection). */
	get running(): boolean {
		return this.timer !== null;
	}

	dispose(): void {
		this.stop();
	}
}

/** What the host installs so providers can drive repaints + change notifications. */
export interface PaneHost {
	requestRender(): void;
	onPanesChanged(): void;
}

export interface PaneRegistry {
	readonly version: number;
	readonly panes: Map<string, RichEditorPane>;
	/** Provider API: add/replace a pane; returns an unregister function. */
	register(pane: RichEditorPane): () => void;
	/** Provider API: ask the host to repaint (coalesced). No-op with no host. */
	requestRender(): void;
	/**
	 * Provider API: signal that a pane's animation cadence or content changed in a
	 * way that needs the host to re-derive its scheduler config (then repaint).
	 * Used by a pane whose owner lives in another extension (e.g. the avatar's
	 * engine changing state) where `register` isn't being called.
	 */
	changed(): void;
	/** Host API: attach/detach the editor as the composition target. */
	setHost(host: PaneHost | null): void;
	/**
	 * True when an editor host is attached. A provider whose surface can also be
	 * drawn standalone (e.g. session-banner's `setWidget` banner) uses this to
	 * defer to the host's integrated rendering and avoid a double banner.
	 */
	hasHost(): boolean;
	/** Gutter panes, left→right by ascending order. */
	gutters(): RichEditorPane[];
	/** The active banner pane (lowest order), or null. */
	banner(): RichEditorPane | null;
	/**
	 * Scheduler configuration derived from the registered panes:
	 * - `count`: how many panes need a host-driven tick (`animated: true`) — e.g.
	 *   pull-model panes that advance frames only when the host repaints.
	 * - `interval`: the fastest cadence any pane declares (`intervalMs`), whether
	 *   or not it is animated, so a push-model pane (its own timer drives frames,
	 *   `animated: false`) can still tighten the repaint rate cap while active.
	 */
	animation(): { count: number; interval: number };
}

// Bump whenever the PaneRegistry SHAPE changes (new method/field). The registry
// object lives on globalThis and survives `/reload` (module re-eval reuses it),
// so without a bump a stale object from before the change is reused and calls to
// the new method throw. v2 added `changed()`; v3 added `hasHost()`.
const REGISTRY_VERSION = 3;

interface InternalRegistry extends PaneRegistry {
	host: PaneHost | null;
}

/**
 * Get (creating on first touch) the process-wide pane registry. Load order does
 * not matter: whichever of rich-editor / a pane provider runs first creates it;
 * panes registered before the host attaches are drained when `setHost` runs.
 */
export function paneRegistry(): PaneRegistry {
	const g = globalThis as unknown as { __piRichEditorPanes?: InternalRegistry };
	// Reuse only a same-version registry that actually has the current shape — the
	// `changed` probe is belt-and-suspenders in case a shape change ever lands
	// without a REGISTRY_VERSION bump.
	if (
		g.__piRichEditorPanes &&
		g.__piRichEditorPanes.version === REGISTRY_VERSION &&
		typeof g.__piRichEditorPanes.changed === "function"
	) {
		return g.__piRichEditorPanes;
	}
	const reg: InternalRegistry = {
		version: REGISTRY_VERSION,
		panes: new Map<string, RichEditorPane>(),
		host: null,
		register(pane: RichEditorPane): () => void {
			this.panes.set(pane.id, pane);
			this.changed();
			return () => {
				const current = this.panes.get(pane.id);
				if (current !== pane) return; // already replaced; don't clobber the newer pane
				this.panes.delete(pane.id);
				try {
					pane.dispose?.();
				} catch {
					/* ignore */
				}
				this.changed();
			};
		},
		requestRender(): void {
			this.host?.requestRender();
		},
		changed(): void {
			this.host?.onPanesChanged();
			this.host?.requestRender();
		},
		setHost(host: PaneHost | null): void {
			this.host = host;
			if (host) {
				host.onPanesChanged();
				host.requestRender();
			}
		},
		hasHost(): boolean {
			return this.host !== null;
		},
		gutters(): RichEditorPane[] {
			return [...this.panes.values()]
				.filter((p) => p.slot === "gutter")
				.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		},
		banner(): RichEditorPane | null {
			return (
				[...this.panes.values()]
					.filter((p) => p.slot === "banner")
					.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0] ?? null
			);
		},
		animation(): { count: number; interval: number } {
			let count = 0;
			let interval = DEFAULT_TICK_MS;
			for (const p of this.panes.values()) {
				if (p.animated) count++;
				if (p.intervalMs != null) interval = Math.min(interval, p.intervalMs);
			}
			return { count, interval };
		},
	};
	g.__piRichEditorPanes = reg;
	return reg;
}
