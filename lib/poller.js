const https = require('https');

class Poller {
  constructor(baseUrl, token, onNotifications) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.onNotifications = onNotifications;
    this.interval = null;
    this.lastPollTime = null;
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
      // First poll — fetch last 10 to populate history on startup
      url.searchParams.set('last', '10');
    }

    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`
      },
      timeout: 5000
    };

    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          if (this.onConnected) this.onConnected();
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
        } else {
          if (this.onDisconnected) this.onDisconnected();
        }
      });
    });

    req.on('error', () => {
      if (this.onDisconnected) this.onDisconnected();
    });

    req.end();
  }
}

module.exports = { Poller };
