import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as emacsFeedback from './implementation.ts';

const {
  buildFeedbackMessage,
  countNotes,
  parseInboxContent,
  quoteBlock,
  storagePaths,
} = emacsFeedback;

const noteA = {
  id: 1,
  file: 'app/models/widget.rb',
  absoluteFile: '/repo/app/models/widget.rb',
  startLine: 10,
  endLine: 12,
  quote: 'if widget.nil?\n  return\nend',
  feedback: 'Please preserve the existing nil fallback.',
  createdAt: '2026-06-13T00:00:00.000Z',
};
const noteB = {
  id: 2,
  file: 'test/widget_test.rb',
  absoluteFile: '/repo/test/widget_test.rb',
  startLine: 20,
  endLine: 20,
  quote: 'assert_equal true, result',
  feedback: 'This assertion should check the actual status value.',
  createdAt: '2026-06-13T00:01:00.000Z',
};
const bundleA = {
  version: 1,
  bundleId: 'bundle-a',
  projectRoot: '/repo',
  sentAt: '2026-06-13T00:02:00.000Z',
  source: 'emacs',
  notes: [noteA],
};
const bundleB = {
  version: 1,
  bundleId: 'bundle-b',
  projectRoot: '/repo',
  sentAt: '2026-06-13T00:03:00.000Z',
  source: 'emacs',
  notes: [noteB],
};

function bundleWithNote(overrides) {
  return {
    ...bundleA,
    notes: [{ ...noteA, ...overrides }],
  };
}

function assertMalformedBundle(bundle) {
  const result = parseInboxContent(JSON.stringify(bundle));

  assert.deepEqual(result.bundles, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 1);
  assert.equal(result.errors[0].content, JSON.stringify(bundle));
  assert.equal(result.errors[0].message, 'Invalid feedback bundle');
}

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeGitRepo(prefix = 'emacs-feedback-repo-') {
  const repoRoot = await makeTempDir(prefix);
  execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
  return repoRoot;
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function makeDescriptor(storage, sessionId = 'session-1') {
  return {
    version: 1,
    sessionId,
    projectRoot: '/repo',
    cwd: '/repo',
    pid: process.pid,
    inboxPath: path.join(storage.inboxDir, `${sessionId}.jsonl`),
    startedAt: '2026-06-13T01:00:00.000Z',
  };
}

async function writeInbox(descriptor, lines) {
  await fs.mkdir(path.dirname(descriptor.inboxPath), { recursive: true });
  await fs.writeFile(descriptor.inboxPath, lines.join('\n'), 'utf8');
}

function makeFakePi({ sendThrows = false, getSessionName } = {}) {
  const commands = new Map();
  const events = new Map();
  const sentUserMessages = [];
  const sentMessages = [];

  const pi = {
    commands,
    events,
    sentUserMessages,
    sentMessages,
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(name, handler) {
      events.set(name, handler);
    },
    sendUserMessage(...args) {
      if (sendThrows) throw new Error('send failed');
      sentUserMessages.push(args);
    },
    sendMessage(message) {
      sentMessages.push(message);
    },
  };

  if (getSessionName !== undefined) {
    pi.getSessionName = getSessionName;
  }

  return pi;
}

function makeFakeCtx({ idle = true, confirm = true, hasUI = true } = {}) {
  const notifications = [];
  const statuses = [];

  const ctx = {
    hasUI,
    notifications,
    statuses,
    confirmCalls: 0,
    isIdle() {
      return idle;
    },
  };

  if (hasUI) {
    ctx.ui = {
      notify(message, type = 'info') {
        notifications.push({ message, type });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
      async confirm() {
        ctx.confirmCalls += 1;
        return confirm;
      },
    };
  }

  return ctx;
}

async function setupInboxWithBundle() {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const descriptor = makeDescriptor(storage);
  await fs.mkdir(storage.sessionsDir, { recursive: true });
  await fs.mkdir(storage.inboxDir, { recursive: true });
  await fs.mkdir(storage.archiveDir, { recursive: true });
  await writeInbox(descriptor, [JSON.stringify(bundleA)]);
  return { home, storage, descriptor };
}

test('storagePaths returns deterministic Pi feedback directories under the given home', () => {
  assert.deepEqual(storagePaths('/tmp/example-home'), {
    baseDir: '/tmp/example-home/.pi/emacs-feedback',
    sessionsDir: '/tmp/example-home/.pi/emacs-feedback/sessions',
    inboxDir: '/tmp/example-home/.pi/emacs-feedback/inbox',
    archiveDir: '/tmp/example-home/.pi/emacs-feedback/archive',
  });
});

test('normalizeDirectory resolves directories and removes trailing separators', () => {
  assert.equal(
    emacsFeedback.normalizeDirectory('/tmp/example-home/project/'),
    '/tmp/example-home/project',
  );
});

test('resolveProjectRoot uses the git toplevel when cwd is a subdirectory', async () => {
  const repoRoot = await makeGitRepo();
  const cwd = path.join(repoRoot, 'app', 'models');
  await fs.mkdir(cwd, { recursive: true });

  assert.equal(emacsFeedback.resolveProjectRoot(cwd), emacsFeedback.normalizeDirectory(repoRoot));
});

test('resolveProjectRoot falls back to the normalized cwd outside a git repo', async () => {
  const cwd = await makeTempDir('emacs-feedback-non-git-');

  assert.equal(emacsFeedback.resolveProjectRoot(cwd), emacsFeedback.normalizeDirectory(cwd));
});

test('createSessionDescriptor creates storage, inbox, and descriptor JSON', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const repoRoot = await makeGitRepo();
  const cwd = path.join(repoRoot, 'nested');
  await fs.mkdir(cwd, { recursive: true });

  const descriptor = await emacsFeedback.createSessionDescriptor({
    home,
    cwd,
    sessionId: 'session-abc',
    now: '2026-06-13T02:00:00.000Z',
  });
  const storage = storagePaths(home);
  const descriptorPath = path.join(storage.sessionsDir, 'session-abc.json');

  assert.equal(await pathExists(storage.sessionsDir), true);
  assert.equal(await pathExists(storage.inboxDir), true);
  assert.equal(await pathExists(storage.archiveDir), true);
  assert.equal(await fs.readFile(path.join(storage.inboxDir, 'session-abc.jsonl'), 'utf8'), '');
  assert.deepEqual(JSON.parse(await fs.readFile(descriptorPath, 'utf8')), descriptor);
  assert.deepEqual(descriptor, {
    version: 1,
    sessionId: 'session-abc',
    projectRoot: emacsFeedback.normalizeDirectory(repoRoot),
    cwd: emacsFeedback.normalizeDirectory(cwd),
    pid: process.pid,
    inboxPath: path.join(storage.inboxDir, 'session-abc.jsonl'),
    startedAt: '2026-06-13T02:00:00.000Z',
  });
});

test('createSessionDescriptor stores a normalized optional session name', async () => {
  const home = await makeTempDir('emacs-feedback-home-');

  const descriptor = await emacsFeedback.createSessionDescriptor({
    home,
    cwd: home,
    sessionId: 'session-named',
    sessionName: '  Plan ACH\n\tsame-day   migration  ',
    now: '2026-07-16T20:32:00.000Z',
  });

  assert.equal(descriptor.sessionName, 'Plan ACH same-day migration');
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(storagePaths(home).sessionsDir, 'session-named.json'), 'utf8'),
    ).sessionName,
    'Plan ACH same-day migration',
  );
});

