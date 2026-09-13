import { randomUUID } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rendererStateProof(states) {
  return states.map(state => ({ extensionID: state.extensionID, revision: state.revision, phase: state.phase,
    generation: state.generation, cleanupComplete: state.cleanupComplete, reloadBlocked: state.reloadBlocked,
    fileNames: [...state.fileNames], ...(state.lastError ? { lastError: { fileName: state.lastError.fileName, stage: state.lastError.stage } } : {}) }));
}

export function recoverableExtensionFailure(error) {
  return Array.isArray(error?.states) && error.states.some(state => state?.phase === 'failed') && error.states.every(state =>
    state?.reloadBlocked === false && (state.phase === 'active' || (state.phase === 'failed' && state.cleanupComplete === true)));
}

/** Dedicated extension output only; never subscribes to app console events. */
export class ExtensionSessionLogFile {
  constructor(file, sessionID, { appKey, writer = atomicJSON } = {}) {
    if (typeof appKey !== "string" || !appKey.trim() || Buffer.byteLength(appKey) > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(appKey)) throw new Error("Extension logs require a bounded app identity.");
    this.appKey = appKey;
    if (!uuid.test(sessionID)) throw new Error('Extension logs require a UUID session identifier.');
    this.file = file; this.sessionID = sessionID; this.writer = writer;
    this.events = []; this.sequence = 0; this.droppedEvents = 0; this.bytes = 0;
    this.pending = null; this.dirty = false; this.failure = null; this.initialized = false;
  }

  append(value) {
    if (this.failure) throw this.failure;
    if (!value || typeof value.extensionID !== 'string' || !uuid.test(value.extensionID) ||
        typeof value.fileName !== 'string' || Buffer.byteLength(value.fileName) > 256 ||
        !value.fileName.toLowerCase().endsWith('.js') || /[\\:\u0000-\u001f\u007f-\u009f]/.test(value.fileName) ||
        value.fileName.split('/').some(part => !part || part === '.' || part === '..') ||
        typeof value.revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.revision) ||
        !['log', 'info', 'warn', 'error'].includes(value.level) || typeof value.message !== 'string' ||
        Buffer.byteLength(value.message) > 4096 || typeof value.timestamp !== 'string' ||
        value.timestamp.length > 64 || !Number.isFinite(Date.parse(value.timestamp)) ||
        this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid attributed extension log event.');
    const event = { sequence: ++this.sequence, extensionID: value.extensionID, fileName: value.fileName,
      revision: value.revision, level: value.level, message: value.message, timestamp: value.timestamp };
    const bytes = Buffer.byteLength(JSON.stringify(event, null, 2)) + 128;
    this.events.push({ event, bytes }); this.bytes += bytes;
    while (this.events.length > 500 || this.bytes > 504 * 1024) {
      this.bytes -= this.events.shift().bytes; this.droppedEvents++;
    }
    this.dirty = true;
    this.initialized = true;
    return this.schedule();
  }

  schedule() {
    if (!this.pending) {
      this.pending = Promise.resolve().then(async () => {
        while (this.dirty) {
          this.dirty = false;
          const envelope = this.snapshot();
          if (Buffer.byteLength(JSON.stringify(envelope, null, 2)) + 1 > 512 * 1024) throw new Error('Extension log envelope exceeds 512 KiB.');
          await this.writer(this.file, envelope);
        }
      }).catch(error => { this.failure = error; throw error; }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  snapshot() {
    return { schema: 1, appKey: this.appKey, sessionID: this.sessionID,
      droppedEvents: this.droppedEvents, events: this.events.map(({ event }) => ({ ...event })) };
  }

  async flush() {
    if (this.failure) throw this.failure;
    if (!this.initialized) { this.initialized = true; this.dirty = true; this.schedule(); }
    await this.pending;
  }
}

async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
