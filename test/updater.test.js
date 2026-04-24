const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

// Mock state
const mockAutoUpdater = {
  setFeedURL() { mockAutoUpdater._setFeedCalls.push([...arguments]); },
  checkForUpdates() { return Promise.resolve(); },
  checkForUpdatesAndNotify() { return mockAutoUpdater._notifyResult; },
  quitAndInstall() { mockAutoUpdater._quitCalled = true; },
  on(event, handler) { mockAutoUpdater._handlers[event] = handler; },
  once(event, handler) { mockAutoUpdater._handlers[event] = handler; },
  autoDownload: false,
  autoInstallOnAppQuit: false,
  _setFeedCalls: [],
  _handlers: {},
  _quitCalled: false,
  _notifyResult: Promise.resolve()
};

const mockDialogCalls = [];
const mockDialog = {
  showMessageBox(opts) {
    mockDialogCalls.push(opts);
    return Promise.resolve({ response: 0 });
  }
};

const mockApp = {
  getPath() { return '/Applications/claude-tray.app/Contents/MacOS/claude-tray'; },
  exit() {}
};

// Intercept require for electron modules
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron-updater') return 'electron-updater';
  if (request === 'electron') return 'electron';
  return origResolve.call(this, request, parent, isMain, options);
};

require.cache['electron-updater'] = {
  id: 'electron-updater',
  filename: 'electron-updater',
  loaded: true,
  exports: { autoUpdater: mockAutoUpdater }
};

require.cache['electron'] = {
  id: 'electron',
  filename: 'electron',
  loaded: true,
  exports: { dialog: mockDialog, app: mockApp }
};

const { setupAutoUpdater, checkForUpdatesManual } = require('../lib/updater');

// Restore after loading
Module._resolveFilename = origResolve;

describe('updater', () => {
  let tmpDir;
  let configDir;
  let configPath;
  let originalHomedir;
  let timers; // track timers returned by setupAutoUpdater for cleanup

  beforeEach(() => {
    timers = null;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-test-'));
    configDir = path.join(tmpDir, '.config', 'claude-tray');
    fs.mkdirSync(configDir, { recursive: true });
    configPath = path.join(configDir, 'update-url');

    originalHomedir = os.homedir;
    os.homedir = () => tmpDir;

    mockAutoUpdater._setFeedCalls = [];
    mockAutoUpdater._handlers = {};
    mockAutoUpdater._quitCalled = false;
    mockAutoUpdater._notifyResult = Promise.resolve();
    mockAutoUpdater.autoDownload = false;
    mockAutoUpdater.autoInstallOnAppQuit = false;
    mockDialogCalls.length = 0;
  });

  afterEach(() => {
    if (timers) {
      clearTimeout(timers.startupTimer);
      clearInterval(timers.periodicTimer);
    }
    os.homedir = originalHomedir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('setupAutoUpdater', () => {
    it('returns early when no update URL configured', () => {
      const result = setupAutoUpdater();
      assert.strictEqual(mockAutoUpdater._setFeedCalls.length, 0);
      assert.strictEqual(result, undefined);
    });

    it('returns timer handles for cleanup', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      assert.ok(timers.startupTimer);
      assert.ok(timers.periodicTimer);
    });

    it('configures feed URL from config file', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com/releases\n');
      timers = setupAutoUpdater();
      assert.strictEqual(mockAutoUpdater._setFeedCalls.length, 1);
      assert.deepStrictEqual(mockAutoUpdater._setFeedCalls[0][0], {
        provider: 'generic',
        url: 'https://updates.example.com/releases'
      });
    });

    it('enables autoDownload but not autoInstallOnAppQuit (custom shell installer)', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      assert.strictEqual(mockAutoUpdater.autoDownload, true);
      assert.strictEqual(mockAutoUpdater.autoInstallOnAppQuit, false);
    });

    it('registers update-available handler', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      assert.ok(mockAutoUpdater._handlers['update-available']);
    });

    it('registers update-downloaded handler', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      assert.ok(mockAutoUpdater._handlers['update-downloaded']);
    });

    it('registers error handler', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      assert.ok(mockAutoUpdater._handlers['error']);
    });

    it('trims whitespace from config URL', () => {
      fs.writeFileSync(configPath, '  https://updates.example.com  \n');
      timers = setupAutoUpdater();
      assert.strictEqual(mockAutoUpdater._setFeedCalls[0][0].url, 'https://updates.example.com');
    });
  });

  describe('checkForUpdatesManual', () => {
    it('shows dialog when no URL configured', () => {
      checkForUpdatesManual();
      assert.strictEqual(mockDialogCalls.length, 1);
      assert.strictEqual(mockDialogCalls[0].title, 'Auto-Update');
      assert.strictEqual(mockDialogCalls[0].type, 'warning');
    });

    it('does not call setFeedURL when no URL configured', () => {
      checkForUpdatesManual();
      assert.strictEqual(mockAutoUpdater._setFeedCalls.length, 0);
    });

    it('sets feed URL when configured', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      checkForUpdatesManual();
      assert.strictEqual(mockAutoUpdater._setFeedCalls.length, 1);
    });

    it('shows error dialog on check failure', async () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      const orig = mockAutoUpdater.checkForUpdates;
      mockAutoUpdater.checkForUpdates = () => Promise.reject(new Error('Network timeout'));
      checkForUpdatesManual();
      await new Promise((r) => setTimeout(r, 50));
      mockAutoUpdater.checkForUpdates = orig;
      const errorDialog = mockDialogCalls.find(d => d.title === 'Update Check Failed');
      assert.ok(errorDialog);
      assert.strictEqual(errorDialog.message, 'Network timeout');
    });
  });

  describe('event handlers', () => {
    it('update-available only logs, no dialog', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      mockAutoUpdater._handlers['update-available']({ version: '2.0.0' });
      // update-available only logs to console, no dialog shown
      assert.strictEqual(mockDialogCalls.length, 0);
    });

    it('update-downloaded shows dialog with Restart/Later buttons', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      mockAutoUpdater._handlers['update-downloaded']({ version: '2.0.0' });
      const dlg = mockDialogCalls.find(d => d.title === 'Update Ready');
      assert.ok(dlg);
      assert.ok(dlg.message.includes('2.0.0'));
      assert.deepStrictEqual(dlg.buttons, ['Restart Now', 'Later']);
    });

    it('error handler does not throw', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      assert.doesNotThrow(() => {
        mockAutoUpdater._handlers['error'](new Error('update failed'));
      });
    });
  });
});
