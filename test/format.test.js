const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { INPUT_KIND_LABELS, MAX_NOTIFICATIONS, formatNotification, buildHistoryEntry } = require('../lib/format');

describe('INPUT_KIND_LABELS', () => {
  it('has all expected keys', () => {
    const keys = ['choice', 'question', 'approval', 'error', 'attention', 'done', 'general'];
    for (const k of keys) {
      assert.ok(INPUT_KIND_LABELS[k], `missing key: ${k}`);
    }
  });

  it('all values are non-empty strings', () => {
    for (const [k, v] of Object.entries(INPUT_KIND_LABELS)) {
      assert.strictEqual(typeof v, 'string', `${k} is not a string`);
      assert.ok(v.length > 0, `${k} is empty`);
    }
  });
});

describe('MAX_NOTIFICATIONS', () => {
  it('is 20', () => {
    assert.strictEqual(MAX_NOTIFICATIONS, 20);
  });
});

describe('formatNotification', () => {
  it('uses conv_title as title when available', () => {
    const result = formatNotification({ conv_title: 'My Conv', project: 'my-proj', type: 'done' });
    assert.strictEqual(result.title, 'My Conv');
  });

  it('falls back to project when conv_title missing', () => {
    const result = formatNotification({ project: 'my-proj', type: 'done' });
    assert.strictEqual(result.title, 'my-proj');
  });

  it('input_needed type uses kind label as body', () => {
    const result = formatNotification({ project: 'p', type: 'input_needed', input_kind: 'choice' });
    assert.strictEqual(result.body, 'Waiting for your choice');
  });

  it('input_needed with question kind', () => {
    const result = formatNotification({ project: 'p', type: 'input_needed', input_kind: 'question' });
    assert.strictEqual(result.body, 'Has a question for you');
  });

  it('input_needed with approval kind', () => {
    const result = formatNotification({ project: 'p', type: 'input_needed', input_kind: 'approval' });
    assert.strictEqual(result.body, 'Needs approval');
  });

  it('input_needed with error kind', () => {
    const result = formatNotification({ project: 'p', type: 'input_needed', input_kind: 'error' });
    assert.strictEqual(result.body, 'Hit an error');
  });

  it('done kind appends summary', () => {
    const result = formatNotification({ project: 'p', type: 'response', input_kind: 'done', summary: 'built OK' });
    assert.strictEqual(result.body, 'Response ready — built OK');
  });

  it('general kind (default) appends summary', () => {
    const result = formatNotification({ project: 'p', type: 'response', summary: 'all tests pass' });
    assert.strictEqual(result.body, 'Finished — all tests pass');
  });

  it('truncates summary to 100 chars for done/general kind', () => {
    const long = 'a'.repeat(200);
    const result = formatNotification({ project: 'p', type: 'response', input_kind: 'done', summary: long });
    // " — " prefix + 100 chars of summary
    assert.ok(result.body.length <= 'Response ready'.length + ' — '.length + 100);
  });

  it('non-done non-general kind uses newline before summary', () => {
    const result = formatNotification({ project: 'p', type: 'response', input_kind: 'choice', summary: 'pick one' });
    assert.strictEqual(result.body, 'Waiting for your choice\npick one');
  });

  it('truncates summary to 80 chars for specific kinds', () => {
    const long = 'b'.repeat(200);
    const result = formatNotification({ project: 'p', type: 'response', input_kind: 'error', summary: long });
    assert.ok(result.body.length <= 'Hit an error'.length + '\n'.length + 80);
  });

  it('unknown input_kind falls back to general label', () => {
    const result = formatNotification({ project: 'p', type: 'input_needed', input_kind: 'unknown_kind' });
    assert.strictEqual(result.body, 'Finished');
  });

  it('missing input_kind defaults to general', () => {
    const result = formatNotification({ project: 'p', type: 'response' });
    assert.strictEqual(result.inputKind, 'general');
    assert.strictEqual(result.kindLabel, 'Finished');
  });

  it('no summary for done kind means no dash', () => {
    const result = formatNotification({ project: 'p', type: 'response', input_kind: 'done' });
    assert.strictEqual(result.body, 'Response ready');
  });

  it('returns convTitle, inputKind, kindLabel', () => {
    const result = formatNotification({ conv_title: 'C', project: 'P', type: 'input_needed', input_kind: 'approval' });
    assert.strictEqual(result.convTitle, 'C');
    assert.strictEqual(result.inputKind, 'approval');
    assert.strictEqual(result.kindLabel, 'Needs approval');
  });
});

describe('buildHistoryEntry', () => {
  it('builds entry with all fields', () => {
    const payload = {
      type: 'input_needed',
      project: 'my-proj',
      conv_title: 'My Conv',
      input_kind: 'choice',
      summary: 'pick a number',
      timestamp: '2026-04-14T12:00:00Z',
      session_id: 'sess-123'
    };
    const entry = buildHistoryEntry(payload);
    assert.strictEqual(entry.type, 'input_needed');
    assert.strictEqual(entry.project, 'my-proj');
    assert.strictEqual(entry.convTitle, 'My Conv');
    assert.strictEqual(entry.inputKind, 'choice');
    assert.strictEqual(entry.kindLabel, 'Waiting for your choice');
    assert.strictEqual(entry.summary, 'pick a number');
    assert.strictEqual(entry.timestamp, '2026-04-14T12:00:00Z');
    assert.strictEqual(entry.sessionId, 'sess-123');
    assert.strictEqual(entry.read, false);
  });

  it('defaults summary to empty string', () => {
    const entry = buildHistoryEntry({ type: 'done', project: 'p' });
    assert.strictEqual(entry.summary, '');
  });

  it('uses provided timestamp', () => {
    const entry = buildHistoryEntry({ type: 'done', project: 'p', timestamp: '2026-01-01T00:00:00Z' });
    assert.strictEqual(entry.timestamp, '2026-01-01T00:00:00Z');
  });

  it('generates timestamp when not provided', () => {
    const entry = buildHistoryEntry({ type: 'done', project: 'p' });
    assert.ok(entry.timestamp);
    // Should be a valid ISO string
    assert.ok(!isNaN(new Date(entry.timestamp).getTime()));
  });

  it('entry is always unread', () => {
    const entry = buildHistoryEntry({ type: 'done', project: 'p' });
    assert.strictEqual(entry.read, false);
  });

  it('falls back to project when conv_title missing', () => {
    const entry = buildHistoryEntry({ type: 'done', project: 'fallback-proj' });
    assert.strictEqual(entry.convTitle, 'fallback-proj');
  });
});
