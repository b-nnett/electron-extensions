import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFixedLocalServiceProfile, localServicePageURL } from './owned-local-service.mjs';
import { selectRendererExtensions } from './dock-library.mjs';

export const MAX_CATALOG_CSS_BYTES = 64 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && !/[\0\r\n]/.test(value);
const within = (file, parent) => file.startsWith(parent + path.sep);
const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = message => new Error(`Invalid catalog extension configuration: ${message}`);
const validRendererRuntime = value => object(value) && Object.keys(value).length === 2 &&
  value.engine === 'isolated-js-v1' && value.verification === 'not-verified';

// Only this repository's curated manifest supplies executable paths and flags.
// There is no CLI override for an app, endpoint, selector or launch argument.
export function validateCatalogProfile(value) {
  if (!object(value) || !/^[a-z][a-z0-9-]{0,63}$/.test(value.slug ?? '') ||
      !text(value.name) || !text(value.bundleIdentifier) || !text(value.bundlePath) ||
      !value.bundlePath.startsWith('/Applications/') || !value.bundlePath.endsWith('.app') ||
      path.normalize(value.bundlePath) !== value.bundlePath) throw invalid('invalid fixed app identity.');
  const executable = text(value.executable) && !value.executable.includes('/')
    ? path.join(value.bundlePath, 'Contents/MacOS', value.executable) : value.executable;
  if (!text(executable) || path.normalize(executable) !== executable ||
      !within(executable, path.join(value.bundlePath, 'Contents/MacOS'))) throw invalid('executable must be inside the app’s MacOS directory.');
  if (!['pipe', 'tcp', 'launchservices-tcp'].includes(value.transport) ||
      !Array.isArray(value.arguments) || value.arguments.length > 8 ||
      value.arguments.some(argument => !text(argument))) throw invalid('invalid transport or arguments.');
  const standardArguments = value.transport === 'pipe'
    ? ['--remote-debugging-pipe']
    : ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
  const allowed = new Set(standardArguments);
  if (value.slug === 'compass') allowed.add('--ignoreAdditionalCommandLineFlags');
  if (value.arguments.some(argument => !allowed.has(argument)) ||
      new Set(value.arguments).size !== value.arguments.length) {
    throw invalid('only the reviewed ordinary debugger flags and fixed Compass parser option are supported.');
  }
  if (!object(value.target) || !text(value.target.selector) || value.target.selector.length > 1024 ||
      !text(value.target.urlPattern) || value.target.urlPattern.length > 2048 ||
      !value.target.urlPattern.startsWith('^') || !value.target.urlPattern.endsWith('$')) throw invalid('target needs an anchored URL pattern and a known selector.');
  try { new RegExp(value.target.urlPattern); } catch { throw invalid('invalid target URL pattern.'); }
  if (value.rendererRuntime !== undefined && !validRendererRuntime(value.rendererRuntime)) {
    throw invalid('rendererRuntime requires exactly engine isolated-js-v1 and verification not-verified.');
  }
  const result = { ...value, arguments: [...new Set([...value.arguments, ...standardArguments])], target: { ...value.target }, executable };
  if (value.rendererRuntime !== undefined) result.rendererRuntime = { ...value.rendererRuntime };
  if (value.ownedLocalService !== undefined || value.slug === 'antigravity') {
    if (!hasFixedLocalServiceProfile(result)) throw invalid('the local service requires the exact reviewed Antigravity identity, service, route and control.');
    result.ownedLocalService = { ...value.ownedLocalService };
  }
  return result;
}

export async function readBoundedJSON(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw invalid(`use a regular JSON file no larger than ${limit} bytes.`);
    const pieces = []; let bytes = 0;
    while (bytes <= limit) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      pieces.push(buffer.subarray(0, bytesRead)); bytes += bytesRead;
    }
    if (bytes > limit) throw invalid('JSON file grew beyond its limit.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pieces))); }
    catch { throw invalid('expected valid UTF-8 JSON.'); }
  } finally { await handle.close(); }
}

