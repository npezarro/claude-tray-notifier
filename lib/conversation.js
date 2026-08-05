const { spawn } = require('child_process');
const path = require('path');

/**
 * Read a session's conversation from the transcript on THIS machine.
 *
 * This is the local-mode counterpart to the relay's conversation endpoint. In a relay
 * setup the session may have run on a different machine, so the relay has to reach back
 * to that machine; in local mode the transcript is simply sitting in ~/.claude/projects,
 * so the same distiller runs directly.
 *
 * The session id goes on STDIN, never argv — the distiller's own contract, kept here so
 * both callers are identical. It resolves the transcript itself by globbing a fixed root
 * for a strictly-validated UUID, which is why no path is passed in.
 */

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Locate the distiller as a real file on disk.
 *
 * A packaged Electron app serves its own files out of app.asar, and an external
 * interpreter cannot read a path inside that archive. `asarUnpack` in package.json
 * writes the script beside the archive instead, so the .asar segment of the path has to
 * be rewritten to .asar.unpacked. In development there is no archive and this is a
 * no-op.
 */
function distillerPath(rootDir = path.join(__dirname, '..')) {
  const unpacked = rootDir.replace(/app\.asar(?=[/\\]|$)/, 'app.asar.unpacked');
  return path.join(unpacked, 'scripts', 'distill-transcript.py');
}

// Exit codes are the distiller's contract. Each maps to something the user can act on,
// because "could not load conversation" is not a diagnosis.
const EXIT_MESSAGES = {
  2: {
    error: 'bad_session_id',
    message: 'That session id is not a valid UUID.'
  },
  3: {
    error: 'not_found',
    message: 'No transcript for this session on this machine. In local mode the ' +
      'conversation can only be read on the machine that ran it.'
  },
  4: {
    error: 'distill_failed',
    message: 'The transcript could not be read (it may be empty or still being written).'
  }
};

function readLocalConversation(sessionId, opts = {}) {
  const python = opts.python || 'python3';
  const script = opts.scriptPath || distillerPath();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn_failed', message: e.message });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: 'timeout', message: 'Reading the transcript timed out.' });
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    // A missing interpreter is the single most likely failure on a stock Mac, where
    // python3 only exists once the Xcode command line tools are installed. Saying so
    // beats a bare ENOENT.
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        return finish({
          ok: false,
          error: 'no_python',
          message: `${python} was not found. Install it (on macOS: xcode-select --install) ` +
            'to read conversations in local mode.'
        });
      }
      finish({ ok: false, error: 'spawn_failed', message: e.message });
    });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          return finish({ ok: true, conversation: JSON.parse(stdout) });
        } catch (_e) {
          return finish({
            ok: false,
            error: 'malformed_output',
            message: 'The transcript reader returned output that was not JSON.'
          });
        }
      }
      const known = EXIT_MESSAGES[code];
      if (known) return finish({ ok: false, ...known });
      finish({
        ok: false,
        error: `exit_${code}`,
        message: stderr.trim() || `The transcript reader exited with code ${code}.`
      });
    });

    child.stdin.on('error', () => {}); // a dead child makes this write fail; close handles it
    child.stdin.end(String(sessionId || ''));
  });
}

module.exports = { readLocalConversation, distillerPath, DEFAULT_TIMEOUT_MS };
