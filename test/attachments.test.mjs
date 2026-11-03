import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  attachmentPaths,
  digestOf,
  extractAttachmentIds,
  pruneUnreferencedAttachments,
  readUploadIndexReferences,
  scanAttachmentReferences,
} from '../lib/attachments.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const ID_A = `sha256:${HASH_A}`;
const ID_B = `sha256:${HASH_B}`;
const ID_C = `sha256:${HASH_C}`;

const workspace = async (prefix) => mkdtemp(path.join(tmpdir(), prefix));
const exists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

test('extractAttachmentIds walks nested events', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: ID_A } }] } },
    { type: 'tool/result', data: { message: { content: [{ type: 'file', attachment: { attachmentId: ID_B } }] } } },
    { type: 'text', data: { text: `no attachment here ${'a'.repeat(64)}` } },
  ];
  const ids = extractAttachmentIds(events);
  assert.deepEqual([...ids].sort(), [ID_A, ID_B].sort());
});

test('digestOf validates the id shape', () => {
  assert.equal(digestOf(ID_A), HASH_A);
  assert.equal(digestOf('sha256:xyz'), undefined);
  assert.equal(digestOf(`md5:${HASH_A}`), undefined);
});

test('pruneUnreferencedAttachments removes only unreferenced objects', async () => {
  const root = await workspace('dsa-attach-');
  try {
    const rootV1 = path.join(root, 'v1');
    for (const [digest, name] of [[HASH_A, 'a.txt'], [HASH_B, 'b.txt'], [HASH_C, 'c.txt']]) {
      const paths = attachmentPaths(rootV1, digest);
      await mkdir(path.dirname(paths.object), { recursive: true });
      await mkdir(path.dirname(paths.fileObject), { recursive: true });
      await mkdir(paths.fileAlias, { recursive: true });
      await writeFile(paths.object, 'x'.repeat(10));
      await writeFile(paths.fileObject, 'x'.repeat(20));
      await writeFile(path.join(paths.fileAlias, name), 'x'.repeat(30));
    }
    const outcome = await pruneUnreferencedAttachments({
      attachmentsRoot: rootV1,
      candidates: [ID_A, ID_C],
      referenced: new Set([ID_B]),
    });
    assert.equal(outcome.deleted.length, 2);
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.freedBytes, 60 * 2);
    assert.equal(await exists(attachmentPaths(rootV1, HASH_A).object), false);
    assert.equal(await exists(attachmentPaths(rootV1, HASH_C).object), false);
    assert.equal(await exists(path.join(attachmentPaths(rootV1, HASH_B).fileAlias, 'b.txt')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanAttachmentReferences returns incomplete when one session cannot be read', async () => {
  const root = await workspace('dsa-scan-');
  try {
    const outcome = await scanAttachmentReferences({
      sessionIds: ['session-ok', 'session-broken'],
      readEvents: async (id) => {
        if (id === 'session-broken') throw new Error('unreadable');
        return [{ data: { attachmentId: ID_A } }];
      },
      uploadIndexPath: path.join(root, 'missing.json'),
    });
    assert.equal(outcome.complete, false);
    assert.equal(outcome.reason, 'read-failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanAttachmentReferences combines sessions and the upload index', async () => {
  const root = await workspace('dsa-scan2-');
  try {
    const index = path.join(root, 'files-v3.json');
    await writeFile(index, JSON.stringify({ records: [{ attachmentId: ID_C }] }));
    const outcome = await scanAttachmentReferences({
      sessionIds: ['session-keep'],
      readEvents: async () => [{ data: { attachmentId: ID_A } }],
      uploadIndexPath: index,
    });
    assert.equal(outcome.complete, true);
    assert.equal(outcome.referenced.has(ID_A), true);
    assert.equal(outcome.referenced.has(ID_C), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanAttachmentReferences stops at its event budget', async () => {
  const root = await workspace('dsa-scan3-');
  try {
    const outcome = await scanAttachmentReferences({
      sessionIds: ['session-one'],
      readEvents: async () => [{ one: 1 }, { two: 2 }],
      uploadIndexPath: path.join(root, 'missing.json'),
      budget: { events: 1 },
    });
    assert.equal(outcome.complete, false);
    assert.equal(outcome.reason, 'event-budget');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readUploadIndexReferences reads missing or malformed files as empty', async () => {
  const root = await workspace('dsa-index-');
  try {
    assert.equal((await readUploadIndexReferences(path.join(root, 'missing.json'))).size, 0);
    const malformed = path.join(root, 'bad.json');
    await writeFile(malformed, '{not json');
    assert.equal((await readUploadIndexReferences(malformed)).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
