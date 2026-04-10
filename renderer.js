const list = document.getElementById('list');

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
    const typeClass = n.type === 'input_needed' ? 'type-input' : 'type-response';
    const typeLabel = n.type === 'input_needed' ? 'Input Needed' : 'Done';
    const summary = n.summary ? `<div class="summary">${escapeHtml(n.summary.slice(0, 120))}</div>` : '';
    return `
      <div class="notification">
        <div class="top">
          <span class="project">${escapeHtml(n.project)}</span>
          <span class="time">${formatTime(n.timestamp)}</span>
        </div>
        <span class="type ${typeClass}">${typeLabel}</span>
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
