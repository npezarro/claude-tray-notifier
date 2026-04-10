const { app, Notification, Tray, Menu, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { createServer } = require('./lib/server');
const { loadToken } = require('./lib/auth');
const { Poller } = require('./lib/poller');

const PORT = 9377;
const MAX_NOTIFICATIONS = 20;
const notifications = [];

// Tray states: idle (grayscale), listening (chartreuse), unread (orange)
const TRAY_STATE = { IDLE: 'idle', LISTENING: 'listening', UNREAD: 'unread' };
let currentState = TRAY_STATE.IDLE;
let hasUnread = false;

let tray = null;
let dropdownWindow = null;
let token;

function pandaIcon(state) {
  const name = `panda-${state}.png`;
  return nativeImage.createFromPath(path.join(__dirname, 'assets', name));
}

function setTrayState(state) {
  currentState = state;
  if (tray) {
    tray.setImage(pandaIcon(state));
  }
}

const INPUT_KIND_LABELS = {
  choice: 'Waiting for your choice',
  question: 'Has a question for you',
  approval: 'Needs approval',
  error: 'Hit an error',
  attention: 'Needs attention',
  done: 'Response ready',
  general: 'Finished'
};

function showNotification(payload) {
  const convTitle = payload.conv_title || payload.project;
  const inputKind = payload.input_kind || 'general';
  const kindLabel = INPUT_KIND_LABELS[inputKind] || INPUT_KIND_LABELS.general;

  let title, body;
  if (payload.type === 'input_needed') {
    title = `${convTitle}`;
    body = kindLabel;
  } else if (inputKind === 'done' || inputKind === 'general') {
    title = `${convTitle}`;
    const summary = payload.summary ? ` — ${payload.summary.slice(0, 100)}` : '';
    body = `${kindLabel}${summary}`;
  } else {
    // Response complete but classified as needing specific input
    title = `${convTitle}`;
    const summary = payload.summary ? `\n${payload.summary.slice(0, 80)}` : '';
    body = `${kindLabel}${summary}`;
  }

  const notification = new Notification({ title, body, silent: false });
  notification.show();

  // Store in history
  notifications.unshift({
    type: payload.type,
    project: payload.project,
    convTitle,
    inputKind,
    kindLabel,
    summary: payload.summary || '',
    timestamp: payload.timestamp || new Date().toISOString(),
    sessionId: payload.session_id,
    read: false
  });
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications.length = MAX_NOTIFICATIONS;
  }

  // Switch to unread (orange) panda
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

  // Create tray with grayscale panda (idle)
  tray = new Tray(pandaIcon(TRAY_STATE.IDLE));
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

  // Switch to listening (chartreuse) after first successful connection
  setTrayState(TRAY_STATE.LISTENING);

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
