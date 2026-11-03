/**
 * Filesystem conventions shared by the Session Archive plugin.
 *
 * Everything here is plain Node: the package must stay loadable from a profile
 * bundle without depending on any shipped DSH package. The layouts mirror the
 * shipped backends (verified against dsh 0.2.1-rc.5):
 *
 *   sessions/<projectKey>/<encodeSegment(sessionId)>/session.v<N>.jsonl.zstd
 *   storages/<domain>/<table>/<sessionId>.json
 *   attachments/v1/{objects,file-objects,files}/...
 *
 * @module dsh-session-admin/lib/paths
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';

/** Session ids observed from the registry/backends: UUIDs and `session-<uuid>`. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_UNIT = /^[A-Za-z0-9._-]$/;

/**
 * Whether a string is safe to use as one session id in a request.
 * @param {unknown} value candidate id
 * @returns {value is string} true for a bounded path-safe id
 */
export function isValidSessionId(value) {
  return typeof value === 'string'
    && ID_PATTERN.test(value)
    && value !== '.'
    && value !== '..';
}

/**
 * Encode one session id as the storage backend's directory segment.
 *
 * Safe ASCII units stay literal; every other UTF-16 code unit becomes `~XXXX`
 * (uppercase hex). `.` and `..` are encoded entirely so they can never name a
 * parent directory.
 * @param {string} id session id
 * @returns {string} encoded directory segment
 */
export function encodeSegment(id) {
  if (id === '.' || id === '..') return id.replaceAll('.', '~002E');
  let out = '';
  for (let index = 0; index < id.length; index += 1) {
    const unit = id[index];
    if (SAFE_UNIT.test(unit)) out += unit;
    else out += `~${id.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Decode one storage directory segment back to the session id.
 * @param {string} segment directory name
 * @returns {string} decoded id (unchanged when it carries no escapes)
 */
export function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Resolve the DSH home and the roots this plugin reads.
 *
 * `DSH_HOME` wins when set (the desktop app and `dsh` set it); otherwise the
 * default home is `~/.dsh`. Every root can be overridden through this plugin's
 * row config for a non-standard deployment.
 * @param {{ dshHome?: string, sessionsRoot?: string, storagesRoot?: string, attachmentsRoot?: string }} [config]
 * @returns {{ home: string, sessions: string, storages: string, attachments: string, uploadIndex: string }}
 */
export function resolveRoots(config = {}) {
  const home = path.resolve(
    typeof config.dshHome === 'string' && config.dshHome !== ''
      ? config.dshHome
      : process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  );
  return {
    home,
    sessions: path.resolve(config.sessionsRoot || path.join(home, 'sessions')),
    storages: path.resolve(config.storagesRoot || path.join(home, 'storages')),
    attachments: path.resolve(config.attachmentsRoot || path.join(home, 'attachments', 'v1')),
    uploadIndex: path.join(home, 'llm-deepseek', 'files-v3.json'),
  };
}

/**
 * Whether `target` resolves strictly inside `root`.
 * @param {string} root absolute root
 * @param {string} target absolute candidate
 * @returns {boolean} containment
 */
export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Sum the regular files below one directory without following symlinks.
 * @param {string} directory absolute directory
 * @returns {Promise<{ bytes: number, files: number }>} accumulated footprint
 */
export async function measureTree(directory) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { bytes: 0, files: 0 };
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureTree(absolute);
      bytes += nested.bytes;
      files += nested.files;
      continue;
    }
    if (!entry.isFile()) continue; // symlinks and specials are never followed
    try {
      const info = await lstat(absolute);
      bytes += info.size;
      files += 1;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return { bytes, files };
}

/**
 * Locate the per-session log directory for each requested id.
 *
 * The directory name depends on the encoded id and the project directory is
 * derived from the session header, so the only reliable lookup is enumerating
 * every project directory. A directory-name collision is reported instead of
 * guessed: two candidates mean we do not know which one the backend owns.
 * @param {string} sessionsRoot absolute sessions root
 * @param {Iterable<string>} ids session ids
 * @returns {Promise<{ found: Map<string, string>, duplicates: Set<string> }>} located directories
 */
export async function findSessionDirs(sessionsRoot, ids) {
  const wanted = new Map();
  for (const id of ids) wanted.set(encodeSegment(id), id);
  const found = new Map();
  const duplicates = new Set();
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { found, duplicates };
    throw error;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(sessionsRoot, project.name);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue; // an unreadable project directory cannot own a writable session
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const direct = wanted.get(entry.name);
      const decoded = direct === undefined ? wanted.get(decodeSegment(entry.name)) : direct;
      if (decoded === undefined) continue;
      if (found.has(decoded)) {
        duplicates.add(decoded);
        continue;
      }
      found.set(decoded, path.join(projectPath, entry.name));
    }
  }
  return { found, duplicates };
}

/**
 * Projection-cache file for one session under the JSON storage root.
 * @param {string} storagesRoot absolute storage root
 * @param {string} id session id
 * @returns {string} absolute record path
 */
export function projectionCachePath(storagesRoot, id) {
  return path.join(storagesRoot, 'session_projcache', 'sessions', `${id}.json`);
}

/**
 * Directory holding every projection-cache record.
 * @param {string} storagesRoot absolute storage root
 * @returns {string} absolute directory
 */
export function projectionCacheDir(storagesRoot) {
  return path.join(storagesRoot, 'session_projcache', 'sessions');
}
