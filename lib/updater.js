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

  const appName = path.basename(appPath);
  const logPath = path.join(os.homedir(), 'Library', 'Logs', 'claude-tray-notifier-update.log');

  // Spawn a detached shell script that waits for this process to exit, then REPLACES
  // the .app bundle wholesale.
  //
  // This used to be `unzip -o "$zip" -d "$appDir"`, which merges the new files INTO the
  // existing bundle and leaves behind any file the new version dropped. The build is
  // ad-hoc code-signed, and Contents/_CodeSignature/CodeResources hashes every file in
  // the bundle — so a single stale leftover invalidates the signature and macOS then
  // refuses to launch the app, usually with no visible error. That is exactly what
  // happened on the first successful update after a long gap (1.7.1 -> 1.9.1).
  //
  // Extract to a staging dir, swap the old bundle aside, move the new one in, and only
  // delete the old copy once the new app is in place — so a failure mid-way leaves a
  // recoverable app rather than a half-written one. Output goes to a log, never
  // /dev/null: a silent installer failure is indistinguishable from "nothing happened".
  const script = `
    set -u
    exec >> "${logPath}" 2>&1
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') installing update from ${zipPath} ==="
    sleep 1

    STAGE="$(mktemp -d /tmp/claude-tray-update.XXXXXX)"
    trap 'rm -rf "$STAGE"' EXIT

    if ! unzip -q "${zipPath}" -d "$STAGE"; then
      echo "FAILED: could not extract the update zip"; exit 1
    fi
    if [ ! -d "$STAGE/${appName}" ]; then
      echo "FAILED: no ${appName} inside the update zip"; exit 1
    fi

    OLD="${appPath}.old-$$"
    if [ -d "${appPath}" ] && ! mv "${appPath}" "$OLD"; then
      echo "FAILED: could not move the existing app aside (in use? permissions?)"; exit 1
    fi

    if ! mv "$STAGE/${appName}" "${appPath}"; then
      echo "FAILED: could not move the new app into place; restoring the previous one"
      [ -d "$OLD" ] && mv "$OLD" "${appPath}"
      exit 1
    fi
    rm -rf "$OLD"

    xattr -rd com.apple.quarantine "${appPath}" 2>/dev/null
    echo "OK: installed, relaunching"
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
