const { normalizeOrigin, INTERACTIVE, SYSTEM } = require('./format');

const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const MAX_NOTIFICATIONS_PER_SESSION = 50;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const sessions = new Map();

function addNotification(payload) {
  const id = payload.session_id;
  if (!id) return null;

  let session = sessions.get(id);
  if (!session) {
    session = {
      sessionId: id,
      project: payload.project || 'unknown',
      cwd: payload.cwd || '',
      convTitle: payload.conv_title || payload.project || 'Untitled',
      origin: normalizeOrigin(payload.origin),
      host: payload.host || '',
      firstSeen: payload.timestamp || new Date().toISOString(),
      lastActivity: payload.timestamp || new Date().toISOString(),
      notifications: []
    };
    sessions.set(id, session);
  }

  // Update mutable fields
  session.lastActivity = payload.timestamp || new Date().toISOString();
  if (payload.conv_title) session.convTitle = payload.conv_title;
  if (payload.project) session.project = payload.project;
  if (payload.host) session.host = payload.host;
  // An origin can only ever be upgraded to interactive, never downgraded. A session that
  // has proven itself interactive once should not be re-muted by a later event that
  // happens to arrive without the field.
  if (normalizeOrigin(payload.origin) === INTERACTIVE) session.origin = INTERACTIVE;

  session.notifications.push({
    type: payload.type,
    inputKind: payload.input_kind || 'general',
    summary: payload.summary || '',
    timestamp: payload.timestamp || new Date().toISOString()
  });

  if (session.notifications.length > MAX_NOTIFICATIONS_PER_SESSION) {
    session.notifications = session.notifications.slice(-MAX_NOTIFICATIONS_PER_SESSION);
  }

  return session;
}

function getStatus(session) {
  const elapsed = Date.now() - new Date(session.lastActivity).getTime();
  return elapsed < ACTIVE_THRESHOLD_MS ? 'active' : 'idle';
}

/**
 * @param {string} [origin] 'interactive' | 'system' | undefined for all
 */
function getSessions(origin) {
  let list = Array.from(sessions.values()).map(s => ({
    ...s,
    origin: normalizeOrigin(s.origin),
    status: getStatus(s)
  }));

  if (origin === INTERACTIVE || origin === SYSTEM) {
    list = list.filter(s => s.origin === origin);
  }

  // Active first, then by lastActivity descending
  list.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return new Date(b.lastActivity) - new Date(a.lastActivity);
  });

  return list;
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return { ...s, origin: normalizeOrigin(s.origin), status: getStatus(s) };
}

function pruneOld(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [id, session] of sessions) {
    if (new Date(session.lastActivity).getTime() < cutoff) {
      sessions.delete(id);
    }
  }
}

function clear() {
  sessions.clear();
}

function size(origin) {
  if (origin === INTERACTIVE || origin === SYSTEM) {
    let n = 0;
    for (const s of sessions.values()) {
      if (normalizeOrigin(s.origin) === origin) n += 1;
    }
    return n;
  }
  return _sizeAll();
}

function _sizeAll() {
  return sessions.size;
}

module.exports = {
  addNotification,
  getSessions,
  getSession,
  pruneOld,
  clear,
  size,
  ACTIVE_THRESHOLD_MS,
  MAX_NOTIFICATIONS_PER_SESSION,
  DEFAULT_MAX_AGE_MS
};
