const { autoUpdater } = require('electron-updater');
const { dialog, app } = require('electron');
const { spawn } = require('child_process');
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

function findDownloadedZip() {
  // electron-updater caches downloads here
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'claude-tray-notifier-updater');
  try {
    const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.zip'));
    if (files.length === 0) return null;
    // Return the most recently modified zip
    return files
      .map(f => ({ name: f, path: path.join(cacheDir, f), mtime: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].path;
  } catch (_) {
    return null;
  }
}

function installAndRelaunch() {
  const appPath = app.getPath('exe').replace(/\/Contents\/MacOS\/.*$/, '');
  const zipPath = findDownloadedZip();

  if (!zipPath) {
    dialog.showMessageBox({ type: 'error', title: 'Update Failed', message: 'Could not find downloaded update file.' });
    return;
  }

  const appDir = path.dirname(appPath);

  // Spawn a detached shell script that:
  // 1. Waits for this process to exit
  // 2. Extracts the zip (replacing the .app)
  // 3. Removes quarantine attribute
  // 4. Relaunches the app
  const script = `
    sleep 1
    unzip -o "${zipPath}" -d "${appDir}" > /dev/null 2>&1
    xattr -rd com.apple.quarantine "${appPath}" 2>/dev/null
    open "${appPath}"
  `;

  const child = spawn('/bin/bash', ['-c', script], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // Now quit the app
  app.exit(0);
}

function setupAutoUpdater() {
  const updateUrl = loadUpdateUrl();
  if (!updateUrl) {
    console.log('No update URL configured at ~/.config/claude-tray/update-url — auto-update disabled');
    return;
  }

  autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // We handle install ourselves

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
      if (response === 0) installAndRelaunch();
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
