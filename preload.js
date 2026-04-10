const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onNotificationsUpdated: (callback) => {
    ipcRenderer.on('notifications-updated', (_event, data) => callback(data));
  },
  clearNotifications: () => {
    ipcRenderer.send('clear-notifications');
  },
  quit: () => {
    ipcRenderer.send('quit');
  }
});
