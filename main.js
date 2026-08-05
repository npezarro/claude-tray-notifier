const { app, Notification, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { createServer } = require('./lib/server');
const { loadToken } = require('./lib/auth');
const { Poller } = require('./lib/poller');
const {
  formatNotification, buildHistoryEntry, MAX_NOTIFICATIONS, normalizeOrigin, shouldNotify, SYSTEM
} = require('./lib/format');
const { setupAutoUpdater, checkForUpdatesManual } = require('./lib/updater');
const { readLocalConversation } = require('./lib/conversation');
const sessionRegistry = require('./lib/sessions');

const PORT = 9377;
const notifications = [];

// System-generated sessions (headless runners, scheduled agents) are kept in their own
// list and are muted: no OS notification, no sound, no tray colour change. They
// outnumber interactive sessions by roughly 3:1 in practice, so mixing them into the
// main feed buried the sessions the user was actually waiting on.
const systemNotifications = [];
const MAX_SYSTEM_NOTIFICATIONS = 60;
let systemMuted = true;

const sessionDetailWindows = new Map(); // sessionId -> BrowserWindow
const activeNotifications = new Set(); // prevent GC of native notifications before click
const MAX_DETAIL_WINDOWS = 5;
let lastNotificationSessionId = null; // track which session the latest notification belongs to

// Tray states: idle (gray ghost), listening (green ghost), unread (amber ghost)
const TRAY_STATE = { IDLE: 'idle', LISTENING: 'listening', UNREAD: 'unread' };
let hasUnread = false;
let isConnected = false;

// Local mode: no relay is configured, so the Claude Code hook POSTs straight to the local
// server on PORT. There is nothing to poll and nothing to be disconnected from, so the
// relay-shaped connection states do not apply.
let localMode = false;

let tray = null;
let dropdownWindow = null;
let token;
let activePoller = null;
let localServer = null;

function trayIcon(state) {
  const name = `ghost-${state}.png`;
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name));
}

function setTrayState(state) {
  if (tray) {
    tray.setImage(trayIcon(state));
  }
}

let authExpired = false;

function connectionLabel() {
  if (localMode) return `Listening locally on port ${PORT}`;
  return isConnected ? 'Connected to relay' : 'Disconnected';
}

function pushConnectionStatus() {
  if (dropdownWindow && !dropdownWindow.isDestroyed()) {
    dropdownWindow.webContents.send('connection-status', { connected: isConnected, authExpired });
  }
}

function pushSystemUpdate() {
  if (dropdownWindow && !dropdownWindow.isDestroyed()) {
    dropdownWindow.webContents.send('system-updated', {
      notifications: systemNotifications,
      muted: systemMuted
    });
  }
}

function showNotification(payload) {
  // Always record the session, whatever its origin — the System tab and the session
  // detail window both read from the registry.
  const session = sessionRegistry.addNotification(payload);

  if (normalizeOrigin(payload.origin) === SYSTEM) {
    systemNotifications.unshift(buildHistoryEntry(payload));
    if (systemNotifications.length > MAX_SYSTEM_NOTIFICATIONS) {
      systemNotifications.length = MAX_SYSTEM_NOTIFICATIONS;
    }
    pushSystemUpdate();
  }

  // Muted means muted: no native notification, no tray state change, no sound. The
  // unmute override exists for when the user is deliberately watching a runner.
  if (!shouldNotify(payload, systemMuted)) return;

  showInteractiveNotification(payload, session);
}

