# Claude Tray Notifier - Context

## Current State
- Electron menubar app for macOS, polls relay server for Claude Code session notifications
- Version 1.9.0, unsigned macOS app with shell-based auto-update
- Relay runs inside pezant-tools PM2 process on VM (port 3003, Apache proxied at /api/notify)
- Hook script at `scripts/claude-tray-hook.sh` sends notifications on Claude Code Stop and Notification events
- Token auto-sync: right-click menu "Sync Token from Server" or auto-prompted on 401
- Token endpoint: `/tools/claude-tray-token` (OIDC-gated, serves NOTIFY_TOKEN as plain text)

## Recent Changes (2026-06-30)
- **Added:** Auto-detect token expiry (401 from relay) with "Token Expired" status and native notification
- **Added:** "Sync Token from Server" menu item that opens OIDC-gated token endpoint in a BrowserWindow
- **Added:** Poller `updateToken()` method for hot-swapping tokens without restart
- **Root cause of June 23 disconnect:** VM .env was rewritten during deploy, NOTIFY_TOKEN changed, Mac app had the old token

## Recent Changes (2026-05-12)
- **Fixed:** Hook was silently failing because `CLAUDE_TRAY_NOTIFY_URL` was never set in `~/.env`
- Hook now sources `~/.env` as a fallback when the env var isn't in the environment
- Commit: 08e90b6

## Required Environment
- `CLAUDE_TRAY_NOTIFY_URL` must be set (in `~/.env` or shell env) to the relay's `/api/notify` endpoint
- Token file at `~/.config/claude-tray/token` must exist and match VM's `NOTIFY_TOKEN`
- Full session closeout: privateContext/deliverables/closeouts/2026-05-12-claude-tray-notifier-fix.md

## Recent Changes (2026-07-29) — mute system sessions, conversation view

- **Added:** `lib/origin.js` — classifies a session `interactive` vs `system`. Order:
  `CLAUDE_TRAY_ORIGIN` env override, transcript `entrypoint` (`cli` vs `sdk-cli`), parent
  process cmdline (`-p`/`--print`), then **fail closed to `system`**. Also usable as a CLI
  (`node lib/origin.js <transcript>`), which is how the hook calls it — one tested
  implementation instead of a shell/python transliteration that can drift.
  Verified against real transcripts of both kinds (see `test/origin.test.js`).
- **Added:** muted **System** tab. System events never raise an OS notification, never
  play a sound, and never change the tray icon. `Mute System Sessions` in the right-click
  menu overrides it. The decision is the pure `shouldNotify()` predicate in `lib/format.js`
  so it is unit-testable without mocking Electron.
- **Added:** **Conversation** tab in the session window. Pulls the full conversation via
  the relay from the machine that ran the session; nothing is stored server-side. Every
  failure mode (machine offline, transcript pruned, reader missing) gets a plain-language
  message and a retry instead of a stuck spinner.
- **Added:** `scripts/distill-transcript.py` — transcript to scrubbed conversation JSON.
  Excludes tool results / file contents / thinking / system-reminders at capture time,
  then scrubs secret-shaped strings. Streams, so a 17MB transcript costs ~0.2s and 14MB RSS.
- **Changed:** hook payload gained `origin`, `entrypoint`, and `host` (host lets the relay
  route a conversation pull back to the right machine). Title now prefers the transcript's
  `aiTitle` over the first-line-of-first-message heuristic, and is only cached once the
  good title exists so an early fallback is not pinned for the session.

### Why cwd is not the origin signal
A `sdk-cli` (headless) run and an interactive session routinely share a working directory
— confirmed on real data under `/mnt/c/Users/npeza`. Any cwd- or project-name-based guess
is wrong a meaningful fraction of the time, which is why `entrypoint` is used instead.

### Known pre-existing gap (not introduced here)
`lib/poller.js` hardcodes `https`, so an `http://` relay URL (local testing) throws
`ERR_INVALID_PROTOCOL`. `fetchConversation` in `main.js` follows the same assumption.
Fine in production; it just means the poll path cannot be smoke-tested against a local
http stub.