test('createSessionDescriptor omits empty and non-string session names', async () => {
  const home = await makeTempDir('emacs-feedback-home-');

  for (const [sessionId, sessionName] of [
    ['session-empty', ' \n\t '],
    ['session-non-string', 42],
  ]) {
    const descriptor = await emacsFeedback.createSessionDescriptor({
      home,
      cwd: home,
      sessionId,
      sessionName,
      now: '2026-07-16T20:32:00.000Z',
    });

    assert.equal('sessionName' in descriptor, false);
    assert.equal(
      'sessionName' in
        JSON.parse(
          await fs.readFile(path.join(storagePaths(home).sessionsDir, `${sessionId}.json`), 'utf8'),
        ),
      false,
    );
  }
});

test('updateSessionDescriptorName returns a new normalized descriptor without changing other fields', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const original = await emacsFeedback.createSessionDescriptor({
    home,
    cwd: home,
    sessionId: 'session-update',
    sessionName: 'Original',
    now: '2026-07-16T20:32:00.000Z',
  });

  const updated = await emacsFeedback.updateSessionDescriptorName(
    original,
    '  Renamed\n session  ',
    storage,
  );

  assert.notEqual(updated, original);
  assert.deepEqual(original, { ...updated, sessionName: 'Original' });
  assert.deepEqual(updated, { ...original, sessionName: 'Renamed session' });
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(storage.sessionsDir, 'session-update.json'), 'utf8'),
    ),
    updated,
  );
});

test('updateSessionDescriptorName removes the name when it is cleared', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const original = await emacsFeedback.createSessionDescriptor({
    home,
    cwd: home,
    sessionId: 'session-clear-name',
    sessionName: 'Original',
    now: '2026-07-16T20:32:00.000Z',
  });

  const updated = await emacsFeedback.updateSessionDescriptorName(original, ' \n ', storage);

  assert.equal(original.sessionName, 'Original');
  assert.equal('sessionName' in updated, false);
  assert.equal(
    'sessionName' in
      JSON.parse(
        await fs.readFile(path.join(storage.sessionsDir, 'session-clear-name.json'), 'utf8'),
      ),
    false,
  );
});

