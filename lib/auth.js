const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function loadToken() {
  const envPath = process.env.CLAUDE_TRAY_TOKEN_PATH;
  const paths = [
    envPath,
    path.join(os.homedir(), '.config', 'claude-tray', 'token')
  ].filter(Boolean);

  for (const p of paths) {
    try {
      const token = fs.readFileSync(p, 'utf8').trim();
      if (token) return token;
    } catch (_) {
      // Try next path
    }
  }
  return null;
}

function validateToken(provided, expected) {
  if (!provided || !expected) return false;
  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { loadToken, validateToken };