export function selectCatalogCSS(library, profile) {
  if (!object(library) || !Array.isArray(library.records)) throw invalid('records must be an array.');
  const extensions = [], sources = [], parts = [], ids = new Set(); let cssBytes = 0;
  for (const record of library.records) {
    if (!object(record) || !text(record.appKey) || typeof record.isEnabled !== 'boolean') throw invalid('each record requires an appKey and boolean isEnabled.');
    if (record.appKey !== profile.bundleIdentifier || !record.isEnabled) continue;
    if (!text(record.id) || ids.has(record.id) || !text(record.name)) throw invalid('enabled records require unique IDs and names.');
    ids.add(record.id);
    if (record.sourceType !== 'css') throw invalid(`${profile.name} supports CSS only; disable enabled JavaScript or unknown source types.`);
    const packaged = record.sourceFiles != null;
    const files = packaged ? record.sourceFiles : [{ fileName: record.sourceFileName, type: record.sourceType, text: record.sourceText }];
    if (!Array.isArray(files) || !files.length || files.length > 32) throw invalid('each extension needs 1–32 source files.');
    const names = new Set();
    for (const source of files) {
      if (!object(source) || !text(source.fileName) || !source.fileName.toLowerCase().endsWith('.css') ||
          source.type !== 'css' || typeof source.text !== 'string' || names.has(source.fileName)) throw invalid('enabled sources must be uniquely named CSS text files.');
      names.add(source.fileName);
      const bytes = Buffer.byteLength(source.text, 'utf8');
      cssBytes += bytes + (parts.length ? 1 : 0);
      if (cssBytes > MAX_CATALOG_CSS_BYTES) throw invalid(`${profile.name} stylesheets exceed the combined 64 KiB limit.`);
      parts.push(source.text); sources.push({ extensionID: record.id, fileName: source.fileName, bytes });
    }
    if (packaged && (record.sourceFileName !== path.posix.basename(files[0].fileName) || record.sourceType !== files[0].type || record.sourceText !== files[0].text)) throw invalid('package and legacy first-source fields disagree.');
    extensions.push({ id: record.id, name: record.name });
  }
  const css = parts.join('\n'), sha256 = digest(css);
  return { css, cssBytes, sha256, sources, extensions,
    enabledExtensionIDs: extensions.map(item => item.id), hasCSS: extensions.length > 0 && css.trim().length > 0,
    revisionKey: digest(JSON.stringify({ extensions, sources, sha256 })) };
}

export async function readCatalogLibrary(file, profile) {
  return selectCatalogCSS(await readBoundedJSON(file, 64 * 1024 * 1024), profile);
}

export function supportsCatalogJavaScript(profile) {
  try { profile = validateCatalogProfile(profile); } catch { return false; }
  if (!validRendererRuntime(profile.rendererRuntime)) return false;
  if (profile.slug === 'figma' || profile.bundleIdentifier === 'com.figma.Desktop' || profile.bundlePath === '/Applications/Figma.app') {
    return profile.slug === 'figma' && profile.name === 'Figma' && profile.bundleIdentifier === 'com.figma.Desktop' &&
      profile.bundlePath === '/Applications/Figma.app' && profile.executable === '/Applications/Figma.app/Contents/MacOS/Figma' &&
      profile.transport === 'pipe' && Array.isArray(profile.arguments) && new Set(profile.arguments).size === profile.arguments.length &&
      profile.arguments.every(argument => argument === '--remote-debugging-pipe') && profile.ownedLocalService === undefined &&
      profile.target?.urlPattern === '^https://www\\.figma\\.com/[^?#\\r\\n]*$' && profile.target?.selector === 'button[type="submit"]';
  }
  if (profile.slug === 'vscode' || profile.bundleIdentifier === 'com.microsoft.VSCode' || profile.bundlePath === '/Applications/Visual Studio Code.app') {
    const allowed = new Set(['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']);
    return profile.slug === 'vscode' && profile.name === 'Visual Studio Code' &&
    profile.bundleIdentifier === 'com.microsoft.VSCode' && profile.bundlePath === '/Applications/Visual Studio Code.app' &&
    profile.executable === '/Applications/Visual Studio Code.app/Contents/MacOS/Code' && profile.transport === 'tcp' &&
    Array.isArray(profile.arguments) && new Set(profile.arguments).size === profile.arguments.length &&
    profile.arguments.every(argument => allowed.has(argument)) && profile.ownedLocalService === undefined &&
    profile.target?.urlPattern === '^vscode\\-file:[^?#\\r\\n]+$' &&
    profile.target?.selector === '.monaco-workbench [role="button"][aria-label="Manage"]';
  }
  return true;
}

