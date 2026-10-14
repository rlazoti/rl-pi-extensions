/**
 * Memory extension — entry-keyed knowledge store with a write-time conflict gate.
 *
 * Status: Phase 1 of the build (entry schema + parser) is implemented in
 * `schema.ts`; this factory deliberately registers **nothing yet**, because the
 * extension is not finished and must stay inert: it is not symlinked into
 * ~/.pi/agent/extensions, and a half-built memory extension must never compete
 * with the one that is actually maintaining the memory bank.
 *
 * Phases still to land (see README.md § Build order):
 *   2 resolver (authority order) · 3 admission gate + conflict protocol
 *   4 injector · 5 tools + doctor + migration · 6 daily-rollover fixes
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	// No tools, commands, or hooks yet. Asserted by index.test.ts.
	void pi;
}
