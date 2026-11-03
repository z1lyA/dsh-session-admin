/**
 * HTTP plumbing for the Session Archive browser surface.
 *
 * The page is served by the same loopback web server, so the route only needs
 * to defend against DNS rebinding, cross-site form posts, and unauthenticated
 * clients. The Connection service owns browser authentication; when it is
 * mounted its rejection is authoritative and ours is a backstop.
 *
 * @module dsh-session-admin/lib/http
 */
import { MAX_BATCH, ArchiveRequestError, validateIds } from './archive.js';

const BODY_LIMIT = 65536;

/**
 * Whether a Host authority is the local machine.
 * @param {string} hostname URL hostname
 * @returns {boolean} loopback
 */
function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (value === '') return false;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (value === '::1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (octets === null) return false;
  if (Number(octets[1]) !== 127) return false;
  return [octets[2], octets[3], octets[4]].every((part) => Number(part) <= 255);
}

/**
 * Build the route guard. Returns a status code to reject, or undefined to pass.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @returns {(req: import('node:http').IncomingMessage) => 401 | 403 | undefined}
 */
export function createTrustFence(ctx) {
  const connection = () => {
    try {
      return ctx.get('connection');
    } catch {
      return undefined;
    }
  };
  return (req) => {
    try {
      const headers = req.headers ?? {};
      let authority;
      try {
        authority = new URL(`http://${String(headers.host ?? '')}`);
      } catch {
        return 403;
      }
      if (!isLoopbackHostname(authority.hostname)) return 403;
      const site = String(headers['sec-fetch-site'] ?? '').toLowerCase();
      if (site === 'cross-site') return 403;
      const origin = headers.origin;
      if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
        let parsed;
        try {
          parsed = new URL(origin);
        } catch {
          return 403;
        }
        if (parsed.host.toLowerCase() !== authority.host.toLowerCase()) return 403;
      }
      const conn = connection();
      if (conn !== undefined && typeof conn.requestRejection === 'function') {
        let code;
        try {
          code = conn.requestRejection(req);
        } catch {
          return 403;
        }
        if (code === 401 || code === 403) return code;
        if (code !== undefined && code !== null && code !== false) return typeof code === 'number' ? code : 403;
      }
      return undefined;
    } catch {
      return 403;
    }
  };
}

/**
 * Read and decode a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req request
 * @returns {Promise<unknown>} decoded body
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new ArchiveRequestError('body-too-large', 'request body exceeds 64 KiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new ArchiveRequestError('invalid-json', 'request body is not valid JSON'));
      }
    });
    req.on('error', (error) => fail(error));
  });
}

/**
 * Validate the delete endpoint's body.
 * @param {unknown} body decoded body
 * @returns {{ ids: string[], dryRun: boolean, cleanupAttachments: boolean }} normalized request
 */
export function parseDeleteBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ArchiveRequestError('invalid-request', 'body must be a JSON object');
  }
  const ids = validateIds(body.ids);
  const dryRun = body.dryRun === true;
  const cleanupAttachments = body.cleanupAttachments !== false;
  if (ids.length > MAX_BATCH) throw new ArchiveRequestError('too-many', `at most ${MAX_BATCH} sessions per request`);
  return { ids, dryRun, cleanupAttachments };
}

/**
 * Send one JSON response with the headers this surface always needs.
 * @param {import('node:http').ServerResponse} res response
 * @param {number} status status code
 * @param {unknown} payload JSON-serializable body
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  try {
    const text = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(text);
  } catch {
    try {
      res.statusCode = 500;
      res.end('{"ok":false,"error":"response failed"}');
    } catch {
      /* the socket is already gone */
    }
  }
}

/**
 * Map one thrown value to an HTTP status and JSON payload.
 * @param {unknown} error thrown value
 * @returns {{ status: number, payload: { ok: false, error: string, code: string } }} response
 */
export function failure(error) {
  const code = error instanceof ArchiveRequestError ? error.code : 'internal';
  const message = error instanceof Error ? error.message : String(error);
  const status = code === 'invalid-request' || code === 'invalid-id' || code === 'invalid-json' ? 400
    : code === 'too-many' || code === 'body-too-large' ? 413
      : code === 'registry-unavailable' || code === 'persistence-unavailable' ? 503
        : 500;
  return { status, payload: { ok: false, error: message, code } };
}
