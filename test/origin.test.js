const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const origin = require('../lib/origin');

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-test-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return file;
}

describe('entrypointFromTranscript', () => {
  it('reads entrypoint from the first record that has one', () => {
    const file = writeTranscript([
      { type: 'mode', mode: 'default' },
      { type: 'user', entrypoint: 'cli' }
    ]);
    assert.strictEqual(origin.entrypointFromTranscript(file), 'cli');
  });

  it('skips malformed lines instead of giving up', () => {
    const file = writeTranscript([
      '{ this is not json but mentions entrypoint',
      { type: 'user', entrypoint: 'sdk-cli' }
    ]);
    assert.strictEqual(origin.entrypointFromTranscript(file), 'sdk-cli');
  });

  it('returns null for a missing file, empty path, or a transcript with no entrypoint', () => {
    assert.strictEqual(origin.entrypointFromTranscript('/no/such/file.jsonl'), null);
    assert.strictEqual(origin.entrypointFromTranscript(''), null);
    assert.strictEqual(origin.entrypointFromTranscript(undefined), null);
    assert.strictEqual(origin.entrypointFromTranscript(writeTranscript([{ type: 'mode' }])), null);
  });
});

describe('isPrintInvocation', () => {
  it('detects the headless print flags', () => {
    assert.ok(origin.isPrintInvocation('claude -p "do a thing"'));
    assert.ok(origin.isPrintInvocation('claude --print --model haiku'));
    assert.ok(origin.isPrintInvocation('/usr/bin/claude --print=x'));
  });

  it('does not fire on an interactive invocation or a lookalike flag', () => {
    assert.ok(!origin.isPrintInvocation('claude'));
    assert.ok(!origin.isPrintInvocation('claude --permission-mode plan'));
    assert.ok(!origin.isPrintInvocation('claude --port 80'));
  });
});

describe('classifyOrigin', () => {
  it('honours an explicit env override above everything else', () => {
    const file = writeTranscript([{ entrypoint: 'sdk-cli' }]);
    const got = origin.classifyOrigin({ transcriptPath: file, envOrigin: 'interactive' });
    assert.strictEqual(got.origin, 'interactive');
    assert.strictEqual(got.signal, 'env');
  });

  it('ignores a junk env value and falls through to the real signal', () => {
    const file = writeTranscript([{ entrypoint: 'cli' }]);
    const got = origin.classifyOrigin({ transcriptPath: file, envOrigin: 'yes-please' });
    assert.strictEqual(got.signal, 'entrypoint');
    assert.strictEqual(got.origin, 'interactive');
  });

  it('classifies cli as interactive and sdk-cli as system', () => {
    assert.strictEqual(
      origin.classifyOrigin({ transcriptPath: writeTranscript([{ entrypoint: 'cli' }]) }).origin,
      'interactive'
    );
    assert.strictEqual(
      origin.classifyOrigin({ transcriptPath: writeTranscript([{ entrypoint: 'sdk-cli' }]) }).origin,
      'system'
    );
  });

  it('treats an unknown entrypoint as system rather than assuming interactive', () => {
    const got = origin.classifyOrigin({ transcriptPath: writeTranscript([{ entrypoint: 'future-thing' }]) });
    assert.strictEqual(got.origin, 'system');
    assert.strictEqual(got.entrypoint, 'future-thing');
  });

  it('accepts a pre-read entrypoint without touching the filesystem', () => {
    const got = origin.classifyOrigin({ entrypoint: 'cli' });
    assert.strictEqual(got.origin, 'interactive');
    assert.strictEqual(got.signal, 'entrypoint');
  });

  it('falls back to the process tree when there is no transcript', () => {
    const deps = {
      readFileSync: (p) => {
        if (String(p).endsWith('/cmdline')) return 'claude\0-p\0hello\0';
        throw new Error('ENOENT');
      }
    };
    const got = origin.classifyOrigin({ ppid: 1234 }, deps);
    assert.strictEqual(got.signal, 'cmdline');
    assert.strictEqual(got.origin, 'system');
  });

  it('reports interactive from the process tree for a non-print invocation', () => {
    const deps = {
      readFileSync: (p) => {
        if (String(p).endsWith('/cmdline')) return 'claude\0';
        throw new Error('ENOENT');
      }
    };
    assert.strictEqual(origin.classifyOrigin({ ppid: 1234 }, deps).origin, 'interactive');
  });

  // Fail-closed is the point: an unidentifiable session must not ping.
  it('fails closed to system when nothing can be determined', () => {
    const got = origin.classifyOrigin({}, {
      readFileSync: () => { throw new Error('ENOENT'); }
    });
    assert.strictEqual(got.origin, 'system');
    assert.strictEqual(got.signal, 'fallback');
  });

  it('does not throw on a transcript it cannot read', () => {
    assert.doesNotThrow(() => origin.classifyOrigin({ transcriptPath: '/root/nope.jsonl' }));
  });
});

// ---------------------------------------------------------------------------
// Ground truth: real transcripts on this machine, if present. These are the cases
// the classifier actually has to get right in production. Skipped on a machine with
// no Claude Code history rather than failing CI.
// ---------------------------------------------------------------------------
describe('classifyOrigin against real local transcripts', () => {
  const root = path.join(os.homedir(), '.claude', 'projects');

  /**
   * Find the first local transcript whose entrypoint matches, scanning generically rather
   * than naming any specific project directory — those names embed a username and a
   * private repo path, which must not be committed to a public repo.
   */
  // Scans newest-first: headless runs vastly outnumber interactive ones on a machine like
  // this, so a naive scan exhausts its budget on runner transcripts and never finds a cli
  // one — which made this test silently skip, i.e. assert nothing.
  function findByEntrypoint(wanted, limit = 250) {
    let all = [];
    try {
      for (const d of fs.readdirSync(root)) {
        let files;
        try {
          files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl'));
        } catch (_e) {
          continue;
        }
        for (const f of files) {
          const full = path.join(root, d, f);
          try {
            all.push({ full, mtime: fs.statSync(full).mtimeMs });
          } catch (_e) { /* vanished mid-scan */ }
        }
      }
    } catch (_e) {
      return null;
    }
    all.sort((a, b) => b.mtime - a.mtime);
    for (const { full } of all.slice(0, limit)) {
      if (origin.entrypointFromTranscript(full) === wanted) return full;
    }
    return null;
  }

  it('classifies a real headless (sdk-cli) transcript as system', (t) => {
    const file = findByEntrypoint('sdk-cli');
    if (!file) return t.skip('no local sdk-cli transcript found');
    const got = origin.classifyOrigin({ transcriptPath: file });
    assert.strictEqual(got.entrypoint, 'sdk-cli');
    assert.strictEqual(got.origin, 'system');
  });

  it('classifies a real interactive (cli) transcript as interactive', (t) => {
    const file = findByEntrypoint('cli');
    if (!file) return t.skip('no local cli transcript found');
    const got = origin.classifyOrigin({ transcriptPath: file });
    assert.strictEqual(got.entrypoint, 'cli');
    assert.strictEqual(got.origin, 'interactive');
  });
});
