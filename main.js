const { app, Notification, nativeImage, ipcMain } = require('electron');
const { menubar } = require('menubar');
const path = require('path');
const { createServer } = require('./lib/server');
const { loadToken } = require('./lib/auth');

const PORT = 9377;
const MAX_NOTIFICATIONS = 20;
const notifications = [];

let mb;
let token;

function createTrayIcon(active = false) {
  const iconName = active ? 'tray-active.png' : 'tray-idle.png';
  return nativeImage.createFromPath(path.join(__dirname, 'assets', iconName));
}

function showNotification(payload) {
  const isInputNeeded = payload.type === 'input_needed';
  const title = 'Claude Code';
  let body;

  if (isInputNeeded) {
    body = `[${payload.project}] Input needed`;
  } else {
    const summary = payload.summary ? ` — ${payload.summary.slice(0, 100)}` : '';
    body = `[${payload.project}] Response ready${summary}`;
  }

  const notification = new Notification({ title, body, silent: false });
  notification.show();

  // Store in history
  notifications.unshift({
    type: payload.type,
    project: payload.project,
    summary: payload.summary || '',
    timestamp: payload.timestamp || new Date().toISOString(),
    sessionId: payload.session_id
  });
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications.length = MAX_NOTIFICATIONS;
  }

  // Flash tray icon
  if (mb && mb.tray) {
    mb.tray.setImage(createTrayIcon(true));
    setTimeout(() => {
      if (mb && mb.tray) mb.tray.setImage(createTrayIcon(false));
    }, 10000);
  }

  // Push update to renderer if window exists
  if (mb && mb.window && !mb.window.isDestroyed()) {
    mb.window.webContents.send('notifications-updated', notifications);
  }
}

app.whenReady().then(() => {
  // Hide dock icon
  app.dock?.hide();

  // Load auth token
  token = loadToken();
  if (!token) {
    console.error('No token found. Run scripts/generate-token.sh first.');
    app.quit();
    return;
  }

  // Create menubar
  mb = menubar({
    index: `file://${path.join(__dirname, 'index.html')}`,
    icon: createTrayIcon(false),
    preloadWindow: true,
    showDockIcon: false,
    browserWindow: {
      width: 380,
      height: 420,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    }
  });

  mb.on('ready', () => {
    console.log('Claude Tray Notifier ready');

    // Start HTTP server
    createServer(PORT, token, (payload) => {
      showNotification(payload);
    });

    console.log(`Listening on 127.0.0.1:${PORT}`);
  });

  mb.on('after-show', () => {
    if (mb.window && !mb.window.isDestroyed()) {
      mb.window.webContents.send('notifications-updated', notifications);
    }
  });

  // IPC handlers
  ipcMain.on('clear-notifications', () => {
    notifications.length = 0;
    if (mb.window && !mb.window.isDestroyed()) {
      mb.window.webContents.send('notifications-updated', notifications);
    }
  });

  ipcMain.on('quit', () => {
    app.quit();
  });
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // Keep running as tray app
});
