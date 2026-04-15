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

function getSessions() {
  const list = Array.from(sessions.values()).map(s => ({
    ...s,
    status: getStatus(s)
  }));

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
  return { ...s, status: getStatus(s) };
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

function size() {
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
