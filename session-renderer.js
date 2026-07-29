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

// --- Conversation view ---------------------------------------------------
//
// The relay stores notification metadata only; the conversation body is pulled from the
// machine that ran the session. That machine can legitimately be offline, so every
// failure gets a plain-language explanation and a retry rather than a stuck spinner.

const conversationEl = document.getElementById('conversation');
const timelineEl = document.getElementById('timeline');
const viewHint = document.getElementById('view-hint');
let conversationLoaded = false;
let conversationLoading = false;

const ERROR_TEXT = {
  worker_unreachable: ['That machine is offline', 'The conversation lives on the PC that ran this session, and it cannot be reached right now.'],
  worker_timeout: ['Timed out', 'That machine took too long to answer. It may be busy, or the tunnel is flaky.'],
  timeout: ['Timed out', 'The relay did not respond in time.'],
  transcript_not_found: ['Transcript not found', 'The session log is no longer on that machine, or it was pruned.'],
  transcript_unreadable: ['Transcript unreadable', 'The log exists but could not be parsed.'],
  distiller_unavailable: ['Reader not installed', 'The transcript reader is missing on that machine. Update its claude-tray-notifier checkout.'],
  unknown_host: ['Unknown machine', 'This session came from a machine with no configured route.'],
  invalid_session_id: ['Bad session id', 'That session id is not a valid identifier.'],
  busy: ['Busy', 'Too many conversations loading at once. Try again in a moment.'],
  response_too_large: ['Too large', 'That conversation exceeded the transfer limit.'],
  no_relay: ['No relay configured', 'Set a relay URL before loading conversations.'],
  no_token: ['No auth token', 'Set an auth token before loading conversations.'],
  network: ['Network error', 'Could not reach the relay.'],
  malformed_response: ['Unexpected response', 'The relay returned something unreadable.']
};

function conversationState(bigText, detail, withRetry) {
  conversationEl.innerHTML = `
    <div class="conv-state">
      <div class="big">${escapeHtml(bigText)}</div>
      <div>${escapeHtml(detail)}</div>
      ${withRetry ? '<button id="conv-retry">Try again</button>' : ''}
    </div>`;
  const retry = document.getElementById('conv-retry');
  if (retry) {
    retry.addEventListener('click', () => {
      conversationLoaded = false;
      loadConversation();
    });
  }
}

function renderConversation(conv) {
  const meta = conv.meta || {};
  const turns = conv.turns || [];

  const metaLine = [
    meta.cwd,
    meta.gitBranch ? `branch ${meta.gitBranch}` : '',
    meta.host,
    `${turns.length} turns`,
    meta.scrubbedCount ? `${meta.scrubbedCount} redacted` : ''
  ].filter(Boolean).join('  ·  ');

  const truncNote = meta.truncated
    ? `<div class="conv-trunc">Earlier ${escapeHtml(meta.droppedTurns)} turns omitted to fit the transfer limit.</div>`
    : '';

  if (!turns.length) {
    conversationState('Nothing to show', 'No readable turns in this transcript.', true);
    return;
  }

  conversationEl.innerHTML =
    `<div class="conv-meta">${escapeHtml(metaLine)}</div>` +
    truncNote +
    turns.map(t => {
      const tools = (t.tools || []).map(tool =>
        `<div class="turn-tool"><b>${escapeHtml(tool.name)}</b>${tool.label ? ' ' + escapeHtml(tool.label) : ''}</div>`
      ).join('');
      return `
        <div class="turn ${t.role === 'user' ? 'user' : 'assistant'}">
          <div class="turn-role">${escapeHtml(t.role)}</div>
          ${t.text ? `<div class="turn-text">${escapeHtml(t.text)}</div>` : ''}
          ${tools ? `<div class="turn-tools">${tools}</div>` : ''}
        </div>`;
    }).join('');
}

async function loadConversation() {
  if (!currentSessionId || conversationLoaded || conversationLoading) return;
  conversationLoading = true;
  conversationState('Loading conversation…', 'Fetching it from the machine that ran this session.', false);
  try {
    const result = await window.sessionApi.fetchConversation(currentSessionId);
    if (result && result.ok) {
      renderConversation(result.conversation || {});
      conversationLoaded = true;
    } else {
      const err = (result && result.error) || 'unknown';
      const pair = ERROR_TEXT[err] || ['Could not load', (result && result.message) || 'Unknown error'];
      conversationState(pair[0], pair[1], true);
    }
  } catch (e) {
    conversationState('Could not load', e.message || String(e), true);
  } finally {
    conversationLoading = false;
  }
}

document.querySelectorAll('.view-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const showConv = tab.dataset.view === 'conversation';
    timelineEl.classList.toggle('hidden', showConv);
    conversationEl.classList.toggle('visible', showConv);
    viewHint.textContent = showConv ? 'pulled live from the source machine' : '';
    if (showConv) loadConversation();
  });
});

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
