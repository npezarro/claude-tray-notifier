const { app, Notification, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { createServer } = require('./lib/server');
const { loadToken } = require('./lib/auth');
const { Poller } = require('./lib/poller');
const { formatNotification, buildHistoryEntry, MAX_NOTIFICATIONS } = require('./lib/format');
const { setupAutoUpdater, checkForUpdatesManual } = require('./lib/updater');
const sessionRegistry = require('./lib/sessions');

const PORT = 9377;
const notifications = [];
const sessionDetailWindows = new Map(); // sessionId -> BrowserWindow
const MAX_DETAIL_WINDOWS = 5;

// Tray states: idle (gray ghost), listening (green ghost), unread (amber ghost)
const TRAY_STATE = { IDLE: 'idle', LISTENING: 'listening', UNREAD: 'unread' };
let currentState = TRAY_STATE.IDLE;
let hasUnread = false;
let isConnected = false;

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

function pushConnectionStatus() {
  if (dropdownWindow && !dropdownWindow.isDestroyed()) {
    dropdownWindow.webContents.send('connection-status', { connected: isConnected });
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

  // Track in session registry
  const session = sessionRegistry.addNotification(payload);

  // Switch to unread (amber ghost)
  hasUnread = true;
  setTrayState(TRAY_STATE.UNREAD);

  // Push update to dropdown if open
  if (dropdownWindow && !dropdownWindow.isDestroyed()) {
    dropdownWindow.webContents.send('notifications-updated', notifications);
  }

  // Push update to any open session detail window for this session
  if (session) {
    const detailWin = sessionDetailWindows.get(session.sessionId);
    if (detailWin && !detailWin.isDestroyed()) {
      const fullSession = sessionRegistry.getSession(session.sessionId);
      detailWin.webContents.send('session-updated', fullSession);
    }
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
    height: 480,
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

  // Send connection status once the page loads
  dropdownWindow.webContents.on('did-finish-load', () => {
    pushConnectionStatus();
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
  pushConnectionStatus();

  // Opening the dropdown marks notifications as read
  markAllRead();
}

function openSessionDetail(sessionData) {
  const id = sessionData.sessionId;

  // Reuse existing window
  const existing = sessionDetailWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    const freshSession = sessionRegistry.getSession(id);
    if (freshSession) existing.webContents.send('session-info', freshSession);
    return;
  }

  // Enforce max windows
  if (sessionDetailWindows.size >= MAX_DETAIL_WINDOWS) {
    // Close the oldest
    for (const [oldId, win] of sessionDetailWindows) {
      if (!win.isDestroyed()) win.close();
      sessionDetailWindows.delete(oldId);
      break;
    }
  }

  const win = new BrowserWindow({
    width: 700,
    height: 600,
    title: `Session: ${sessionData.project}`,
    webPreferences: {
      preload: path.join(__dirname, 'preload-session.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('session-detail.html');

  win.webContents.on('did-finish-load', () => {
    const freshSession = sessionRegistry.getSession(id);
    win.webContents.send('session-info', freshSession || sessionData);
  });

  win.on('closed', () => {
    sessionDetailWindows.delete(id);
  });

  sessionDetailWindows.set(id, win);
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
    const sessionCount = sessionRegistry.size();
    const contextMenu = Menu.buildFromTemplate([
      { label: `Claude Tray Notifier v${require('./package.json').version}`, enabled: false },
      { label: isConnected ? 'Connected to relay' : 'Disconnected', enabled: false },
      { label: `${sessionCount} session${sessionCount !== 1 ? 's' : ''} tracked`, enabled: false },
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

  // Start polling relay server
  const poller = new Poller('https://pezant.ca', token, (payload) => {
    showNotification(payload);
  });
  poller.onConnected = () => {
    isConnected = true;
    pushConnectionStatus();
    if (!hasUnread) setTrayState(TRAY_STATE.LISTENING);
  };
  poller.onDisconnected = () => {
    isConnected = false;
    pushConnectionStatus();
  };
  poller.start(2000);

  // Switch to listening (green ghost) after first successful connection
  setTrayState(TRAY_STATE.LISTENING);

  // Auto-updater (checks on startup + every 4h)
  setupAutoUpdater();

  // Prune stale sessions every hour
  setInterval(() => sessionRegistry.pruneOld(), 60 * 60 * 1000);

  console.log('Claude Tray Notifier ready');
  console.log(`Local server: 127.0.0.1:${PORT}`);
  console.log('Polling: https://pezant.ca/api/notify/poll every 2s');
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

ipcMain.handle('get-sessions', () => {
  return sessionRegistry.getSessions();
});

ipcMain.handle('get-session', (_event, sessionId) => {
  return sessionRegistry.getSession(sessionId);
});

ipcMain.on('open-session-detail', (_event, sessionData) => {
  openSessionDetail(sessionData);
});

ipcMain.on('quit', () => {
  app.quit();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
