const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sessionApi', {
  getSession: (id) => ipcRenderer.invoke('get-session', id),
  onSessionInfo: (callback) => {
    ipcRenderer.on('session-info', (_event, data) => callback(data));
  },
  onSessionUpdated: (callback) => {
    ipcRenderer.on('session-updated', (_event, data) => callback(data));
  }
});
