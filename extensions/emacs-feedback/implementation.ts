import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const STATUS_KEY = 'emacs-feedback';

type NotifyType = 'info' | 'warning' | 'error';

export interface FeedbackNote {
  id: number;
  file: string;
  absoluteFile: string;
  startLine: number;
  endLine: number;
  quote: string;
  feedback: string;
  createdAt: string;
  source?: 'diff';
  location?: string;
  lineSide?: 'new' | 'old' | 'mixed';
  hunkHeader?: string;
}

export interface FeedbackBundle {
  version: 1;
  bundleId: string;
  projectRoot: string;
  sentAt: string;
  source: 'emacs';
  notes: FeedbackNote[];
}

export interface SessionDescriptor {
  version: 1;
  /**
   * Stable descriptor key: the Pi session id (sanitized, see
   * descriptorSessionId) when available, otherwise a random UUID. The inbox
   * and archive paths derive from it, so a stable id keeps a session's queued
   * notes reachable across switches, resumes, and reloads.
   */
  sessionId: string;
  projectRoot: string;
  cwd: string;
  pid: number;
  inboxPath: string;
  startedAt: string;
  sessionName?: string;
}

export interface StoragePaths {
  baseDir: string;
  sessionsDir: string;
  inboxDir: string;
  archiveDir: string;
}

export interface InboxParseError {
  line: number;
  content: string;
  message: string;
}

export interface ParsedInbox {
  bundles: FeedbackBundle[];
  errors: InboxParseError[];
}

export interface CreateSessionDescriptorOptions {
  home?: string;
  cwd?: string;
  sessionId?: string;
  now?: string;
  sessionName?: string;
}

export interface DescriptorFileOperations {
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  rm(file: string, options: { force: true }): Promise<unknown>;
}

export interface CommandContextLike {
  hasUI?: boolean;
  isIdle(): boolean;
  sessionManager?: {
    getSessionId?(): string | undefined;
  };
  ui?: {
    notify?(message: string, type?: NotifyType): void;
    setStatus?(key: string, value: string | undefined): void;
    confirm?(title: string, message?: string): boolean | Promise<boolean>;
  };
}

export interface RegisteredCommand {
  description: string;
  handler(args: unknown, ctx: CommandContextLike): void | Promise<void>;
}

export interface PiLike {
  registerCommand(name: string, command: RegisteredCommand): void;
  sendUserMessage(message: string, options?: { deliverAs: 'steer' | 'followUp' }): void;
  sendMessage?(message: { customType: string; content: string; display?: boolean }): void | Promise<void>;
}

export interface SessionLifecyclePiLike extends PiLike {
  on(
    event: string,
    handler: (event: unknown, ctx: CommandContextLike) => void | Promise<void>,
  ): void;
  getSessionName?(): string | undefined;
}

export function storagePaths(home = os.homedir()): StoragePaths {
  const baseDir = path.join(home, '.pi', 'emacs-feedback');

  return {
    baseDir,
    sessionsDir: path.join(baseDir, 'sessions'),
    inboxDir: path.join(baseDir, 'inbox'),
    archiveDir: path.join(baseDir, 'archive'),
  };
}

export function normalizeDirectory(directory: string): string {
  let normalized = path.resolve(directory);
  try {
    normalized = realpathSync.native(normalized);
  } catch (_error) {
    // The fallback path may not exist yet; still normalize it deterministically.
  }

  const parsed = path.parse(normalized);
  if (normalized === parsed.root) return normalized;
  return normalized.replace(/[\\/]+$/, '');
}

export function resolveProjectRoot(cwd = process.cwd()): string {
  try {
    const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const projectRoot = result.trim();
    return normalizeDirectory(projectRoot || cwd);
  } catch (_error) {
    return normalizeDirectory(cwd);
  }
}

function normalizeSessionName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized === '' ? undefined : normalized;
}

const SAFE_DESCRIPTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Map a Pi session id to a stable, filename-safe descriptor id.
 *
 * The descriptor id is also the inbox/archive key, so the same session must
 * always map to the same id — across switches, resumes, reloads, and process
 * restarts — or queued notes get stranded in an unreachable inbox. Safe ids
 * pass through unchanged; anything else is hashed deterministically. Returns
 * undefined when no usable id is available (callers fall back to a random
 * UUID).
 */
export function descriptorSessionId(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (SAFE_DESCRIPTOR_ID.test(trimmed)) return trimmed;
  return createHash('sha256').update(trimmed).digest('hex');
}

const descriptorFileOperations: DescriptorFileOperations = {
  writeFile,
  rename,
  rm,
};

