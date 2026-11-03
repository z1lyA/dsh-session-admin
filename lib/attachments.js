/**
 * Content-addressed attachment handling for session deletion.
 *
 * DSH stores attachment bytes once per digest under `attachments/v1`, and the
 * same object legitimately backs many sessions. There is no refcount and no
 * delete API, so this module only ever removes an object after a completed
 * reference scan proves that no remaining session (and no host-wide upload
 * index entry) mentions it. A scan that cannot finish removes nothing.
 *
 * @module dsh-session-admin/lib/attachments
 */
import path from 'node:path';
import { lstat, readFile, rm } from 'node:fs/promises';
import { isInside, measureTree } from './paths.js';

/** One durable attachment id: `sha256:` plus 64 lowercase hex digits. */
const ATTACHMENT_ID = /sha256:([a-f0-9]{64})/g;

/**
 * Collect every attachment id mentioned anywhere in a JSON-like value.
 * @param {unknown} value decoded session events or upload index
 * @returns {Set<string>} `sha256:<hex>` ids
 */
export function extractAttachmentIds(value) {
  const ids = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(ATTACHMENT_ID)) ids.add(match[0]);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key]);
    }
  };
  walk(value);
  return ids;
}

/**
 * Validate and strip the `sha256:` prefix of one attachment id.
 * @param {string} id attachment id
 * @returns {string | undefined} bare hex digest
 */
export function digestOf(id) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(id);
  return match === null ? undefined : match[1];
}

/**
 * Every stored path of one attachment object.
 * @param {string} attachmentsRoot absolute `attachments/v1` root
 * @param {string} digest bare sha256 hex digest
 * @returns {{ object: string, fileObject: string, fileAlias: string }} absolute paths
 */
export function attachmentPaths(attachmentsRoot, digest) {
  const bucket = digest.slice(0, 2);
  return {
    object: path.join(attachmentsRoot, 'objects', bucket, digest),
    fileObject: path.join(attachmentsRoot, 'file-objects', bucket, digest),
    fileAlias: path.join(attachmentsRoot, 'files', bucket, digest),
  };
}

/**
 * Delete one attachment object and its file alias when present.
 * @param {string} attachmentsRoot absolute root
 * @param {string} digest bare digest
 * @returns {Promise<{ bytes: number, removed: boolean }>} reclaimed footprint
 */
async function removeAttachmentObject(attachmentsRoot, digest) {
  const paths = attachmentPaths(attachmentsRoot, digest);
  for (const candidate of [paths.object, paths.fileObject, paths.fileAlias]) {
    if (!isInside(attachmentsRoot, candidate)) throw new Error('attachment path escaped the attachment root');
  }
  let bytes = 0;
  let removed = false;
  for (const candidate of [paths.object, paths.fileObject, paths.fileAlias]) {
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isDirectory()) {
      const measured = await measureTree(candidate);
      bytes += measured.bytes;
      await rm(candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed = true;
      continue;
    }
    if (!info.isFile()) continue;
    bytes += info.size;
    await rm(candidate, { force: true });
    removed = true;
  }
  return { bytes, removed };
}

/**
 * Remove attachment objects that no remaining session or upload-index entry references.
 * @param {{ attachmentsRoot: string, candidates: Iterable<string>, referenced: Set<string> }} input
 * @returns {Promise<{ freedBytes: number, deleted: string[], failed: Array<{ id: string, message: string }> }>}
 */
export async function pruneUnreferencedAttachments({ attachmentsRoot, candidates, referenced }) {
  let freedBytes = 0;
  const deleted = [];
  const failed = [];
  for (const id of candidates) {
    if (referenced.has(id)) continue;
    const digest = digestOf(id);
    if (digest === undefined) continue;
    try {
      const outcome = await removeAttachmentObject(attachmentsRoot, digest);
      freedBytes += outcome.bytes;
      if (outcome.removed) deleted.push(id);
    } catch (error) {
      failed.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { freedBytes, deleted, failed };
}

/**
 * Read the host-wide upload index and collect the attachment ids it still names.
 *
 * The index is a cache with TTLs, but an entry may still be used to re-send a
 * file without a new upload, so it counts as a reference here.
 * @param {string} uploadIndexPath absolute `llm-deepseek/files-v3.json`
 * @returns {Promise<Set<string>>} referenced attachment ids (empty when absent or unreadable)
 */
export async function readUploadIndexReferences(uploadIndexPath) {
  try {
    const text = await readFile(uploadIndexPath, 'utf8');
    return extractAttachmentIds(JSON.parse(text));
  } catch {
    return new Set();
  }
}

/**
 * Scan every remaining session's events plus the upload index for attachment references.
 *
 * The scan is all-or-nothing: exceeding the budget or failing one read returns
 * `complete: false`, and the caller must then keep every candidate object.
 * @param {{
 *   sessionIds: Iterable<string>,
 *   readEvents: (sessionId: string) => Promise<unknown>,
 *   uploadIndexPath: string,
 *   budget?: { sessions?: number, events?: number, milliseconds?: number },
 * }} input
 * @returns {Promise<{ complete: boolean, referenced: Set<string>, reason?: string }>}
 */
export async function scanAttachmentReferences({ sessionIds, readEvents, uploadIndexPath, budget = {} }) {
  const maxSessions = budget.sessions ?? 500;
  const maxEvents = budget.events ?? 200000;
  const maxMilliseconds = budget.milliseconds ?? 90000;
  const started = Date.now();
  const referenced = new Set();
  let sessions = 0;
  let events = 0;
  for (const sessionId of sessionIds) {
    if (sessions >= maxSessions) return { complete: false, referenced, reason: 'session-budget' };
    if (Date.now() - started > maxMilliseconds) return { complete: false, referenced, reason: 'time-budget' };
    sessions += 1;
    let page;
    try {
      page = await readEvents(sessionId);
    } catch {
      return { complete: false, referenced, reason: 'read-failed' };
    }
    const rows = Array.isArray(page) ? page : [];
    events += rows.length;
    if (events > maxEvents) return { complete: false, referenced, reason: 'event-budget' };
    for (const id of extractAttachmentIds(rows)) referenced.add(id);
  }
  for (const id of await readUploadIndexReferences(uploadIndexPath)) referenced.add(id);
  return { complete: true, referenced };
}
