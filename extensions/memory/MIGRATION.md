# Migration from standalone pi-memory3

Imported from `~/Projects/Terminal/pi-memory3` commit `36852cf`. The former entry-keyed `extensions/memory` is retained in monorepo Git history; it is not the active implementation.

The bank remains `~/.pi/memory3` (or `PI_MEMORY_DIR`), with its settings, logs and revisions unchanged. This is a code move, not a bank migration. Back up the bank separately before switching.

## Activation

Install monorepo dependencies with `npm install`, which also installs this component's locked dependencies. Remove the standalone pi-memory3 package registration from Pi settings and enable `memory` through `/rl-extensions`; reload every Pi session using the bank. Do not enable both copies: tool names, commands and injection overlap. Verify `/memory` and `/memory doctor` in a fresh session.

## Rollback

Disable `memory` in `/rl-extensions`, restore the standalone pi-memory3 package registration, and reload every session. Keep only one implementation active. Neither direction moves or deletes the bank.

## Verification

From the monorepo root run `npm test`, `npm run typecheck` and `npm run verify:memory`. The latter includes isolated Vitest tests, real-Pi smoke and cross-process race probes. Test isolation is not an OS sandbox; never run tests concurrently with live bank writes. Retrieval and scope experiments remain opt-in.
