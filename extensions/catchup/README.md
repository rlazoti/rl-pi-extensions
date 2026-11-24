# catchup

`/catchup` answers: **Did any new local commits touch the files this Pi session was working on?**

Enable **catchup** in `/rl-extensions`, then `/reload`. Or try it for one Pi launch with `pi -e /path/to/rl-pi-extensions/extensions/catchup`.

1. Before parking a session, run `/catchup mark` to save the current local branch and commit. A first `/catchup` saves it too if there is no checkpoint.
2. After resuming the same session, run `/catchup` to see new commits, with overlaps first. Rerunning it keeps the same checkpoint so you can review the list again.
3. Once caught up, run `/catchup mark` to start a new comparison window.

For example:

```text
/catchup: 2 new commits on main since 7b1a2ef.
1 overlapping commit in this scan (checked 2 edited or currently changed paths).
  c6b3194  Fix checkout rounding — src/billing/tax.ts
  9cab820  Update the changelog
```

The checkpoint is non-model metadata on the active Pi conversation path. A saved session retains it across restarts and compaction. `/tree` can move to a point before it; forks and clones start with their own checkpoint. Pi doesn't create an on-disk session until it has a conversation message, so a checkpoint made before the first prompt is still in memory.

## What it compares

- The **current local branch**, from the checkpoint to its current tip. It checks the newest 200 first-parent commits and shows at most eight, prioritizing overlaps. A merge counts as one commit and is compared to its first parent. This is not an upstream or worktree-target check; changes on a different branch will not appear until they reach the current branch.
- Paths from successful `edit`/`write` history on the active conversation path and from the current staged, unstaged, and non-ignored untracked paths. Completed nested edits (including codemode) count when Pi's bounded nested-call history retains their path. Arbitrary Bash edits already committed cannot be attributed. Current working changes may include someone else's work in a shared checkout. Submodule working changes are ignored. Paths match by name, not by file identity across renames.
- If the checkout, branch, or ancestry no longer matches, it preserves the old checkpoint and asks you to switch back or explicitly mark again. Detached HEAD and branches without commits cannot be marked. If Git exceeds the time or output budget, it reports the error rather than presenting a partial result as complete.

The command runs no model, injects no prompt, and performs no background Git work. It never fetches (including lazy fetches in partial clones), merges, or changes the checkout. Verified with Pi 1.6.0 and Git 2.56.0; Git must support `--no-lazy-fetch`.
