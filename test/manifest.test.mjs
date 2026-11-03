import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('manifest declares the bundle patch, browser half, locale and icon exports', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-session-admin');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.equal(Array.isArray(manifest.dsh.client.inject), true);
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), true);
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'lib/archive.js', 'lib/http.js', 'lib/paths.js', 'lib/attachments.js']) {
    const info = await stat(path.join(root, file));
    assert.equal(info.isFile(), true, `${file} exists`);
  }
});

test('patch inserts the host row under a stable id', async () => {
  const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: session-admin/);
  assert.match(patch, /name: dsh-session-admin/);
});

test('locale resources carry the display metadata for both shipped locales', async () => {
  for (const locale of ['zh', 'en']) {
    const dict = JSON.parse(await readFile(path.join(root, 'locale', `${locale}.json`), 'utf8'));
    assert.equal(typeof dict.meta.title, 'string');
    assert.equal(dict.meta.title.length > 0, true);
    assert.equal(typeof dict.meta.description, 'string');
    assert.equal(dict.meta.description.length > 0, true);
  }
});

test('icon is a valid bounded svg', async () => {
  const file = path.join(root, 'icon.svg');
  const text = await readFile(file, 'utf8');
  assert.match(text, /<svg[\s>]/);
  assert.match(text, /<\/svg>/);
  const info = await stat(file);
  assert.equal(info.size <= 256 * 1024, true);
});
