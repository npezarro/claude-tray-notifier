const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onNotificationsUpdated: (callback) => {
    ipcRenderer.on('notifications-updated', (_event, data) => callback(data));
  },
  onConnectionStatus: (callback) => {
    ipcRenderer.on('connection-status', (_event, data) => callback(data));
  },
  onSystemUpdated: (callback) => {
    ipcRenderer.on('system-updated', (_event, data) => callback(data));
  },
  clearNotifications: () => {
    ipcRenderer.send('clear-notifications');
  },
  getSessions: (origin) => ipcRenderer.invoke('get-sessions', origin),
  getSession: (id) => ipcRenderer.invoke('get-session', id),
  getSystemNotifications: () => ipcRenderer.invoke('get-system-notifications'),
  setSystemMuted: (muted) => ipcRenderer.send('set-system-muted', muted),
  openSessionDetail: (sessionId) => ipcRenderer.send('open-session-detail', sessionId),
  quit: () => {
    ipcRenderer.send('quit');
  }
});
