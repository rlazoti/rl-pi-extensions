// Test bootstrap: loaded via `node --import ./test-support/register.mjs`
// so the resolve hook is active before any test file links its imports.
//
// Why this exists:
// - Extension sources use `.js` relative specifiers (jiti/Pi convention);
//   Node's type stripping does not remap `.js` to `.ts`, so the hook does.
// - Extensions import Pi packages (@earendil-works/*, @mariozechner/*) that
//   are peer dependencies provided by the Pi runtime, not by this repo's
//   node_modules. The hook aliases them to the real packages from the local
//   Pi install (~/.pi/agent/install/releases/<version>/node_modules), the
//   same versions Pi itself loads.

import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));
