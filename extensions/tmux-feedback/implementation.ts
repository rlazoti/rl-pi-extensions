import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "tmux-feedback";
const STATUS_KEY = "tmux-feedback";
const MAX_QUOTE_TITLE_CHARS = 72;
const MAX_NOTE_FEEDBACK_SNIPPET_CHARS = 40;
const MAX_NOTE_QUOTE_SNIPPET_CHARS = 48;
const EDIT_FEEDBACK_ACTION = "Edit feedback";
const REMOVE_NOTE_ACTION = "Remove note";
const BACK_ACTION = "Back";
const TMUX_CAPTURE_COMMAND = "/feedback-capture";
const TMUX_FEEDBACK_BINDING = `send-keys -X copy-selection-and-cancel; send-keys C-c; send-keys -l ${TMUX_CAPTURE_COMMAND}; send-keys Enter`;

export interface FeedbackNote {
  id: number;
  quote: string;
  feedback: string;
  createdAt: string;
}

interface FeedbackState {
  notes: FeedbackNote[];
  nextId: number;
}

interface FeedbackSnapshot extends FeedbackState {
  action: "snapshot";
}

type NotifyType = "info" | "warning" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFeedbackNote(value: unknown): value is FeedbackNote {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isInteger(value.id) &&
    value.id > 0 &&
    typeof value.quote === "string" &&
    typeof value.feedback === "string" &&
    typeof value.createdAt === "string"
  );
}

function cloneNotes(notes: readonly FeedbackNote[]): FeedbackNote[] {
  return notes.map((note) => ({ ...note }));
}

function normalizeSnapshot(data: unknown): FeedbackState | undefined {
  if (!isRecord(data) || data.action !== "snapshot" || !Array.isArray(data.notes)) return undefined;

  const notes: FeedbackNote[] = [];
  const seenIds = new Set<number>();

  for (const value of data.notes) {
    if (!isFeedbackNote(value) || seenIds.has(value.id)) continue;
    seenIds.add(value.id);
    notes.push({ ...value });
  }

  const highestId = notes.reduce((max, note) => Math.max(max, note.id), 0);
  const requestedNextId =
    typeof data.nextId === "number" && Number.isInteger(data.nextId) && data.nextId > 0 ? data.nextId : 1;

  return {
    notes,
    nextId: Math.max(requestedNextId, highestId + 1),
  };
}

export function reconstructFeedbackState(branch: readonly unknown[]): FeedbackState {
  let state: FeedbackState = { notes: [], nextId: 1 };

  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
    const snapshot = normalizeSnapshot(entry.data);
    if (snapshot) state = snapshot;
  }

  return state;
}