test('updateSessionDescriptorName preserves old JSON and cleans its temp file when rename fails', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const original = await emacsFeedback.createSessionDescriptor({
    home,
    cwd: home,
    sessionId: 'session-rename-failure',
    sessionName: 'Original',
    now: '2026-07-16T20:32:00.000Z',
  });
  const descriptorPath = path.join(storage.sessionsDir, 'session-rename-failure.json');
  const oldJson = await fs.readFile(descriptorPath, 'utf8');
  const operations = {
    writeFile: fs.writeFile,
    async rename() {
      throw new Error('forced rename failure');
    },
    rm: fs.rm,
  };

  await assert.rejects(
    emacsFeedback.updateSessionDescriptorName(original, 'Replacement', storage, operations),
    /forced rename failure/,
  );

  assert.equal(await fs.readFile(descriptorPath, 'utf8'), oldJson);
  assert.deepEqual(await fs.readdir(storage.sessionsDir), ['session-rename-failure.json']);
  assert.equal(original.sessionName, 'Original');
});

test('readInbox parses valid bundles and malformed lines from disk', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const descriptor = makeDescriptor(storage);
  await writeInbox(descriptor, [JSON.stringify(bundleA), 'not json', JSON.stringify(bundleB)]);

  const result = await emacsFeedback.readInbox(descriptor.inboxPath);

  assert.deepEqual(result.bundles, [bundleA, bundleB]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 2);
  assert.equal(result.errors[0].content, 'not json');
});

test('archiveBundlesAndClearInbox archives bundles and truncates inbox', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();

  await emacsFeedback.archiveBundlesAndClearInbox(descriptor, [bundleA], storage);

  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(storage.archiveDir, descriptor.sessionId, 'bundle-a.json'), 'utf8')),
    bundleA,
  );
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '');
});

test('quoteBlock prefixes a single line with a quote marker', () => {
  assert.equal(quoteBlock('x'), '> x');
});

test('quoteBlock preserves the current empty quote behavior', () => {
  assert.equal(quoteBlock(''), '> ');
});

test('quoteBlock prefixes each line with a quote marker', () => {
  assert.equal(quoteBlock('a\nb'), '> a\n> b');
});

test('parseInboxContent keeps valid bundles and reports malformed JSONL lines', () => {
  const content = [JSON.stringify(bundleA), 'not json', JSON.stringify(bundleB)].join('\n');

  const result = parseInboxContent(content);

  assert.deepEqual(result.bundles, [bundleA, bundleB]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 2);
  assert.equal(result.errors[0].content, 'not json');
  assert.equal(typeof result.errors[0].message, 'string');
  assert.notEqual(result.errors[0].message, '');
});

test('parseInboxContent returns empty results for empty content', () => {
  assert.deepEqual(parseInboxContent(''), { bundles: [], errors: [] });
});

test('parseInboxContent rejects a feedback note with startLine below one', () => {
  assertMalformedBundle(bundleWithNote({ startLine: 0 }));
});

test('parseInboxContent rejects a feedback note with a non-integer startLine', () => {
  assertMalformedBundle(bundleWithNote({ startLine: 10.5 }));
});

test('parseInboxContent rejects a feedback note with endLine before startLine', () => {
  assertMalformedBundle(bundleWithNote({ startLine: 10, endLine: 9 }));
});

test('parseInboxContent rejects a feedback note with a non-integer endLine', () => {
  assertMalformedBundle(bundleWithNote({ endLine: 12.5 }));
});

test('isFeedbackNote accepts diff note optional metadata fields', () => {
  assert.equal(
    emacsFeedback.isFeedbackNote({
      ...noteA,
      source: 'diff',
      location: 'app/models/widget.rb:mixed old 10 / new 20',
      lineSide: 'mixed',
      hunkHeader: '@@ -10,1 +20,1 @@',
    }),
    true,
  );
});

test('isFeedbackNote rejects an unsupported note source', () => {
  assert.equal(emacsFeedback.isFeedbackNote({ ...noteA, source: 'git' }), false);
});

test('isFeedbackNote rejects an unsupported line side', () => {
  assert.equal(emacsFeedback.isFeedbackNote({ ...noteA, lineSide: 'left' }), false);
});

test('isFeedbackNote rejects a non-string location', () => {
  assert.equal(emacsFeedback.isFeedbackNote({ ...noteA, location: 42 }), false);
  assert.equal(emacsFeedback.isFeedbackNote({ ...noteA, location: { file: 'a.rb' } }), false);
});

test('isFeedbackNote rejects a non-string hunkHeader', () => {
  assert.equal(emacsFeedback.isFeedbackNote({ ...noteA, hunkHeader: 7 }), false);
  assert.equal(emacsFeedback.isFeedbackNote({ ...noteA, hunkHeader: ['@@'] }), false);
});

test('countNotes sums notes across bundles', () => {
  assert.equal(countNotes([bundleA, bundleB]), 2);
});

test('formatLocation uses a custom note location when present', () => {
  assert.equal(
    emacsFeedback.formatLocation({ ...noteA, location: 'app/models/foo.rb:old 10' }),
    'app/models/foo.rb:old 10',
  );
});

