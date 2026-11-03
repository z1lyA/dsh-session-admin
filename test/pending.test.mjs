import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PENDING_MAX,
  createPendingEntry,
  pendingFilePath,
  readPending,
  writePending,
} from '../lib/pending.js';

const workspace = (prefix) => mkdtemp(path.join(tmpdir(), prefix));

test('createPendingEntry carries the optimization intent', () => {
  const entry = createPendingEntry('session-abc', false);
  assert.equal(entry.id, 'session-abc');
  assert.equal(entry.cleanupAttachments, false);
  assert.equal(entry.attempts, 0);
  assert.equal(entry.lastError, null);
  assert.equal(typeof entry.requestedAt, 'string');
});

test('writePending/readPending round-trip entries', async () => {
  const home = await workspace('dsa-pending-');
  try {
    const entries = [
      createPendingEntry('session-a', true),
      { ...createPendingEntry('session-b', false), attempts: 2, lastError: 'session-live' },
    ];
    await writePending(home, entries);
    const file = pendingFilePath(home);
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.entries.length, 2);
    const read = await readPending(home);
    assert.deepEqual(read, entries);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readPending treats a missing file as an empty queue', async () => {
  const home = await workspace('dsa-pending-missing-');
  try {
    assert.deepEqual(await readPending(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readPending rejects malformed or unsupported files instead of silently resetting them', async () => {
  const home = await workspace('dsa-pending-bad-');
  try {
    await mkdir(path.join(home, 'session-admin'), { recursive: true });
    const file = pendingFilePath(home);
    await writeFile(file, '{not json');
    await assert.rejects(readPending(home), /not valid JSON/);
    await writeFile(file, JSON.stringify({ version: 99, entries: [] }));
    await assert.rejects(readPending(home), /unsupported shape/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('readPending drops invalid ids and duplicate entries', async () => {
  const home = await workspace('dsa-pending-filter-');
  try {
    await mkdir(path.join(home, 'session-admin'), { recursive: true });
    await writeFile(pendingFilePath(home), JSON.stringify({
      version: 1,
      entries: [
        { id: '../escape', requestedAt: 'x' },
        { id: 'session-a' },
        { id: 'session-a' },
        { id: 'session-b', cleanupAttachments: false },
      ],
    }));
    const read = await readPending(home);
    assert.deepEqual(read.map((entry) => entry.id), ['session-a', 'session-b']);
    assert.equal(read[1].cleanupAttachments, false);
    assert.equal(read[0].attempts, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('writePending refuses an unbounded queue', async () => {
  const home = await workspace('dsa-pending-cap-');
  try {
    const entries = Array.from({ length: PENDING_MAX + 1 }, (_, index) => createPendingEntry(`session-${index}`, true));
    await assert.rejects(writePending(home, entries), /exceeds/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
