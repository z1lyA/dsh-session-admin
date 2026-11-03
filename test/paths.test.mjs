import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decodeSegment,
  encodeSegment,
  findSessionDirs,
  isInside,
  isValidSessionId,
  measureTree,
  projectionCachePath,
  resolveRoots,
} from '../lib/paths.js';

const workspace = async (prefix) => mkdtemp(path.join(tmpdir(), prefix));

test('encodeSegment keeps safe ids literal and round-trips escapes', () => {
  assert.equal(encodeSegment('session-1d8f7019-9eec'), 'session-1d8f7019-9eec');
  assert.equal(encodeSegment('a b'), 'a~0020b');
  assert.equal(encodeSegment('地理标志'), '~5730~7406~6807~5FD7');
  assert.equal(decodeSegment(encodeSegment('地理标志')), '地理标志');
  assert.equal(decodeSegment(encodeSegment('session-abc_1.2')), 'session-abc_1.2');
});

test('encodeSegment escapes dot-only names', () => {
  assert.equal(encodeSegment('.'), '~002E');
  assert.equal(encodeSegment('..'), '~002E~002E');
});

test('isValidSessionId rejects path syntax', () => {
  assert.equal(isValidSessionId('session-00d57b62-bd2f-4ac2-a45c-3dd6a1651502'), true);
  assert.equal(isValidSessionId('166b0c10-edb2-4d0d-8988-198f51d2b6f2'), true);
  assert.equal(isValidSessionId('../escape'), false);
  assert.equal(isValidSessionId('a/b'), false);
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId('.'), false);
  assert.equal(isValidSessionId('..'), false);
  assert.equal(isValidSessionId(42), false);
  assert.equal(isValidSessionId('x'.repeat(201)), false);
});

test('resolveRoots honours overrides and defaults to DSH home layout', () => {
  const roots = resolveRoots({
    dshHome: 'C:\\home\\dsh',
    sessionsRoot: 'C:\\data\\sessions',
    storagesRoot: 'C:\\data\\storages',
    attachmentsRoot: 'C:\\data\\attachments',
  });
  assert.equal(roots.sessions, path.resolve('C:\\data\\sessions'));
  assert.equal(roots.storages, path.resolve('C:\\data\\storages'));
  assert.equal(roots.attachments, path.resolve('C:\\data\\attachments'));
  assert.equal(roots.uploadIndex, path.join(path.resolve('C:\\home\\dsh'), 'llm-deepseek', 'files-v3.json'));
  const fallback = resolveRoots({ dshHome: 'C:\\home\\dsh' });
  assert.equal(fallback.sessions, path.join(path.resolve('C:\\home\\dsh'), 'sessions'));
  assert.equal(fallback.storages, path.join(path.resolve('C:\\home\\dsh'), 'storages'));
  assert.equal(fallback.attachments, path.join(path.resolve('C:\\home\\dsh'), 'attachments', 'v1'));
});

test('isInside refuses the root itself and siblings', () => {
  assert.equal(isInside('C:\\a', 'C:\\a\\b'), true);
  assert.equal(isInside('C:\\a', 'C:\\a'), false);
  assert.equal(isInside('C:\\a', 'C:\\ab\\c'), false);
  assert.equal(isInside('C:\\a', 'C:\\b\\c'), false);
});

test('measureTree sums regular files below the directory', async () => {
  const root = await workspace('dsa-measure-');
  try {
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'a.txt'), 'x'.repeat(10));
    await writeFile(path.join(root, 'nested', 'b.txt'), 'x'.repeat(25));
    const measured = await measureTree(root);
    assert.deepEqual(measured, { bytes: 35, files: 2 });
    assert.deepEqual(await measureTree(path.join(root, 'missing')), { bytes: 0, files: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findSessionDirs locates encoded directories and reports collisions', async () => {
  const root = await workspace('dsa-find-');
  try {
    const id = 'session-abc-def';
    const segment = encodeSegment(id);
    await mkdir(path.join(root, '--project-one--', segment), { recursive: true });
    await mkdir(path.join(root, '--project-two--'), { recursive: true });
    const first = await findSessionDirs(root, [id, 'session-missing']);
    assert.equal(first.found.get(id), path.join(root, '--project-one--', segment));
    assert.equal(first.duplicates.size, 0);

    await mkdir(path.join(root, '--project-two--', segment), { recursive: true });
    const second = await findSessionDirs(root, [id]);
    assert.equal(second.duplicates.has(id), true);
    assert.equal(second.found.has(id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findSessionDirs tolerates a missing sessions root', async () => {
  const root = await workspace('dsa-missing-');
  try {
    const located = await findSessionDirs(path.join(root, 'nope'), ['session-x']);
    assert.equal(located.found.size, 0);
    assert.equal(located.duplicates.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('projectionCachePath uses the per-record layout', () => {
  assert.equal(
    projectionCachePath('C:\\home\\storages', 'session-x'),
    path.join('C:\\home\\storages', 'session_projcache', 'sessions', 'session-x.json'),
  );
});