test('formatLocation falls back to file range when custom location is empty', () => {
  assert.equal(emacsFeedback.formatLocation({ ...noteA, location: '' }), 'app/models/widget.rb:10-12');
});

test('formatLocation falls back to file range when custom location is whitespace', () => {
  assert.equal(emacsFeedback.formatLocation({ ...noteA, location: ' \n\t ' }), 'app/models/widget.rb:10-12');
});

test('buildFeedbackMessage uses a singular note label for one note', () => {
  const message = buildFeedbackMessage([bundleA]);

  assert.match(
    message,
    /I captured Emacs review feedback for the current changes \(1 note\)/,
  );
});

test('buildFeedbackMessage formats an anchored message for every note', () => {
  const message = buildFeedbackMessage([bundleA, bundleB]);

  assert.match(
    message,
    /I captured Emacs review feedback for the current changes \(2 notes\)/,
  );
  assert.match(message, /Feedback 1 \(app\/models\/widget\.rb:10-12\):/);
  assert.match(message, /> if widget\.nil\?\n>   return\n> end/);
  assert.match(message, /Please preserve the existing nil fallback\./);
  assert.match(message, /Feedback 2 \(test\/widget_test\.rb:20\):/);
});

test('buildFeedbackMessage uses a custom note location in feedback headers', () => {
  const message = buildFeedbackMessage([
    bundleWithNote({ location: 'app/models/foo.rb:old 10' }),
  ]);

  assert.match(message, /Feedback 1 \(app\/models\/foo\.rb:old 10\):/);
  assert.doesNotMatch(message, /Feedback 1 \(app\/models\/widget\.rb:10-12\):/);
});

test('registerSessionLifecycle persists startup and changed names, clears names, and removes on shutdown', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi({ getSessionName: () => '  Startup\n name  ' });
  const ctx = makeFakeCtx();
  const getDescriptor = emacsFeedback.registerSessionLifecycle(pi, storage, {
    home,
    cwd: home,
    sessionId: 'session-lifecycle',
    now: '2026-07-16T20:32:00.000Z',
  });
  const descriptorPath = path.join(storage.sessionsDir, 'session-lifecycle.json');

  await pi.events.get('session_start')({}, ctx);
  assert.equal(getDescriptor().sessionName, 'Startup name');
  assert.equal(JSON.parse(await fs.readFile(descriptorPath, 'utf8')).sessionName, 'Startup name');

  await pi.events.get('session_info_changed')({ name: '  Dynamic\n name  ' }, ctx);
  assert.equal(getDescriptor().sessionName, 'Dynamic name');
  assert.equal(JSON.parse(await fs.readFile(descriptorPath, 'utf8')).sessionName, 'Dynamic name');

  await pi.events.get('session_info_changed')({ name: ' \t ' }, ctx);
  assert.equal('sessionName' in getDescriptor(), false);
  assert.equal('sessionName' in JSON.parse(await fs.readFile(descriptorPath, 'utf8')), false);

  const inboxPath = getDescriptor().inboxPath;
  await pi.events.get('session_shutdown')();
  assert.equal(getDescriptor(), undefined);
  assert.equal(await pathExists(descriptorPath), false);
  assert.equal(await pathExists(inboxPath), true);
});

test('registerSessionLifecycle serializes concurrent name changes in invocation order', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi({ getSessionName: () => 'Original' });
  const ctx = makeFakeCtx();
  const secondRenameFinished = Promise.withResolvers();
  const writes = [];
  let updatesStartedConcurrently = false;
  const operations = {
    async writeFile(file, data, encoding) {
      writes.push(JSON.parse(data).sessionName);
      return fs.writeFile(file, data, encoding);
    },
    async rename(oldPath, newPath) {
      const { sessionName } = JSON.parse(await fs.readFile(oldPath, 'utf8'));
      if (sessionName === 'A' && updatesStartedConcurrently) {
        await secondRenameFinished.promise;
      }
      await fs.rename(oldPath, newPath);
      if (sessionName === 'B') {
        secondRenameFinished.resolve();
      }
    },
    rm: fs.rm,
  };
  const getDescriptor = emacsFeedback.registerSessionLifecycle(
    pi,
    storage,
    {
      home,
      cwd: home,
      sessionId: 'session-concurrent-names',
      now: '2026-07-16T20:32:00.000Z',
    },
    operations,
  );
  await pi.events.get('session_start')({}, ctx);
  const descriptorPath = path.join(storage.sessionsDir, 'session-concurrent-names.json');

  const updateA = pi.events.get('session_info_changed')({ name: 'A' }, ctx);
  const updateB = pi.events.get('session_info_changed')({ name: 'B' }, ctx);
  await Promise.resolve();
  updatesStartedConcurrently = writes.includes('B');
  const results = await Promise.allSettled([updateA, updateB]);

  assert.deepEqual(
    results.map(({ status }) => status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(getDescriptor().sessionName, 'B');
  assert.equal(JSON.parse(await fs.readFile(descriptorPath, 'utf8')).sessionName, 'B');
  assert.deepEqual(await fs.readdir(storage.sessionsDir), ['session-concurrent-names.json']);
});

test('registerSessionLifecycle drains queued name changes before shutdown removes the descriptor', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi({ getSessionName: () => 'Original' });
  const writes = [];
  const operations = {
    async writeFile(file, data, encoding) {
      writes.push(JSON.parse(data).sessionName);
      return fs.writeFile(file, data, encoding);
    },
    rename: fs.rename,
    rm: fs.rm,
  };
  const getDescriptor = emacsFeedback.registerSessionLifecycle(
    pi,
    storage,
    {
      home,
      cwd: home,
      sessionId: 'session-shutdown-name-race',
      now: '2026-07-16T20:32:00.000Z',
    },
    operations,
  );
  await pi.events.get('session_start')({}, makeFakeCtx());
  const descriptorPath = path.join(storage.sessionsDir, 'session-shutdown-name-race.json');

  const update = pi.events.get('session_info_changed')({ name: 'Pending' }, makeFakeCtx());
  const shutdown = pi.events.get('session_shutdown')();
  const results = await Promise.allSettled([update, shutdown]);

  assert.deepEqual(
    results.map(({ status }) => status),
    ['fulfilled', 'fulfilled'],
  );
  assert.deepEqual(writes, ['Pending']);
  assert.equal(getDescriptor(), undefined);
  assert.equal(await pathExists(descriptorPath), false);
  assert.deepEqual(await fs.readdir(storage.sessionsDir), []);
});

