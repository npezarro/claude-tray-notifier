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
  const appDir = path.dirname(appPath);
  const logPath = path.join(os.homedir(), 'Library', 'Logs', 'claude-tray-notifier-update.log');

  // Spawn a detached shell script that waits for this process to exit, then REPLACES
  // the .app bundle wholesale.
  //
  // Why not the original `unzip -o "$zip" -d "$appDir"`: that merges new files INTO the
  // existing bundle and never removes files the new version dropped, so stale files
  // accumulate across releases. The build is ad-hoc code-signed and
  // Contents/_CodeSignature/CodeResources hashes every file in the bundle, so leftovers
  // are a standing hazard to signature validity. (Note: `unzip -o` was NOT observed to
  // break a real update — 1.7.1 -> 1.9.1 -> 1.9.2 all installed fine with it. This is
  // hardening against a latent problem, not a fix for a reproduced failure.)
  //
  // Staging lives in the app's OWN parent directory, not /tmp. /tmp is frequently a
  // different filesystem, which turns the final `mv` into a copy-then-delete: slow, and
  // non-atomic, so an interruption can leave a half-written bundle. Same-filesystem
  // renames are atomic, so the window where no app exists is a single syscall.
  //
  // Output goes to a log, never /dev/null: a silent installer failure is
  // indistinguishable from "nothing happened", which is exactly how the original
  // version would have hidden a real error.
  const script = `
    set -u
    exec >> "${logPath}" 2>&1
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') installing update from ${zipPath} ==="
    sleep 1

    # Same filesystem as the app => the swap below is an atomic rename.
    STAGE="$(mktemp -d "${appDir}/.claude-tray-update.XXXXXX" 2>/dev/null)" || STAGE=""
    if [ -z "$STAGE" ]; then
      STAGE="$(mktemp -d /tmp/claude-tray-update.XXXXXX)" || {
        echo "FAILED: could not create a staging directory"; exit 1; }
      echo "WARN: staging in /tmp (could not write to ${appDir}); the final move may cross filesystems"
    fi
    trap 'rm -rf "$STAGE"' EXIT

    if ! unzip -q "${zipPath}" -d "$STAGE"; then
      echo "FAILED: could not extract the update zip"; exit 1
    fi
    if [ ! -d "$STAGE/${appName}" ]; then
      echo "FAILED: no ${appName} inside the update zip"; exit 1
    fi
    # Cheap sanity gate: refuse to swap in a bundle with no launchable binary.
    if [ ! -x "$STAGE/${appName}/Contents/MacOS/$(basename "${appName}" .app)" ]; then
      echo "FAILED: extracted bundle has no executable; refusing to replace the working app"
      exit 1
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
