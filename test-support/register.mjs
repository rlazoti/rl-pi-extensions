// Test bootstrap: loaded via `node --import ./test-support/register.mjs`
// so the resolve hook is active before any test file links its imports.
//
// Why this exists:
// - Extension sources use `.js` relative specifiers (jiti/Pi convention);
//   Node's type stripping does not remap `.js` to `.ts`, so the hook does.
// - Extensions import Pi packages (@earendil-works/*, @mariozechner/*) that
//   are peer dependencies provided by the Pi runtime. The hook maps them to
//   the real packages in the local Pi install
//   (~/.pi/agent/install/releases/<version>/node_modules) — the same code Pi
//   loads — *before* normal resolution, because `npm install` also puts a
//   pinned copy in this repo's node_modules for the sake of `npm run
//   typecheck`. Letting that copy win would silently test against versions
//   that lag the running Pi (it happened once: pi-ai's root has no `complete`
//   export, while Pi serves the root as the compat entrypoint).
// - tests/test-harness.test.ts pins all of this, including a check that the
//   pinned copy matches the runtime version.

import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));