test('registerSessionLifecycle works without getSessionName and does not subscribe to name changes', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi();
  const getDescriptor = emacsFeedback.registerSessionLifecycle(pi, storage, {
    home,
    cwd: home,
    sessionId: 'session-older-runtime',
    now: '2026-07-16T20:32:00.000Z',
  });

  await pi.events.get('session_start')({}, makeFakeCtx());

  assert.equal('sessionName' in getDescriptor(), false);
  assert.equal(await pathExists(getDescriptor().inboxPath), true);
  assert.equal(pi.events.has('session_info_changed'), false);
});

test('registerSessionLifecycle continues unnamed when getSessionName throws', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi({
    getSessionName() {
      throw new Error('name unavailable');
    },
  });
  const getDescriptor = emacsFeedback.registerSessionLifecycle(pi, storage, {
    home,
    cwd: home,
    sessionId: 'session-getter-failure',
    now: '2026-07-16T20:32:00.000Z',
  });

  await pi.events.get('session_start')({}, makeFakeCtx());

  assert.equal('sessionName' in getDescriptor(), false);
  assert.equal(await pathExists(getDescriptor().inboxPath), true);
  assert.equal(pi.events.has('session_info_changed'), true);
});

test('registerSessionLifecycle keeps the descriptor and notifies when refreshStatus fails', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  ctx.ui.setStatus = () => {
    throw new Error('status failed');
  };
  const getDescriptor = emacsFeedback.registerSessionLifecycle(pi, storage, {
    home,
    cwd: home,
    sessionId: 'session-refresh-failure',
    now: '2026-07-16T20:32:00.000Z',
  });

  await pi.events.get('session_start')({}, ctx);

  assert.equal(getDescriptor().sessionId, 'session-refresh-failure');
  assert.equal(
    await pathExists(path.join(storage.sessionsDir, 'session-refresh-failure.json')),
    true,
  );
  assert.deepEqual(ctx.notifications.at(-1), {
    message: 'Failed to register Emacs feedback session: status failed',
    type: 'error',
  });
});

test('registerSessionLifecycle retains the old descriptor when a name refresh fails', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi({ getSessionName: () => 'Original' });
  const ctx = makeFakeCtx();
  const operations = {
    writeFile: fs.writeFile,
    async rename() {
      throw new Error('forced lifecycle rename failure');
    },
    rm: fs.rm,
  };
  const getDescriptor = emacsFeedback.registerSessionLifecycle(
    pi,
    storage,
    {
      home,
      cwd: home,
      sessionId: 'session-name-refresh-failure',
      now: '2026-07-16T20:32:00.000Z',
    },
    operations,
  );
  await pi.events.get('session_start')({}, ctx);
  const descriptorPath = path.join(storage.sessionsDir, 'session-name-refresh-failure.json');
  const descriptorBeforeFailure = getDescriptor();
  const jsonBeforeFailure = await fs.readFile(descriptorPath, 'utf8');

  await pi.events.get('session_info_changed')({ name: 'Replacement' }, ctx);

  assert.equal(getDescriptor(), descriptorBeforeFailure);
  assert.equal(getDescriptor().sessionName, 'Original');
  assert.equal(await fs.readFile(descriptorPath, 'utf8'), jsonBeforeFailure);
  assert.deepEqual(await fs.readdir(storage.sessionsDir), ['session-name-refresh-failure.json']);
  assert.deepEqual(ctx.notifications.at(-1), {
    message: 'Failed to update Emacs feedback session name: forced lifecycle rename failure',
    type: 'error',
  });
});

