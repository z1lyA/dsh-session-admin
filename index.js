/**
 * Session Archive — Host half.
 *
 * Registers the browser-facing JSON endpoints used by the archived-session
 * management page. Permanent deletion stays user-confirmed in the page; there
 * is no agent tool because DSH composes agent tools per agent preset, and this
 * bundle's row belongs to the web app layer rather than an agent preset.
 *
 * @module dsh-session-admin
 */
import { ArchiveRequestError, createArchiveAdmin } from './lib/archive.js';
import { createTrustFence, failure, parseDeleteBody, readJsonBody, sendJson } from './lib/http.js';

const API_PREFIX = '/dsh-session-admin/api';
const LIST_PATH = `${API_PREFIX}/archived`;
const DELETE_PATH = `${API_PREFIX}/delete`;
const CANCEL_PENDING_PATH = `${API_PREFIX}/pending/cancel`;

/**
 * Host plugin body.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {object} [config] row config (root overrides and defaults)
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const admin = createArchiveAdmin(ctx, config);
  const fence = createTrustFence(ctx);

  ctx.inject(['webServer'], (web) => {
    const respond = async (req, res, run) => {
      const rejection = fence(req);
      if (rejection !== undefined) {
        sendJson(res, rejection, { ok: false, error: 'request rejected by the local trust fence', code: 'forbidden' });
        return;
      }
      try {
        const payload = await run();
        sendJson(res, 200, { ok: true, ...payload });
      } catch (error) {
        const mapped = failure(error);
        sendJson(res, mapped.status, mapped.payload);
      }
    };

    const listHandler = (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'GET required', code: 'method-not-allowed' });
        return;
      }
      return respond(req, res, () => admin.list());
    };

    const deleteHandler = async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required', code: 'method-not-allowed' });
        return;
      }
      if (String(req.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim() !== 'application/json') {
        sendJson(res, 415, { ok: false, error: 'application/json required', code: 'unsupported-media-type' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const mapped = failure(error);
        sendJson(res, mapped.status, mapped.payload);
        return;
      }
      return respond(req, res, async () => {
        const request = parseDeleteBody(body);
        if (request.dryRun) return admin.plan(request.ids, { cleanupAttachments: request.cleanupAttachments });
        return admin.remove(request.ids, { cleanupAttachments: request.cleanupAttachments });
      });
    };

    const cancelHandler = async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST required', code: 'method-not-allowed' });
        return;
      }
      if (String(req.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim() !== 'application/json') {
        sendJson(res, 415, { ok: false, error: 'application/json required', code: 'unsupported-media-type' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const mapped = failure(error);
        sendJson(res, mapped.status, mapped.payload);
        return;
      }
      return respond(req, res, () => {
        if (body === null || typeof body !== 'object' || !Array.isArray(body.ids)) {
          throw new ArchiveRequestError('invalid-request', 'ids must be an array');
        }
        return admin.cancelPending(body.ids);
      });
    };

    web.effect(() => {
      const disposeList = web.webServer.register({ kind: 'exact', path: LIST_PATH, handler: listHandler });
      const disposeDelete = web.webServer.register({ kind: 'exact', path: DELETE_PATH, handler: deleteHandler });
      const disposeCancel = web.webServer.register({ kind: 'exact', path: CANCEL_PENDING_PATH, handler: cancelHandler });
      return () => {
        try {
          disposeList();
        } catch {
          /* already disposed */
        }
        try {
          disposeDelete();
        } catch {
          /* already disposed */
        }
        try {
          disposeCancel();
        } catch {
          /* already disposed */
        }
      };
    }, 'session-admin: http routes');
  });

  // A queued deletion is safe only when no conversation is live. The plugin
  // activates at Host start, before the browser opens any session, so execute
  // the queue here and off the boot path.
  ctx.inject(['workspaceRegistry', 'sessionPersistence'], (ready) => {
    ready.effect(() => {
      let disposed = false;
      const timer = setTimeout(() => {
        if (disposed) return;
        admin.sweepPending().then((summary) => {
          try {
            if ((summary?.totals?.queued ?? 0) > 0) {
              ctx.logger?.info?.(
                `[session-admin] pending deletions: queued=${summary.totals.queued} deleted=${summary.totals.deleted} `
                + `kept=${summary.totals.kept} dropped=${summary.totals.dropped} freed=${summary.totals.freedBytes}`,
              );
            }
          } catch {
            /* logging must never fail the sweep */
          }
        }).catch((error) => {
          try {
            ctx.logger?.warn?.(`[session-admin] pending deletion sweep failed: ${error instanceof Error ? error.message : String(error)}`);
          } catch {
            /* logging must never fail the sweep */
          }
        });
      }, 500);
      return () => {
        disposed = true;
        clearTimeout(timer);
      };
    }, 'session-admin: pending sweep');
  });

  // Unarchiving a session cancels its pending deletion immediately, including
  // when the unarchive happens in the native menu or another tab. The workspace
  // archive set lives in the domain's global singleton (table/key '').
  ctx.inject(['workspaceRegistry'], (ready) => {
    ready.effect(() => {
      const off = ready.on('domain/changed', (change) => {
        if (change === null || typeof change !== 'object') return;
        if (change.domain !== 'workspace') return;
        if (change.table !== '') return;
        admin.schedulePrune();
      });
      return () => {
        try {
          off();
        } catch {
          /* already disposed */
        }
      };
    }, 'session-admin: prune pending on workspace change');
  });
}
