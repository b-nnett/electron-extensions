// Cooperative renderer lifecycle for Style Lab and configured app adapters.
// No source evaluator, debugger transport, Node dependency, CSP change or global
// console replacement. execute(ea, console) is an INTERNAL trusted-fixture adapter,
// not a public manifest/mount contract or an untrusted-code security sandbox.

export const FIXTURE_RUNTIME_LIMITS = Object.freeze({
  extensions: 64, files: 32, disposers: 256, logEvents: 500,
  logBytes: 504 * 1024, messageBytes: 4096
});

const encoder = new TextEncoder();
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const levels = ['log', 'info', 'warn', 'error'];

function truncate(text, maximum = FIXTURE_RUNTIME_LIMITS.messageBytes) {
  // Never encode an unbounded input string merely to measure it.
  const parts = [];
  let bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (bytes + size > maximum) {
      while (bytes > maximum - 3) bytes -= encoder.encode(parts.pop()).length;
      return parts.join('') + '…';
    }
    parts.push(character); bytes += size;
  }
  return parts.join('');
}

// Do not enumerate objects, invoke their getters/toJSON, serialize DOM nodes, or
// implicitly record page data. Explicit primitive console arguments are enough.
function messagePart(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return truncate(value);
  if (['number', 'boolean', 'bigint', 'undefined'].includes(typeof value)) return String(value);
  if (typeof value === 'symbol') return '[Symbol]';
  if (typeof value === 'function') return '[Function]';
  return '[Object]';
}

function errorText(error) {
  if (typeof error === 'string') return truncate(error);
  // Lifecycle errors are explicitly reported, with no stack or page contents.
  try { if (error instanceof Error && typeof error.message === 'string') return truncate(error.message); }
  catch { /* An unusual thrown object must not break error reporting. */ }
  return 'Extension operation failed.';
}

function definition(value) {
  if (!value || typeof value.extensionID !== 'string' || !identifier.test(value.extensionID)) throw new TypeError('A bounded extensionID is required.');
  const revision = Number.isSafeInteger(value.revision) && value.revision > 0 ? String(value.revision) : value.revision;
  if (typeof revision !== 'string' || !revisionPattern.test(revision)) throw new TypeError('A bounded immutable revision is required.');
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > FIXTURE_RUNTIME_LIMITS.files) {
    throw new TypeError('Use one to 32 trusted fixture script adapters.');
  }
  const names = new Set();
  const files = value.files.map(file => {
    const name = file?.fileName;
    if (typeof name !== 'string' || name.length > 256 || !name.toLowerCase().endsWith('.js') ||
        /[\\:\u0000-\u001f\u007f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') ||
        names.has(name) || typeof file.execute !== 'function') {
      throw new TypeError('Each adapter needs a unique contained .js name and an execute function; source strings are not accepted.');
    }
    names.add(name);
    return Object.freeze({ fileName: name, execute: file.execute });
  });
  return Object.freeze({ extensionID: value.extensionID, revision, files: Object.freeze(files) });
}

class OperationDeadline extends Error {}

async function bounded(operation, deadline, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new OperationDeadline(`${label} did not finish before its deadline.`)), Math.max(1, deadline - Date.now()));
      })
    ]);
  } finally { clearTimeout(timer); }
}

export class FixtureExtensionRuntime {
  #records = new Map();
  #events = [];
  #eventBytes = 0;
  #sequence = 0;
  #closed = false;
  #onLog;
  #timeout;