test('registerSessionLifecycle continues queued name changes after an update fails', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi({ getSessionName: () => 'Original' });
  const ctx = makeFakeCtx();
  let renameAttempts = 0;
  const operations = {
    writeFile: fs.writeFile,
    async rename(oldPath, newPath) {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        throw new Error('forced first rename failure');
      }
      return fs.rename(oldPath, newPath);
    },
    rm: fs.rm,
  };
  const getDescriptor = emacsFeedback.registerSessionLifecycle(
    pi,
    storage,
    {
      home,
      cwd: home,
      sessionId: 'session-name-recovery',
      now: '2026-07-16T20:32:00.000Z',
    },
    operations,
  );
  await pi.events.get('session_start')({}, ctx);
  const descriptorPath = path.join(storage.sessionsDir, 'session-name-recovery.json');

  const failedUpdate = pi.events.get('session_info_changed')({ name: 'Failed' }, ctx);
  const recoveredUpdate = pi.events.get('session_info_changed')({ name: 'Recovered' }, ctx);
  const results = await Promise.allSettled([failedUpdate, recoveredUpdate]);

  assert.deepEqual(
    results.map(({ status }) => status),
    ['fulfilled', 'fulfilled'],
  );
  assert.equal(getDescriptor().sessionName, 'Recovered');
  assert.equal(JSON.parse(await fs.readFile(descriptorPath, 'utf8')).sessionName, 'Recovered');
  assert.deepEqual(await fs.readdir(storage.sessionsDir), ['session-name-recovery.json']);
  assert.deepEqual(ctx.notifications, [
    {
      message: 'Failed to update Emacs feedback session name: forced first rename failure',
      type: 'error',
    },
  ]);
});

test('registerSessionLifecycle recovers when both a name update and its notification fail', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi({ getSessionName: () => 'Original' });
  const ctx = makeFakeCtx();
  ctx.ui.notify = () => {
    throw new Error('forced notification failure');
  };
  let renameAttempts = 0;
  const operations = {
    writeFile: fs.writeFile,
    async rename(oldPath, newPath) {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        throw new Error('forced first rename failure');
      }
      return fs.rename(oldPath, newPath);
    },
    rm: fs.rm,
  };
  const getDescriptor = emacsFeedback.registerSessionLifecycle(
    pi,
    storage,
    {
      home,
      cwd: home,
      sessionId: 'session-notification-recovery',
      now: '2026-07-16T20:32:00.000Z',
    },
    operations,
  );
  await pi.events.get('session_start')({}, ctx);
  const descriptorPath = path.join(storage.sessionsDir, 'session-notification-recovery.json');
  const inboxPath = getDescriptor().inboxPath;
  await fs.writeFile(inboxPath, `${JSON.stringify(bundleA)}\n`, 'utf8');

  await assert.doesNotReject(
    pi.events.get('session_info_changed')({ name: 'Failed' }, ctx),
  );
  await assert.doesNotReject(
    pi.events.get('session_info_changed')({ name: 'Recovered' }, makeFakeCtx()),
  );

  assert.equal(getDescriptor().sessionName, 'Recovered');
  assert.equal(JSON.parse(await fs.readFile(descriptorPath, 'utf8')).sessionName, 'Recovered');
  await assert.doesNotReject(pi.events.get('session_shutdown')());
  assert.equal(getDescriptor(), undefined);
  assert.equal(await pathExists(descriptorPath), false);
  assert.equal(await fs.readFile(inboxPath, 'utf8'), `${JSON.stringify(bundleA)}\n`);
});

test('registerCommands registers the Emacs feedback slash commands', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const pi = makeFakePi();

  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  assert.deepEqual([...pi.commands.keys()].sort(), [
    'emacs-feedback-address',
    'emacs-feedback-clear',
    'emacs-feedback-help',
    'emacs-feedback-list',
  ]);
});

test('/emacs-feedback-help uses concise source and diff line wording', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();

  emacsFeedback.registerCommands(pi, () => undefined, storage);

  await pi.commands.get('emacs-feedback-help').handler([], ctx);

  assert.match(
    pi.sentMessages[0].content,
    /Select source regions or Magit\/diff lines, then run M-x pi-feedback-add\./,
  );
  assert.doesNotMatch(pi.sentMessages[0].content, /selected Magit\/diff lines/);
});

test('/emacs-feedback-address sends idle feedback, archives inbox, and clears status', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ idle: true });
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  assert.equal(pi.sentUserMessages[0].length, 1);
  assert.match(pi.sentUserMessages[0][0], /I captured Emacs review feedback/);
  assert.equal(await pathExists(path.join(storage.archiveDir, descriptor.sessionId, 'bundle-a.json')), true);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '');
  assert.deepEqual(ctx.statuses.at(-1), { key: 'emacs-feedback', value: undefined });
});

