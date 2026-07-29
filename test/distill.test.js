const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'distill-transcript.py');

let pythonOk = false;
before(() => {
  const probe = spawnSync('python3', ['--version']);
  pythonOk = probe.status === 0;
});

function fixture(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-test-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));
  return file;
}

function run(file, extraArgs = []) {
  const out = execFileSync('python3', [SCRIPT, '--file', file, ...extraArgs], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(out);
}

function userRec(text, over = {}) {
  return {
    type: 'user', isSidechain: false, timestamp: '2026-07-29T00:00:00Z', cwd: '/w',
    message: { role: 'user', content: text }, ...over
  };
}

function asstRec(blocks, over = {}) {
  return {
    type: 'assistant', isSidechain: false, timestamp: '2026-07-29T00:00:01Z',
    message: { role: 'assistant', content: blocks }, ...over
  };
}

describe('distill-transcript.py', () => {
  it('excludes tool results, thinking blocks, and system reminders', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const file = fixture([
      userRec('hello <system-reminder>SECRET CONTEXT DUMP</system-reminder> world'),
      asstRec([
        { type: 'thinking', thinking: 'INTERNAL REASONING' },
        { type: 'text', text: 'visible reply' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }
      ]),
      userRec([{ type: 'tool_result', content: 'FILE CONTENTS THAT MUST NOT LEAK' }]),
      { type: 'attachment', attachment: { content: 'ATTACHED SECRET' } }
    ]);
    const blob = JSON.stringify(run(file));

    for (const forbidden of [
      'SECRET CONTEXT DUMP', 'INTERNAL REASONING',
      'FILE CONTENTS THAT MUST NOT LEAK', 'ATTACHED SECRET'
    ]) {
      assert.ok(!blob.includes(forbidden), `leaked: ${forbidden}`);
    }
    assert.ok(blob.includes('visible reply'));
    assert.ok(blob.includes('ls -la'), 'the tool label should survive');
  });

  // One assistant reply spans several records (prose, tool call, more prose). Emitting each
  // as its own turn made ~74% of a real session's turn budget single tool calls, so actual
  // exchanges got truncated away.
  it('merges consecutive same-role records into one logical turn', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const file = fixture([
      userRec('do the thing'),
      asstRec([{ type: 'text', text: 'starting' }]),
      asstRec([{ type: 'tool_use', name: 'Bash', input: { command: 'step-one' } }]),
      asstRec([{ type: 'tool_use', name: 'Bash', input: { command: 'step-two' } }]),
      asstRec([{ type: 'text', text: 'done' }]),
      userRec('thanks')
    ]);
    const got = run(file);

    assert.strictEqual(got.turns.length, 3, 'user / assistant / user');
    assert.deepStrictEqual(got.turns.map((x) => x.role), ['user', 'assistant', 'user']);

    const a = got.turns[1];
    assert.match(a.text, /starting/);
    assert.match(a.text, /done/);
    assert.strictEqual(a.tools.length, 2, 'both tool calls kept on the merged turn');
    assert.deepStrictEqual(a.tools.map((x) => x.label), ['step-one', 'step-two']);
  });

  it('never emits a turn that is empty of both text and tools', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const file = fixture([
      userRec('hi'),
      asstRec([]),
      asstRec([{ type: 'tool_result', content: 'nope' }]),
      userRec('bye')
    ]);
    const got = run(file);
    for (const turn of got.turns) {
      assert.ok(turn.text || (turn.tools && turn.tools.length), 'empty turn emitted');
    }
  });

  it('redacts secret-shaped strings and counts them', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const fakes = [
      'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
      'sk-ant-api03-' + 'FAKE0000000000000000000000',
      'AIza' + 'SyFAKE00000000000000000000000000000',
      'deadbeef'.repeat(5),
      'export DISCORD_TOKEN="FAKEtoken0123456789abcdef"'
    ];
    const file = fixture([userRec('creds: ' + fakes.join(' '))]);
    const got = run(file);
    const text = got.turns[0].text;

    assert.ok(got.meta.scrubbedCount >= 5, `expected >=5 redactions, got ${got.meta.scrubbedCount}`);
    for (const marker of ['ghp_A1b2', 'sk-ant-api03-FAKE', 'AIzaSy', 'deadbeefdeadbeef', 'FAKEtoken']) {
      assert.ok(!text.includes(marker), `not redacted: ${marker}`);
    }
    // The key name is useful context and should survive; only the value goes.
    assert.match(text, /DISCORD_TOKEN/);
  });

  it('reports truncation instead of silently dropping turns', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const records = [];
    for (let i = 0; i < 10; i += 1) {
      records.push(userRec(`u${i}`));
      records.push(asstRec([{ type: 'text', text: `a${i}` }]));
    }
    const got = run(fixture(records), ['--max-turns', '4']);
    assert.strictEqual(got.turns.length, 4);
    assert.strictEqual(got.meta.truncated, true);
    assert.strictEqual(got.meta.droppedTurns, 16);
    // Oldest go first: the recent tail is what a reader needs.
    assert.match(got.turns[got.turns.length - 1].text, /a9/);
  });

  it('prefers aiTitle over the first user message', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const withAi = run(fixture([
      userRec('some rambling opening line'),
      { type: 'ai-title', aiTitle: 'Concise Summary' }
    ]));
    assert.strictEqual(withAi.meta.title, 'Concise Summary');

    const withoutAi = run(fixture([userRec('some rambling opening line')]));
    assert.match(withoutAi.meta.title, /rambling/);
  });

  it('skips subagent sidechain records', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const got = run(fixture([
      userRec('main thread'),
      asstRec([{ type: 'text', text: 'SIDECHAIN CHATTER' }], { isSidechain: true })
    ]));
    assert.ok(!JSON.stringify(got).includes('SIDECHAIN CHATTER'));
  });

  it('exits 2 on an invalid session id and 3 when not found', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const bad = spawnSync('python3', [SCRIPT], { input: 'not-a-uuid\n', encoding: 'utf8' });
    assert.strictEqual(bad.status, 2);

    const missing = spawnSync('python3', [SCRIPT], {
      input: '5ef01c15-0000-0000-0000-000000000000\n', encoding: 'utf8'
    });
    assert.strictEqual(missing.status, 3);
  });

  it('survives malformed lines rather than failing the whole run', (t) => {
    if (!pythonOk) return t.skip('python3 unavailable');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-bad-'));
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [
      '{ this is not json',
      JSON.stringify(userRec('still readable')),
      '',
      '{"partial":'
    ].join('\n'));
    const got = run(file);
    assert.strictEqual(got.turns.length, 1);
    assert.match(got.turns[0].text, /still readable/);
  });
});
