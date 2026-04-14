const { app, Notification, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { createServer } = require('./lib/server');
const { loadToken } = require('./lib/auth');
const { Poller } = require('./lib/poller');
const { formatNotification, buildHistoryEntry, MAX_NOTIFICATIONS } = require('./lib/format');
const { setupAutoUpdater, checkForUpdatesManual } = require('./lib/updater');

const PORT = 9377;
const notifications = [];

// Tray states: idle (gray ghost), listening (green ghost), unread (amber ghost)
const TRAY_STATE = { IDLE: 'idle', LISTENING: 'listening', UNREAD: 'unread' };
let currentState = TRAY_STATE.IDLE;
let hasUnread = false;

let tray = null;
let dropdownWindow = null;
let token;

function trayIcon(state) {
  const name = `ghost-${state}.png`;
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name));
}

function setTrayState(state) {
  currentState = state;
  if (tray) {
    tray.setImage(trayIcon(state));
  }
}

function showNotification(payload) {
  const { title, body } = formatNotification(payload);

  const notification = new Notification({ title, body, silent: false });
  notification.show();

  // Store in history
  notifications.unshift(buildHistoryEntry(payload));
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications.length = MAX_NOTIFICATIONS;
  }

  // Switch to unread (amber ghost)
  hasUnread = true;
  setTrayState(TRAY_STATE.UNREAD);

  // Push update to renderer if window exists
  if (dropdownWindow && !dropdownWindow.isDestroyed()) {
    dropdownWindow.webContents.send('notifications-updated', notifications);
  }
}

function markAllRead() {
  for (const n of notifications) n.read = true;
  hasUnread = false;
  setTrayState(TRAY_STATE.LISTENING);
}

function toggleWindow() {
  if (!dropdownWindow || dropdownWindow.isDestroyed()) {
    createWindow();
  } else if (dropdownWindow.isVisible()) {
    dropdownWindow.hide();
  } else {
    showWindow();
  }
}

function createWindow() {
  dropdownWindow = new BrowserWindow({
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

  dropdownWindow.loadFile('index.html');

  dropdownWindow.on('blur', () => {
    if (dropdownWindow && !dropdownWindow.isDestroyed()) dropdownWindow.hide();
  });
}

function showWindow() {
  if (!dropdownWindow || dropdownWindow.isDestroyed()) {
    createWindow();
  }

  // Position window below the tray icon
  const trayBounds = tray.getBounds();
  const windowBounds = dropdownWindow.getBounds();
  const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  const y = Math.round(trayBounds.y + trayBounds.height + 4);

  dropdownWindow.setPosition(x, y, false);
  dropdownWindow.show();
  dropdownWindow.focus();
  dropdownWindow.webContents.send('notifications-updated', notifications);

  // Opening the dropdown marks notifications as read
  markAllRead();
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

  // Create tray with gray ghost (idle)
  tray = new Tray(trayIcon(TRAY_STATE.IDLE));
  tray.setToolTip('Claude Code Notifier');

  // Left click toggles the dropdown window
  tray.on('click', () => {
    toggleWindow();
  });

  // Right click shows a simple context menu
  tray.on('right-click', () => {
    const unreadCount = notifications.filter(n => !n.read).length;
    const contextMenu = Menu.buildFromTemplate([
      { label: `Claude Tray Notifier v${require('./package.json').version}`, enabled: false },
      { label: `Polling pezant.ca`, enabled: false },
      { type: 'separator' },
      { label: `${unreadCount} unread`, enabled: false },
      { label: 'Mark All Read', click: () => markAllRead() },
      { label: 'Clear All', click: () => {
        notifications.length = 0;
        hasUnread = false;
        setTrayState(TRAY_STATE.LISTENING);
      }},
      { type: 'separator' },
      { label: 'Check for Updates', click: () => checkForUpdatesManual() },
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

  // Start polling pezant.ca relay — go chartreuse once connected
  const poller = new Poller('https://pezant.ca', token, (payload) => {
    showNotification(payload);
  });
  poller.onConnected = () => {
    if (!hasUnread) setTrayState(TRAY_STATE.LISTENING);
  };
  poller.start(2000);

  // Switch to listening (green ghost) after first successful connection
  setTrayState(TRAY_STATE.LISTENING);

  // Auto-updater (checks on startup + every 4h)
  setupAutoUpdater();

  console.log('Claude Tray Notifier ready');
  console.log(`Local server: 127.0.0.1:${PORT}`);
  console.log('Polling: https://pezant.ca/tools/notify/poll every 2s');
});

// IPC handlers
ipcMain.on('clear-notifications', () => {
  notifications.length = 0;
  hasUnread = false;
  setTrayState(TRAY_STATE.LISTENING);
  if (dropdownWindow && !dropdownWindow.isDestroyed()) {
    dropdownWindow.webContents.send('notifications-updated', notifications);
  }
});

ipcMain.on('quit', () => {
  app.quit();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
