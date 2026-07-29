/**
 * Classify a Claude Code session as interactive or system-generated.
 *
 * Why this exists: the Stop hook fires identically for a session the user is sitting in
 * front of and for headless runners (scheduled agents, CI-style fix loops, cron jobs).
 * Those runners vastly outnumber real sessions, so without a split every interactive
 * notification is buried.
 *
 * Signals, first match wins:
 *   1. An explicit CLAUDE_TRAY_ORIGIN env override, so a runner can self-declare.
 *   2. The transcript's `entrypoint` field — "cli" is interactive, "sdk-cli" is the
 *      headless/programmatic path. This is the authoritative signal.
 *   3. The parent process command line — a `-p`/`--print` invocation is headless.
 *   4. Fail closed to "system".
 *
 * Note on (4): the asymmetry is deliberate. A misclassified interactive session still
 * shows up in the muted queue, so nothing is lost but the ping. A misclassified system
 * session recreates exactly the firehose this module exists to stop.
 *
 * Deliberately NOT used as a signal: the working directory. A headless run and an
 * interactive session routinely share a cwd, so any cwd- or project-name-based guess is
 * wrong a meaningful fraction of the time.
 */

const fs = require('fs');

const INTERACTIVE = 'interactive';
const SYSTEM = 'system';

const INTERACTIVE_ENTRYPOINTS = new Set(['cli']);

/** Read `entrypoint` from the first transcript record that carries one. */
function entrypointFromTranscript(transcriptPath, { readFileSync = fs.readFileSync } = {}) {
  if (!transcriptPath) return null;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (_e) {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line || line.indexOf('entrypoint') === -1) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.entrypoint === 'string' && rec.entrypoint) {
        return rec.entrypoint;
      }
    } catch (_e) {
      // Partial or malformed line — keep scanning.
    }
  }
  return null;
}

/**
 * Walk up the process tree looking for the `claude` invocation. A hook runs as a child
 * of the CLI, but not always a direct child, hence the walk.
 */
function findClaudeCmdline(startPid, { readFileSync = fs.readFileSync } = {}) {
  let pid = startPid;
  for (let i = 0; i < 6; i += 1) {
    if (!pid || pid === '0' || pid === 0) return null;
    let cmdline;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch (_e) {
      return null;
    }
    if (/(^|[/\s])claude(\.exe)?(\s|$)/.test(cmdline)) return cmdline;
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^PPid:\s*(\d+)/m);
      pid = m ? m[1] : null;
    } catch (_e) {
      return null;
    }
  }
  return null;
}

function isPrintInvocation(cmdline) {
  return / (-p|--print)([ =]|$)/.test(` ${cmdline} `);
}

/**
 * @param {object} input
 * @param {string} [input.transcriptPath]
 * @param {string} [input.entrypoint]  pre-read entrypoint, if the caller already has it
 * @param {string} [input.envOrigin]   CLAUDE_TRAY_ORIGIN value
 * @param {number|string} [input.ppid]
 * @returns {{origin: string, entrypoint: string|null, signal: string}}
 */
function classifyOrigin(input = {}, deps = {}) {
  const { transcriptPath, envOrigin, ppid } = input;

  if (envOrigin === INTERACTIVE || envOrigin === SYSTEM) {
    return { origin: envOrigin, entrypoint: input.entrypoint || null, signal: 'env' };
  }

  const entrypoint = input.entrypoint || entrypointFromTranscript(transcriptPath, deps);
  if (entrypoint) {
    return {
      origin: INTERACTIVE_ENTRYPOINTS.has(entrypoint) ? INTERACTIVE : SYSTEM,
      entrypoint,
      signal: 'entrypoint'
    };
  }

  const cmdline = findClaudeCmdline(ppid, deps);
  if (cmdline) {
    return {
      origin: isPrintInvocation(cmdline) ? SYSTEM : INTERACTIVE,
      entrypoint: null,
      signal: 'cmdline'
    };
  }

  return { origin: SYSTEM, entrypoint: null, signal: 'fallback' };
}

/**
 * Extract a conversation title. Prefers the model-generated `aiTitle`, which is a real
 * summary, over the first line of the first user message, which is often a bare
 * greeting, a pasted path, or truncated mid-sentence.
 */
function extractTitle(transcriptPath, { readFileSync = fs.readFileSync } = {}) {
  if (!transcriptPath) return { title: '', source: 'none' };
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (_e) {
    return { title: '', source: 'none' };
  }

  let aiTitle = '';
  let firstUser = '';

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    if (!rec) continue;

    if (rec.type === 'ai-title' && rec.aiTitle) {
      aiTitle = String(rec.aiTitle); // keep scanning; later titles are better informed
      continue;
    }

    if (!firstUser && rec.type === 'user' && rec.message && !rec.isSidechain) {
      let content = rec.message.content;
      if (Array.isArray(content)) {
        content = content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join(' ');
      }
      if (typeof content === 'string' && content) {
        const cleaned = content
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
          .replace(/<command-[\s\S]*?>/g, ' ')
          .replace(/<!--[\s\S]*?-->/g, ' ');
        for (const candidate of cleaned.split('\n')) {
          const t = candidate.trim();
          if (t && !t.startsWith('<')) {
            firstUser = t.slice(0, 80);
            break;
          }
        }
      }
    }
  }

  if (aiTitle) return { title: aiTitle.slice(0, 80), source: 'aiTitle' };
  if (firstUser) return { title: firstUser, source: 'firstMessage' };
  return { title: '', source: 'none' };
}

/**
 * CLI: `node lib/origin.js <transcript-path>` prints one JSON object.
 *
 * The Stop hook shells out to this so the classification has exactly one tested
 * implementation rather than a shell/python transliteration that can drift.
 */
function main(argv) {
  const transcriptPath = argv[0] || '';
  const result = classifyOrigin({
    transcriptPath,
    envOrigin: process.env.CLAUDE_TRAY_ORIGIN,
    ppid: process.ppid
  });
  const { title, source } = extractTitle(transcriptPath);
  process.stdout.write(JSON.stringify({
    origin: result.origin,
    entrypoint: result.entrypoint || '',
    signal: result.signal,
    title,
    titleSource: source
  }));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (_e) {
    // Never let a classifier crash break the notification: emit the safe default.
    process.stdout.write(JSON.stringify({
      origin: SYSTEM, entrypoint: '', signal: 'error', title: '', titleSource: 'none'
    }));
  }
}

module.exports = {
  classifyOrigin,
  entrypointFromTranscript,
  extractTitle,
  findClaudeCmdline,
  isPrintInvocation,
  INTERACTIVE,
  SYSTEM
};
