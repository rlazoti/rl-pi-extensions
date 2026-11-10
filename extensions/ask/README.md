---
summary: Multi-question interface with single/multi-select, structured options, recommendations, and skip tracking.
tools: [ask]
category: interaction
keywords: [questions, multi-select, single-select, user-input, feedback]
---

# ask

Unified multi-question interface for gathering user input with single-select, multi-select, structured options, and explicit skip tracking.

## Features

- **Single or multiple questions** — pass one question or an array for tabbed interface
- **Multi-select** (default) — checkboxes, toggle multiple with Space
- **Single-select** — radio buttons, Space picks one and deselects previous (`multi: false`)
- **Structured options** — `{ label, value, description?, recommended? }`
- **Recommended badge** — ★ marker on recommended options, pre-focused
- **Descriptions** — tooltip-style, shown only when option is focused
- **Notes** — press Enter on an option to attach a note; it is included in the answer
- **Notes that outlive one option** — `n` writes one note for the whole ask, `m` one for the current question (answered, skipped or not); both work on the Done tab, and both are rendered as context, never as an answer
- **Free-form** — questions without options accept typed text
- **Custom option** — inline "Custom..." option at the bottom of every option list
- **Three-state tracking**: ✓ answered, ↷ skipped, ○ unanswered

## Configuration

Edit `config.ts` to toggle features:

```typescript
export const defaultConfig: AskConfig = {
  enableSingleSelect: true,   // Allow multi: false questions
  enableRecommended: true,     // Show ★ badges, pre-focus recommended
  enableDescriptions: true,    // Show descriptions on focus
  showCustomOption: true,      // Show "Custom..." option
  enableFreeForm: true,        // Allow questions without options
  enableNotes: true,           // Allow notes on selected options
  enableNotifications: true,   // Emit notify:send so the notify extension alerts you while waiting for input
};
```

## Usage

### String shorthand
```typescript
await ask({
  questions: {
    id: "color",
    label: "Color",
    question: "Pick a color",
    options: ["Red", "Green", "Blue"]  // becomes { label: "Red", value: "Red" }
  }
})
```

### Structured options
```typescript
await ask({
  questions: {
    id: "strategy",
    label: "Strategy",
    question: "Deployment strategy?",
    multi: false,
    options: [
      { label: "Fast", value: "fast", description: "Skip tests, deploy immediately", recommended: true },
      { label: "Safe", value: "safe", description: "Run full test suite first" },
      { label: "Canary", value: "canary", description: "Roll out to 5% of traffic" }
    ]
  }
})
```

### Multiple questions
```typescript
await ask({
  questions: [
    { id: "q1", label: "One", question: "Pick one", multi: false, options: [...] },
    { id: "q2", label: "Details", question: "Tell me more" },
    { id: "q3", label: "Many", question: "Pick many", options: [...] }
  ]
})
```

## Keyboard Navigation

| Key | Action |
|-----|--------|
| **Tab** / **l** | Next tab |
| **Shift+Tab** / **h** | Previous tab |
| **j** / **↓** | Focus next option |
| **k** / **↑** | Focus previous option |
| **Space** | Toggle focused option |
| **1-9** | Quick toggle by number |
| **Enter** | Edit a note on an option, or open the custom/free-form editor; submit on Done (while a note editor is open, Enter saves the note instead) |
| **n** | Note for **all** questions — works on any tab, including Done |
| **m** | Note for **this** question, without picking an option (nothing to annotate on Done) |
| **s** | Skip question (clears selections, keeps its note) |
| **Esc** | Cancel |

## Result Format

```typescript
{
  answers: {
    q1: [
      { label: "Fast", value: "fast", description: "Skip tests", note: "only if CI is green" },
      { value: "my custom text", custom: true }
    ]
  },
  skipped: ["q2"],
  unanswered: ["q3"],
  note: "applies to every question",
  questionNotes: { q2: "this is the reason I skipped it" }
}
```

Notes are the user's own words, so they are the least ambiguous thing in the result: read them
before weighing the options. `note` and `questionNotes` are omitted entirely when nobody typed one,
and they survive skipping (an option note belongs to the answer it qualified, so it goes with the
answer). The tool text puts them on lines above the JSON — `User note: …`, `User note on q2
("…"): …` — so they read as context rather than as another answer; multi-line or padded text is
folded to one line there and kept verbatim in the JSON.

Results always return structured objects. Custom answers include `custom: true`. Option notes appear in the answer's `note` field.

## Runtime and migration

This copy is managed by `/rl-extensions`. The prior installation at
`~/.pi/agent/extensions/ask` may be a real directory, which the manager will not
replace. Before enabling this copy, move the old directory to a backup **outside**
`~/.pi/agent/extensions/`, then enable `ask` and `/reload`. Never load both copies:
they register the same tool. To roll back, disable the symlink, restore the old
directory and reload. Do not move the live installation without the owner's approval.

A single free-form question uses `ctx.ui.input` and works in TUI or RPC when the
host supports it. The tabbed questionnaire requires TUI; in RPC or without a UI it
returns the existing no-UI result. Cancellation and no-UI results currently tell
the model to proceed with its best judgment; they are not approval grants.

This extension emits `notify:send` for listeners and balanced `herdr:blocked`
events. `session-attention` separately observes `ask` tool execution, so enabling
another `notify:send` listener may produce duplicate notifications.
