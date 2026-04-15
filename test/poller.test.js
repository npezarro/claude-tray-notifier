const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const https = require('https');

// Monkey-patch https.request for testing
const originalRequest = https.request;
let mockRequest;

function installMock(opts) {
  mockRequest = {
    calls: [],
    statusCode: opts.statusCode || 200,
    body: opts.body || '{"notifications":[]}',
    error: opts.error || null
  };
  https.request = function (url, options, callback) {
    mockRequest.calls.push({ url: url.toString(), options });
    const req = new EventEmitter();
    req.end = () => {
      if (mockRequest.error) {
        process.nextTick(() => req.emit('error', mockRequest.error));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = mockRequest.statusCode;
      process.nextTick(() => {
        callback(res);
        res.emit('data', mockRequest.body);
        res.emit('end');
      });
    };
    return req;
  };
}

function restoreMock() {
  https.request = originalRequest;
}

const { Poller } = require('../lib/poller');

describe('Poller', () => {
  beforeEach(() => {
    restoreMock();
  });

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', () => {
      const p = new Poller('https://example.com/', 'tok', () => {});
      assert.strictEqual(p.baseUrl, 'https://example.com');
    });

    it('stores token and callback', () => {
      const cb = () => {};
      const p = new Poller('https://x.com', 'mytoken', cb);
      assert.strictEqual(p.token, 'mytoken');
      assert.strictEqual(p.onNotifications, cb);
    });

    it('initializes interval and lastPollTime as null', () => {
      const p = new Poller('https://x.com', 'tok', () => {});
      assert.strictEqual(p.interval, null);
      assert.strictEqual(p.lastPollTime, null);
    });
  });

  describe('start and stop', () => {
    it('start sets the interval', () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.start(60000);
      assert.notStrictEqual(p.interval, null);
      p.stop();
      restoreMock();
    });

    it('stop clears the interval', () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.start(60000);
      p.stop();
      assert.strictEqual(p.interval, null);
      restoreMock();
    });

    it('stop is safe when not started', () => {
      const p = new Poller('https://example.com', 'tok', () => {});
      assert.doesNotThrow(() => p.stop());
    });

    it('start polls immediately', async () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.start(60000);
      await new Promise((r) => setTimeout(r, 20));
      p.stop();
      assert.ok(mockRequest.calls.length >= 1);
      restoreMock();
    });
  });

  describe('poll — request formation', () => {
    it('requests /api/notify/poll endpoint', async () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(mockRequest.calls[0].url.includes('/api/notify/poll'));
      restoreMock();
    });

    it('sends Authorization bearer header', async () => {
      installMock({});
      const p = new Poller('https://example.com', 'secret123', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(mockRequest.calls[0].options.headers.Authorization, 'Bearer secret123');
      restoreMock();
    });

    it('uses GET method', async () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(mockRequest.calls[0].options.method, 'GET');
      restoreMock();
    });

    it('sets timeout to 5000ms', async () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(mockRequest.calls[0].options.timeout, 5000);
      restoreMock();
    });

    it('omits since param on first poll', async () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(!mockRequest.calls[0].url.includes('since='));
      restoreMock();
    });

    it('includes since param after receiving notifications', async () => {
      installMock({ body: JSON.stringify({ notifications: [{ type: 'test' }] }) });
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      // Now poll again
      mockRequest.body = '{"notifications":[]}';
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(mockRequest.calls[1].url.includes('since='));
      restoreMock();
    });
  });

  describe('poll — notifications', () => {
    it('calls onNotifications for each notification', async () => {
      installMock({
        body: JSON.stringify({
          notifications: [
            { type: 'done', message: 'Task finished' },
            { type: 'error', message: 'Something failed' }
          ]
        })
      });
      const received = [];
      const p = new Poller('https://example.com', 'tok', (n) => received.push(n));
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(received.length, 2);
      assert.deepStrictEqual(received[0], { type: 'done', message: 'Task finished' });
      assert.deepStrictEqual(received[1], { type: 'error', message: 'Something failed' });
      restoreMock();
    });

    it('updates lastPollTime after notifications', async () => {
      installMock({ body: JSON.stringify({ notifications: [{ type: 'done' }] }) });
      const p = new Poller('https://example.com', 'tok', () => {});
      assert.strictEqual(p.lastPollTime, null);
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.notStrictEqual(p.lastPollTime, null);
      assert.ok(!isNaN(Date.parse(p.lastPollTime)));
      restoreMock();
    });

    it('does not call onNotifications for empty array', async () => {
      installMock({ body: '{"notifications":[]}' });
      const received = [];
      const p = new Poller('https://example.com', 'tok', (n) => received.push(n));
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(received.length, 0);
      restoreMock();
    });

    it('does not update lastPollTime for empty notifications', async () => {
      installMock({ body: '{"notifications":[]}' });
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(p.lastPollTime, null);
      restoreMock();
    });

    it('handles missing notifications key', async () => {
      installMock({ body: '{"status":"ok"}' });
      const received = [];
      const p = new Poller('https://example.com', 'tok', (n) => received.push(n));
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(received.length, 0);
      restoreMock();
    });
  });

  describe('poll — callbacks', () => {
    it('calls onConnected on 200 response', async () => {
      installMock({});
      let connected = false;
      const p = new Poller('https://example.com', 'tok', () => {});
      p.onConnected = () => { connected = true; };
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(connected, true);
      restoreMock();
    });

    it('calls onDisconnected on non-200 after being connected', async () => {
      // First connect successfully
      installMock({});
      let disconnected = false;
      const p = new Poller('https://example.com', 'tok', () => {});
      p.onDisconnected = () => { disconnected = true; };
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      restoreMock();
      // Now fail — should fire onDisconnected
      installMock({ statusCode: 500 });
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(disconnected, true);
      restoreMock();
    });

    it('calls onDisconnected on request error after being connected', async () => {
      // First connect successfully
      installMock({});
      let disconnected = false;
      const p = new Poller('https://example.com', 'tok', () => {});
      p.onDisconnected = () => { disconnected = true; };
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      restoreMock();
      // Now error — should fire onDisconnected
      installMock({ error: new Error('ECONNREFUSED') });
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(disconnected, true);
      restoreMock();
    });

    it('does not call onDisconnected when never connected', async () => {
      installMock({ statusCode: 500 });
      let disconnected = false;
      const p = new Poller('https://example.com', 'tok', () => {});
      p.onDisconnected = () => { disconnected = true; };
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(disconnected, false);
      restoreMock();
    });

    it('does not throw when onConnected is not set', async () => {
      installMock({});
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(true);
      restoreMock();
    });

    it('does not throw when onDisconnected is not set on non-200', async () => {
      installMock({ statusCode: 401 });
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(true);
      restoreMock();
    });

    it('does not throw when onDisconnected is not set on error', async () => {
      installMock({ error: new Error('fail') });
      const p = new Poller('https://example.com', 'tok', () => {});
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(true);
      restoreMock();
    });
  });

  describe('poll — invalid JSON', () => {
    it('silently ignores parse errors', async () => {
      installMock({ body: 'not json' });
      const received = [];
      const p = new Poller('https://example.com', 'tok', (n) => received.push(n));
      p.poll();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(received.length, 0);
      restoreMock();
    });
  });
});
