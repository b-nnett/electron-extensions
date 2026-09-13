import { EventEmitter } from 'node:events';
import { CHATGPT_APP_KEY, selectRendererExtensions } from './dock-library.mjs';
import { readBoundedJSON } from './catalog-stylesheet.mjs';
import { recoverableExtensionFailure, rendererStateProof } from './extension-session-logs.mjs';
import { isChatGPTAppPage } from './chatgpt-stylesheet.mjs';

export function uniqueChatGPTTarget(targets, expectedID = null) {
  if (!Array.isArray(targets) || targets.length > 256) throw new Error('Invalid ChatGPT renderer target list.');
  const matches = targets.filter(item => item?.type === 'page' && isChatGPTAppPage(item.url));
  if (matches.length > 1) throw new Error('More than one ChatGPT desktop page is open; close extra ChatGPT windows and try again.');
  const selected = matches[0];
  if (expectedID !== null && (!selected || selected.id !== expectedID)) {
    throw new Error('The selected ChatGPT desktop page disappeared or changed identity.');
  }
  return selected;
}

export function chatGPTTerminalStatus(report) {
  return { phase: report.errors.length ? 'error' : 'stopped', pid: null, port: null,
    enabledExtensionIDs: [], cssBytes: 0, jsBytes: 0, jsStates: [], error: report.errors.join(' ') || null };
}

export function selectChatGPTExtensions(library) {
  return selectRendererExtensions(library, { appKey: CHATGPT_APP_KEY, name: 'ChatGPT' });
}

export async function readChatGPTExtensions(file) {
  return selectChatGPTExtensions(await readBoundedJSON(file, 64 * 1024 * 1024));
}

const METHODS = new Set(['Page.enable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot',
  'DOM.enable', 'DOM.getDocument', 'DOM.querySelectorAll', 'CSS.enable', 'CSS.getComputedStyleForNode',
  'CSS.createStyleSheet', 'CSS.setStyleSheetText', 'CSS.getStyleSheetText',
  'Runtime.enable', 'Runtime.evaluate', 'Runtime.compileScript', 'Page.createIsolatedWorld']);
const EVENTS = ['Page.frameNavigated', 'Page.loadEventFired', 'Runtime.consoleAPICalled', 'Runtime.exceptionThrown',
  'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'disconnected'];

// The caller first pins the exact owned ChatGPT page socket. No browser or
// main-process connection is accepted by the fixed launcher entry point.
export function chatGPTRendererPage(transport, requireOwner) {
  const page = new EventEmitter();
  for (const event of EVENTS) transport.on(event, value => page.emit(event, value));
  page.call = async (method, params = {}) => {
    if (!METHODS.has(method)) throw new Error('This ChatGPT renderer operation is not allowed.');
    if (method === 'Runtime.evaluate' && params.allowUnsafeEvalBlockedByCSP !== false) throw new Error('Renderer evaluation cannot bypass CSP.');
    if (method === 'Page.createIsolatedWorld' && (params.grantUniveralAccess !== false || params.grantUniversalAccess)) {
      throw new Error('Renderer worlds cannot receive universal access.');
    }
    await requireOwner();
    return transport.call(method, params);
  };
  return page;
}

export async function applyChatGPTSources(styles, scripts, selection, invalidateAppliedRevision = () => {}) {
  // DOM cleanup can become visible before the subsequent integrity/library
  // checks finish. The previously confirmed enabled revision is now stale.
  invalidateAppliedRevision();
  const voice = await styles.set(selection.hasCSS ? selection.css : '');
  const generation = styles.generation;
  try {
    return { voice, generation, phase: selection.hasContent ? 'active' : 'disabled', jsStates: rendererStateProof(await scripts.sync(selection.jsExtensions)) };
  } catch (error) {
    if (!recoverableExtensionFailure(error)) throw error;
    return { voice, generation, phase: 'error', jsStates: rendererStateProof(error.states),
      error: 'One or more extensions failed to load. See their runtime logs.' };
  }
}

// Integrity inspection and file reads yield to changes in both the document and
// library. A successful old apply must not acknowledge a newer desired state.
export async function confirmChatGPTApplication({ selection, styles, generation, readSelection, stopped }) {
  const documentCurrent = () => !stopped() && !styles.needsUpdate && styles.generation === generation;
  if (!documentCurrent()) return false;
  const current = await readSelection();
  return documentCurrent() && current.revisionKey === selection.revisionKey;
}
