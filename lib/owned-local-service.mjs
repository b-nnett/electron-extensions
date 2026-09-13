import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getProcessIdentity, sameProcessIdentity } from './process-identity.mjs';

const exec = promisify(execFile);
export const ANTIGRAVITY_SERVICE_PATH = 'Contents/Resources/bin/language_server';
export const ANTIGRAVITY_URL_PATTERN = '^https://127\\.0\\.0\\.1:[1-9][0-9]{3,4}/$';
export const ANTIGRAVITY_CONTROL = 'button[aria-label="Toggle Sidebar"][data-testid="sidebar-toggle"]';

// This is one reviewed app contract, not a configurable localhost attachment
// mechanism. The installed main process spawns this packaged service directly.
export function hasFixedLocalServiceProfile(profile) {
  const service = profile?.ownedLocalService;
  return profile?.slug === 'antigravity' && profile.bundleIdentifier === 'com.google.antigravity' &&
    profile.bundlePath === '/Applications/Antigravity.app' &&
    profile.executable === '/Applications/Antigravity.app/Contents/MacOS/Antigravity' &&
    profile.transport === 'pipe' && Array.isArray(profile.arguments) &&
    profile.arguments.every(argument => argument === '--remote-debugging-pipe') &&
    service !== null && typeof service === 'object' && !Array.isArray(service) &&
    Object.keys(service).length === 1 && service.executableRelativePath === ANTIGRAVITY_SERVICE_PATH &&
    profile.target?.urlPattern === ANTIGRAVITY_URL_PATTERN && profile.target.selector === ANTIGRAVITY_CONTROL;
}

export function localServicePageURL(value, profile) {
  if (!hasFixedLocalServiceProfile(profile) || typeof value !== 'string' ||
      !/^https:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/$/.test(value)) return null;
  try {
    const url = new URL(value), port = Number(url.port);
    return url.href === value && port >= 1024 && port <= 65535 ? url : null;
  } catch { return null; }
}

export function soleIPv4LoopbackListener(stdout, port) {
  if (typeof stdout !== 'string' || stdout.length > 65536 || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  // macOS lsof also selects the numeric file-descriptor field with -Fpn.
  // Accept that one field in its documented position, or the two-field form.
  // Keep exactly one process and one socket; never discard unknown records.
  const match = /^p([1-9][0-9]*)\n(?:f(0|[1-9][0-9]*)\n)?n127\.0\.0\.1:([1-9][0-9]*)\n?$/.exec(stdout);
  if (!match || Number(match[3]) !== port || Number(match[1]) > 2147483647 ||
      (match[2] !== undefined && Number(match[2]) > 2147483647)) return null;
  return Number(match[1]);
}

async function readListeners(port) {
  const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'],
    { timeout: 3000, maxBuffer: 65536 });
  return stdout;
}

const startedMicros = value => {
  if (!/^[1-9][0-9]*\.[0-9]{6}$/.test(value ?? '')) throw new Error('The local service process start time is unavailable.');
  const [seconds, micros] = value.split('.');
  return BigInt(seconds) * 1000000n + BigInt(micros);
};
const fileIdentity = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(item => {
  if (typeof item !== 'bigint') throw new Error('The packaged local service file identity is unavailable.');
  return item.toString();
}).join(':');

export class OwnedCatalogLocalService {
  constructor(profile, mainIdentity, {
    readIdentity = getProcessIdentity, listeners = readListeners,
    canonicalize = realpath, inspectFile = file => stat(file, { bigint: true })
  } = {}) {
    if (!hasFixedLocalServiceProfile(profile) || !sameProcessIdentity(mainIdentity, mainIdentity) ||
        mainIdentity.executable !== profile.executable || !Number.isInteger(mainIdentity.uid) || mainIdentity.uid < 0) {
      throw new Error('The fixed local service app identity is unavailable.');
    }
    this.profile = profile; this.main = { ...mainIdentity };
    this.executable = path.join(profile.bundlePath, profile.ownedLocalService.executableRelativePath);
    this.readIdentity = readIdentity; this.listeners = listeners; this.canonicalize = canonicalize; this.inspectFile = inspectFile;
    this.binding = null; this.failed = false;
  }
  get origin() { return this.binding?.origin ?? null; }
  get evidence() { return this.binding ? structuredClone(this.binding) : null; }
  async bind(value) {
    if (this.binding) throw new Error('A local service session cannot be rebound. Start a new session.');
    const url = localServicePageURL(value, this.profile);
    if (!url) { this.failed = true; throw new Error('The renderer is outside the fixed local service route.'); }
    const current = await this.inspect(Number(url.port));
    this.binding = { origin: url.origin, port: Number(url.port), processIdentity: current.processIdentity,
      executable: this.executable, fileIdentity: current.fileIdentity, relationship: 'direct-child', listener: `127.0.0.1:${url.port}` };
    return this.evidence;
  }
  async check(currentMain) {
    if (!this.binding) throw new Error('The renderer local service has not been verified.');
    await this.inspect(this.binding.port, currentMain);
  }
  async inspect(port, suppliedMain) {
    if (this.failed) throw new Error('The local service ownership check failed; start a new session.');
    try {
      const main = suppliedMain ?? await this.readIdentity(this.main.pid);
      if (!sameProcessIdentity(this.main, main)) throw new Error('The local service main process changed.');
      if (await this.canonicalize(this.executable) !== this.executable) throw new Error('The packaged local service path changed.');
      const file = await this.inspectFile(this.executable);
      if (!file.isFile()) throw new Error('The packaged local service is not a regular file.');
      const currentFile = fileIdentity(file);
      if (this.binding && currentFile !== this.binding.fileIdentity) throw new Error('The packaged local service file changed.');
      const pid = soleIPv4LoopbackListener(await this.listeners(port), port);
      if (!pid) throw new Error('The local service port has no sole IPv4 loopback listener.');
      const service = await this.readIdentity(pid);
      if (!sameProcessIdentity(service, service) || service.pid !== pid || service.executable !== this.executable ||
          service.ppid !== this.main.pid || service.uid !== this.main.uid ||
          startedMicros(service.started) < startedMicros(this.main.started)) {
        throw new Error('The local service is not the exact packaged direct child of this app.');
      }
      if (this.binding && !sameProcessIdentity(this.binding.processIdentity, service)) throw new Error('The local service process identity changed.');
      return { processIdentity: { ...service }, fileIdentity: currentFile };
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}
