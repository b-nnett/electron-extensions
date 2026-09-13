const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('styleLab', {
  snapshot: () => ipcRenderer.invoke('fixture:snapshot'),
  launch: () => ipcRenderer.invoke('fixture:action', 'launch'),
  applyCSS: css => ipcRenderer.invoke('fixture:action', 'apply', css),
  removeCSS: () => ipcRenderer.invoke('fixture:action', 'remove'),
  installButton: () => ipcRenderer.invoke('fixture:action', 'installButton'),
  removeButton: () => ipcRenderer.invoke('fixture:action', 'removeButton'),
  reload: () => ipcRenderer.invoke('fixture:action', 'reload'),
  verify: () => ipcRenderer.invoke('fixture:action', 'verify'),
  stop: () => ipcRenderer.invoke('fixture:action', 'stop'),
  subscribe: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('fixture:state', listener);
    return () => ipcRenderer.removeListener('fixture:state', listener);
  },
});
