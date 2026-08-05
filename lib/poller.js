const http = require('http');
const https = require('https');

/**
 * Pick the transport from the URL rather than assuming TLS.
 *
 * Hardcoding `https` here made a local relay (`http://127.0.0.1:...`) throw
 * ERR_INVALID_PROTOCOL, which ruled out the simplest self-hosted setup and any local
 * testing of the poll path.
 */
function transportFor(url) {
  return url.protocol === 'http:' ? http : https;
}

class Poller {
  constructor(baseUrl, token, onNotifications) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.onNotifications = onNotifications;
    this.interval = null;
    this.lastPollTime = null;
    this._connected = false;
    this._authFailCount = 0;
    this._authFailFired = false;
  }

  updateToken(newToken) {
    this.token = newToken;
    this._authFailCount = 0;
    this._authFailFired = false;
  }

  start(intervalMs = 2000) {
    console.log(`Polling ${this.baseUrl}/api/notify/poll every ${intervalMs}ms`);
    this.poll(); // Immediate first poll
    this.interval = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  poll() {
    const url = new URL(`${this.baseUrl}/api/notify/poll`);
    if (this.lastPollTime) {
      url.searchParams.set('since', this.lastPollTime);
    } else {
      url.searchParams.set('last', '10');
    }

    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`
      },
      timeout: 5000
    };

    const req = transportFor(url).request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          this._authFailCount = 0;
          this._authFailFired = false;
          if (!this._connected) { this._connected = true; if (this.onConnected) this.onConnected(); }
          try {
            const data = JSON.parse(body);
            if (data.notifications && data.notifications.length > 0) {
              this.lastPollTime = new Date().toISOString();
              for (const n of data.notifications) {
                this.onNotifications(n);
              }
            }
          } catch (_) {
            // Silently ignore parse errors
          }
        } else if (res.statusCode === 401) {
          this._authFailCount++;
          if (this._connected) { this._connected = false; }
          if (!this._authFailFired && this._authFailCount >= 3) {
            this._authFailFired = true;
            if (this.onAuthFailed) this.onAuthFailed();
          }
          if (this.onDisconnected) this.onDisconnected();
        } else {
          if (this._connected) { this._connected = false; if (this.onDisconnected) this.onDisconnected(); }
        }
      });
    });

    req.on('error', () => {
      if (this._connected) { this._connected = false; if (this.onDisconnected) this.onDisconnected(); }
    });

    req.end();
  }
}

module.exports = { Poller, transportFor };