  constructor({ onLog, operationTimeoutMs = 3000 } = {}) {
    if (onLog !== undefined && typeof onLog !== 'function') throw new TypeError('onLog must be a function.');
    if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 5 || operationTimeoutMs > 10000) {
      throw new TypeError('Use a bounded operation timeout between 5 and 10000 milliseconds.');
    }
    this.#onLog = onLog; this.#timeout = operationTimeoutMs;
  }

  #log(record, fileName, level, args) {
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) return;
    const event = Object.freeze({ sequence: ++this.#sequence, extensionID: record.extensionID,
      fileName, revision: record.revision, level,
      message: truncate(args.slice(0, 32).map(messagePart).join(' ') + (args.length > 32 ? ' …' : '')),
      timestamp: new Date().toISOString() });
    // Include generous indentation/comma overhead for the native reader's
    // pretty-printed wrapper, plus 8 KiB reserved outside this event budget.
    const bytes = encoder.encode(JSON.stringify(event, null, 2)).length + 128;
    this.#events.push({ event, bytes }); this.#eventBytes += bytes;
    while (this.#events.length > FIXTURE_RUNTIME_LIMITS.logEvents || this.#eventBytes > FIXTURE_RUNTIME_LIMITS.logBytes) {
      this.#eventBytes -= this.#events.shift().bytes;
    }
    try {
      // A failed observer must never fail the extension or stop its cleanup.
      Promise.resolve(this.#onLog?.(event)).catch(() => {});
    } catch { /* Caller-owned log persistence is separate from lifecycle success. */ }
  }

  #failure(record, fileName, stage, error) {
    record.lastError = Object.freeze({ fileName, stage, message: errorText(error) });
    this.#log(record, fileName, 'error', [`${stage}: ${record.lastError.message}`]);
  }

  #state(record) {
    return Object.freeze({ extensionID: record.extensionID, revision: record.revision,
      phase: record.phase, generation: record.generation, cleanupComplete: record.cleanupComplete,
      reloadBlocked: record.reloadBlocked, fileNames: [...record.fileNames],
      lastError: record.lastError ? { ...record.lastError } : null });
  }

  state(extensionID) { const record = this.#records.get(extensionID); return record ? this.#state(record) : null; }
  logs() { return this.#events.map(({ event }) => ({ ...event })); }

  #enqueue(record, operation) {
    record.pending++;
    const result = record.queue.then(operation).finally(() => { record.pending--; });
    record.queue = result.catch(() => {});
    return result;
  }

  forgetDisabled() {
    for (const [id, record] of this.#records) {
      if (record.phase === 'disabled' && record.cleanupComplete && !record.reloadBlocked && record.pending === 0) this.#records.delete(id);
    }
  }

  #context(record, fileName) {
    const controller = record.controller;
    const generation = record.generation;
    const current = () => record.generation === generation && !controller.signal.aborted;
    const ea = Object.freeze({ id: record.extensionID, signal: controller.signal,
      onDispose: callback => {
        if (typeof callback !== 'function') throw new TypeError('ea.onDispose requires a function.');
        if (!current()) throw new Error('This extension generation has ended; do not acquire more resources.');
        if (record.disposers.length >= FIXTURE_RUNTIME_LIMITS.disposers) throw new Error('Extension disposer limit reached.');
        record.disposers.push({ callback, fileName });
      }
    });
    const console = Object.freeze(Object.fromEntries(levels.map(level => [level, (...args) => {
      // A retained callback from an old generation cannot impersonate a new one.
      if (record.generation === generation && ['loading', 'active', 'unloading'].includes(record.phase)) {
        this.#log(record, fileName, level, args);
      }
    }])));
    return { ea, console };
  }

  async #cleanup(record, terminalPhase = 'disabled') {
    record.phase = 'unloading';
    // Removing the failed callback from the stack does not repair its resource.
    // Repeated disable must preserve prior uncertainty until a new document.
    let complete = !record.unsettledExecution && !record.reloadBlocked;
    try { record.controller?.abort('Extension generation ended.'); }
    catch (error) { complete = false; this.#failure(record, record.fileNames[0], 'abort', error); }
    const deadline = Date.now() + this.#timeout;
    // Consume before calling: no disposer is run twice even if it rejects.
    while (record.disposers.length) {
      const { callback, fileName } = record.disposers.pop();
      try { await bounded(callback, deadline, 'Extension cleanup'); }
      catch (error) { complete = false; this.#failure(record, fileName, 'cleanup', error); }
    }
    record.cleanupComplete = complete;
    record.reloadBlocked ||= !complete;
    record.phase = complete ? terminalPhase : 'failed';
    return this.#state(record);
  }

  enable(value) {
    let selected;
    try { selected = definition(value); }
    catch (error) { return Promise.reject(error); }
    if (this.#closed) return Promise.reject(new Error('This owned renderer runtime is disposed.'));
    let record = this.#records.get(selected.extensionID);
    if (!record) {
      if (this.#records.size >= FIXTURE_RUNTIME_LIMITS.extensions) return Promise.reject(new Error('Owned renderer extension limit reached.'));
      record = { extensionID: selected.extensionID, revision: selected.revision, fileNames: [],
        phase: 'disabled', generation: 0, cleanupComplete: true, reloadBlocked: false,
        lastError: null, disposers: [], controller: null, unsettledExecution: false, queue: Promise.resolve(), pending: 0 };
      this.#records.set(record.extensionID, record);
    }
    return this.#enqueue(record, async () => {
      if (this.#closed) return this.#state(record);
      if (record.reloadBlocked) return this.#state(record);
      const names = selected.files.map(file => file.fileName);
      if (record.phase === 'active' && record.revision === selected.revision) {
        if (JSON.stringify(names) !== JSON.stringify(record.fileNames)) throw new Error('A revision cannot identify different source files.');
        return this.#state(record);
      }
      if (record.phase !== 'disabled') {
        await this.#cleanup(record);
        if (record.reloadBlocked) return this.#state(record);
      }
      record.revision = selected.revision; record.fileNames = names; record.generation++;
      record.phase = 'loading'; record.cleanupComplete = false; record.lastError = null;
      record.controller = new AbortController(); record.unsettledExecution = false;
      const deadline = Date.now() + this.#timeout;
      for (const file of selected.files) {
        const { ea, console } = this.#context(record, file.fileName);
        try {
          if (ea.signal.aborted) throw new Error('Extension was disabled during loading.');
          await bounded(() => file.execute(ea, console), deadline, 'Extension loading');
          if (ea.signal.aborted) throw new Error('Extension was disabled during loading.');
        } catch (error) {
          record.unsettledExecution = error instanceof OperationDeadline;
          this.#failure(record, file.fileName, 'load', error);
          await this.#cleanup(record, 'failed');
          return this.#state(record);
        }
      }
      record.phase = 'active';
      return this.#state(record);
    });
  }

  disable(extensionID) {
    if (typeof extensionID !== 'string' || !identifier.test(extensionID)) return Promise.reject(new TypeError('Invalid extensionID.'));
    const record = this.#records.get(extensionID);
    if (!record) return Promise.resolve(null);
    // Cooperative async initializers can finish promptly in response to abort.
    if (record.phase === 'loading') record.controller?.abort('Extension disabled while loading.');
    return this.#enqueue(record, async () => {
      if (record.phase === 'disabled') return this.#state(record);
      return this.#cleanup(record);
    });
  }

  async dispose() {
    this.#closed = true;
    return Promise.all([...this.#records.keys()].map(extensionID => this.disable(extensionID)));
  }
}
