const { autoUpdater } = require('electron-updater');
const { dialog, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Update downloaded: v${info.version}`);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `v${info.version} downloaded. Restart now?`,
      buttons: ['Restart Now', 'Later']
    }).then(({ response }) => {
      if (response === 0) {
        // Must remove window-all-closed handler that prevents quit
        app.removeAllListeners('window-all-closed');
        autoUpdater.quitAndInstall(false, true);
      }
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
    dialog.showMessageBox({ type: 'warning', title: 'Auto-Update', message: 'Not configured. Set URL in ~/.config/claude-tray/update-url' });
    return;
  }
  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });

  const version = require('../package.json').version;

  autoUpdater.once('update-not-available', () => {
    dialog.showMessageBox({ type: 'info', title: 'No Update Available', message: `You're on the latest version (v${version}).` });
  });
  autoUpdater.once('update-available', (info) => {
    dialog.showMessageBox({ type: 'info', title: 'Update Found', message: `v${info.version} is downloading...` });
  });
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Manual update check failed:', err.message);
    dialog.showMessageBox({ type: 'error', title: 'Update Check Failed', message: err.message });
  });
}

module.exports = { setupAutoUpdater, checkForUpdatesManual };
