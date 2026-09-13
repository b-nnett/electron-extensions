import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DIAGNOSTIC_SCREENSHOT_FLAG = '--diagnostic-screenshots';
export const DIAGNOSTIC_LIMITS = Object.freeze({ captures: 64, bytes: 64 * 1024 * 1024, imageBytes: 8 * 1024 * 1024 });

/** Screenshot consent is an explicit invocation option, never extension metadata. */
export function diagnosticArguments(options) {
  if (options.diagnosticScreenshots !== undefined && typeof options.diagnosticScreenshots !== 'boolean') {
    throw new Error('diagnosticScreenshots must be an explicit boolean.');
  }
  return options.diagnosticScreenshots === true ? [DIAGNOSTIC_SCREENSHOT_FLAG] : [];
}

/** Normal runtime never invokes a capture callback or writes renderer content. */
export class RuntimeDiagnostics {
  constructor({ enabled = false, output } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('Screenshot diagnostics require explicit boolean consent.');
    if (enabled && (!path.isAbsolute(output ?? '') || path.normalize(output) !== output)) {
      throw new Error('Screenshot diagnostics require the validated session output directory.');
    }
    this.enabled = enabled;
    this.output = output;
    this.captures = 0;
    this.bytes = 0;
    this.reservedBytes = 0;
  }

  get summary() {
    return { screenshotsEnabled: this.enabled,
      screenshotScope: this.enabled ? 'Complete visible renderer; may contain private app content. No native window chrome.' : 'none',
      captures: this.captures, capturedBytes: this.bytes,
      maximumCaptures: DIAGNOSTIC_LIMITS.captures, maximumCapturedBytes: DIAGNOSTIC_LIMITS.bytes };
  }

  requireAllowedMethod(method) {
    if (method === 'Page.captureScreenshot' && !this.enabled) {
      throw new Error('Renderer screenshots are disabled during normal runtime. Use explicit screenshot diagnostics.');
    }
  }

  async capture(filename, operation) {
    if (!this.enabled) return null;
    if (filename !== null && (typeof filename !== 'string' || !/^revision-[1-9]\d*-(before|after|styled|restored)\.png$/.test(filename))) {
      throw new Error('Invalid diagnostic screenshot filename.');
    }
    // Reserve the largest permitted image before invoking capture so even a
    // discarded paint-priming image stays within the session's collection cap.
    if (this.captures >= DIAGNOSTIC_LIMITS.captures || this.bytes + this.reservedBytes > DIAGNOSTIC_LIMITS.bytes - DIAGNOSTIC_LIMITS.imageBytes) {
      throw new Error('Screenshot diagnostics reached the bounded session capture limit.');
    }
    this.captures++;
    this.reservedBytes += DIAGNOSTIC_LIMITS.imageBytes;
    try {
      const png = await operation();
      if (!Buffer.isBuffer(png) || png.length < 33 || png.length > DIAGNOSTIC_LIMITS.imageBytes ||
          !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          png.subarray(12, 16).toString('ascii') !== 'IHDR' || !png.readUInt32BE(16) || !png.readUInt32BE(20) ||
          png.readUInt32BE(16) * png.readUInt32BE(20) > 16 * 1024 * 1024) {
        throw new Error('Screenshot diagnostics require a bounded PNG.');
      }
      this.bytes += png.length;
      if (filename !== null) await writeFile(path.join(this.output, filename), png, { mode: 0o600, flag: 'wx' });
      return filename;
    } finally {
      this.reservedBytes -= DIAGNOSTIC_LIMITS.imageBytes;
    }
  }
}

/** A transport boundary catches future accidental capture calls as well. */
export function guardDiagnosticTransport(transport, diagnostics) {
  const call = transport.call.bind(transport);
  transport.call = (method, ...args) => {
    diagnostics.requireAllowedMethod(method);
    return call(method, ...args);
  };
  return transport;
}
