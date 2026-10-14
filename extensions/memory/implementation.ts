/**
 * Memory extension — entry-keyed knowledge store with a write-time conflict gate.
 *
 * Status: Phases 1-2 of the build are implemented — `schema.ts` (entry schema +
 * tolerant topic-file parser) and `resolver.ts` (two-gate authority resolution).
 * This factory deliberately registers **nothing yet**, because the extension is
 * not finished and must stay inert: it is not symlinked into
 * ~/.pi/agent/extensions, and a half-built memory extension must never compete
 * with the one that is actually maintaining the memory bank.
 *
 * Phases still to land (see README.md § Build order):
 *   3 admission gate + conflict protocol · 4 injector · 5 tools + doctor +
 *   migration + single-instance guard · 6 daily-rollover fixes
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	// No tools, commands, or hooks yet. Asserted by index.test.ts.
	void pi;
}
