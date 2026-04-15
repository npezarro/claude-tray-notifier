const list = document.getElementById('list');
const sessionsList = document.getElementById('sessions-list');

const KIND_STYLES = {
  choice:   { cls: 'type-choice',   icon: '◆' },
  question: { cls: 'type-question', icon: '?' },
  approval: { cls: 'type-approval', icon: '✓' },
  error:    { cls: 'type-error',    icon: '!' },
  attention:{ cls: 'type-input',    icon: '•' },
  done:     { cls: 'type-done',     icon: '—' },
  general:  { cls: 'type-done',     icon: '—' }
};

// --- Tab switching ---
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.getElementById(`${target}-panel`).classList.add('active');

    if (target === 'sessions') {
      loadSessions();
    }
  });
});

// --- Connection status ---
window.api.onConnectionStatus(({ connected, lastPoll }) => {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (connected) {
    dot.className = 'connection-dot connected';
    label.textContent = 'Connected';
  } else {
    dot.className = 'connection-dot disconnected';
    label.textContent = 'Disconnected';
  }
});

// --- Notifications ---
function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function render(notifications) {
  if (!notifications || notifications.length === 0) {
    list.innerHTML = '<div class="empty">No notifications yet</div>';
    return;
  }

  list.innerHTML = notifications.map(n => {
    const kind = n.inputKind || 'general';
    const style = KIND_STYLES[kind] || KIND_STYLES.general;
    const kindLabel = n.kindLabel || 'Finished';
    const title = escapeHtml(n.convTitle || n.project);
    const unreadCls = n.read ? '' : ' unread';

    const summary = n.summary
      ? `<div class="summary">${escapeHtml(n.summary.slice(0, 120))}</div>`
      : '';

    return `
      <div class="notification${unreadCls}">
        <div class="top">
          <span class="conv-title">${title}</span>
          <span class="time">${formatTime(n.timestamp)}</span>
        </div>
        <div class="meta">
          <span class="type ${style.cls}">${style.icon} ${escapeHtml(kindLabel)}</span>
          <span class="project-tag">${escapeHtml(n.project)}</span>
        </div>
        ${summary}
      </div>
    `;
  }).join('');
}

window.api.onNotificationsUpdated(render);

// --- Sessions ---
function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderSessions(sessions) {
  if (!sessions || sessions.length === 0) {
    sessionsList.innerHTML = '<div class="empty">No sessions yet</div>';
    return;
  }

  sessionsList.innerHTML = sessions.map(s => {
    const count = s.notifications ? s.notifications.length : 0;
    return `
      <div class="session-item" data-session-id="${escapeHtml(s.sessionId)}">
        <div class="session-top">
          <span class="session-status ${s.status}"></span>
          <span class="session-project">${escapeHtml(s.project)}</span>
          <span class="session-time">${relativeTime(s.lastActivity)}</span>
        </div>
        <div class="session-conv-title">${escapeHtml(s.convTitle)}</div>
        <div class="session-count">${count} event${count !== 1 ? 's' : ''}</div>
      </div>
    `;
  }).join('');
}

sessionsList.addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  window.api.openSessionDetail(item.dataset.sessionId);
});

async function loadSessions() {
  try {
    const sessions = await window.api.getSessions();
    renderSessions(sessions);
  } catch (err) {
    sessionsList.innerHTML = `<div class="empty">Error loading sessions</div>`;
  }
}

// --- Utils ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// --- Footer ---
document.getElementById('clear').addEventListener('click', () => {
  window.api.clearNotifications();
  render([]);
});

document.getElementById('quit').addEventListener('click', () => {
  window.api.quit();
});