test('/emacs-feedback-address sends busy feedback as a follow-up', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ idle: false });
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  assert.equal(pi.sentUserMessages[0].length, 2);
  assert.deepEqual(pi.sentUserMessages[0][1], { deliverAs: 'followUp' });
});

test('/emacs-feedback-address on an empty inbox notifies without sending', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const descriptor = makeDescriptor(storage);
  await writeInbox(descriptor, ['']);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(ctx.notifications.at(-1).message, 'No queued Emacs feedback to address');
});

test('/emacs-feedback-address sends valid bundles and warns when malformed lines are discarded', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const descriptor = makeDescriptor(storage);
  await fs.mkdir(storage.archiveDir, { recursive: true });
  await writeInbox(descriptor, ['not json', JSON.stringify(bundleA)]);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  assert.match(pi.sentUserMessages[0][0], /Feedback 1 \(app\/models\/widget\.rb:10-12\):/);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '');
  assert.equal(ctx.notifications.at(-1)?.type, 'warning');
  assert.match(ctx.notifications.at(-1)?.message, /Malformed inbox lines were discarded/);
});

test('/emacs-feedback-list includes malformed-line warnings in the displayed summary', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const descriptor = makeDescriptor(storage);
  await writeInbox(descriptor, [JSON.stringify(bundleA), 'not json']);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-list').handler([], ctx);

  assert.deepEqual(pi.sentMessages[0].customType, 'emacs-feedback-list');
  assert.equal(pi.sentMessages[0].display, true);
  assert.match(pi.sentMessages[0].content, /Malformed line 2:/);
});

test('/emacs-feedback-clear confirms and truncates inbox with queued notes', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ confirm: true });
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-clear').handler([], ctx);

  assert.equal(ctx.confirmCalls, 1);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '');
  assert.deepEqual(ctx.notifications.at(-1), {
    message: 'Cleared queued Emacs feedback',
    type: 'info',
  });
  assert.deepEqual(ctx.statuses.at(-1), { key: 'emacs-feedback', value: undefined });
});

test('/emacs-feedback-clear leaves inbox unchanged when confirmation is declined', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const originalContent = await fs.readFile(descriptor.inboxPath, 'utf8');
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ confirm: false });
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-clear').handler([], ctx);

  assert.equal(ctx.confirmCalls, 1);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), originalContent);
});

test('/emacs-feedback-clear notifies without confirming when inbox is empty', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const descriptor = makeDescriptor(storage);
  await writeInbox(descriptor, ['']);
  const pi = makeFakePi();
  const ctx = makeFakeCtx({ confirm: true });
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-clear').handler([], ctx);

  assert.equal(ctx.confirmCalls, 0);
  assert.deepEqual(ctx.notifications.at(-1), {
    message: 'No queued Emacs feedback to clear',
    type: 'info',
  });
  assert.deepEqual(ctx.statuses.at(-1), { key: 'emacs-feedback', value: undefined });
});

test('/emacs-feedback-address leaves inbox unchanged when sendUserMessage throws', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const originalContent = await fs.readFile(descriptor.inboxPath, 'utf8');
  const pi = makeFakePi({ sendThrows: true });
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), originalContent);
  assert.equal(await pathExists(path.join(storage.archiveDir, descriptor.sessionId, 'bundle-a.json')), false);
  assert.deepEqual(ctx.notifications.at(-1), {
    message: 'Failed to send Emacs feedback: send failed',
    type: 'error',
  });
});

test('/emacs-feedback-address still sends and clears the inbox when archiving fails', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  // Session archive dir exists but is read-only: mkdir succeeds (recursive),
  // the archive write fails with EACCES, the send must still go through.
  const sessionArchiveDir = path.join(storage.archiveDir, descriptor.sessionId);
  await fs.mkdir(sessionArchiveDir, { recursive: true });
  await fs.chmod(sessionArchiveDir, 0o500);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  try {
    await pi.commands.get('emacs-feedback-address').handler([], ctx);
  } finally {
    await fs.chmod(sessionArchiveDir, 0o700);
  }

  assert.equal(pi.sentUserMessages.length, 1);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '');
  assert.equal(ctx.notifications.at(-1).type, 'error');
  assert.match(ctx.notifications.at(-1).message, /Sent Emacs feedback, but archiving failed/);
});

test('/emacs-feedback-address refuses to send when the archive itself cannot be read', async () => {
  const home = await makeTempDir('emacs-feedback-home-');
  const storage = storagePaths(home);
  const descriptor = makeDescriptor(storage);
  await fs.mkdir(storage.inboxDir, { recursive: true });
  await fs.writeFile(storage.archiveDir, 'not a directory', 'utf8');
  await writeInbox(descriptor, [JSON.stringify(bundleA)]);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  // Without a readable archive there is no way to know what was already sent,
  // so the handler must not send instead of risking a duplicate delivery.
  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), JSON.stringify(bundleA), 'inbox untouched');
  assert.equal(ctx.notifications.at(-1).type, 'error');
  assert.match(ctx.notifications.at(-1).message, /Failed to read the Emacs feedback archive/);
});