async function writeSessionDescriptorAtomically(
  descriptor: SessionDescriptor,
  storage: StoragePaths,
  operations: DescriptorFileOperations = descriptorFileOperations,
): Promise<void> {
  const descriptorPath = path.join(storage.sessionsDir, `${descriptor.sessionId}.json`);
  const tempPath = path.join(
    storage.sessionsDir,
    `.${descriptor.sessionId}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await operations.writeFile(tempPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    await operations.rename(tempPath, descriptorPath);
  } catch (error) {
    await operations.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createSessionDescriptor(
  options: CreateSessionDescriptorOptions = {},
): Promise<SessionDescriptor> {
  const home = options.home ?? os.homedir();
  const cwd = normalizeDirectory(options.cwd ?? process.cwd());
  const sessionId = options.sessionId ?? randomUUID();
  const startedAt = options.now ?? new Date().toISOString();
  const storage = storagePaths(home);

  await mkdir(storage.sessionsDir, { recursive: true });
  await mkdir(storage.inboxDir, { recursive: true });
  await mkdir(storage.archiveDir, { recursive: true });

  const inboxPath = path.join(storage.inboxDir, `${sessionId}.jsonl`);
  const inboxHandle = await open(inboxPath, 'a');
  await inboxHandle.close();

  const sessionName = normalizeSessionName(options.sessionName);
  const descriptor: SessionDescriptor = {
    version: 1,
    sessionId,
    projectRoot: resolveProjectRoot(cwd),
    cwd,
    pid: process.pid,
    inboxPath,
    startedAt,
    ...(sessionName ? { sessionName } : {}),
  };

  await writeSessionDescriptorAtomically(descriptor, storage);

  return descriptor;
}

export async function updateSessionDescriptorName(
  descriptor: SessionDescriptor,
  value: unknown,
  storage: StoragePaths,
  operations: DescriptorFileOperations = descriptorFileOperations,
): Promise<SessionDescriptor> {
  const updated = { ...descriptor };
  const sessionName = normalizeSessionName(value);

  if (sessionName) {
    updated.sessionName = sessionName;
  } else {
    delete updated.sessionName;
  }

  await writeSessionDescriptorAtomically(updated, storage, operations);
  return updated;
}

export function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function formatLocation(note: FeedbackNote): string {
  if (typeof note.location === 'string' && note.location.trim() !== '') {
    return note.location.trim();
  }

  if (note.startLine === note.endLine) {
    return `${note.file}:${note.startLine}`;
  }

  return `${note.file}:${note.startLine}-${note.endLine}`;
}

export function countNotes(bundles: FeedbackBundle[]): number {
  return bundles.reduce((total, bundle) => total + bundle.notes.length, 0);
}

export function buildFeedbackMessage(bundles: FeedbackBundle[]): string {
  const notes = bundles.flatMap((bundle) => bundle.notes);
  const noteCount = notes.length;
  const noteLabel = noteCount === 1 ? 'note' : 'notes';
  const sections = [
    `I captured Emacs review feedback for the current changes (${noteCount} ${noteLabel}). Please address this feedback before continuing.`,
  ];

  for (const [index, note] of notes.entries()) {
    sections.push(
      [
        `Feedback ${index + 1} (${formatLocation(note)}):`,
        '',
        'Quoted selection:',
        quoteBlock(note.quote),
        '',
        'Feedback:',
        note.feedback,
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

export function parseInboxContent(content: string): ParsedInbox {
  const bundles: FeedbackBundle[] = [];
  const errors: InboxParseError[] = [];

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim() === '') {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push({
        line: index + 1,
        content: line,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (isFeedbackBundle(parsed)) {
      bundles.push(parsed);
    } else {
      errors.push({
        line: index + 1,
        content: line,
        message: 'Invalid feedback bundle',
      });
    }
  }

  return { bundles, errors };
}

export async function readInbox(inboxPath: string): Promise<ParsedInbox> {
  let content: string;
  try {
    content = await readFile(inboxPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { bundles: [], errors: [] };
    }
    throw error;
  }

  return parseInboxContent(content);
}

export async function clearInbox(inboxPath: string): Promise<void> {
  await writeFile(inboxPath, '', 'utf8');
}

export async function archiveBundlesAndClearInbox(
  descriptor: SessionDescriptor,
  bundles: FeedbackBundle[],
  storage: StoragePaths,
): Promise<void> {
  const sessionArchiveDir = path.join(storage.archiveDir, descriptor.sessionId);
  await mkdir(sessionArchiveDir, { recursive: true });

  for (const bundle of bundles) {
    const archivePath = path.join(sessionArchiveDir, `${bundle.bundleId}.json`);
    await writeFile(archivePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  }

  await clearInbox(descriptor.inboxPath);
}

export async function removeSessionDescriptor(
  descriptor: SessionDescriptor,
  storage: StoragePaths,
): Promise<void> {
  await rm(path.join(storage.sessionsDir, `${descriptor.sessionId}.json`), { force: true });
}

export function formatInboxSummary(parsed: ParsedInbox): string {
  const noteCount = countNotes(parsed.bundles);
  const noteLabel = noteCount === 1 ? 'note' : 'notes';
  const bundleLabel = parsed.bundles.length === 1 ? 'bundle' : 'bundles';
  const sections: string[] = [];

  if (noteCount === 0) {
    sections.push('No queued Emacs feedback.');
  } else {
    sections.push(
      `Queued Emacs feedback: ${noteCount} ${noteLabel} across ${parsed.bundles.length} ${bundleLabel}.`,
    );

    for (const bundle of parsed.bundles) {
      const lines = [
        `Bundle ${bundle.bundleId}`,
        `Sent: ${bundle.sentAt}`,
        `Project: ${bundle.projectRoot}`,
      ];

      for (const [index, note] of bundle.notes.entries()) {
        lines.push('');
        lines.push(`Feedback ${index + 1} (${formatLocation(note)}):`);
        lines.push('Quoted selection:');
        lines.push(quoteBlock(note.quote));
        lines.push('Feedback:');
        lines.push(note.feedback);
      }

      sections.push(lines.join('\n'));
    }
  }

  if (parsed.errors.length > 0) {
    sections.push(
      [
        'Malformed inbox lines were skipped:',
        ...parsed.errors.map(
          (error) => `Malformed line ${error.line}: ${error.message}\n${error.content}`,
        ),
      ].join('\n'),
    );
  }

  return sections.join('\n\n---\n\n');
}

export async function refreshStatus(
  ctx: CommandContextLike,
  descriptor: SessionDescriptor,
  _storage: StoragePaths,
): Promise<void> {
  const parsed = await readInbox(descriptor.inboxPath);
  const noteCount = countNotes(parsed.bundles);
  ctx.ui?.setStatus?.(STATUS_KEY, noteCount > 0 ? `emacs feedback ${noteCount}` : undefined);
}

export function registerCommands(
  pi: PiLike,
  getDescriptor: () => SessionDescriptor | undefined,
  storage: StoragePaths,
): void {
  const withDescriptor = async (
    ctx: CommandContextLike,
    callback: (descriptor: SessionDescriptor) => Promise<void>,
  ) => {
    const descriptor = getDescriptor();
    if (!descriptor) {
      await notify(pi, ctx, 'No active Emacs feedback session descriptor', 'error');
      return;
    }

    await callback(descriptor);
  };

  pi.registerCommand('emacs-feedback-address', {
    description: 'Ask the assistant to address queued Emacs feedback',
    handler: async (_args, ctx) => {
      await withDescriptor(ctx, async (descriptor) => {
        let parsed: ParsedInbox;
        try {
          parsed = await readInbox(descriptor.inboxPath);
        } catch (error) {
          await notify(pi, ctx, `Failed to read Emacs feedback inbox: ${errorMessage(error)}`, 'error');
          return;
        }

        const noteCount = countNotes(parsed.bundles);
        if (noteCount === 0) {
          await notify(pi, ctx, 'No queued Emacs feedback to address', 'info');
          await refreshStatus(ctx, descriptor, storage);
          return;
        }

        const message = buildFeedbackMessage(parsed.bundles);

        try {
          if (ctx.isIdle()) {
            pi.sendUserMessage(message);
          } else {
            pi.sendUserMessage(message, { deliverAs: 'followUp' });
          }
        } catch (error) {
          await notify(pi, ctx, `Failed to send Emacs feedback: ${errorMessage(error)}`, 'error');
          return;
        }

        if (parsed.errors.length > 0) {
          await notify(
            pi,
            ctx,
            'Malformed inbox lines were discarded while sending Emacs feedback',
            'warning',
          );
        }

        try {
          await archiveBundlesAndClearInbox(descriptor, parsed.bundles, storage);
        } catch (cleanupError) {
          let clearDetail = '';
          try {
            await clearInbox(descriptor.inboxPath);
          } catch (clearError) {
            clearDetail = ` Also failed to clear inbox: ${errorMessage(clearError)}`;
          }

          await notify(
            pi,
            ctx,
            `Sent Emacs feedback, but cleanup failed: ${errorMessage(cleanupError)}.${clearDetail}`,
            'error',
          );
        }

        await refreshStatus(ctx, descriptor, storage);
      });
    },
  });

  pi.registerCommand('emacs-feedback-list', {
    description: 'Show queued Emacs feedback notes',
    handler: async (_args, ctx) => {
      await withDescriptor(ctx, async (descriptor) => {
        let parsed: ParsedInbox;
        try {
          parsed = await readInbox(descriptor.inboxPath);
        } catch (error) {
          await notify(pi, ctx, `Failed to read Emacs feedback inbox: ${errorMessage(error)}`, 'error');
          return;
        }

        const content = formatInboxSummary(parsed);
        await sendDisplayMessage(pi, ctx, 'emacs-feedback-list', content);
        await refreshStatus(ctx, descriptor, storage);
      });
    },
  });

  pi.registerCommand('emacs-feedback-clear', {
    description: 'Clear queued Emacs feedback after confirmation',
    handler: async (_args, ctx) => {
      await withDescriptor(ctx, async (descriptor) => {
        let parsed: ParsedInbox;
        try {
          parsed = await readInbox(descriptor.inboxPath);
        } catch (error) {
          await notify(pi, ctx, `Failed to read Emacs feedback inbox: ${errorMessage(error)}`, 'error');
          return;
        }

        const noteCount = countNotes(parsed.bundles);
        if (noteCount === 0 && parsed.errors.length === 0) {
          await notify(pi, ctx, 'No queued Emacs feedback to clear', 'info');
          await refreshStatus(ctx, descriptor, storage);
          return;
        }

        if (ctx.ui?.confirm) {
          const noteLabel = noteCount === 1 ? 'note' : 'notes';
          const malformedLabel = parsed.errors.length === 1 ? 'malformed line' : 'malformed lines';
          const ok = await ctx.ui.confirm(
            'Clear queued Emacs feedback?',
            `Discard ${noteCount} feedback ${noteLabel} and ${parsed.errors.length} ${malformedLabel}?`,
          );
          if (!ok) return;
        }

        try {
          await clearInbox(descriptor.inboxPath);
        } catch (error) {
          await notify(pi, ctx, `Failed to clear Emacs feedback inbox: ${errorMessage(error)}`, 'error');
          return;
        }

        await notify(pi, ctx, 'Cleared queued Emacs feedback', 'info');
        await refreshStatus(ctx, descriptor, storage);
      });
    },
  });

  pi.registerCommand('emacs-feedback-help', {
    description: 'Show Emacs feedback workflow help',
    handler: async (_args, ctx) => {
      await sendDisplayMessage(pi, ctx, 'emacs-feedback-help', emacsFeedbackHelpText());
    },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidLineRange(startLine: unknown, endLine: unknown): boolean {
  return (
    Number.isInteger(startLine) &&
    Number.isInteger(endLine) &&
    (startLine as number) >= 1 &&
    (endLine as number) >= (startLine as number)
  );
}

export function isFeedbackNote(value: unknown): value is FeedbackNote {
  return (
    isRecord(value) &&
    Number.isInteger(value.id) &&
    typeof value.file === 'string' &&
    typeof value.absoluteFile === 'string' &&
    isValidLineRange(value.startLine, value.endLine) &&
    typeof value.quote === 'string' &&
    typeof value.feedback === 'string' &&
    typeof value.createdAt === 'string' &&
    (!('source' in value) || value.source === 'diff') &&
    (!('lineSide' in value) ||
      value.lineSide === 'new' ||
      value.lineSide === 'old' ||
      value.lineSide === 'mixed')
  );
}

export function isFeedbackBundle(value: unknown): value is FeedbackBundle {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.bundleId === 'string' &&
    typeof value.projectRoot === 'string' &&
    typeof value.sentAt === 'string' &&
    value.source === 'emacs' &&
    Array.isArray(value.notes) &&
    value.notes.every(isFeedbackNote)
  );
}

function emacsFeedbackHelpText(): string {
  return [
    'Emacs feedback workflow',
    '',
    '1. Review Pi-authored source changes in Emacs.',
    '2. Select source regions or Magit/diff lines, then run M-x pi-feedback-add.',
    '3. Repeat for every anchored review note.',
    '4. Run M-x pi-feedback-send to append a bundle to this Pi session inbox.',
    '5. In Pi, run /emacs-feedback-address to ask the assistant to address queued notes.',
    '',
    'Commands',
    '- /emacs-feedback-address: send queued Emacs feedback to the assistant.',
    '- /emacs-feedback-list: display queued notes and malformed inbox lines.',
    '- /emacs-feedback-clear: discard queued inbox content.',
    '- /emacs-feedback-help: show this help.',
    '',
    'V1 uses local JSONL files under ~/.pi/emacs-feedback and does not auto-trigger assistant turns from Emacs.',
  ].join('\n');
}

async function notify(
  pi: PiLike,
  ctx: CommandContextLike,
  message: string,
  type: NotifyType = 'info',
): Promise<void> {
  if (ctx.ui?.notify) {
    ctx.ui.notify(message, type);
    return;
  }

  await sendDisplayMessage(pi, ctx, 'emacs-feedback-notice', message);
}

async function sendDisplayMessage(
  pi: PiLike,
  ctx: CommandContextLike,
  customType: string,
  content: string,
): Promise<void> {
  if (pi.sendMessage) {
    await pi.sendMessage({ customType, content, display: true });
    return;
  }

  ctx.ui?.notify?.(content);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function registerSessionLifecycle(
  pi: SessionLifecyclePiLike,
  storage: StoragePaths,
  createOptions: CreateSessionDescriptorOptions = {},
  operations: DescriptorFileOperations = descriptorFileOperations,
): () => SessionDescriptor | undefined {
  let descriptor: SessionDescriptor | undefined;
  let pendingNameUpdates = Promise.resolve();
  const getDescriptor = () => descriptor;
  const supportsSessionName = typeof pi.getSessionName === 'function';

  pi.on('session_start', async (_event: unknown, ctx: CommandContextLike) => {
    let sessionName: string | undefined;
    if (supportsSessionName) {
      try {
        sessionName = pi.getSessionName?.();
      } catch (_error) {
        // Session registration remains available when the optional getter fails.
      }
    }

    // Key the descriptor by Pi's stable session id so a session switch,
    // resume, or reload recreates it with the SAME id — and therefore the
    // SAME inbox path — keeping queued notes reachable when the user returns
    // to the session. Random-UUID fallback for runtimes without the getter.
    let stableSessionId: string | undefined;
    try {
      stableSessionId = descriptorSessionId(ctx.sessionManager?.getSessionId?.());
    } catch (_error) {
      // A stale context can throw; the random fallback keeps registration alive.
    }

    try {
      descriptor = await createSessionDescriptor({
        ...createOptions,
        sessionId: createOptions.sessionId ?? stableSessionId,
        sessionName,
      });
      await refreshStatus(ctx, descriptor, storage);
    } catch (error) {
      await notify(
        pi,
        ctx,
        `Failed to register Emacs feedback session: ${errorMessage(error)}`,
        'error',
      );
    }
  });

  if (supportsSessionName) {
    pi.on('session_info_changed', (event: unknown, ctx: CommandContextLike) => {
      const sessionName = isRecord(event) ? event.name : undefined;
      // Pi may invoke event handlers concurrently, so preserve invocation order explicitly.
      pendingNameUpdates = pendingNameUpdates
        .then(async () => {
          const descriptorToUpdate = descriptor;
          if (!descriptorToUpdate) return;

          try {
            const updated = await updateSessionDescriptorName(
              descriptorToUpdate,
              sessionName,
              storage,
              operations,
            );
            if (descriptor === descriptorToUpdate) {
              descriptor = updated;
            }
          } catch (error) {
            await notify(
              pi,
              ctx,
              `Failed to update Emacs feedback session name: ${errorMessage(error)}`,
              'error',
            );
          }
        })
        .catch(() => undefined);
      return pendingNameUpdates;
    });
  }

  pi.on('session_shutdown', async () => {
    await pendingNameUpdates.catch(() => undefined);
    if (!descriptor) return;
    const descriptorToRemove = descriptor;
    descriptor = undefined;
    // Remove only the session descriptor on shutdown, so Emacs no longer
    // matches this (no longer active) session. Inbox JSONL files may hold
    // unaddressed Emacs feedback, so they are kept until address/clear
    // truncates them. The descriptor itself is disposable: the next
    // session_start for the same stable session id recreates it pointing at
    // the same inbox (see descriptorSessionId).
    await removeSessionDescriptor(descriptorToRemove, storage).catch(() => undefined);
  });

  return getDescriptor;
}

export default function emacsFeedback(pi: ExtensionAPI): void {
  const storage = storagePaths();
  const lifecyclePi = pi as unknown as SessionLifecyclePiLike;
  const getDescriptor = registerSessionLifecycle(lifecyclePi, storage);
  registerCommands(lifecyclePi, getDescriptor, storage);
}
