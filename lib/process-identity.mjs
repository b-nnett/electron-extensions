import { execFile } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const MAX_PIDS = 8192;
const MAX_PID = 2147483647;

// Packaged helpers resolve only the adjacent sealed runtime. The raw CLI layout
// points at the same built artifact; it never falls back to Python or PATH.
const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function nativeProcessIdentityHelperPath(root = runtimeRoot) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error('Invalid process identity runtime root.');
  if (root.endsWith('/Contents/Resources/Runtime')) return path.join(root, 'native/ProcessIdentity');
  if (root.split(path.sep).some(part => part.toLowerCase().endsWith('.app'))) throw new Error('The app has no supported packaged process identity layout.');
  return path.join(root, 'dist/Extensions Anywhere.app/Contents/Resources/Runtime/native/ProcessIdentity');
}

export class ProcessIdentityError extends Error {
  constructor(message, { code = 'PROCESS_LOOKUP_FAILED', pid, errno, cause } = {}) {
    super(message, { cause });
    this.name = 'ProcessIdentityError';
    this.code = code;
    if (pid !== undefined) this.pid = pid;
    if (errno !== undefined) this.errno = errno;
  }
}

function validPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) throw new TypeError('PID must be a positive signed 32-bit integer.');
}

function validExecutable(executable) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\0\r\n]/.test(executable)) throw new TypeError('Executable must be an absolute path without control characters.');
  return path.normalize(executable);
}

async function nativeBatch(pids) {
  if (process.platform !== 'darwin') throw new ProcessIdentityError('Process identity requires macOS.', { code: 'UNSUPPORTED_PLATFORM' });
  try {
    const helper = nativeProcessIdentityHelperPath();
    const metadata = await lstat(helper);
    if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(helper) !== helper) throw new Error('The packaged process identity reader must be a canonical regular file.');
    await access(helper, constants.X_OK);
    const { stdout } = await run(helper, [JSON.stringify(pids)], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ProcessIdentityError('Native process identity reader failed.', { code: 'NATIVE_READER_FAILED', cause });
  }
}

async function currentUserPids(uid) {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,uid='], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return parseCurrentUserPids(stdout, uid);
}

export function parseCurrentUserPids(stdout, uid) {
  const pids = [];
  for (const line of stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(line);
    if (!match) throw new ProcessIdentityError('Unexpected PID inventory output.', { code: 'INVALID_INVENTORY' });
    if (Number(match[2]) === uid) pids.push(Number(match[1]));
  }
  return pids;
}

// Dependency injection is for synthetic tests; production exports below use
// the fixed OS reader. Inventory is explicitly scoped to the current user.
export function createProcessIdentityReader({ readBatch = nativeBatch, listPids = currentUserPids, canonicalize = realpath, uid = process.getuid?.() } = {}) {
  async function decode(record, pid) {
    if (!record || record.pid !== pid) throw new ProcessIdentityError('Invalid native identity response.', { code: 'INVALID_RESPONSE', pid });
    if (record.status === 'absent' && record.errno === 3 && record.confirmedBy === 'kill-0') return null;
    if (record.status === 'error') throw new ProcessIdentityError(record.message || 'Process lookup failed.', { pid, code: record.code, errno: record.errno });
    if (record.status !== 'ok' || !/^[1-9]\d*\.\d{6}$/.test(record.started) ||
        !Number.isInteger(record.uid) || record.uid < 0 || !Number.isInteger(record.ppid) || record.ppid < 0) {
      throw new ProcessIdentityError('Incomplete native process identity.', { code: 'INVALID_RESPONSE', pid });
    }
    let executable;
    try { executable = validExecutable(await canonicalize(validExecutable(record.executable))); }
    catch (cause) { throw new ProcessIdentityError('Cannot canonicalize kernel executable path.', { code: 'EXECUTABLE_PATH_UNRESOLVED', pid, cause }); }
    return { pid, executable, started: record.started, uid: record.uid, ppid: record.ppid };
  }

  async function batch(pids) {
    if (!Array.isArray(pids) || !pids.length || pids.length > MAX_PIDS || new Set(pids).size !== pids.length) throw new ProcessIdentityError('Invalid or oversized PID inventory.', { code: 'INVALID_INVENTORY' });
    pids.forEach(validPid);
    const records = await readBatch(pids);
    if (!Array.isArray(records) || records.length !== pids.length) throw new ProcessIdentityError('Incomplete native batch response.', { code: 'INVALID_RESPONSE' });
    return records;
  }

  async function getProcessIdentity(pid) {
    validPid(pid);
    return decode((await batch([pid]))[0], pid);
  }

  async function findProcessesByExecutable(expected) {
    const executable = validExecutable(await canonicalize(validExecutable(expected)));
    if (!Number.isInteger(uid) || uid < 0) throw new ProcessIdentityError('Current user is unavailable.', { code: 'INVALID_UID' });
    const pids = await listPids(uid);
    const records = await batch(pids);
    const matches = [], unresolved = [];
    for (let i = 0; i < pids.length; i++) {
      try {
        const identity = await decode(records[i], pids[i]);
        if (identity && identity.uid !== uid) throw new ProcessIdentityError('Process user changed during inventory.', { code: 'PROCESS_CHANGED', pid: pids[i] });
        if (identity?.executable === executable) matches.push(identity);
      } catch (error) {
        unresolved.push({ pid: pids[i], code: error.code || 'PROCESS_LOOKUP_FAILED', message: error.message, ...(error.errno === undefined ? {} : { errno: error.errno }) });
      }
    }
    // An empty matches list establishes absence only when unresolved is empty.
    return { executable, uid, scope: 'current-user', matches, unresolved };
  }

  return { getProcessIdentity, findProcessesByExecutable };
}

// Compare snapshots before acting on an owned process. This does not make a
// later signal atomic with inspection; callers must keep that interval short.
export function sameProcessIdentity(a, b) {
  return Boolean(a && b && Number.isInteger(a.pid) && a.pid > 0 &&
    typeof a.started === 'string' && /^[1-9]\d*\.\d{6}$/.test(a.started) &&
    typeof a.executable === 'string' && path.isAbsolute(a.executable) &&
    a.pid === b.pid && a.started === b.started && a.executable === b.executable && a.uid === b.uid);
}

const reader = createProcessIdentityReader();
export const getProcessIdentity = reader.getProcessIdentity;
export const findProcessesByExecutable = reader.findProcessesByExecutable;
