# todos

A task list the agent keeps, and you can see. The agent plans with it, moves tasks
through their life as it works, and the list is put back in front of it every turn —
so a long session keeps reacting to the plan it made instead of to the last tool
result.

It exists for goal drift. A long session accumulates tool calls, the original plan
stops being the thing the model is reacting to, and it finishes something adjacent.
Writing the plan down is the model's job; keeping it visible is this extension's.

## Enable

`/rl-extensions` → `todos`. Off until symlinked, like everything here.

Then ask for a plan, or say "track this as tasks". Four tools appear:

| Tool | What it is for |
|---|---|
| `TodoCreate` | Plan the work. Pass `tasks: [...]` to create several in one call. |
| `TodoList` | The whole list, with `[ready]` and `[blocked by #id]` marked. |
| `TodoGet` | One task in full: description, dependencies, owner, metadata, elapsed. |
| `TodoUpdate` | `status`, fields, and `addBlocks` / `addBlockedBy` links. |

And one command: `/todos` (panel), `/todos clear`, `/todos settings`.

## What you see

A row above the editor while the list is non-empty: the tally, then one line per
task, up to 12. A task the agent marked `in_progress` gets a spinner and its elapsed
time, so you can tell "working on it" from "planned, forgotten". Past 12 rows it says
`… N more (see TodoList)` rather than growing into a wall.

`/todos` opens the panel, where you can move tasks without asking:

```
↑↓ move   enter act   s start   d done   b block   x delete
c clear done   t show done   o settings   q close
```

`enter` means *start* on pending work and *finish* on work that is running.

Completed tasks start hidden — they are the least useful rows in the panel — and the
header says how many are hidden. Every keystroke goes through the same code path as
the model's `TodoUpdate`, so a rule the model cannot bypass is a rule you cannot
bypass either.

## Where the list lives

Default: `<cwd>/.pi/tasks/tasks-<sessionId>.json`. It survives `/resume`, and shares
nothing with another session — the failure mode of a shared default task file is one
session quietly finishing another session's plan.

`/todos settings` writes `<cwd>/.pi/tasks-config.json`:

| `taskScope` | file |
|---|---|
| `session` | `<cwd>/.pi/tasks/tasks-<sessionId>.json` (default) |
| `project` | `<cwd>/.pi/tasks/tasks.json`, so a new session inherits the open work |
| `memory` | nothing on disk; the list ends with the session |

`PI_TODOS` overrides the location and wins over the config file:

| value | file |
|---|---|
| `off` | none — for CI and automation |
| `/abs/x.json`, `./rel.json`, `~/x.json` | that file |
| `sprint-1` | `~/.pi/tasks/sprint-1.json` — a named list several sessions can share |

A bare name becomes a filename, so it is reduced to a basename of safe characters:
`PI_TODOS=../../etc/passwd` names a list, it does not point outside `~/.pi/tasks`.

## Finished work disappears, on purpose

`autoClearCompleted` decides what happens to completed tasks, `4` turns after they
land (the grace period exists so you can see what it did before it vanishes):

| mode | behaviour |
|---|---|
| `on_list_complete` | **default.** Once every task is finished, the whole list clears. |
| `on_task_complete` | Each task clears on its own countdown. |
| `never` | Completed tasks stay until `/todos clear`. |

`on_list_complete` never starts counting while one task is still open, and a task
reopened after finishing leaves the schedule. A plan that is half done is not
cleared, which is the difference between tidying and losing the plan.

## What the model gets, and what it costs

- `before_agent_start` appends the **open** work only — in progress, then pending by
  priority, then blocked/failed — with the count of finished tasks on one line.
  A list with nothing open adds nothing at all.
- Tool descriptions, `promptSnippet` and `promptGuidelines` carry the workflow
  (plan in one call, `in_progress` before starting, `completed` only when fully
  done) so the behaviour does not depend on your prompt.
- After **4** turns without a task tool call, one tool result carries a
  `<system-reminder>` nudging it back. Once per quiet stretch, never twice in a row,
  and never when the list is empty.

## Rules the store refuses

These come back as a readable tool result, not a stack trace:

- a dependency that would form a **cycle**;
- a link to an id that does not exist;
- completing a task whose **subtasks** are still open;
- a `parentId` pointing at a missing parent, or at one of its own descendants.

Ids are `t1`, `t2`, … and are listed in creation order everywhere — a list that
reads `t1, t10, t2` reads as a wrong plan.

## When storage goes wrong

A task list is not worth breaking a session for:

- **corrupt file** → moved aside to `<name>.corrupt-<timestamp>` (never overwritten),
  the session continues on an in-memory list, and you are told once per message;
- **unwritable path** → same fallback, same one report;
- **a file that was fine and then broke** → an error, not an empty list: the model is
  not told "no tasks" when the truth is "unreadable";
- **two sessions, one file** → writes are serialised by a lock file, and each one
  re-reads the file *inside* the lock, so a mutation is applied to what is on disk
  rather than to a snapshot taken earlier. A refused mutation rolls the record back to
  those bytes. A lock left by a dead process is broken once its pid is checked; a lock
  still held after ~5 s is an error the tool reports, not a hang.

## Limits

- `in_progress` means the agent said it is working. There is no claim or heartbeat:
  if a session dies mid-task, the file keeps `in_progress`, and a new session shows it
  that way until someone presses `s` (or the agent updates it).
- The widget caps at 12 rows by design; the count line keeps the truth anyway.
- `PI_TODOS=off` and `taskScope: memory` mean **no persistence** — `/resume` finds an
  empty list, and says so.
- A named shared list (`PI_TODOS=sprint-1`) is one file read by several sessions at
  once. The merge rules above apply; it is still a coordination surface, not a queue.
- Nothing here stops the model from *claiming* a task is done. `TodoUpdate` records
  what the agent says; verifying it is the tests' job.