function showInteractiveNotification(payload, session) {
  const { title, body } = formatNotification(payload);

  const notification = new Notification({ title, body, silent: false });

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
    pushSystemUpdate();
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
  pushSystemUpdate();
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

function setSystemMuted(next) {
  systemMuted = !!next;
  pushSystemUpdate();
}

/**
 * Fetch a session's full conversation.
 *
 * Local mode reads the transcript directly, since it is on this machine by definition.
 * With a relay, the session may have run elsewhere: the relay stores no conversation text
 * and pulls it from the originating machine, which can legitimately be offline. Either
 * way the renderer gets a structured error to display rather than a bare rejection.
 */
function fetchConversation(sessionId) {
  const relayUrl = loadRelayUrl();
  if (!relayUrl) {
    return readLocalConversation(sessionId);
  }

  return new Promise((resolve) => {
    if (!token) {
      return resolve({ ok: false, error: 'no_token', message: 'No auth token configured' });
    }

    const base = relayUrl.replace(/\/$/, '');
    const url = new URL(`${base}/api/notify/conversation/${encodeURIComponent(sessionId)}`);
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (_e) {
          return resolve({
            ok: false, error: 'malformed_response',
            message: `Relay returned a non-JSON response (HTTP ${res.statusCode})`
          });
        }
        if (res.statusCode === 200) return resolve({ ok: true, conversation: parsed });
        resolve({
          ok: false,
          error: parsed.error || `http_${res.statusCode}`,
          message: parsed.message || `Relay returned HTTP ${res.statusCode}`
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', message: 'The relay did not respond in time' });
    });
    req.on('error', (e) => {
      resolve({ ok: false, error: 'network', message: e.message });
    });
    req.end();
  });
}

function loadRelayUrl() {
  const configPath = path.join(os.homedir(), '.config', 'claude-tray', 'relay-url');
  try {
    return fs.readFileSync(configPath, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

let callbackServer = null;

function syncTokenFromServer() {
  const relayUrl = loadRelayUrl();
  if (!relayUrl) {
    new Notification({ title: 'Token Sync Failed', body: 'No relay URL configured' }).show();
    return;
  }

  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
  }

  const baseUrl = relayUrl.replace(/\/$/, '');
  const successPage = `<html><body style="font-family:-apple-system,sans-serif;background:#1e1e1e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <div style="text-align:center"><h2 style="color:#4ade80">Token Synced</h2><p>You can close this tab.</p></div></body></html>`;

  callbackServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === '/token-callback') {
      const newToken = url.searchParams.get('token');
      if (newToken && newToken.length >= 32 && /^[a-f0-9]+$/.test(newToken)) {
        token = newToken;
        saveToken(token);
        if (activePoller) activePoller.updateToken(token);
        authExpired = false;
        pushConnectionStatus();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(successPage);
        new Notification({ title: 'Token Synced', body: 'Connection restored', silent: false }).show();
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid token');
      }
      setTimeout(() => { callbackServer.close(); callbackServer = null; }, 2000);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  callbackServer.listen(0, '127.0.0.1', () => {
    const port = callbackServer.address().port;
    const callbackUrl = `http://localhost:${port}/token-callback`;
    const tokenUrl = `${baseUrl}/tools/claude-tray-token?callback=${encodeURIComponent(callbackUrl)}`;
    shell.openExternal(tokenUrl);
  });

  // Auto-cleanup after 2 minutes if user never completes auth
  setTimeout(() => {
    if (callbackServer) { callbackServer.close(); callbackServer = null; }
  }, 120000);
}

function saveToken(newToken) {
  const configDir = path.join(os.homedir(), '.config', 'claude-tray');
  fs.mkdirSync(configDir, { recursive: true });
  // 0600 to match generate-token.sh — this is a shared secret, and any local process that
  // can read it can post notifications as the user.
  fs.writeFileSync(path.join(configDir, 'token'), newToken.trim(), { mode: 0o600 });
}

/**
 * Bring the app up for whichever mode is configured.
 *
 * Local mode is the default: with no relay URL on disk there is nothing to poll, so the
 * app would otherwise sit on the gray idle icon forever while quietly working fine. The
 * local server is the delivery path, so once it is listening the app genuinely is.
 */
function startListening(activeToken) {
  if (!localServer) {
    // A getter, not the value: the token can be regenerated from the tray menu while this
    // server is listening, and it must start accepting the new one immediately.
    localServer = createServer(PORT, () => token, (payload) => {
      showNotification(payload);
    });
  }

  if (loadRelayUrl()) {
    localMode = false;
    startPoller(activeToken);
    return;
  }

  localMode = true;
  isConnected = true;
  authExpired = false;
  if (!hasUnread) setTrayState(TRAY_STATE.LISTENING);
  pushConnectionStatus();
  console.log(`Local mode — listening on http://127.0.0.1:${PORT}/notify`);
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
    authExpired = false;
    pushConnectionStatus();
    if (!hasUnread) setTrayState(TRAY_STATE.LISTENING);
  };
  activePoller.onDisconnected = () => {
    isConnected = false;
    pushConnectionStatus();
  };
  activePoller.onAuthFailed = () => {
    authExpired = true;
    setTrayState(TRAY_STATE.IDLE);
    pushConnectionStatus();
    const n = new Notification({
      title: 'Auth Token Expired',
      body: 'Click to sync token from server',
      silent: false
    });
    n.on('click', () => syncTokenFromServer());
    n.show();
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

  // In local mode the token is just a shared secret between the hook and this app, so
  // there is nothing to paste in from anywhere — Generate is the normal path. Pasting
  // only matters when a relay issued the token.
  const html = `
    <html><body style="font-family:-apple-system,sans-serif;background:#1e1e1e;color:#e0e0e0;padding:20px;display:flex;flex-direction:column;gap:12px">
      <label style="font-size:13px">Paste an auth token, or generate one for local use:</label>
      <input id="t" style="width:100%;padding:8px;border:1px solid #555;border-radius:4px;background:#2a2a2a;color:#e0e0e0;font-family:monospace;font-size:12px" autofocus>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="require('electron').ipcRenderer.send('token-cancel')" style="padding:6px 16px;border:1px solid #555;border-radius:4px;background:#333;color:#e0e0e0;cursor:pointer">Cancel</button>
        <button onclick="require('electron').ipcRenderer.send('token-generate')" style="padding:6px 16px;border:1px solid #555;border-radius:4px;background:#333;color:#e0e0e0;cursor:pointer">Generate</button>
        <button onclick="require('electron').ipcRenderer.send('token-submit',document.getElementById('t').value)" style="padding:6px 16px;border:none;border-radius:4px;background:#4a9eff;color:#fff;cursor:pointer">Save</button>
      </div>
      <script>document.getElementById('t').addEventListener('keydown',e=>{if(e.key==='Enter')require('electron').ipcRenderer.send('token-submit',document.getElementById('t').value)})</script>
    </body></html>`;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  const accept = (value) => {
    token = value;
    saveToken(token);
    startListening(token);
    win.close();
    cleanup();
  };

  const onSubmit = (_e, val) => {
    if (val && val.trim()) return accept(val.trim());
    win.close();
    cleanup();
  };
  const onGenerate = () => {
    // Same shape generate-token.sh produces, so the two paths are interchangeable.
    accept(crypto.randomBytes(32).toString('hex'));
    new Notification({
      title: 'Token Generated',
      body: 'Saved to ~/.config/claude-tray/token — the hook reads it from there.'
    }).show();
  };
  const onCancel = () => { win.close(); cleanup(); };
  const cleanup = () => {
    ipcMain.removeListener('token-submit', onSubmit);
    ipcMain.removeListener('token-generate', onGenerate);
    ipcMain.removeListener('token-cancel', onCancel);
  };

  ipcMain.once('token-submit', onSubmit);
  ipcMain.once('token-generate', onGenerate);
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
      { label: connectionLabel(), enabled: false },
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
      {
        label: `${systemNotifications.length} system event${systemNotifications.length !== 1 ? 's' : ''}`,
        enabled: false
      },
      {
        label: 'Mute System Sessions',
        type: 'checkbox',
        checked: systemMuted,
        click: () => setSystemMuted(!systemMuted)
      },
      { label: 'Clear System Queue', click: () => {
        systemNotifications.length = 0;
        pushSystemUpdate();
      }},
      { type: 'separator' },
      { label: 'Set Auth Token...', click: () => promptForToken() },
      // Token sync is a relay feature — it opens the relay's token page and takes the new
      // token back on a loopback callback. In local mode there is no server to sync from,
      // and offering it would just produce an error dialog.
      ...(localMode ? [] : [{ label: 'Sync Token from Server', click: () => syncTokenFromServer() }]),
      { label: 'Check for Updates', click: () => checkForUpdatesManual() },
      { label: 'Quit', click: () => app.quit() }
    ]);
    tray.popUpContextMenu(contextMenu);
  });

  // Pre-create the dropdown window
  createWindow();

  // The local server always runs: it is the delivery path in local mode, and a direct
  // POST target for testing when a relay is configured.
  if (token) {
    startListening(token);
  } else {
    console.log('No token configured — use Set Auth Token in the menu');
    promptForToken();
  }

  // Auto-updater (checks on startup + every 4h)
  setupAutoUpdater();

  // Prune stale sessions every hour
  setInterval(() => sessionRegistry.pruneOld(), 60 * 60 * 1000);

  console.log('Claude Tray Notifier ready');
  console.log(`Local server: http://127.0.0.1:${PORT}/notify`);
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

ipcMain.handle('get-sessions', (_event, origin) => {
  return sessionRegistry.getSessions(origin);
});

ipcMain.handle('get-system-notifications', () => {
  return { notifications: systemNotifications, muted: systemMuted };
});

ipcMain.on('set-system-muted', (_event, muted) => {
  setSystemMuted(muted);
});

ipcMain.handle('fetch-conversation', (_event, sessionId) => {
  return fetchConversation(sessionId);
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