function normalizeQuote(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function singleLineSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function buildFeedbackMessage(notes: readonly FeedbackNote[]): string {
  const noteLabel = notes.length === 1 ? "note" : "notes";
  const lines: string[] = [
    `I captured inline feedback from tmux scrollback (${notes.length} ${noteLabel}). Please address this feedback before continuing.`,
    "",
  ];

  notes.forEach((note, index) => {
    lines.push(`Feedback ${index + 1} (note #${note.id}):`);
    lines.push("");
    lines.push("Quoted selection:");
    lines.push(quoteBlock(note.quote));
    lines.push("");
    lines.push("Feedback:");
    lines.push(note.feedback.trim());
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

function normalizeEditableFeedback(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function notesMatch(left: FeedbackNote, right: FeedbackNote): boolean {
  return (
    left.id === right.id &&
    left.quote === right.quote &&
    left.feedback === right.feedback &&
    left.createdAt === right.createdAt
  );
}

function formatNoteOption(note: FeedbackNote): string {
  const feedback = truncate(singleLineSnippet(note.feedback), MAX_NOTE_FEEDBACK_SNIPPET_CHARS);
  const quote = truncate(singleLineSnippet(note.quote), MAX_NOTE_QUOTE_SNIPPET_CHARS);
  return `#${note.id} · ${feedback} — “${quote}”`;
}

function noteActionTitle(note: FeedbackNote): string {
  return `Tmux feedback #${note.id}: ${truncate(singleLineSnippet(note.quote), MAX_QUOTE_TITLE_CHARS)}`;
}

function tmuxBindingCommands(): string[][] {
  return [
    ["bind-key", "-T", "copy-mode", "Y", TMUX_FEEDBACK_BINDING],
    ["bind-key", "-T", "copy-mode-vi", "Y", TMUX_FEEDBACK_BINDING],
  ];
}

function feedbackHelpText(): string {
  return [
    "Tmux feedback workflow",
    "",
    "1. In the pi tmux pane, enter tmux copy-mode.",
    "2. Scroll to the assistant text you want to comment on.",
    "3. Select the exact text you want to anchor feedback to.",
    "4. Press capital Y in tmux copy-mode.",
    "5. The binding copies the selection, exits copy-mode, clears any partial pi input with Ctrl+C, sends /feedback-capture, and opens a feedback editor.",
    "6. Type your feedback and submit it. Repeat for more notes.",
    "7. Run /feedback-send when you want the assistant to read all queued feedback.",
    "",
    "Commands",
    "- /feedback-capture: read the latest tmux buffer and queue feedback for it.",
    "- /feedback-send: send all queued feedback to the assistant.",
    "- /feedback-list: select a queued note to edit its feedback or remove it.",
    "- /feedback-clear: discard queued feedback notes.",
    "- /feedback-install-tmux-binding: install the Y binding in the current tmux server.",
    "- /feedback-help: show this help.",
    "",
    "Persistent ~/.tmux.conf binding",
    `bind-key -T copy-mode Y ${TMUX_FEEDBACK_BINDING.replaceAll(";", "\\;")}`,
    `bind-key -T copy-mode-vi Y ${TMUX_FEEDBACK_BINDING.replaceAll(";", "\\;")}`,
    "",
    "Caveats",
    "- The Y binding targets the current tmux pane; use it from the pi pane.",
    "- Ctrl+C clearing is intentional so /feedback-capture does not get appended to partially typed input.",
    "- If the assistant is actively running, Ctrl+C could interrupt it; this workflow is meant for reviewing completed answers.",
  ].join("\n");
}

function notify(ctx: ExtensionContext, message: string, type: NotifyType = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
  }
}

export default function tmuxFeedback(pi: ExtensionAPI) {
  let notes: FeedbackNote[] = [];
  let nextId = 1;

  const updateStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, notes.length > 0 ? `tmux feedback ${notes.length}` : undefined);
  };

  const reconstructState = (ctx: ExtensionContext) => {
    const state = reconstructFeedbackState(ctx.sessionManager.getBranch());
    notes = cloneNotes(state.notes);
    nextId = state.nextId;
    updateStatus(ctx);
  };

  const appendSnapshot = (ctx: ExtensionContext) => {
    const snapshot: FeedbackSnapshot = {
      action: "snapshot",
      notes: cloneNotes(notes),
      nextId,
    };

    pi.appendEntry(CUSTOM_TYPE, snapshot);
    updateStatus(ctx);
  };

  const readLatestTmuxBuffer = async (): Promise<string> => {
    const result = await pi.exec("tmux", ["show-buffer"], { timeout: 2_000 });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `tmux show-buffer exited ${result.code}`;
      throw new Error(detail);
    }
    return normalizeQuote(result.stdout);
  };

  const captureFeedback = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      notify(ctx, "/feedback-capture requires interactive mode", "error");
      return;
    }

    reconstructState(ctx);

    let quote: string;
    try {
      quote = await readLatestTmuxBuffer();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      notify(ctx, `Could not read tmux buffer: ${detail}`, "error");
      return;
    }

    if (!quote) {
      notify(ctx, "tmux buffer is empty. Select text in copy-mode first.", "warning");
      return;
    }

    const title = `Feedback for: ${truncate(singleLineSnippet(quote), MAX_QUOTE_TITLE_CHARS)}`;
    const feedback = await ctx.ui.editor(title, "");
    const trimmedFeedback = feedback?.trim() ?? "";
    if (!trimmedFeedback) {
      notify(ctx, "Feedback cancelled", "info");
      return;
    }

    const note: FeedbackNote = {
      id: nextId++,
      quote,
      feedback: trimmedFeedback,
      createdAt: new Date().toISOString(),
    };

    notes = [...notes, note];
    appendSnapshot(ctx);
    notify(ctx, `Queued tmux feedback #${note.id}`, "info");
  };

  const sendFeedback = async (ctx: ExtensionContext) => {
    reconstructState(ctx);

    if (notes.length === 0) {
      notify(ctx, "No queued tmux feedback to send", "info");
      return;
    }

    const queuedNotes = cloneNotes(notes);
    const message = buildFeedbackMessage(queuedNotes);
    const busy = !ctx.isIdle();

    try {
      if (busy) {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
      } else {
        pi.sendUserMessage(message);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      notify(ctx, `Failed to send feedback: ${detail}`, "error");
      return;
    }

    notes = [];
    nextId = 1;
    appendSnapshot(ctx);
    notify(
      ctx,
      busy
        ? `Queued ${queuedNotes.length} feedback ${queuedNotes.length === 1 ? "note" : "notes"} as follow-up`
        : `Sent ${queuedNotes.length} feedback ${queuedNotes.length === 1 ? "note" : "notes"}`,
      "info",
    );
  };

  const listFeedback = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      notify(ctx, "/feedback-list requires interactive mode", "error");
      return;
    }

    reconstructState(ctx);

    while (true) {
      if (notes.length === 0) {
        notify(ctx, "No queued tmux feedback", "info");
        return;
      }

      const optionToId = new Map(notes.map((note) => [formatNoteOption(note), note.id]));
      const selectedOption = await ctx.ui.select("Queued tmux feedback", [...optionToId.keys()]);
      if (selectedOption === undefined) return;

      const selectedId = optionToId.get(selectedOption);
      const selectedNote = notes.find((note) => note.id === selectedId);
      if (!selectedNote) {
        notify(ctx, "Selected tmux feedback is no longer available", "warning");
        continue;
      }

      const selectedSnapshot = { ...selectedNote };

      while (true) {
        const currentNote = notes.find((note) => note.id === selectedSnapshot.id);
        if (!currentNote || !notesMatch(currentNote, selectedSnapshot)) {
          notify(ctx, `Tmux feedback #${selectedSnapshot.id} changed. Reopen it and try again.`, "warning");
          break;
        }

        const action = await ctx.ui.select(noteActionTitle(currentNote), [
          EDIT_FEEDBACK_ACTION,
          REMOVE_NOTE_ACTION,
          BACK_ACTION,
        ]);
        if (action === undefined || action === BACK_ACTION) break;

        if (action === EDIT_FEEDBACK_ACTION) {
          const original = { ...currentNote };
          const editedFeedback = await ctx.ui.editor(
            `${EDIT_FEEDBACK_ACTION} for tmux feedback #${original.id}: ${truncate(singleLineSnippet(original.quote), MAX_QUOTE_TITLE_CHARS)}`,
            original.feedback,
          );
          if (editedFeedback === undefined) {
            notify(ctx, "Feedback edit cancelled", "info");
            break;
          }

          const normalizedFeedback = normalizeEditableFeedback(editedFeedback);
          if (!normalizedFeedback) {
            notify(ctx, "Feedback edit cancelled", "info");
            break;
          }
          if (normalizedFeedback === normalizeEditableFeedback(original.feedback)) break;

          const noteIndex = notes.findIndex(
            (note) => note.id === original.id && notesMatch(note, original),
          );
          if (noteIndex === -1) {
            notify(ctx, `Tmux feedback #${original.id} changed. Reopen it and try again.`, "warning");
            break;
          }

          notes = notes.map((note, index) =>
            index === noteIndex ? { ...note, feedback: normalizedFeedback } : note,
          );
          appendSnapshot(ctx);
          notify(ctx, `Updated tmux feedback #${original.id}`, "info");
          break;
        }

        if (action === REMOVE_NOTE_ACTION) {
          const original = { ...currentNote };
          const confirmed = await ctx.ui.confirm(
            `Remove tmux feedback #${original.id}?`,
            `Remove the note for “${truncate(singleLineSnippet(original.quote), MAX_NOTE_QUOTE_SNIPPET_CHARS)}”?`,
          );
          if (!confirmed) continue;

          const noteIndex = notes.findIndex(
            (note) => note.id === original.id && notesMatch(note, original),
          );
          if (noteIndex === -1) {
            notify(ctx, `Tmux feedback #${original.id} changed. Reopen it and try again.`, "warning");
            break;
          }

          notes = notes.filter((_note, index) => index !== noteIndex);
          appendSnapshot(ctx);
          notify(ctx, `Removed tmux feedback #${original.id}`, "info");
          break;
        }
      }
    }
  };

  const clearFeedback = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      notify(ctx, "/feedback-clear requires interactive mode", "error");
      return;
    }

    reconstructState(ctx);

    if (notes.length === 0) {
      notify(ctx, "No queued tmux feedback to clear", "info");
      return;
    }

    const ok = await ctx.ui.confirm(
      "Clear queued tmux feedback?",
      `Discard ${notes.length} queued feedback ${notes.length === 1 ? "note" : "notes"}?`,
    );
    if (!ok) return;

    notes = [];
    nextId = 1;
    appendSnapshot(ctx);
    notify(ctx, "Cleared queued tmux feedback", "info");
  };

  const installTmuxBinding = async (ctx: ExtensionContext) => {
    let installed = 0;
    for (const args of tmuxBindingCommands()) {
      const result = await pi.exec("tmux", args, { timeout: 2_000 });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `tmux ${args.join(" ")} exited ${result.code}`;
        notify(ctx, `Failed to install tmux binding: ${detail}`, "error");
        return;
      }
      installed++;
    }

    notify(ctx, `Installed tmux feedback binding in ${installed} copy-mode tables (Y, clears partial pi input first)`, "info");
  };

  const showHelp = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      notify(ctx, "/feedback-help requires interactive mode", "error");
      return;
    }

    await ctx.ui.editor("Tmux feedback help", feedbackHelpText());
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  pi.registerCommand("feedback-capture", {
    description: "Capture selected tmux copy buffer text and queue feedback for it",
    handler: async (_args, ctx) => captureFeedback(ctx),
  });

  pi.registerCommand("feedback-send", {
    description: "Send all queued tmux feedback as one user message",
    handler: async (_args, ctx) => sendFeedback(ctx),
  });

  pi.registerCommand("feedback-list", {
    description: "Edit or remove queued tmux feedback notes",
    handler: async (_args, ctx) => listFeedback(ctx),
  });

  pi.registerCommand("feedback-clear", {
    description: "Clear queued tmux feedback notes after confirmation",
    handler: async (_args, ctx) => clearFeedback(ctx),
  });

  pi.registerCommand("feedback-install-tmux-binding", {
    description: "Install the current-session tmux copy-mode Y binding for feedback capture",
    handler: async (_args, ctx) => installTmuxBinding(ctx),
  });

  pi.registerCommand("feedback-help", {
    description: "Show tmux feedback workflow help and caveats",
    handler: async (_args, ctx) => showHelp(ctx),
  });
}