export function isCatalogJavaScriptPage(value, profile, route = {}) {
  if (!supportsCatalogJavaScript(profile) || !isCatalogAppPage(value, profile, route)) return false;
  try {
    const url = new URL(value);
    if (profile.slug === 'figma') return url.protocol === 'https:' && url.hostname === 'www.figma.com' &&
      !url.username && !url.password && !url.port;
    if (profile.slug === 'vscode') return url.protocol === 'vscode-file:' && url.hostname === 'vscode-app' && !url.username && !url.password && !url.port &&
      decodeURIComponent(url.pathname) === `${profile.bundlePath}/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html`;
    return true;
  } catch { return false; }
}

export function selectCatalogExtensions(library, profile) {
  if (supportsCatalogJavaScript(profile)) return selectRendererExtensions(library, { appKey: profile.bundleIdentifier, name: profile.name });
  const selected = selectCatalogCSS(library, profile);
  return { ...selected, hasContent: selected.hasCSS, jsBytes: 0, jsExtensions: [] };
}

export async function readCatalogExtensions(file, profile) {
  return selectCatalogExtensions(await readBoundedJSON(file, 64 * 1024 * 1024), profile);
}

function resolvedWithMissingTail(file) {
  let ancestor = file; const tail = [];
  while (true) {
    try { return path.join(realpathSync(ancestor), ...tail); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || ancestor === path.dirname(ancestor)) throw error;
      tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
}

export function isCatalogAppPage(value, profile, { ownedServiceOrigin = null, allowUnboundLocalService = false } = {}) {
  try {
    if (typeof value !== 'string' || value.length > 16384) return false;
    if (profile.ownedLocalService !== undefined || profile.slug === 'antigravity') {
      const local = localServicePageURL(value, profile);
      return Boolean(local && (allowUnboundLocalService || local.origin === ownedServiceOrigin));
    }
    const url = new URL(value);
    const electermOrigin = profile.slug === 'electerm' && url.origin === 'http://127.0.0.1:30975';
    if (url.username || url.password || (url.port && !electermOrigin) ||
        (url.protocol === 'http:' && !electermOrigin) ||
        ['javascript:', 'data:', 'blob:', 'about:', 'chrome:', 'devtools:', 'chrome-extension:'].includes(url.protocol)) return false;
    if (url.protocol === 'file:' && (url.hostname || !within(resolvedWithMissingTail(fileURLToPath(url)), profile.bundlePath))) return false;
    if (url.protocol !== 'file:' && !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return false;
    url.search = ''; url.hash = '';
    return new RegExp(profile.target.urlPattern).test(url.href);
  } catch { return false; }
}

export function uniqueCatalogTarget(targets, profile, route = {}) {
  if (!Array.isArray(targets) || targets.length > 1024) throw invalid('invalid debugger target list.');
  const types = profile.ownedLocalService ? ['page'] : ['page', 'webview'];
  const matches = targets.filter(target => types.includes(target?.type) && isCatalogAppPage(target.url, profile, route));
  if (matches.length > 1) throw new Error(`${profile.name} exposed multiple matching app pages. Close extra windows and retry.`);
  return matches[0] ?? null;
}

const VISUAL_PROPERTIES = ['background-color', 'color', 'border-top-left-radius', 'display', 'visibility', 'opacity'];

/** Renderer DOM/CSS only. A caller supplies the already-owned page transport. */
export class CatalogStylesheet {
  constructor(cdp, profile, requireOwner, beforeWrite = () => {}, { ownedServiceOrigin = null } = {}) {
    this.cdp = cdp; this.profile = profile; this.requireOwner = requireOwner; this.beforeWrite = beforeWrite;
    this.route = { ownedServiceOrigin };
    if (profile.ownedLocalService && !isCatalogAppPage(`${ownedServiceOrigin}/`, profile, this.route)) {
      throw new Error('The renderer requires a verified local service origin.');
    }
    this.sheet = null; this.generation = 0; this.needsUpdate = true;
    this.onNavigation = ({ frame }) => {
      if (frame && !frame.parentId) { this.generation++; this.sheet = null; this.needsUpdate = true; }
    };
    cdp.on('Page.frameNavigated', this.onNavigation);
  }
  async init({ waitForFrame } = {}) {
    await this.requireOwner();
    for (const method of ['Page.enable', 'DOM.enable', 'CSS.enable']) await this.cdp.call(method);
    if (waitForFrame) await waitForFrame();
    else await this.frame();
  }
  async frame() {
    await this.requireOwner();
    const { frameTree } = await this.cdp.call('Page.getFrameTree');
    if (!frameTree?.frame?.id || !isCatalogAppPage(frameTree.frame.url, this.profile, this.route)) {
      const error = new Error('The selected renderer is outside the fixed app route.');
      const value = frameTree?.frame?.url;
      error.frameRoute = { hasRootFrame: Boolean(frameTree?.frame?.id), urlPresent: typeof value === 'string' };
      if (typeof value === 'string') {
        error.frameRoute.urlSha256 = digest(value);
        try { const url = new URL(value); error.frameRoute.protocol = url.protocol; error.frameRoute.hostname = url.hostname; } catch {}
      }
      // Only initial readiness may retry an uncommitted root. The exact ':'
      // sentinel was observed transitioning to the allowed URL in Figma126.8.18.
      // Ordinary frame calls still reject it; no source is admitted here.
      const figmaPending = value === ':' && this.profile.slug === 'figma' && supportsCatalogJavaScript(this.profile);
      if (frameTree?.frame?.id && (value === '' || value === 'about:blank' || figmaPending)) error.code = 'CATALOG_INITIAL_FRAME_PENDING';
      throw error;
    }
    return frameTree.frame;
  }
  async control({ visible = false } = {}) {
    const generation = this.generation;
    await this.frame();
    const { root } = await this.cdp.call('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await this.cdp.call('DOM.querySelectorAll', { nodeId: root.nodeId, selector: this.profile.target.selector });
    if (!Array.isArray(nodeIds) || nodeIds.length !== 1) {
      const error = new Error('The fixed app control is not uniquely available.'); error.code = 'CONTROL_NOT_READY'; throw error;
    }
    const { computedStyle } = await this.cdp.call('CSS.getComputedStyleForNode', { nodeId: nodeIds[0] });
    if (!Array.isArray(computedStyle)) throw new Error('Missing computed control styles.');
    const values = Object.fromEntries(computedStyle.map(item => [item.name, item.value]));
    const computed = Object.fromEntries(VISUAL_PROPERTIES.map(name => [name, values[name] ?? null]));
    if (Object.values(computed).some(value => typeof value !== 'string')) throw new Error('Incomplete computed control styles.');
    let clip = null;
    if (visible) {
      if (values.display === 'none' || values.visibility !== 'visible' || Number(values.opacity) === 0) {
        const error = new Error('The fixed app control is not visible.'); error.code = 'CONTROL_NOT_READY'; throw error;
      }
      const { model } = await this.cdp.call('DOM.getBoxModel', { nodeId: nodeIds[0] });
      const { cssVisualViewport: viewport } = await this.cdp.call('Page.getLayoutMetrics');
      if (!model || !Array.isArray(model.border) || model.border.length !== 8 || !viewport) throw new Error('Control layout evidence is unavailable.');
      const x = Math.min(...model.border.filter((_, index) => index % 2 === 0));
      const y = Math.min(...model.border.filter((_, index) => index % 2 === 1));
      const width = Math.max(...model.border.filter((_, index) => index % 2 === 0)) - x;
      const height = Math.max(...model.border.filter((_, index) => index % 2 === 1)) - y;
      if (![x, y, width, height, viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite) ||
          width <= 0 || height <= 0 || width * height > 1024 * 1024 ||
          x < viewport.pageX || y < viewport.pageY || x + width > viewport.pageX + viewport.clientWidth || y + height > viewport.pageY + viewport.clientHeight) {
        const error = new Error('The fixed control is outside the visible viewport or exceeds capture limits.'); error.code = 'CONTROL_NOT_READY'; throw error;
      }
      clip = { x, y, width, height, scale: 1 };
    }
    if (generation !== this.generation) throw new Error('The app navigated while reading the control.');
    return { matches: 1, computed, clip };
  }
  async settledControl({ wait = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = Date.now } = {}) {
    // Computed style immediately after a write can still be the start value of
    // a CSS transition. Observe three equal samples, without changing animation
    // settings or accepting an endlessly changing control.
    const started = clock(), generation = this.generation;
    let previous, consecutive = 0;
    for (let samples = 1; samples <= 20; samples++) {
      await wait(100);
      if (generation !== this.generation) throw new Error('The app navigated while waiting for computed styles to settle.');
      const control = await this.control();
      const serialized = JSON.stringify(control.computed);
      consecutive = serialized === previous ? consecutive + 1 : 1; previous = serialized;
      const elapsedMs = clock() - started;
      if (elapsedMs > 2000) break;
      if (consecutive >= 3) return { ...control, observation: { samples, elapsedMs, stableSamples: consecutive } };
      if (elapsedMs >= 2000) break;
    }
    throw new Error('The known control’s computed styles did not settle within the bounded observation period.');
  }
  async set(css) {
    if (typeof css !== 'string' || Buffer.byteLength(css, 'utf8') > MAX_CATALOG_CSS_BYTES) throw invalid('stylesheets must total 64 KiB or less.');
    const generation = this.generation;
    const current = () => { if (generation !== this.generation) throw new Error('The app navigated during the stylesheet update; application was not confirmed.'); };
    const frame = await this.frame(); current();
    // Legacy CSS proofs retain their control check. Mixed product sessions use
    // owned-frame validation and stylesheet readback, independent of vendor UI.
    if (css) { if (!supportsCatalogJavaScript(this.profile)) await this.control(); current(); this.beforeWrite(); }
    if (!this.sheet && css) {
      const { styleSheetId } = await this.cdp.call('CSS.createStyleSheet', { frameId: frame.id, force: true });
      current();
      if (typeof styleSheetId !== 'string' || !styleSheetId) throw new Error('No owned stylesheet identifier was returned.');
      this.sheet = styleSheetId;
    }
    if (this.sheet) {
      await this.requireOwner(); current(); if (css) this.beforeWrite();
      await this.cdp.call('CSS.setStyleSheetText', { styleSheetId: this.sheet, text: css }); current();
      const { text: readback } = await this.cdp.call('CSS.getStyleSheetText', { styleSheetId: this.sheet }); current();
      if (readback !== css) throw new Error('The renderer did not confirm the requested stylesheet text.');
    }
    this.needsUpdate = false;
    return { generation, stylesheetReadbackVerified: true, cssBytes: Buffer.byteLength(css) };
  }
  async screenshot(clip) {
    const generation = this.generation;
    await this.frame();
    // A clipped surface capture can leave a stale, cropped backing surface in
    // a macOS window until its next paint. Capture the complete visible renderer
    // without changing the viewport; native window captures remain independent.
    const { cssVisualViewport: viewport } = await this.cdp.call('Page.getLayoutMetrics');
    if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) ||
        viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || viewport.clientWidth * viewport.clientHeight > 16 * 1024 * 1024) {
      throw new Error('The renderer viewport exceeds screenshot limits.');
    }
    const { data } = await this.cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (typeof data !== 'string' || data.length > 12 * 1024 * 1024 || generation !== this.generation) throw new Error('Invalid or interrupted renderer screenshot.');
    const png = Buffer.from(data, 'base64');
    if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        png.subarray(12, 16).toString('ascii') !== 'IHDR' || png.length > 8 * 1024 * 1024 ||
        !png.readUInt32BE(16) || !png.readUInt32BE(20) || png.readUInt32BE(16) * png.readUInt32BE(20) > 16 * 1024 * 1024) throw new Error('Renderer screenshot is not a bounded PNG.');
    return png;
  }
  async dispose() {
    try { if (this.sheet) await this.set(''); }
    finally { this.cdp.off('Page.frameNavigated', this.onNavigation); }
  }
}
