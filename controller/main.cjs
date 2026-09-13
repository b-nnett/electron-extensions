const { app, BrowserWindow, ipcMain } = require('electron');
const { readFile, access } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
let window;
let session;
let FixtureSession;
let operation;
let quitting = false;
let quitReady = false;
const state = {
  running: false, launched: false, busy: false, available: false,
  message: 'Ready to launch the signed test app.', error: null,
  cssActive: false, demoActive: false, consoleEntries: [], button: null, original: null, integrity: null,
  baseline: null, pid: null, presets: {},
};

function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('fixture:state', { ...state });
}

function requireRunning() {
  if (!state.running || !session?.styles) throw new Error('Launch Style Lab first.');
}

function observeSession(current) {
  const disconnected = () => {
    if (current !== session || quitting || !state.running) return;
    state.running = false;
    state.message = 'Style Lab disconnected. Stop the session to launch it again.';
    state.error = 'The fixture window or debugger connection closed.';
    publish();
  };
  current.cdp.once('disconnected', disconnected);
  current.child.once('exit', disconnected);
  current.styles.on('failure', error => {
    if (current !== session || quitting) return;
    state.error = error.message;
    state.message = 'The stylesheet could not be reapplied.';
    publish();
  });
  current.buttonDemo.on('console', entry => {
    if (current !== session || quitting || !state.running) return;
    state.consoleEntries = [...state.consoleEntries, entry].slice(-20);
    publish();
  });
  current.buttonDemo.on('failure', error => {
    if (current !== session || quitting) return;
    state.demoActive = current.buttonDemo.active;
    state.error = error.message;
    state.message = 'The demo button could not be reapplied.';
    publish();
  });
}

async function perform(action, value) {
  switch (action) {
    case 'launch': {
      if (state.launched) throw new Error('Stop the current session before launching another.');
      session = new FixtureSession();
      const started = await session.start();
      Object.assign(state, {
        launched: true, running: true, cssActive: false, demoActive: false,
        consoleEntries: [], pid: started.pid,
        baseline: started.signature, original: started.button, button: started.button,
        integrity: null, message: 'Style Lab is connected. Pick a preset or write your own CSS.',
      });
      observeSession(session);
      break;
    }
    case 'apply':
      requireRunning();
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 65536) {
        throw new Error('Use a stylesheet smaller than 64 KB.');
      }
      state.button = await session.styles.apply(value);
      state.cssActive = Boolean(value.trim());
      state.message = state.cssActive ? 'Stylesheet applied to the live app.' : 'The empty stylesheet is applied.';
      break;
    case 'remove':
      requireRunning();
      state.button = await session.styles.remove();
      state.cssActive = false;
      state.message = 'Stylesheet removed. The original button appearance is restored.';
      break;
    case 'reload':
      requireRunning();
      state.button = await session.reload();
      state.message = state.cssActive || state.demoActive ? 'App reloaded. Active customizations were reapplied.' : 'App reloaded with its original appearance.';
      break;
    case 'installButton':
      requireRunning();
      state.demoActive = (await session.buttonDemo.install()).present;
      state.message = 'Demo button added. Click it in Style Lab to run its JavaScript.';
      break;
    case 'removeButton':
      requireRunning();
      state.demoActive = (await session.buttonDemo.remove()).present;
      state.message = 'Demo button and its click handler removed.';
      break;
    case 'verify':
      if (!state.baseline || !session) throw new Error('Launch Style Lab to capture a baseline first.');
      state.integrity = null;
      state.integrity = await session.verify();
      state.message = 'Verified: bundle fingerprint and signature match the launch baseline.';
      break;
    case 'stop':
      state.running = false;
      if (session) await session.stop();
      Object.assign(state, { launched: false, cssActive: false, demoActive: false, pid: null, button: null });
      state.message = 'Style Lab stopped. You can launch a fresh session.';
      break;
    default:
      throw new Error('Unknown fixture action.');
  }
}

function validSender(event) {
  return window && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === page;
}

ipcMain.handle('fixture:snapshot', event => {
  if (!validSender(event)) throw new Error('Untrusted controller frame.');
  return { ...state };
});

ipcMain.handle('fixture:action', async (event, action, value) => {
  if (!validSender(event)) throw new Error('Untrusted controller frame.');
  if (quitting || operation) return { ok: false, error: 'Wait for the current operation to finish.' };
  state.busy = true;
  state.error = null;
  state.message = {
    launch: 'Checking the signed bundle and launching Style Lab…',
    apply: 'Applying your stylesheet…', remove: 'Removing the stylesheet…',
    installButton: 'Adding the demo button and its JavaScript handler…',
    removeButton: 'Removing the demo button and its handler…',
    reload: 'Reloading Style Lab…', verify: 'Checking every bundle file and its signature…',
    stop: 'Removing customizations and stopping Style Lab…',
  }[action] || 'Working…';
  publish();
  operation = perform(action, value);
  try {
    await operation;
    return { ok: true };
  } catch (error) {
    state.error = error.message;
    state.message = 'The operation could not finish.';
    return { ok: false, error: error.message };
  } finally {
    operation = null;
    state.busy = false;
    publish();
  }
});

async function createWindow() {
  window = new BrowserWindow({
    width: 940, height: 790, minWidth: 780, minHeight: 710,
    title: 'Extensions Anywhere', backgroundColor: '#f3f1eb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  await window.loadURL(page);
}

app.whenReady().then(async () => {
  const module = await import('../lib/fixture-session.mjs');
  FixtureSession = module.FixtureSession;
  for (const preset of ['neon', 'lilac']) {
    state.presets[preset] = await readFile(path.join(__dirname, '..', 'styles', `${preset}.css`), 'utf8');
  }
  try { await access(module.fixtureBundle); state.available = true; }
  catch { state.message = 'Build the fixture with npm run build:fixture, then restart this controller.'; }
  await createWindow();
}).catch(error => {
  console.error('Controller startup failed:', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  (async () => {
    await operation?.catch(() => {});
    await session?.stop();
  })().catch(error => console.error('Fixture cleanup failed:', error.message)).finally(() => {
    quitReady = true;
    app.quit();
  });
});
