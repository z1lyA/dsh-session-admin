import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createArchiveAdmin, validateIds, ArchiveRequestError } from '../lib/archive.js';
import { attachmentPaths } from '../lib/attachments.js';
import { pendingFilePath } from '../lib/pending.js';
import { encodeSegment, projectionCachePath } from '../lib/paths.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const ID_A = `sha256:${HASH_A}`;
const ID_B = `sha256:${HASH_B}`;
const ID_C = `sha256:${HASH_C}`;

const exists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build a fake plugin context with the exact services the admin touches.
 * @param {object} options harness options
 * @returns {object} { ctx, calls, roots }
 */
function harness(options) {
  const {
    root,
    archived,
    workspaces = [],
    headers = [],
    events = async () => [],
    live = () => undefined,
  } = options;
  const sessions = path.join(root, 'sessions');
  const storages = path.join(root, 'storages');
  const attachments = path.join(root, 'attachments', 'v1');
  const calls = { unarchive: [], detach: [], archive: [], unpin: [] };
  const registry = {
    archivedSessionIds: [...archived],
    list: () => workspaces,
    get: () => undefined,
    archiveSession: async (id) => { calls.archive.push(id); },
    unarchiveSession: async (id) => { calls.unarchive.push(id); },
    unpinSession: async (id) => { calls.unpin.push(id); },
  };
  const persistence = {
    list: async () => headers.map((header) => ({ header })),
  };
  const services = new Map([
    ['workspaceRegistry', registry],
    ['sessionPersistence', persistence],
    ['sessionQuery', { listEvents: (id) => events(id) }],
    ['sessions', { get: (id) => live(id) }],
  ]);
  const ctx = {
    get: (name) => services.get(name),
    logger: { warn: () => {} },
  };
  const config = {
    dshHome: root,
    sessionsRoot: sessions,
    storagesRoot: storages,
    attachmentsRoot: attachments,
  };
  const admin = createArchiveAdmin(ctx, config);
  return { admin, calls, sessions, storages, attachments };
}

/** Create one session log directory plus its projection-cache record. */
async function layoutSession(root, id, { logBytes = 100, cacheBytes = 50 } = {}) {
  const sessions = path.join(root, 'sessions');
  const directory = path.join(sessions, '--project--', encodeSegment(id));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'session.v4.jsonl.zstd'), 'x'.repeat(logBytes));
  const cache = projectionCachePath(path.join(root, 'storages'), id);
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, 'x'.repeat(cacheBytes));
  return { directory, cache };
}

/** Create one attachment object, its file object, and its file alias. */
async function layoutAttachment(attachments, digest, name, size = 10) {
  const paths = attachmentPaths(attachments, digest);
  await mkdir(path.dirname(paths.object), { recursive: true });
  await mkdir(path.dirname(paths.fileObject), { recursive: true });
  await mkdir(paths.fileAlias, { recursive: true });
  await writeFile(paths.object, 'x'.repeat(size));
  await writeFile(paths.fileObject, 'x'.repeat(size));
  await writeFile(path.join(paths.fileAlias, name), 'x'.repeat(size));
  return paths;
}

test('validateIds rejects unsafe and oversized input', () => {
  assert.deepEqual(validateIds(['session-a', 'session-a', 'session-b']), ['session-a', 'session-b']);
  assert.throws(() => validateIds([]), (error) => error instanceof ArchiveRequestError && error.code === 'invalid-request');
  assert.throws(() => validateIds(['../x']), (error) => error instanceof ArchiveRequestError && error.code === 'invalid-id');
  assert.throws(() => validateIds(Array.from({ length: 101 }, (_, index) => `session-${index}`)), (error) => error.code === 'too-many');
});

