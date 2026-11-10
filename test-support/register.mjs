// Test bootstrap: loaded via `node --import ./test-support/register.mjs`
// so the resolve hook is active before any test file links its imports.
//
// Why this exists:
// - Extension sources use `.js` relative specifiers (jiti/Pi convention);
//   Node's type stripping does not remap `.js` to `.ts`, so the hook does.
// - Extensions import Pi packages (@earendil-works/*, @mariozechner/*) that
//   the Pi runtime provides. This repo deliberately keeps no copy: an exact pin
//   in package.json is resolved by pnpm even under --prod, so a registry mirror
//   that lags one Pi release would block installing this package at all. The
//   hook maps those specifiers to the packages the running Pi actually loaded
//   (the release named in ~/.pi/agent/install/current-version) *before* normal
//   resolution, and refuses with instructions when there is no Pi install —
//   `npm run typecheck` reads the same install via .pi/tsconfig.pi-types.json,
//   so the type gate cannot check a different Pi than the one under test.
// - tests/test-harness.test.ts pins all of this, including that the repo's
//   manifests carry no @earendil-works dependency and no pinned peer.

import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));
