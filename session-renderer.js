const timeline = document.getElementById('timeline');

const KIND_LABELS = {
  choice: 'Choice needed',
  question: 'Question',
  approval: 'Needs approval',
  error: 'Error',
  attention: 'Attention',
  done: 'Done',
  general: 'Complete'
};

let currentSessionId = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function renderHeader(session) {
  document.getElementById('header-title').textContent = `${session.project} — ${session.convTitle}`;

  const dot = document.getElementById('status-dot');
  dot.className = `status-dot ${session.status}`;

  document.getElementById('meta-status').textContent = session.status === 'active' ? 'Active' : 'Idle';
  document.getElementById('meta-started').textContent = `Started ${formatDate(session.firstSeen)}`;
  document.getElementById('meta-cwd').textContent = session.cwd || '';
  document.getElementById('session-id').textContent = session.sessionId;
}

function renderTimeline(notifications) {
  if (!notifications || notifications.length === 0) {
    timeline.innerHTML = '<div class="empty">No events recorded</div>';
    return;
  }

  timeline.innerHTML = notifications.map(n => {
    const kind = n.inputKind || 'general';
    const kindLabel = KIND_LABELS[kind] || KIND_LABELS.general;
    const kindClass = `kind-${kind === 'attention' ? 'attention' : kind}`;
    const summary = n.summary ? `<div class="event-summary">${escapeHtml(n.summary)}</div>` : '';

    return `
      <div class="event ${kindClass}">
        <div class="event-top">
          <span class="event-time">${formatTimestamp(n.timestamp)}</span>
          <span class="event-kind ${kindClass}">${escapeHtml(kindLabel)}</span>
        </div>
        ${summary}
      </div>
    `;
  }).join('');

  // Auto-scroll to bottom
  timeline.scrollTop = timeline.scrollHeight;
}

// Receive session info from main process
window.sessionApi.onSessionInfo((session) => {
  currentSessionId = session.sessionId;
  renderHeader(session);
  renderTimeline(session.notifications || []);
});

// Live updates when new notifications arrive for this session
window.sessionApi.onSessionUpdated((session) => {
  if (session.sessionId === currentSessionId) {
    renderHeader(session);
    renderTimeline(session.notifications || []);
  }
});
