const INPUT_KIND_LABELS = {
  choice: 'Waiting for your choice',
  question: 'Has a question for you',
  approval: 'Needs approval',
  error: 'Hit an error',
  attention: 'Needs attention',
  done: 'Response ready',
  general: 'Finished'
};

const MAX_NOTIFICATIONS = 20;

/**
 * Build notification title and body from a payload.
 * Pure function — no Electron or DOM dependency.
 */
function formatNotification(payload) {
  const convTitle = payload.conv_title || payload.project;
  const inputKind = payload.input_kind || 'general';
  const kindLabel = INPUT_KIND_LABELS[inputKind] || INPUT_KIND_LABELS.general;

  let title, body;
  if (payload.type === 'input_needed') {
    title = `${convTitle}`;
    body = kindLabel;
  } else if (inputKind === 'done' || inputKind === 'general') {
    title = `${convTitle}`;
    const summary = payload.summary ? ` — ${payload.summary.slice(0, 100)}` : '';
    body = `${kindLabel}${summary}`;
  } else {
    title = `${convTitle}`;
    const summary = payload.summary ? `\n${payload.summary.slice(0, 80)}` : '';
    body = `${kindLabel}${summary}`;
  }

  return { title, body, convTitle, inputKind, kindLabel };
}

/**
 * Build a history entry from a payload.
 */
function buildHistoryEntry(payload) {
  const { convTitle, inputKind, kindLabel } = formatNotification(payload);
  return {
    type: payload.type,
    project: payload.project,
    convTitle,
    inputKind,
    kindLabel,
    summary: payload.summary || '',
    timestamp: payload.timestamp || new Date().toISOString(),
    sessionId: payload.session_id,
    read: false
  };
}

module.exports = { INPUT_KIND_LABELS, MAX_NOTIFICATIONS, formatNotification, buildHistoryEntry };
