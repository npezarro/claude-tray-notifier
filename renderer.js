const list = document.getElementById('list');

const KIND_STYLES = {
  choice:   { cls: 'type-choice',   icon: '◆' },
  question: { cls: 'type-question', icon: '?' },
  approval: { cls: 'type-approval', icon: '✓' },
  error:    { cls: 'type-error',    icon: '!' },
  attention:{ cls: 'type-input',    icon: '•' },
  done:     { cls: 'type-done',     icon: '—' },
  general:  { cls: 'type-done',     icon: '—' }
};

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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

window.api.onNotificationsUpdated(render);

document.getElementById('clear').addEventListener('click', () => {
  window.api.clearNotifications();
  render([]);
});

document.getElementById('quit').addEventListener('click', () => {
  window.api.quit();
});
