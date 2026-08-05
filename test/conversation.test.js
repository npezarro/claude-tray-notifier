const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readLocalConversation, distillerPath } = require('../lib/conversation');

// The interpreter is injectable, so these run against a stub written in Node rather than
// requiring python3 on the test machine. The real distiller has its own suite in
// distill.test.js; what is under test here is the contract between them — stdin delivery,
// stdout parsing, and the exit-code mapping.
let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-test-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function stub(name, body) {
  const file = path.join(dir, `${name}.js`);
  fs.writeFileSync(file, body);
  return { python: process.execPath, scriptPath: file };
}

const ECHO_STDIN = `
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ sessionId: input.trim(), turns: [{ role: 'user' }] }));
    process.exit(0);
  });
`;

describe('readLocalConversation', () => {
  it('returns the parsed conversation on exit 0', async () => {
    const res = await readLocalConversation('abc-123', stub('ok', ECHO_STDIN));
    assert.equal(res.ok, true);
    assert.deepEqual(res.conversation.turns, [{ role: 'user' }]);
  });

  it('passes the session id on stdin, not argv', async () => {
    const opts = stub('argv', `
      let input = '';
      process.stdin.on('data', (c) => { input += c; });
      process.stdin.on('end', () => {
        process.stdout.write(JSON.stringify({ stdin: input.trim(), argv: process.argv.slice(2) }));
        process.exit(0);
      });
    `);
    const res = await readLocalConversation('7f3d-session', opts);
    assert.equal(res.conversation.stdin, '7f3d-session');
    assert.deepEqual(res.conversation.argv, [], 'the id must never reach argv');
  });

  it('maps exit 3 to a not_found the user can act on', async () => {
    const res = await readLocalConversation('x', stub('missing', 'process.exit(3)'));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_found');
    assert.match(res.message, /machine that ran it/);
  });

  it('maps exit 2 to a bad session id', async () => {
    const res = await readLocalConversation('nope', stub('badid', 'process.exit(2)'));
    assert.equal(res.error, 'bad_session_id');
  });

  it('maps exit 4 to a read failure', async () => {
    const res = await readLocalConversation('x', stub('failed', 'process.exit(4)'));
    assert.equal(res.error, 'distill_failed');
  });

  it('surfaces stderr for an unrecognised exit code', async () => {
    const opts = stub('weird', 'process.stderr.write("boom\\n"); process.exit(9)');
    const res = await readLocalConversation('x', opts);
    assert.equal(res.error, 'exit_9');
    assert.equal(res.message, 'boom');
  });

  it('reports a missing interpreter as no_python, not ENOENT', async () => {
    const res = await readLocalConversation('x', {
      python: path.join(dir, 'definitely-not-installed'),
      scriptPath: path.join(dir, 'irrelevant.py')
    });
    assert.equal(res.error, 'no_python');
    assert.match(res.message, /xcode-select/);
  });

  it('rejects non-JSON output rather than throwing', async () => {
    const opts = stub('garbage', 'process.stdout.write("<html>nope</html>"); process.exit(0)');
    const res = await readLocalConversation('x', opts);
    assert.equal(res.error, 'malformed_output');
  });

  it('kills a hung reader and reports a timeout', async () => {
    const opts = stub('hang', 'setInterval(() => {}, 1000)');
    const res = await readLocalConversation('x', { ...opts, timeoutMs: 150 });
    assert.equal(res.error, 'timeout');
  });
});

describe('distillerPath', () => {
  it('points outside app.asar, which an interpreter cannot read into', () => {
    const p = distillerPath('/Applications/App.app/Contents/Resources/app.asar');
    assert.equal(p, '/Applications/App.app/Contents/Resources/app.asar.unpacked/scripts/distill-transcript.py');
  });

  it('leaves an unpackaged path alone', () => {
    assert.equal(distillerPath('/src/claude-tray'), '/src/claude-tray/scripts/distill-transcript.py');
  });

  it('does not rewrite a directory that merely starts with app.asar', () => {
    const p = distillerPath('/src/app.asarbackup');
    assert.equal(p, '/src/app.asarbackup/scripts/distill-transcript.py');
  });

  it('resolves to a file that exists in this checkout', () => {
    assert.ok(fs.existsSync(distillerPath()), 'the packaged files list must keep this in sync');
  });
});
