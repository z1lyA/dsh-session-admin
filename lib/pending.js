/**
 * Durable queue of session deletions that must wait for the next Host start.
 *
 * The Host keeps a Session/Agent alive for the whole process once a conversation
 * was opened, and only the AgentHandle owner (the session controller) may
 * dispose it. Deleting the log while that handle exists can make the backend
 * recreate a headerless log or write the projection cache back, so the plugin
 * refuses to touch the files and records the intent here instead. The next Host
 * start has no live session, and the queue is executed before the browser opens
 * a conversation.
 *
 * The file is plugin-owned: `$DSH_HOME/session-admin/pending-deletions.json`.
 * Writes are atomic (temp file + rename) and the queue is bounded, so a corrupt
 * or hand-edited file can never make the Host delete an unbounded list.
 *
 * @module dsh-session-admin/lib/pending
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidSessionId } from './paths.js';

/** Schema version of the pending file. */
export const PENDING_VERSION = 1;
/** Maximum number of queued sessions. */
export const PENDING_MAX = 500;

/**
 * Absolute path of the pending-deletion file for one DSH home.
 * @param {string} home resolved DSH home
 * @returns {string} absolute file path
 */
export function pendingFilePath(home) {
  return path.join(home, 'session-admin', 'pending-deletions.json');
}

/**
 * Normalize one durable entry, dropping unknown fields.
 * @param {Record<string, unknown>} raw stored entry
 * @returns {object} normalized entry
 */
function normalizeEntry(raw) {
  return {
    id: String(raw.id),
    requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : new Date(0).toISOString(),
    cleanupAttachments: raw.cleanupAttachments !== false,
    attempts: Number.isSafeInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? raw.lastError : null,
    lastAttemptAt: typeof raw.lastAttemptAt === 'string' ? raw.lastAttemptAt : null,
  };
}

/**
 * Read the pending queue.
 *
 * A missing file is an empty queue. A malformed file throws instead of being
 * treated as empty: silently replacing it could discard a user's deletion
 * intent, and the caller decides whether to surface or retry.
 * @param {string} home resolved DSH home
 * @returns {Promise<object[]>} normalized entries in queue order
 */
export async function readPending(home) {
  let text;
  try {
    text = await readFile(pendingFilePath(home), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`pending deletion file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (data === null || typeof data !== 'object' || data.version !== PENDING_VERSION || !Array.isArray(data.entries)) {
    throw new Error('pending deletion file has an unsupported shape');
  }
  const entries = [];
  const seen = new Set();
  for (const raw of data.entries) {
    if (raw === null || typeof raw !== 'object' || !isValidSessionId(raw.id)) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    entries.push(normalizeEntry(raw));
  }
  return entries;
}

/**
 * Replace the pending queue atomically.
 * @param {string} home resolved DSH home
 * @param {object[]} entries entries to persist
 * @returns {Promise<void>} resolution after the rename
 */
export async function writePending(home, entries) {
  if (entries.length > PENDING_MAX) throw new Error(`pending deletion queue exceeds ${PENDING_MAX} entries`);
  const file = pendingFilePath(home);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({ version: PENDING_VERSION, entries }, null, 2);
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Build one fresh queue entry for a session that cannot be deleted yet.
 * @param {string} id session id
 * @param {boolean} cleanupAttachments attachment cleanup intent
 * @returns {object} durable entry
 */
export function createPendingEntry(id, cleanupAttachments) {
  return {
    id,
    requestedAt: new Date().toISOString(),
    cleanupAttachments: cleanupAttachments !== false,
    attempts: 0,
    lastError: null,
    lastAttemptAt: null,
  };
}
