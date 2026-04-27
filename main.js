const { app, Notification, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
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
const activeNotifications = new Set(); // prevent GC of native notifications before click
const MAX_DETAIL_WINDOWS = 5;
let lastNotificationSessionId = null; // track which session the latest notification belongs to

// Tray states: idle (gray ghost), listening (green ghost), unread (amber ghost)
const TRAY_STATE = { IDLE: 'idle', LISTENING: 'listening', UNREAD: 'unread' };
let hasUnread = false;
let isConnected = false;

let tray = null;
let dropdownWindow = null;
let token;
let activePoller = null;

function trayIcon(state) {
  const name = `ghost-${state}.png`;
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name));
}

function setTrayState(state) {
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

  // Track in session registry (before show, so click handler can reference it)
  const session = sessionRegistry.addNotification(payload);

  // Track latest notification's session for app activate handler
  if (session) lastNotificationSessionId = session.sessionId;

  // Keep reference alive so macOS click handler isn't GC'd
  activeNotifications.add(notification);

  // Click notification -> open session detail window
  const notifSessionId = session ? session.sessionId : null;
  notification.on('click', () => {
    if (notifSessionId) {
      const freshSession = sessionRegistry.getSession(notifSessionId);
      if (freshSession) openSessionDetail(freshSession);
    }
    activeNotifications.delete(notification);
  });
  notification.on('close', () => {
    activeNotifications.delete(notification);
  });

  notification.show();

  // Store in history
  notifications.unshift(buildHistoryEntry(payload));
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications.length = MAX_NOTIFICATIONS;
  }

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
    // Hide dock icon when all detail windows are closed
    if (sessionDetailWindows.size === 0 && app.dock) {
      app.dock.hide();
    }
  });

  sessionDetailWindows.set(id, win);

  // Show dock icon when a detail window is open
  if (app.dock) app.dock.show();
}

function loadRelayUrl() {
  const configPath = path.join(os.homedir(), '.config', 'claude-tray', 'relay-url');
  try {
    return fs.readFileSync(configPath, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function saveToken(newToken) {
  const configDir = path.join(os.homedir(), '.config', 'claude-tray');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'token'), newToken.trim());
}

function startPoller(pollerToken) {
  if (activePoller) activePoller.stop();

  const relayUrl = loadRelayUrl();
  if (!relayUrl) {
    console.error('No relay URL configured at ~/.config/claude-tray/relay-url');
    return;
  }

  activePoller = new Poller(relayUrl, pollerToken, (payload) => {
    showNotification(payload);
  });
  activePoller.onConnected = () => {
    isConnected = true;
    pushConnectionStatus();
    if (!hasUnread) setTrayState(TRAY_STATE.LISTENING);
  };
  activePoller.onDisconnected = () => {
    isConnected = false;
    pushConnectionStatus();
  };
  activePoller.start(2000);
}

function promptForToken() {
  // Use a tiny BrowserWindow with an input field since Electron has no native prompt
  const win = new BrowserWindow({
    width: 420,
    height: 160,
    title: 'Set Auth Token',
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  const html = `
    <html><body style="font-family:-apple-system,sans-serif;background:#1e1e1e;color:#e0e0e0;padding:20px;display:flex;flex-direction:column;gap:12px">
      <label style="font-size:13px">Paste your auth token:</label>
      <input id="t" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#e0e0e0;font-family:monospace;font-size:12px" autofocus>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="require('electron').ipcRenderer.send('token-cancel')" style="padding:6px 16px;border:1px solid #555;border-radius:4px;background:#333;color:#e0e0e0;cursor:pointer">Cancel</button>
        <button onclick="require('electron').ipcRenderer.send('token-submit',document.getElementById('t').value)" style="padding:6px 16px;border:none;border-radius:4px;background:#4a9eff;color:#fff;cursor:pointer">Save</button>
      </div>
      <script>document.getElementById('t').addEventListener('keydown',e=>{if(e.key==='Enter')require('electron').ipcRenderer.send('token-submit',document.getElementById('t').value)})</script>
    </body></html>`;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  const onSubmit = (_e, val) => {
    if (val && val.trim()) {
      token = val.trim();
      saveToken(token);
      startPoller(token);
    }
    win.close();
    cleanup();
  };
  const onCancel = () => { win.close(); cleanup(); };
  const cleanup = () => {
    ipcMain.removeListener('token-submit', onSubmit);
    ipcMain.removeListener('token-cancel', onCancel);
  };

  ipcMain.once('token-submit', onSubmit);
  ipcMain.once('token-cancel', onCancel);
}

app.whenReady().then(() => {
  // Hide dock icon on macOS
  if (app.dock) app.dock.hide();

  // Load auth token (app still starts without one — user can set via menu)
  token = loadToken();

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
      { label: 'Set Auth Token...', click: () => promptForToken() },
      { label: 'Check for Updates', click: () => checkForUpdatesManual() },
      { label: 'Quit', click: () => app.quit() }
    ]);
    tray.popUpContextMenu(contextMenu);
  });

  // Pre-create the dropdown window
  createWindow();

  // Start local HTTP server (for direct testing)
  if (token) {
    createServer(PORT, token, (payload) => {
      showNotification(payload);
    });
    startPoller(token);
  } else {
    console.log('No token configured — use Set Auth Token in the menu');
    promptForToken();
  }

  // Auto-updater (checks on startup + every 4h)
  setupAutoUpdater();

  // Prune stale sessions every hour
  setInterval(() => sessionRegistry.pruneOld(), 60 * 60 * 1000);

  console.log('Claude Tray Notifier ready');
  console.log(`Local server: 127.0.0.1:${PORT}`);
  console.log('Polling relay server every 2s');
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

ipcMain.on('open-session-detail', (_event, sessionId) => {
  const sessionData = sessionRegistry.getSession(sessionId);
  if (sessionData) openSessionDetail(sessionData);
});

ipcMain.on('quit', () => {
  app.quit();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// When app is activated (e.g. clicking a notification), open the last notified session
app.on('activate', () => {
  if (lastNotificationSessionId) {
    const session = sessionRegistry.getSession(lastNotificationSessionId);
    if (session) openSessionDetail(session);
    lastNotificationSessionId = null;
  }
});
