const http = require('http');
const { validateToken } = require('./auth');

/**
 * @param {string|function(): string} token A literal token, or a getter for the current
 *   one. In local mode this server IS the delivery path, so a token regenerated at
 *   runtime has to take effect without a restart — a captured string would keep rejecting
 *   the hook with a 401, and the hook fails silently by design, so every notification
 *   would vanish with no visible error anywhere.
 */
function createServer(port, token, onNotification) {
  const currentToken = typeof token === 'function' ? token : () => token;

  const server = http.createServer((req, res) => {
    // Health check — no auth
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Notify endpoint (for local testing / direct POST)
    if (req.method === 'POST' && req.url === '/notify') {
      const authHeader = req.headers['authorization'] || '';
      const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
      if (!validateToken(bearerToken, currentToken())) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (!payload.type || !payload.project) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing type or project' }));
            return;
          }
          onNotification(payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (_e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { createServer };