test('list reports archived sessions with their footprint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-list-'));
  try {
    const id = 'session-abc';
    await layoutSession(root, id);
    const { admin } = harness({
      root,
      archived: [id],
      workspaces: [{ id: 'ws-1', title: 'Project', sessionIds: [id] }],
      headers: [{ id, cwd: 'C:\\project' }],
    });
    const inventory = await admin.list();
    assert.equal(inventory.items.length, 1);
    assert.equal(inventory.items[0].id, id);
    assert.equal(inventory.items[0].workspaceId, 'ws-1');
    assert.equal(inventory.items[0].hasLog, true);
    assert.equal(inventory.items[0].logBytes, 100);
    assert.equal(inventory.items[0].cacheBytes, 50);
    assert.equal(inventory.items[0].totalBytes, 150);
    assert.equal(inventory.totals.bytes, 150);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan measures without deleting anything', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-plan-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const { admin, calls } = harness({
      root,
      archived: [id],
      workspaces: [{ id: 'ws-1', title: 'Project', sessionIds: [id] }],
      headers: [{ id, cwd: 'C:\\project' }],
    });
    const planned = await admin.plan([id]);
    assert.equal(planned.items[0].ok, true);
    assert.equal(planned.items[0].totalBytes, 150);
    assert.equal(planned.totals.count, 1);
    assert.equal(await exists(layout.directory), true);
    assert.equal(await exists(layout.cache), true);
    assert.deepEqual(calls.unarchive, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remove deletes the log directory, cache, and archive record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-remove-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const { admin, calls } = harness({
      root,
      archived: [id],
      workspaces: [{ id: 'ws-1', title: 'Project', sessionIds: [id] }],
      headers: [{ id, cwd: 'C:\\project' }],
    });
    const result = await admin.remove([id], { cleanupAttachments: false });
    assert.equal(result.results[0].deleted, true);
    assert.equal(result.totals.deleted, 1);
    assert.equal(result.totals.freedBytes, 150);
    assert.equal(await exists(layout.directory), false);
    assert.equal(await exists(layout.cache), false);
    assert.deepEqual(calls.unarchive, [id]);
    assert.equal(result.attachment.skipped, 'disabled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remove clears the record even when the log and cache are already gone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-orphan-'));
  try {
    const id = 'session-ghost';
    const { admin, calls } = harness({
      root,
      archived: [id],
      workspaces: [{ id: 'ws-1', title: 'Project', sessionIds: [id] }],
      headers: [{ id, cwd: 'C:\\project' }],
    });
    const planned = await admin.plan([id]);
    assert.equal(planned.items[0].ok, true);
    assert.equal(planned.items[0].hasLog, false);
    assert.equal(planned.items[0].totalBytes, 0);

    const result = await admin.remove([id], { cleanupAttachments: false });
    assert.equal(result.results[0].deleted, true);
    assert.equal(result.totals.freedBytes, 0);
    assert.deepEqual(calls.unarchive, [id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remove queues a live session and still refuses non-archived ids', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-refuse-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const harnessLive = harness({
      root,
      archived: [id],
      headers: [{ id, cwd: 'C:\\project' }],
      live: (sessionId) => (sessionId === id ? { id } : undefined),
    });
    const liveResult = await harnessLive.admin.remove([id], { cleanupAttachments: false });
    assert.equal(liveResult.results[0].deleted, false);
    assert.equal(liveResult.results[0].queued, true);
    assert.equal(liveResult.totals.queued, 1);
    assert.equal(liveResult.totals.deleted, 0);
    // Nothing on disk is touched while the session is live.
    assert.equal(await exists(layout.directory), true);
    assert.equal(await exists(layout.cache), true);
    const listed = await harnessLive.admin.list();
    assert.equal(typeof listed.items[0].pending?.requestedAt, 'string');
    assert.equal(listed.totals.pending, 1);

    const harnessOther = harness({
      root,
      archived: [],
      headers: [{ id, cwd: 'C:\\project' }],
    });
    const otherResult = await harnessOther.admin.remove([id], { cleanupAttachments: false });
    assert.equal(otherResult.results[0].deleted, false);
    assert.equal(otherResult.results[0].code, 'not-archived');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelPending drops a queued deletion without touching disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-cancel-pending-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const harnessLive = harness({
      root,
      archived: [id],
      headers: [{ id, cwd: 'C:\\project' }],
      live: (sessionId) => (sessionId === id ? { id } : undefined),
    });
    await harnessLive.admin.remove([id], { cleanupAttachments: false });
    const cancelled = await harnessLive.admin.cancelPending([id, 'session-other']);
    assert.equal(cancelled.totals.cancelled, 1);
    assert.equal(cancelled.results[0].cancelled, true);
    assert.equal(cancelled.results[1].cancelled, false);
    const listed = await harnessLive.admin.list();
    assert.equal(listed.items[0].pending, undefined);
    assert.equal(await exists(layout.directory), true);
    assert.equal(await exists(layout.cache), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepPending deletes a queued session once no agent is live', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-sweep-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const pending = path.join(root, 'session-admin', 'pending-deletions.json');
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(pending, JSON.stringify({
      version: 1,
      entries: [{ id, requestedAt: new Date().toISOString(), cleanupAttachments: true, attempts: 0, lastError: null, lastAttemptAt: null }],
    }));
    const { admin, calls } = harness({
      root,
      archived: [id],
      workspaces: [{ id: 'ws-1', title: 'Project', sessionIds: [id] }],
      headers: [{ id, cwd: 'C:\\project' }],
    });
    const swept = await admin.sweepPending();
    assert.equal(swept.totals.deleted, 1);
    assert.equal(swept.totals.kept, 0);
    assert.equal(await exists(layout.directory), false);
    assert.equal(await exists(layout.cache), false);
    assert.deepEqual(calls.unarchive, [id]);
    const listed = await admin.list();
    assert.equal(listed.totals.pending, 0);
    const queue = JSON.parse(await readFile(pending, 'utf8'));
    assert.deepEqual(queue.entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepPending drops an intent when the session was unarchived', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-sweep-drop-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const pending = path.join(root, 'session-admin', 'pending-deletions.json');
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(pending, JSON.stringify({
      version: 1,
      entries: [{ id, requestedAt: new Date().toISOString(), cleanupAttachments: true, attempts: 0, lastError: null, lastAttemptAt: null }],
    }));
    const { admin } = harness({ root, archived: [], headers: [{ id, cwd: 'C:\\project' }] });
    const swept = await admin.sweepPending();
    assert.equal(swept.totals.deleted, 0);
    assert.equal(swept.totals.dropped, 1);
    assert.equal(await exists(layout.directory), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepPending keeps an intent while the session is still live', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-sweep-live-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const pending = path.join(root, 'session-admin', 'pending-deletions.json');
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(pending, JSON.stringify({
      version: 1,
      entries: [{ id, requestedAt: new Date().toISOString(), cleanupAttachments: false, attempts: 0, lastError: null, lastAttemptAt: null }],
    }));
    const { admin } = harness({
      root,
      archived: [id],
      headers: [{ id, cwd: 'C:\\project' }],
      live: (sessionId) => (sessionId === id ? { id } : undefined),
    });
    const swept = await admin.sweepPending();
    assert.equal(swept.totals.deleted, 0);
    assert.equal(swept.totals.kept, 1);
    assert.equal(await exists(layout.directory), true);
    const queue = JSON.parse(await readFile(pending, 'utf8'));
    assert.equal(queue.entries[0].lastError, 'session-live');
    assert.equal(queue.entries[0].attempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan marks a live session as queued instead of invalid', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-plan-live-'));
  try {
    const id = 'session-abc';
    await layoutSession(root, id);
    const { admin } = harness({
      root,
      archived: [id],
      workspaces: [{ id: 'ws-1', title: 'Project', sessionIds: [id] }],
      headers: [{ id, cwd: 'C:\\project' }],
      live: (sessionId) => (sessionId === id ? { id } : undefined),
    });
    const planned = await admin.plan([id]);
    assert.equal(planned.items[0].ok, true);
    assert.equal(planned.items[0].willQueue, true);
    assert.equal(planned.totals.immediate, 0);
    assert.equal(planned.totals.queued, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remove cleans only attachments no remaining session references', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-attach-remove-'));
  try {
    const target = 'session-abc';
    const keep = 'session-keep';
    await layoutSession(root, target);
    await layoutSession(root, keep);
    const { admin, attachments } = harness({
      root,
      archived: [target],
      headers: [
        { id: target, cwd: 'C:\\project' },
        { id: keep, cwd: 'C:\\project' },
      ],
      events: async (sessionId) => {
        if (sessionId === target) return [{ data: { a: ID_A, c: ID_C } }];
        if (sessionId === keep) return [{ data: { b: ID_B } }];
        return [];
      },
    });
    const pathsA = await layoutAttachment(attachments, HASH_A, 'a.txt');
    const pathsB = await layoutAttachment(attachments, HASH_B, 'b.txt');
    const pathsC = await layoutAttachment(attachments, HASH_C, 'c.txt');

    const result = await admin.remove([target], { cleanupAttachments: true });
    assert.equal(result.results[0].deleted, true);
    assert.equal(result.attachment.deleted, 2);
    assert.equal(result.attachment.freedBytes, 60);
    assert.equal(await exists(pathsA.object), false);
    assert.equal(await exists(pathsC.object), false);
    assert.equal(await exists(pathsB.object), true);
    assert.equal(await exists(path.join(pathsB.fileAlias, 'b.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remove keeps every attachment when the reference scan cannot complete', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-attach-skip-'));
  try {
    const target = 'session-abc';
    const keep = 'session-keep';
    await layoutSession(root, target);
    const { admin, attachments } = harness({
      root,
      archived: [target],
      headers: [
        { id: target, cwd: 'C:\\project' },
        { id: keep, cwd: 'C:\\project' },
      ],
      events: async (sessionId) => {
        if (sessionId === target) return [{ data: { a: ID_A } }];
        throw new Error('unreadable');
      },
    });
    const pathsA = await layoutAttachment(attachments, HASH_A, 'a.txt');
    const result = await admin.remove([target], { cleanupAttachments: true });
    assert.equal(result.results[0].deleted, true);
    assert.equal(result.attachment.deleted, 0);
    assert.equal(result.attachment.skipped, 'read-failed');
    assert.equal(await exists(pathsA.object), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remove deletes subagent descendants but not unrelated sessions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-desc-'));
  try {
    const parent = 'session-parent';
    const child = 'session-child';
    const unrelated = 'session-unrelated';
    const parentLayout = await layoutSession(root, parent);
    const childLayout = await layoutSession(root, child);
    const unrelatedLayout = await layoutSession(root, unrelated);
    const { admin, calls } = harness({
      root,
      archived: [parent],
      headers: [
        { id: parent, cwd: 'C:\\project' },
        { id: child, cwd: 'C:\\project', origin: 'subagent', parentSession: parent },
        { id: unrelated, cwd: 'C:\\project' },
      ],
    });
    const result = await admin.remove([parent], { cleanupAttachments: false });
    assert.equal(result.results[0].deleted, true);
    assert.equal(result.results[0].descendants, 1);
    assert.equal(await exists(parentLayout.directory), false);
    assert.equal(await exists(childLayout.directory), false);
    assert.equal(await exists(unrelatedLayout.directory), true);
    assert.deepEqual(calls.archive, [child]);
    assert.equal(calls.unarchive.includes(child), true);
    assert.equal(calls.unarchive.includes(parent), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unarchive reports the sessions it changed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-unarchive-'));
  try {
    const id = 'session-abc';
    const { admin, calls } = harness({ root, archived: [id], headers: [{ id, cwd: 'C:\\project' }] });
    const result = await admin.unarchive([id, 'session-other']);
    assert.equal(result.totals.unarchived, 1);
    assert.deepEqual(calls.unarchive, [id]);
    assert.equal(result.results[1].code, 'not-archived');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list prunes a pending intent for a session that is no longer archived', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-prune-list-'));
  try {
    const id = 'session-abc';
    const layout = await layoutSession(root, id);
    const pending = pendingFilePath(root);
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(pending, JSON.stringify({
      version: 1,
      entries: [{ id, requestedAt: new Date().toISOString(), cleanupAttachments: true, attempts: 0, lastError: null, lastAttemptAt: null }],
    }));
    const { admin } = harness({ root, archived: [], headers: [{ id, cwd: 'C:\\project' }] });
    const listed = await admin.list();
    assert.equal(listed.totals.pending, 0);
    // The page read only schedules the prune; give the coalesced pass time to run.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    const queue = JSON.parse(await readFile(pending, 'utf8'));
    assert.deepEqual(queue.entries, []);
    // Pruning only clears intent; it never deletes files.
    assert.equal(await exists(layout.directory), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unarchive clears a queued deletion for the same session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-unarchive-queue-'));
  try {
    const id = 'session-abc';
    const pending = pendingFilePath(root);
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(pending, JSON.stringify({
      version: 1,
      entries: [{ id, requestedAt: new Date().toISOString(), cleanupAttachments: true, attempts: 0, lastError: null, lastAttemptAt: null }],
    }));
    const { admin } = harness({ root, archived: [id], headers: [{ id, cwd: 'C:\\project' }] });
    await admin.unarchive([id]);
    const queue = JSON.parse(await readFile(pending, 'utf8'));
    assert.deepEqual(queue.entries, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prunePending keeps intents for sessions that are still archived', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsa-prune-keep-'));
  try {
    const id = 'session-abc';
    const pending = pendingFilePath(root);
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(pending, JSON.stringify({
      version: 1,
      entries: [{ id, requestedAt: new Date().toISOString(), cleanupAttachments: true, attempts: 0, lastError: null, lastAttemptAt: null }],
    }));
    const { admin } = harness({ root, archived: [id], headers: [{ id, cwd: 'C:\\project' }] });
    const pruned = await admin.prunePending();
    assert.deepEqual(pruned.removed, []);
    const queue = JSON.parse(await readFile(pending, 'utf8'));
    assert.equal(queue.entries.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
