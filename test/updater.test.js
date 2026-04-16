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
  autoDownload: false,
  autoInstallOnAppQuit: false,
  _setFeedCalls: [],
  _handlers: {},
  _quitCalled: false,
  _notifyResult: Promise.resolve()
};

const mockNotifications = [];
class MockNotification {
  constructor(opts) {
    this.opts = opts;
    this._handlers = {};
    this.shown = false;
    mockNotifications.push(this);
  }
  show() { this.shown = true; }
  on(event, handler) { this._handlers[event] = handler; }
}

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
  exports: { Notification: MockNotification }
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
    mockNotifications.length = 0;
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

    it('enables autoDownload and autoInstallOnAppQuit', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      assert.strictEqual(mockAutoUpdater.autoDownload, true);
      assert.strictEqual(mockAutoUpdater.autoInstallOnAppQuit, true);
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
    it('shows notification when no URL configured', () => {
      checkForUpdatesManual();
      assert.strictEqual(mockNotifications.length, 1);
      assert.strictEqual(mockNotifications[0].opts.title, 'Auto-Update Not Configured');
      assert.ok(mockNotifications[0].shown);
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

    it('shows error notification on check failure', async () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      mockAutoUpdater._notifyResult = Promise.reject(new Error('Network timeout'));
      const orig = mockAutoUpdater.checkForUpdatesAndNotify;
      mockAutoUpdater.checkForUpdatesAndNotify = () => mockAutoUpdater._notifyResult;
      checkForUpdatesManual();
      await new Promise((r) => setTimeout(r, 50));
      mockAutoUpdater.checkForUpdatesAndNotify = orig;
      const errorNotif = mockNotifications.find(n => n.opts.title === 'Update Check Failed');
      assert.ok(errorNotif);
      assert.strictEqual(errorNotif.opts.body, 'Network timeout');
    });
  });

  describe('event handlers', () => {
    it('update-available shows download notification', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      mockAutoUpdater._handlers['update-available']({ version: '2.0.0' });
      const notif = mockNotifications.find(n => n.opts.title === 'Update Available');
      assert.ok(notif);
      assert.ok(notif.opts.body.includes('2.0.0'));
      assert.ok(notif.shown);
    });

    it('update-downloaded shows ready notification', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      mockAutoUpdater._handlers['update-downloaded']({ version: '2.0.0' });
      const notif = mockNotifications.find(n => n.opts.title === 'Update Ready');
      assert.ok(notif);
      assert.ok(notif.opts.body.includes('2.0.0'));
    });

    it('clicking update-downloaded notification calls quitAndInstall', () => {
      fs.writeFileSync(configPath, 'https://updates.example.com');
      timers = setupAutoUpdater();
      mockAutoUpdater._handlers['update-downloaded']({ version: '2.0.0' });
      const notif = mockNotifications.find(n => n.opts.title === 'Update Ready');
      notif._handlers.click();
      assert.strictEqual(mockAutoUpdater._quitCalled, true);
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
