const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../lib/server');

const TOKEN = 'test-secret-token';
let server;
let port;
let received = [];

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { ...headers }
    };
    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe('server', () => {
  beforeEach((_, done) => {
    received = [];
    server = createServer(0, TOKEN, (payload) => received.push(payload));
    server.on('listening', () => {
      port = server.address().port;
      done();
    });
  });

  afterEach((_, done) => {
    server.close(done);
  });

  // --- Health endpoint ---

  it('GET /health returns 200 with status ok', async () => {
    const res = await request('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { status: 'ok' });
  });

  it('GET /health requires no auth', async () => {
    const res = await request('GET', '/health');
    assert.strictEqual(res.status, 200);
  });

  // --- Auth ---

  it('POST /notify rejects missing auth', async () => {
    const res = await request('POST', '/notify', { type: 'done', project: 'test' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'unauthorized');
  });

  it('POST /notify rejects wrong token', async () => {
    const res = await request('POST', '/notify', { type: 'done', project: 'test' }, {
      'Authorization': 'Bearer wrong-token'
    });
    assert.strictEqual(res.status, 401);
  });

  it('POST /notify accepts valid Bearer token', async () => {
    const res = await request('POST', '/notify', { type: 'done', project: 'test' }, {
      'Authorization': `Bearer ${TOKEN}`
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });

  // --- Payload validation ---

  it('POST /notify rejects missing type', async () => {
    const res = await request('POST', '/notify', { project: 'test' }, {
      'Authorization': `Bearer ${TOKEN}`
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'missing type or project');
  });

  it('POST /notify rejects missing project', async () => {
    const res = await request('POST', '/notify', { type: 'done' }, {
      'Authorization': `Bearer ${TOKEN}`
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'missing type or project');
  });

  it('POST /notify rejects invalid JSON', async () => {
    const res = await request('POST', '/notify', 'not json{', {
      'Authorization': `Bearer ${TOKEN}`
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'invalid json');
  });

  // --- Notification delivery ---

  it('POST /notify delivers payload to callback', async () => {
    const payload = { type: 'input_needed', project: 'my-app', input_kind: 'choice' };
    await request('POST', '/notify', payload, {
      'Authorization': `Bearer ${TOKEN}`
    });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, 'input_needed');
    assert.strictEqual(received[0].project, 'my-app');
    assert.strictEqual(received[0].input_kind, 'choice');
  });

  it('delivers multiple notifications', async () => {
    for (let i = 0; i < 3; i++) {
      await request('POST', '/notify', { type: 'done', project: `p${i}` }, {
        'Authorization': `Bearer ${TOKEN}`
      });
    }
    assert.strictEqual(received.length, 3);
    assert.strictEqual(received[2].project, 'p2');
  });

  // --- 404 ---

  it('returns 404 for unknown routes', async () => {
    const res = await request('GET', '/unknown');
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for GET /notify', async () => {
    const res = await request('GET', '/notify');
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for POST /health', async () => {
    const res = await request('POST', '/health');
    assert.strictEqual(res.status, 404);
  });
});
