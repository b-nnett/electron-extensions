const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

// Deliberately no preload, IPC, extension loader, CSS injection, or debug setup.
// Debugging, when wanted, is enabled externally using Electron's launch argument.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const win = new BrowserWindow({
    width: 680, height: 720, x: 740, y: 90,
    title: 'Style Lab', backgroundColor: '#f3f2ee',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
