/**
 * Session Archive operations.
 *
 * DSH exposes archive/unarchive but no way to permanently remove a session.
 * This module implements that missing operation locally, with the safety rules
 * the shipped architecture requires:
 *
 *  - only registry-archived sessions are eligible, and a live agent refuses;
 *  - the whole per-session log directory is removed (never truncated);
 *  - the projection cache goes through the storage domain (or its exact file);
 *  - subagent descendants are removed with their parent, never a user fork;
 *  - schedules bound to the session are deleted;
 *  - attachment objects are removed only after a complete reference scan says
 *    no remaining session or upload-index entry uses them.
 *
 * Every read is defensive: services can be absent (minimal profiles) and the
 * callers get an explicit code instead of a guessed mutation.
 *
 * @module dsh-session-admin/lib/archive
 */
import { readdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  findSessionDirs,
  isInside,
  isValidSessionId,
  measureTree,
  projectionCacheDir,
  projectionCachePath,
  resolveRoots,
} from './paths.js';
import {
  extractAttachmentIds,
  pruneUnreferencedAttachments,
  scanAttachmentReferences,
} from './attachments.js';
import {
  PENDING_MAX,
  createPendingEntry,
  readPending,
  writePending,
} from './pending.js';

/** Maximum ids accepted by one list/delete request. */
export const MAX_BATCH = 100;
const REFERENCE_BUDGET = { sessions: 500, events: 200000, milliseconds: 90000 };
const TARGET_REFERENCE_BUDGET = { events: 100000, milliseconds: 30000 };

/** An input or precondition failure carrying a stable machine code. */
export class ArchiveRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArchiveRequestError';
    this.code = code;
  }
}

/**
 * Validate a client-supplied id list.
 * @param {unknown} ids raw value
 * @returns {string[]} unique ids in request order
 */
