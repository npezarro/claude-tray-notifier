const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sessions = require('../lib/sessions');

function makePayload(overrides = {}) {
  return {
    type: 'response_complete',
    session_id: 'sess-001',
    project: 'my-project',
    cwd: '/home/user/repos/my-project',
    summary: 'Done with the task',
    timestamp: new Date().toISOString(),
    conv_title: 'Fix the bug',
    input_kind: 'done',
    ...overrides
  };
}

describe('sessions', () => {
  beforeEach(() => {
    sessions.clear();
  });

  describe('addNotification', () => {
    it('creates a new session entry', () => {
      const result = sessions.addNotification(makePayload());
      assert.equal(result.sessionId, 'sess-001');
      assert.equal(result.project, 'my-project');
      assert.equal(result.convTitle, 'Fix the bug');
      assert.equal(result.notifications.length, 1);
    });

    it('returns null for missing session_id', () => {
      const result = sessions.addNotification(makePayload({ session_id: '' }));
      assert.equal(result, null);
    });

    it('appends notifications to existing session', () => {
      sessions.addNotification(makePayload());
      sessions.addNotification(makePayload({ summary: 'Second notification' }));
      const s = sessions.getSession('sess-001');
      assert.equal(s.notifications.length, 2);
      assert.equal(s.notifications[1].summary, 'Second notification');
    });

    it('updates mutable fields on subsequent notifications', () => {
      sessions.addNotification(makePayload());
      sessions.addNotification(makePayload({ conv_title: 'Updated title', project: 'new-proj' }));
      const s = sessions.getSession('sess-001');
      assert.equal(s.convTitle, 'Updated title');
      assert.equal(s.project, 'new-proj');
    });

    it('caps notifications per session', () => {
      for (let i = 0; i < 60; i++) {
        sessions.addNotification(makePayload({ summary: `Notification ${i}` }));
      }
      const s = sessions.getSession('sess-001');
      assert.equal(s.notifications.length, sessions.MAX_NOTIFICATIONS_PER_SESSION);
      // Should keep the latest ones
      assert.equal(s.notifications[s.notifications.length - 1].summary, 'Notification 59');
    });
  });

  describe('getSessions', () => {
    it('returns empty array when no sessions', () => {
      assert.deepEqual(sessions.getSessions(), []);
    });

    it('returns sessions sorted active first, then by recency', () => {
      const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      const recent = new Date().toISOString();

      sessions.addNotification(makePayload({ session_id: 'old-sess', timestamp: old }));
      sessions.addNotification(makePayload({ session_id: 'new-sess', timestamp: recent }));

      const list = sessions.getSessions();
      assert.equal(list.length, 2);
      assert.equal(list[0].sessionId, 'new-sess');
      assert.equal(list[0].status, 'active');
      assert.equal(list[1].sessionId, 'old-sess');
      assert.equal(list[1].status, 'idle');
    });
  });

  describe('getSession', () => {
    it('returns null for unknown session', () => {
      assert.equal(sessions.getSession('nonexistent'), null);
    });

    it('returns session with status', () => {
      sessions.addNotification(makePayload());
      const s = sessions.getSession('sess-001');
      assert.equal(s.status, 'active');
      assert.equal(s.sessionId, 'sess-001');
    });
  });

  describe('status transitions', () => {
    it('marks session as idle when last activity exceeds threshold', () => {
      const old = new Date(Date.now() - sessions.ACTIVE_THRESHOLD_MS - 1000).toISOString();
      sessions.addNotification(makePayload({ timestamp: old }));
      const s = sessions.getSession('sess-001');
      assert.equal(s.status, 'idle');
    });

    it('marks session as active when last activity is within threshold', () => {
      sessions.addNotification(makePayload({ timestamp: new Date().toISOString() }));
      const s = sessions.getSession('sess-001');
      assert.equal(s.status, 'active');
    });
  });

  describe('pruneOld', () => {
    it('removes sessions older than max age', () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
      sessions.addNotification(makePayload({ session_id: 'old', timestamp: old }));
      sessions.addNotification(makePayload({ session_id: 'recent' }));

      sessions.pruneOld();
      assert.equal(sessions.size(), 1);
      assert.ok(sessions.getSession('recent'));
      assert.equal(sessions.getSession('old'), null);
    });

    it('accepts custom max age', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      sessions.addNotification(makePayload({ timestamp: fiveMinAgo }));

      sessions.pruneOld(1000); // 1 second max age
      assert.equal(sessions.size(), 0);
    });
  });

  describe('clear', () => {
    it('removes all sessions', () => {
      sessions.addNotification(makePayload({ session_id: 'a' }));
      sessions.addNotification(makePayload({ session_id: 'b' }));
      assert.equal(sessions.size(), 2);
      sessions.clear();
      assert.equal(sessions.size(), 0);
    });
  });
});
