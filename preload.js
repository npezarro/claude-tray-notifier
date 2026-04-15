const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onNotificationsUpdated: (callback) => {
    ipcRenderer.on('notifications-updated', (_event, data) => callback(data));
  },
  onConnectionStatus: (callback) => {
    ipcRenderer.on('connection-status', (_event, data) => callback(data));
  },
  clearNotifications: () => {
    ipcRenderer.send('clear-notifications');
  },
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  getSession: (id) => ipcRenderer.invoke('get-session', id),
  openSessionDetail: (sessionId) => ipcRenderer.send('open-session-detail', sessionId),
  quit: () => {
    ipcRenderer.send('quit');
  }
});