export function validateIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new ArchiveRequestError('invalid-request', 'ids must be a non-empty array');
  if (ids.length > MAX_BATCH) throw new ArchiveRequestError('too-many', `at most ${MAX_BATCH} sessions per request`);
  const unique = [];
  const seen = new Set();
  for (const id of ids) {
    if (!isValidSessionId(id)) throw new ArchiveRequestError('invalid-id', 'session id is not path-safe');
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

/**
 * Create the archive admin facade bound to one plugin context.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {{ dshHome?: string, sessionsRoot?: string, storagesRoot?: string, attachmentsRoot?: string, cleanupAttachmentsDefault?: boolean }} [config]
 * @returns {{
 *   list: () => Promise<object>,
 *   plan: (ids: string[], options?: object) => Promise<object>,
 *   remove: (ids: string[], options?: object) => Promise<object>,
 *   unarchive: (ids: string[]) => Promise<object>,
 *   cancelPending: (ids: string[]) => Promise<object>,
 *   sweepPending: () => Promise<object>,
 *   prunePending: () => Promise<object>,
 *   schedulePrune: () => void,
 *   roots: object,
 * }}
 */
export function createArchiveAdmin(ctx, config = {}) {
  const roots = resolveRoots(config);
  const cleanupAttachmentsDefault = config.cleanupAttachmentsDefault !== false;
  let tail = Promise.resolve();

  /** Run one mutation at a time: two browser tabs must not race the same files. */
  const serialize = (operation) => {
    const run = tail.then(operation, operation);
    tail = run.then(() => {}, () => {});
    return run;
  };

  /** Read the durable pending-deletion queue; a missing file is empty. */
  const readQueue = () => readPending(roots.home);
  /** Persist the pending-deletion queue atomically. */
  const writeQueue = (entries) => writePending(roots.home, entries);
  /** Normalize a queue entry for the browser. */
  const pendingView = (entry) => ({
    requestedAt: entry.requestedAt,
    cleanupAttachments: entry.cleanupAttachments,
    attempts: entry.attempts,
    lastError: entry.lastError,
    lastAttemptAt: entry.lastAttemptAt,
  });

  /** Resolve an optional service without throwing in minimal compositions. */
  const service = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };
  const warn = (message) => {
    try {
      service('logger')?.warn?.(message);
      ctx.logger?.warn?.(message);
    } catch {
      /* logging must never fail a request */
    }
  };

  const registry = () => service('workspaceRegistry');
  const persistence = () => service('sessionPersistence');
  const query = () => service('sessionQuery');
  const schedule = () => service('schedule');
  const liveSession = (id) => service('sessions')?.get?.(id);

  const requireRegistry = () => {
    const value = registry();
    if (value === undefined) throw new ArchiveRequestError('registry-unavailable', 'the workspace registry is not mounted');
    return value;
  };
  const requirePersistence = () => {
    const value = persistence();
    if (value === undefined) throw new ArchiveRequestError('persistence-unavailable', 'session persistence is not mounted');
    return value;
  };

  const archivedSet = () => new Set([...(requireRegistry().archivedSessionIds ?? [])].map(String));

  /** Durable session headers keyed by id (live sessions included when persisted). */
  const storedHeaders = async () => {
    const list = await requirePersistence().list();
    const headers = new Map();
    for (const snapshot of list) {
      const header = snapshot?.header;
      if (header !== undefined && header.id !== undefined) headers.set(String(header.id), header);
    }
    const sessions = service('sessions');
    for (const session of sessions?.list?.() ?? []) {
      const header = session?.header;
      if (header !== undefined && header.id !== undefined) headers.set(String(header.id), header);
    }
    return headers;
  };

  /**
   * Descendant subagent sessions (never user forks).
   * @param {string} id root session id
   * @param {Map<string, any>} headers stored headers
   * @returns {string[]} transitive subagent descendants
   */
  const descendantsOf = (id, headers) => {
    const children = new Map();
    for (const [sessionId, header] of headers) {
      if (header?.origin !== 'subagent' || header?.parentSession === undefined) continue;
      const parent = String(header.parentSession);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(sessionId);
    }
    const out = [];
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const child of children.get(current) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        stack.push(child);
      }
    }
    return out;
  };

  /** Owning workspace per session id, from registry order. */
  const ownershipIndex = () => {
    const map = new Map();
    for (const workspace of registry()?.list?.() ?? []) {
      for (const sessionId of workspace.sessionIds ?? []) map.set(String(sessionId), workspace);
    }
    return map;
  };

  const fileSize = async (absolute) => {
    try {
      const info = await lstat(absolute);
      return info.isFile() ? info.size : 0;
    } catch {
      return 0;
    }
  };

  /** Read the attachment ids referenced by the given sessions, or report incompleteness. */
  const collectTargetReferences = async (sessionIds) => {
    const events = query()?.listEvents;
    if (typeof events !== 'function') return { complete: false, ids: new Set(), reason: 'query-unavailable' };
    const ids = new Set();
    let count = 0;
    const started = Date.now();
    for (const sessionId of sessionIds) {
      let rows;
      try {
        rows = await events.call(query(), sessionId);
      } catch {
        return { complete: false, ids, reason: 'read-failed' };
      }
      const rowsArray = Array.isArray(rows) ? rows : [];
      count += rowsArray.length;
      if (count > TARGET_REFERENCE_BUDGET.events || Date.now() - started > TARGET_REFERENCE_BUDGET.milliseconds) {
        return { complete: false, ids, reason: 'budget' };
      }
      for (const id of extractAttachmentIds(rowsArray)) ids.add(id);
    }
    return { complete: true, ids };
  };

  /** Schedules grouped by their original session id. */
  const schedulesBySession = async () => {
    const current = schedule();
    if (current === undefined || typeof current.catalog !== 'function') return new Map();
    const rows = await current.catalog();
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const sessionId = String(row?.sessionId ?? '');
      if (sessionId === '') continue;
      if (!map.has(sessionId)) map.set(sessionId, []);
      map.get(sessionId).push(row);
    }
    return map;
  };

  /** Remove the projection-cache record through the storage domain when it is mounted. */
  const removeProjectionCache = async (sessionId) => {
    const file = projectionCachePath(roots.storages, sessionId);
    const freed = await fileSize(file);
    const domain = service('storageDomain');
    const table = domain?.get?.('session_projcache')?.table?.('sessions');
    if (table !== undefined && typeof table.delete === 'function') {
      try {
        await table.delete(sessionId);
      } catch (error) {
        warn(`[session-admin] projection cache record delete failed for ${sessionId}: ${String(error)}`);
      }
    }
    try {
      await rm(file, { force: true });
      const directory = projectionCacheDir(roots.storages);
      for (const name of await readdir(directory)) {
        if (!name.startsWith(`${sessionId}.json.`)) continue;
        const leftover = path.join(directory, name);
        await rm(leftover, { force: true });
      }
    } catch {
      /* the record and its backups are best-effort when the domain already removed them */
    }
    return freed;
  };

  /** Measure one group of session ids without reading event logs. */
  const measureGroup = async (group) => {
    const { found, duplicates } = await findSessionDirs(roots.sessions, group);
    let logBytes = 0;
    let cacheBytes = 0;
    let logFiles = 0;
    let hasLog = false;
    let duplicate = false;
    for (const sessionId of group) {
      if (duplicates.has(sessionId)) {
        duplicate = true;
        continue;
      }
      const directory = found.get(sessionId);
      if (directory !== undefined) {
        hasLog = true;
        const measured = await measureTree(directory);
        logBytes += measured.bytes;
        logFiles += measured.files;
      }
      cacheBytes += await fileSize(projectionCachePath(roots.storages, sessionId));
    }
    return { logBytes, cacheBytes, logFiles, hasLog, duplicate, found, duplicates };
  };

  /**
   * Drop queued deletions whose session is no longer archived.
   *
   * Unarchiving cancels the intent: the session is visible again, so deleting
   * it on the next start would contradict the user's latest action. This runs
   * on workspace-domain changes, on every page read, at Host start, and in the
   * admin unarchive path.
   * @returns {Promise<{ removed: string[], kept: number }>} pruned ids
   */
  const prunePending = () => serialize(async () => {
    let queue;
    try {
      queue = await readQueue();
    } catch (error) {
      warn(`[session-admin] pending deletion queue is unreadable; prune skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { removed: [], kept: 0 };
    }
    if (queue.length === 0) return { removed: [], kept: 0 };
    const archived = archivedSet();
    const kept = queue.filter((entry) => archived.has(entry.id));
    const removed = queue.filter((entry) => !archived.has(entry.id)).map((entry) => entry.id);
    if (removed.length === 0) return { removed: [], kept: kept.length };
    try {
      await writeQueue(kept);
    } catch (error) {
      warn(`[session-admin] could not prune the pending deletion queue: ${error instanceof Error ? error.message : String(error)}`);
      return { removed: [], kept: kept.length };
    }
    return { removed, kept: kept.length };
  });

  /** Coalesce prune requests so a burst of workspace writes costs one pass. */
  let pruneTimer = null;
  const schedulePrune = () => {
    if (pruneTimer !== null) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = null;
      prunePending().catch((error) => {
        warn(`[session-admin] pending deletion prune failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 100);
    // Do not keep a Host process (or a test runner) alive just for this pass.
    pruneTimer.unref?.();
  };

  /**
   * Archived-session inventory with exact on-disk footprint.
   * @returns {Promise<{ items: object[], totals: object, generatedAt: string }>}
   */
  const list = async () => {
    // A session unarchived elsewhere (native menu, another tab) cancels its
    // pending deletion even if the domain event has not arrived yet.
    schedulePrune();
    const ids = [...archivedSet()];
    const headers = await storedHeaders().catch(() => new Map());
    const ownership = ownershipIndex();
    const queue = await readQueue().catch(() => []);
    const pendingById = new Map(queue.map((entry) => [entry.id, entry]));
    const inventory = [];
    for (const id of ids) {
      const descendants = descendantsOf(id, headers);
      const measured = await measureGroup([id, ...descendants]);
      const workspace = ownership.get(id);
      const pendingEntry = pendingById.get(id);
      inventory.push({
        id,
        workspaceId: workspace === undefined ? undefined : String(workspace.id),
        workspaceTitle: workspace === undefined ? undefined : String(workspace.title),
        logBytes: measured.logBytes,
        cacheBytes: measured.cacheBytes,
        totalBytes: measured.logBytes + measured.cacheBytes,
        logFiles: measured.logFiles,
        hasLog: measured.hasLog,
        duplicate: measured.duplicate,
        live: liveSession(id) !== undefined,
        descendants,
        pending: pendingEntry === undefined ? undefined : pendingView(pendingEntry),
      });
    }
    const totals = {
      count: inventory.length,
      bytes: inventory.reduce((sum, item) => sum + item.totalBytes, 0),
      descendants: inventory.reduce((sum, item) => sum + item.descendants.length, 0),
      pending: inventory.filter((item) => item.pending !== undefined).length,
    };
    return {
      items: inventory,
      totals,
      defaults: { cleanupAttachments: cleanupAttachmentsDefault },
      generatedAt: new Date().toISOString(),
    };
  };

  /**
   * Dry-run plan for a deletion, used by the confirmation dialog.
   * @param {string[]} ids raw ids
   * @param {{ cleanupAttachments?: boolean }} [options]
   * @returns {Promise<object>}
   */
  const plan = async (ids, options = {}) => {
    const unique = validateIds(ids);
    const cleanupAttachments = options.cleanupAttachments ?? cleanupAttachmentsDefault;
    const archived = archivedSet();
    const headers = await storedHeaders().catch(() => new Map());
    const queue = await readQueue().catch(() => []);
    const pendingById = new Map(queue.map((entry) => [entry.id, entry]));
    const items = [];
    for (const id of unique) {
      if (!archived.has(id)) {
        items.push({ id, ok: false, code: 'not-archived', message: 'session is not archived' });
        continue;
      }
      const descendants = descendantsOf(id, headers);
      const liveDescendant = descendants.find((sessionId) => liveSession(sessionId) !== undefined);
      const measured = await measureGroup([id, ...descendants]);
      const pendingEntry = pendingById.get(id);
      const live = liveSession(id) !== undefined;
      items.push({
        id,
        ok: true,
        descendants,
        live,
        pending: pendingEntry === undefined ? undefined : pendingView(pendingEntry),
        willQueue: pendingEntry === undefined && (live || liveDescendant !== undefined),
        liveDescendant,
        logBytes: measured.logBytes,
        cacheBytes: measured.cacheBytes,
        totalBytes: measured.logBytes + measured.cacheBytes,
        logFiles: measured.logFiles,
        hasLog: measured.hasLog,
        duplicate: measured.duplicate,
      });
    }
    const okItems = items.filter((item) => item.ok);
    const immediate = okItems.filter((item) => item.pending === undefined && item.willQueue !== true);
    const queued = okItems.filter((item) => item.pending !== undefined || item.willQueue === true);
    const totals = {
      count: okItems.length,
      bytes: okItems.reduce((sum, item) => sum + item.totalBytes, 0),
      immediateBytes: immediate.reduce((sum, item) => sum + item.totalBytes, 0),
      queuedBytes: queued.reduce((sum, item) => sum + item.totalBytes, 0),
      descendants: okItems.reduce((sum, item) => sum + item.descendants.length, 0),
      immediate: immediate.length,
      queued: queued.length,
    };
    return { items, totals, cleanupAttachments, generatedAt: new Date().toISOString() };
  };

  /**
   * Permanently remove the given archived sessions.
   * @param {string[]} ids raw ids
   * @param {{ cleanupAttachments?: boolean }} [options]
   * @returns {Promise<object>}
   */
  const removeUnlocked = async (ids, options = {}) => {
    const unique = validateIds(ids);
    const cleanupAttachments = options.cleanupAttachments ?? cleanupAttachmentsDefault;
    const queueLive = options.queueLive !== false;
    const ignoreQueue = options.ignoreQueue === true;
    const archived = archivedSet();
    const headers = await storedHeaders().catch(() => new Map());
    const ownership = ownershipIndex();
    const schedules = await schedulesBySession().catch(() => new Map());
    let queue = [];
    let queueReadError = null;
    if (!ignoreQueue) {
      try {
        queue = await readQueue();
      } catch (error) {
        queueReadError = error;
        warn(`[session-admin] pending deletion queue is unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const queuedIds = new Set(queue.map((entry) => entry.id));
    const queueAdditions = [];
    const results = [];
    const deletedIds = new Set();
    const candidates = new Set();
    let attachmentScanAvailable = cleanupAttachments && typeof query()?.listEvents === 'function';

    for (const id of unique) {
      if (!archived.has(id)) {
        results.push({ id, deleted: false, code: 'not-archived', message: 'session is not archived', warnings: [] });
        continue;
      }
      if (!ignoreQueue && queuedIds.has(id)) {
        results.push({ id, deleted: false, queued: true, alreadyQueued: true, freedBytes: 0, warnings: [] });
        continue;
      }
      if (liveSession(id) !== undefined) {
        if (queueLive) {
          queuedIds.add(id);
          queueAdditions.push(id);
          results.push({ id, deleted: false, queued: true, freedBytes: 0, warnings: [] });
          continue;
        }
        results.push({ id, deleted: false, code: 'live-session', message: 'session is live in memory; it cannot be deleted now', warnings: [] });
        continue;
      }
      const descendants = descendantsOf(id, headers);
      const group = [id, ...descendants];
      const liveDescendant = group.find((sessionId) => liveSession(sessionId) !== undefined);
      if (liveDescendant !== undefined) {
        if (queueLive) {
          queuedIds.add(id);
          queueAdditions.push(id);
          results.push({ id, deleted: false, queued: true, freedBytes: 0, warnings: [] });
          continue;
        }
        results.push({ id, deleted: false, code: 'live-descendant', message: `descendant ${liveDescendant} is live`, warnings: [] });
        continue;
      }

      let groupCandidates = null;
      if (attachmentScanAvailable) {
        const referenced = await collectTargetReferences(group);
        if (referenced.complete) groupCandidates = referenced.ids;
        else attachmentScanAvailable = false;
      }

      const warnings = [];
      let freedBytes = 0;
      let failed = false;

      // Stop running descendants before touching their logs.
      const quiesced = [];
      for (const sessionId of descendants) {
        try {
          await requireRegistry().archiveSession(sessionId, { stopActivity: true });
          quiesced.push(sessionId);
        } catch (error) {
          warnings.push(`could not stop descendant ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const { found, duplicates } = await findSessionDirs(roots.sessions, group);
      for (const sessionId of group) {
        if (duplicates.has(sessionId)) {
          failed = true;
          warnings.push(`duplicate log directory for ${sessionId}; not deleting`);
          continue;
        }
        const directory = found.get(sessionId);
        if (directory === undefined) continue;
        if (!isInside(roots.sessions, directory)) {
          failed = true;
          warnings.push(`refused a log directory outside the sessions root for ${sessionId}`);
          continue;
        }
        try {
          const measured = await measureTree(directory);
          await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          freedBytes += measured.bytes;
        } catch (error) {
          failed = true;
          warnings.push(`log directory delete failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (failed) {
        // Restore the archive state we changed for descendants; keep the parent archived.
        for (const sessionId of quiesced) {
          try {
            await requireRegistry().unarchiveSession(sessionId);
          } catch {
            /* best effort */
          }
        }
        results.push({ id, deleted: false, code: 'log-delete-failed', message: 'could not delete the session log directory', warnings });
        continue;
      }

      // Schedules bound to the group would keep delivering into deleted sessions.
      let schedulesDeleted = 0;
      for (const sessionId of group) {
        for (const task of schedules.get(sessionId) ?? []) {
          try {
            await schedule().delete({ sessionId, id: task.id });
            schedulesDeleted += 1;
          } catch (error) {
            warnings.push(`schedule ${String(task.id)} delete failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      for (const sessionId of group) {
        try {
          freedBytes += await removeProjectionCache(sessionId);
        } catch (error) {
          warnings.push(`projection cache delete failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      for (const sessionId of group) {
        try {
          ownership.get(sessionId)?.detachSession?.(sessionId);
        } catch {
          /* internal helper; the slot prunes on the next registry write or restart */
        }
        try {
          await requireRegistry().unpinSession(sessionId);
        } catch {
          /* pinning and archival are exclusive; this is a consistency net */
        }
        try {
          await requireRegistry().unarchiveSession(sessionId);
        } catch (error) {
          warnings.push(`archive record cleanup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        deletedIds.add(sessionId);
      }

      if (groupCandidates !== null) {
        for (const candidate of groupCandidates) candidates.add(candidate);
      }
      results.push({ id, deleted: true, freedBytes, descendants: descendants.length, schedulesDeleted, warnings });
    }

    // Persist queued intents after the whole batch so a queue write failure is
    // reported instead of silently losing the deletion request.
    let queueWriteError = null;
    if (queueAdditions.length > 0) {
      if (queueReadError !== null) {
        queueWriteError = queueReadError;
      } else {
        const known = new Set(queue.map((entry) => entry.id));
        for (const id of queueAdditions) {
          if (!known.has(id)) queue.push(createPendingEntry(id, cleanupAttachments));
        }
        if (queue.length > PENDING_MAX) {
          queueWriteError = new Error(`pending deletion queue exceeds ${PENDING_MAX} entries`);
        } else {
          try {
            await writeQueue(queue);
          } catch (error) {
            queueWriteError = error;
          }
        }
      }
    }
    if (queueWriteError !== null) {
      const message = `could not persist the pending deletion: ${queueWriteError instanceof Error ? queueWriteError.message : String(queueWriteError)}`;
      for (const result of results) {
        if (result.queued === true && result.alreadyQueued !== true) {
          result.queued = false;
          result.deleted = false;
          result.code = 'queue-failed';
          result.message = message;
        }
      }
    }

    let attachment = { freedBytes: 0, deleted: 0, skipped: 'disabled' };
    if (cleanupAttachments) {
      if (!attachmentScanAvailable) {
        attachment = { freedBytes: 0, deleted: 0, skipped: 'reference-scan-unavailable' };
      } else if (candidates.size === 0) {
        attachment = { freedBytes: 0, deleted: 0, skipped: 'no-candidates' };
      } else {
        const headersAfter = await storedHeaders().catch(() => null);
        if (headersAfter === null) {
          attachment = { freedBytes: 0, deleted: 0, skipped: 'listing-failed' };
        } else {
          const remaining = [...headersAfter.keys()].filter((sessionId) => !deletedIds.has(sessionId));
          const scan = await scanAttachmentReferences({
            sessionIds: remaining,
            readEvents: (sessionId) => query().listEvents(sessionId),
            uploadIndexPath: roots.uploadIndex,
            budget: REFERENCE_BUDGET,
          });
          if (!scan.complete) {
            attachment = { freedBytes: 0, deleted: 0, skipped: scan.reason ?? 'reference-scan-incomplete' };
          } else {
            const pruned = await pruneUnreferencedAttachments({
              attachmentsRoot: roots.attachments,
              candidates,
              referenced: scan.referenced,
            });
            attachment = {
              freedBytes: pruned.freedBytes,
              deleted: pruned.deleted.length,
              failed: pruned.failed,
              skipped: undefined,
            };
          }
        }
      }
    }

    const freedBytes = results.reduce((sum, item) => sum + (item.deleted ? item.freedBytes : 0), 0) + attachment.freedBytes;
    return {
      results,
      attachment,
      totals: {
        requested: unique.length,
        deleted: results.filter((item) => item.deleted).length,
        queued: results.filter((item) => item.queued === true).length,
        failed: results.filter((item) => item.deleted !== true && item.queued !== true).length,
        freedBytes,
      },
      generatedAt: new Date().toISOString(),
    };
  };

  /**
   * Public deletion entry: sessions that are live in memory are queued for the
   * next Host start instead of failing.
   */
  const remove = (ids, options = {}) => serialize(() => removeUnlocked(ids, options));

  /**
   * Drop queued deletions. Nothing was written to disk yet, so cancelling is
   * immediate and cannot lose data.
   * @param {string[]} ids raw ids
   * @returns {Promise<object>} per-id cancel results
   */
  const cancelPending = (ids) => serialize(async () => {
    const unique = validateIds(ids);
    let queue;
    try {
      queue = await readQueue();
    } catch (error) {
      throw new ArchiveRequestError('queue-unavailable', `pending deletion queue is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const wanted = new Set(unique);
    const removed = new Set();
    const kept = [];
    for (const entry of queue) {
      if (wanted.has(entry.id)) removed.add(entry.id);
      else kept.push(entry);
    }
    if (removed.size > 0) {
      try {
        await writeQueue(kept);
      } catch (error) {
        throw new ArchiveRequestError('queue-write-failed', `could not persist the pending queue: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      results: unique.map((id) => ({ id, cancelled: removed.has(id) })),
      totals: { requested: unique.length, cancelled: removed.size },
      generatedAt: new Date().toISOString(),
    };
  });

  /**
   * Execute the pending queue at Host start, where no conversation is live.
   *
   * Every entry is re-checked: an unarchived session drops its intent, a live
   * session stays queued for the next start, and a failed deletion is kept with
   * its reason so the page can show it.
   * @returns {Promise<object>} sweep summary
   */
  const sweepPending = () => serialize(async () => {
    let queue;
    try {
      queue = await readQueue();
    } catch (error) {
      warn(`[session-admin] pending deletion queue is unreadable; sweep skipped: ${error instanceof Error ? error.message : String(error)}`);
      return {
        results: [],
        totals: { queued: 0, deleted: 0, kept: 0, dropped: 0, freedBytes: 0 },
        error: error instanceof Error ? error.message : String(error),
        generatedAt: new Date().toISOString(),
      };
    }
    if (queue.length === 0) {
      return { results: [], totals: { queued: 0, deleted: 0, kept: 0, dropped: 0, freedBytes: 0 }, generatedAt: new Date().toISOString() };
    }
    const archived = archivedSet();
    const headers = await storedHeaders().catch(() => new Map());
    const keep = [];
    const dropped = [];
    const batches = new Map();
    for (const entry of queue) {
      if (!archived.has(entry.id)) {
        dropped.push({ id: entry.id, reason: 'not-archived' });
        continue;
      }
      const descendants = descendantsOf(entry.id, headers);
      const live = [entry.id, ...descendants].some((sessionId) => liveSession(sessionId) !== undefined);
      if (live) {
        keep.push({
          ...entry,
          attempts: entry.attempts + 1,
          lastError: 'session-live',
          lastAttemptAt: new Date().toISOString(),
        });
        continue;
      }
      const key = entry.cleanupAttachments === false ? 'false' : 'true';
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(entry);
    }
    const deleted = [];
    const failed = [];
    for (const [flag, entries] of batches) {
      let outcome;
      try {
        outcome = await removeUnlocked(entries.map((entry) => entry.id), {
          cleanupAttachments: flag === 'true',
          queueLive: false,
          ignoreQueue: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of entries) {
          keep.push({ ...entry, attempts: entry.attempts + 1, lastError: message, lastAttemptAt: new Date().toISOString() });
          failed.push({ id: entry.id, code: 'delete-failed' });
        }
        continue;
      }
      for (const entry of entries) {
        const result = outcome.results.find((item) => item.id === entry.id);
        if (result?.deleted === true) {
          deleted.push({ id: entry.id, freedBytes: result.freedBytes });
          continue;
        }
        if (result?.code === 'not-archived') {
          dropped.push({ id: entry.id, reason: 'not-archived' });
          continue;
        }
        keep.push({
          ...entry,
          attempts: entry.attempts + 1,
          lastError: result?.code ?? 'delete-failed',
          lastAttemptAt: new Date().toISOString(),
        });
        failed.push({ id: entry.id, code: result?.code ?? 'delete-failed' });
      }
    }
    try {
      await writeQueue(keep);
    } catch (error) {
      warn(`[session-admin] could not rewrite the pending deletion queue: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      results: { deleted, failed, dropped, kept: keep.map((entry) => entry.id) },
      totals: {
        queued: queue.length,
        deleted: deleted.length,
        kept: keep.length,
        dropped: dropped.length,
        freedBytes: deleted.reduce((sum, item) => sum + (item.freedBytes ?? 0), 0),
      },
      generatedAt: new Date().toISOString(),
    };
  });

  /**
   * Unarchive sessions without opening them.
   * @param {string[]} ids raw ids
   * @returns {Promise<object>}
   */
  const unarchive = (ids) => serialize(async () => {
    const unique = validateIds(ids);
    const registryValue = requireRegistry();
    const archived = archivedSet();
    const results = [];
    for (const id of unique) {
      if (!archived.has(id)) {
        results.push({ id, unarchived: false, code: 'not-archived', message: 'session is not archived' });
        continue;
      }
      try {
        await registryValue.unarchiveSession(id);
        results.push({ id, unarchived: true });
      } catch (error) {
        results.push({ id, unarchived: false, code: 'unarchive-failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
    // Unarchiving cancels any queued deletion for the same session.
    const unarchivedIds = new Set(results.filter((item) => item.unarchived).map((item) => item.id));
    if (unarchivedIds.size > 0) {
      try {
        const queue = await readQueue();
        const kept = queue.filter((entry) => !unarchivedIds.has(entry.id));
        if (kept.length !== queue.length) await writeQueue(kept);
      } catch (error) {
        warn(`[session-admin] could not clear pending deletions after unarchive: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      results,
      totals: { requested: unique.length, unarchived: results.filter((item) => item.unarchived).length },
      generatedAt: new Date().toISOString(),
    };
  });

  return { list, plan, remove, unarchive, cancelPending, sweepPending, prunePending, schedulePrune, roots };
}
