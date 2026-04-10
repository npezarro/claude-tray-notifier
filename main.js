const { app, Notification, Tray, Menu, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { createServer } = require('./lib/server');
const { loadToken } = require('./lib/auth');
const { Poller } = require('./lib/poller');

const PORT = 9377;
const MAX_NOTIFICATIONS = 20;
const notifications = [];

let tray = null;
let window = null;
let token;

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

  // Update tray title briefly to signal activity
  if (tray) {
    tray.setTitle(' !');
    setTimeout(() => {
      if (tray) tray.setTitle('');
    }, 10000);
  }

  // Push update to renderer if window exists
  if (window && !window.isDestroyed()) {
    window.webContents.send('notifications-updated', notifications);
  }
}

function toggleWindow() {
  if (!window || window.isDestroyed()) {
    createWindow();
  } else if (window.isVisible()) {
    window.hide();
  } else {
    showWindow();
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 380,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.loadFile('index.html');

  window.on('blur', () => {
    if (window && !window.isDestroyed()) window.hide();
  });
}

function showWindow() {
  if (!window || window.isDestroyed()) {
    createWindow();
  }

  // Position window below the tray icon
  const trayBounds = tray.getBounds();
  const windowBounds = window.getBounds();
  const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  const y = Math.round(trayBounds.y + trayBounds.height + 4);

  window.setPosition(x, y, false);
  window.show();
  window.focus();
  window.webContents.send('notifications-updated', notifications);
}

app.whenReady().then(() => {
  // Hide dock icon on macOS
  if (app.dock) app.dock.hide();

  // Load auth token
  token = loadToken();
  if (!token) {
    console.error('No token found. Run scripts/generate-token.sh first.');
    console.error('Expected at ~/.config/claude-tray/token');
    app.quit();
    return;
  }

  // Create tray with text title instead of icon (reliable across all macOS versions)
  tray = new Tray(path.join(__dirname, 'assets', 'tray-idleTemplate.png'));
  tray.setTitle(' C');
  tray.setToolTip('Claude Code Notifier');

  // Left click toggles the dropdown window
  tray.on('click', () => {
    toggleWindow();
  });

  // Right click shows a simple context menu
  tray.on('right-click', () => {
    const contextMenu = Menu.buildFromTemplate([
      { label: `Claude Tray Notifier v${require('./package.json').version}`, enabled: false },
      { label: `Polling pezant.ca`, enabled: false },
      { type: 'separator' },
      { label: `Notifications: ${notifications.length}`, enabled: false },
      { label: 'Clear All', click: () => { notifications.length = 0; } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]);
    tray.popUpContextMenu(contextMenu);
  });

  // Pre-create the dropdown window
  createWindow();

  // Start local HTTP server (for direct testing)
  createServer(PORT, token, (payload) => {
    showNotification(payload);
  });

  // Start polling pezant.ca relay for notifications from WSL2
  const poller = new Poller('https://pezant.ca', token, (payload) => {
    showNotification(payload);
  });
  poller.start(2000);

  console.log('Claude Tray Notifier ready');
  console.log(`Local server: 127.0.0.1:${PORT}`);
  console.log('Polling: https://pezant.ca/tools/notify/poll every 2s');
});

// IPC handlers
ipcMain.on('clear-notifications', () => {
  notifications.length = 0;
  if (window && !window.isDestroyed()) {
    window.webContents.send('notifications-updated', notifications);
  }
});

ipcMain.on('quit', () => {
  app.quit();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
