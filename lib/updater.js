const { autoUpdater } = require('electron-updater');
const { Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

function loadUpdateUrl() {
  // Read update server URL from config (keeps domain out of public repo)
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
    const notification = new Notification({
      title: 'Update Available',
      body: `Claude Tray Notifier v${info.version} is downloading...`,
      silent: true
    });
    notification.show();
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Update downloaded: v${info.version}`);
    const notification = new Notification({
      title: 'Update Ready',
      body: `v${info.version} downloaded. Restart to apply.`,
      silent: false
    });
    notification.on('click', () => {
      autoUpdater.quitAndInstall();
    });
    notification.show();
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
    const n = new Notification({ title: 'Auto-Update Not Configured', body: 'Set update URL in ~/.config/claude-tray/update-url', silent: true });
    n.show();
    return;
  }
  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
  autoUpdater.once('update-not-available', () => {
    const n = new Notification({ title: 'No Update Available', body: 'You\'re on the latest version.', silent: true });
    n.show();
  });
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('Manual update check failed:', err.message);
    const notification = new Notification({
      title: 'Update Check Failed',
      body: err.message,
      silent: true
    });
    notification.show();
  });
}

module.exports = { setupAutoUpdater, checkForUpdatesManual };