test('/emacs-feedback-address warns when clearing the inbox fails after a successful send', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  // Read-only inbox file: readInbox succeeds, clearInbox's write fails (EACCES).
  await fs.chmod(descriptor.inboxPath, 0o400);
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  try {
    await pi.commands.get('emacs-feedback-address').handler([], ctx);
  } finally {
    await fs.chmod(descriptor.inboxPath, 0o600);
  }

  assert.equal(pi.sentUserMessages.length, 1);
  assert.equal(await pathExists(path.join(storage.archiveDir, descriptor.sessionId, 'bundle-a.json')), true);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), JSON.stringify(bundleA), 'inbox left in place for the next address');
  assert.equal(ctx.notifications.at(-1).type, 'error');
  assert.match(ctx.notifications.at(-1).message, /Sent Emacs feedback, but clearing the inbox failed/);
});

test('/emacs-feedback-address does not resend bundles that are already archived', async () => {
  // Simulates a crash between send and the old post-send cleanup: the bundle
  // is in the archive AND still queued in the inbox.
  const { storage, descriptor } = await setupInboxWithBundle();
  const sessionArchiveDir = path.join(storage.archiveDir, descriptor.sessionId);
  await fs.mkdir(sessionArchiveDir, { recursive: true });
  await fs.writeFile(path.join(sessionArchiveDir, 'bundle-a.json'), JSON.stringify(bundleA), 'utf8');
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(pi.sentUserMessages.length, 0);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '', 'stale inbox truncated');
  assert.equal(ctx.notifications.at(-1).type, 'info');
  assert.match(ctx.notifications.at(-1).message, /already sent and archived/);
});

test('/emacs-feedback-address sends only the not-yet-archived bundles', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  await writeInbox(descriptor, [JSON.stringify(bundleA), JSON.stringify(bundleB)]);
  const sessionArchiveDir = path.join(storage.archiveDir, descriptor.sessionId);
  await fs.mkdir(sessionArchiveDir, { recursive: true });
  await fs.writeFile(path.join(sessionArchiveDir, 'bundle-a.json'), JSON.stringify(bundleA), 'utf8');
  const pi = makeFakePi();
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(pi, () => descriptor, storage);

  await pi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(pi.sentUserMessages.length, 1);
  assert.match(pi.sentUserMessages[0][0], /test\/widget_test\.rb/, 'only bundle-b (noteB) is sent');
  assert.doesNotMatch(pi.sentUserMessages[0][0], /app\/models\/widget\.rb/, 'already-archived bundle-a is not re-sent');
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '');
  assert.equal(await pathExists(path.join(sessionArchiveDir, 'bundle-b.json')), true);
});

test('/emacs-feedback-address retries the send after a failed send rolls back the archive', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const failedPi = makeFakePi({ sendThrows: true });
  const ctx = makeFakeCtx();
  emacsFeedback.registerCommands(failedPi, () => descriptor, storage);

  await failedPi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), JSON.stringify(bundleA));
  assert.equal(await pathExists(path.join(storage.archiveDir, descriptor.sessionId, 'bundle-a.json')), false, 'write-ahead archive rolled back');

  const retryPi = makeFakePi();
  emacsFeedback.registerCommands(retryPi, () => descriptor, storage);
  await retryPi.commands.get('emacs-feedback-address').handler([], ctx);

  assert.equal(retryPi.sentUserMessages.length, 1);
  assert.equal(await fs.readFile(descriptor.inboxPath, 'utf8'), '');
  assert.equal(await pathExists(path.join(storage.archiveDir, descriptor.sessionId, 'bundle-a.json')), true);
});

test('readArchivedBundleIds returns bundle ids and tolerates a missing archive dir', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();

  assert.deepEqual(await emacsFeedback.readArchivedBundleIds(descriptor, storage), new Set());

  const sessionArchiveDir = path.join(storage.archiveDir, descriptor.sessionId);
  await fs.mkdir(sessionArchiveDir, { recursive: true });
  await fs.writeFile(path.join(sessionArchiveDir, 'bundle-a.json'), '{}', 'utf8');
  await fs.writeFile(path.join(sessionArchiveDir, 'not-a-bundle.txt'), 'x', 'utf8');

  assert.deepEqual(await emacsFeedback.readArchivedBundleIds(descriptor, storage), new Set(['bundle-a']));
});

test('refreshStatus sets note count and clears status when the inbox is empty', async () => {
  const { storage, descriptor } = await setupInboxWithBundle();
  const ctx = makeFakeCtx();

  await emacsFeedback.refreshStatus(ctx, descriptor, storage);
  await emacsFeedback.clearInbox(descriptor.inboxPath);
  await emacsFeedback.refreshStatus(ctx, descriptor, storage);

  assert.deepEqual(ctx.statuses, [
    { key: 'emacs-feedback', value: 'emacs feedback 1' },
    { key: 'emacs-feedback', value: undefined },
  ]);
});
