const { autoUpdater } = require('electron-updater');
const { Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Keep references to prevent GC before user clicks
const activeNotifications = new Set();

function showNotif(title, body, onClick) {
  const n = new Notification({ title, body, silent: true });
  activeNotifications.add(n);
  if (onClick) n.on('click', () => { onClick(); activeNotifications.delete(n); });
  n.on('close', () => activeNotifications.delete(n));
  n.show();
  return n;
}

function loadUpdateUrl() {
  const configPath = path.join(os.homedir(), '.config', 'claude-tray', 'update-url');
  try {
    return fs.readFileSync(configPath, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function setupAutoUpdater() {
  const updateUrl = loadUpdateUrl();
  if (!updateUrl) {
    console.log('No update URL configured at ~/.config/claude-tray/update-url — auto-update disabled');
    return;
  }

  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: v${info.version}`);
    showNotif('Update Available', `Claude Tray Notifier v${info.version} is downloading...`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Update downloaded: v${info.version}`);
    showNotif('Update Ready', `v${info.version} downloaded. Click to restart.`, () => {
      autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err.message);
  });

  // Check on startup (with delay to let the app settle)
  const startupTimer = setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 5000);

  // Check every 4 hours
  const periodicTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);

  return { startupTimer, periodicTimer };
}

function checkForUpdatesManual() {
  const updateUrl = loadUpdateUrl();
  if (!updateUrl) {
    showNotif('Auto-Update Not Configured', 'Set update URL in ~/.config/claude-tray/update-url');
    return;
  }
  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });

  const version = require('../package.json').version;

  autoUpdater.once('update-not-available', () => {
    showNotif('No Update Available', `You're on the latest version (v${version}).`);
  });
  autoUpdater.once('update-available', (info) => {
    showNotif('Update Found', `v${info.version} is downloading...`);
  });
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Manual update check failed:', err.message);
    showNotif('Update Check Failed', err.message);
  });
}

module.exports = { setupAutoUpdater, checkForUpdatesManual };
