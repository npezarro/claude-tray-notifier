# Claude Tray Notifier

macOS menu bar notifier for Claude Code CLI sessions. Sits in the menu bar as a ghost icon
and fires a native notification when a session finishes or needs input, with enough context
to know whether it is worth switching to: project, conversation title, and what kind of
input is wanted.

Click a notification to open the session, including a scrubbed transcript of the
conversation.

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 20+
- Claude Code CLI
- `python3` for the Conversation tab (`xcode-select --install` if missing)

## Install

```bash
git clone https://github.com/npezarro/claude-tray-notifier.git
cd claude-tray-notifier
./scripts/install-mac.sh
```

That generates an auth token, builds the app, installs it to `/Applications`, and adds a
LaunchAgent so it starts on login. It ends by printing a hooks block.

**You must add that block to `~/.claude/settings.json`, or nothing will ever reach the
app.** It looks like this, with the path pointing at wherever you cloned the repo:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "/path/to/claude-tray-notifier/scripts/claude-tray-hook.sh stop" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command",
        "command": "/path/to/claude-tray-notifier/scripts/claude-tray-hook.sh notification" } ] }
    ]
  }
}
```

Start a Claude Code session and finish a turn. The ghost should turn amber.

The build is unsigned, so macOS may quarantine it on first launch. Right-click the app in
`/Applications` and choose Open, or run
`xattr -dr com.apple.quarantine "/Applications/Claude Tray Notifier.app"`.

## How it works

By default everything stays on one machine:

```
Claude Code hook → http://127.0.0.1:9377/notify → tray app → native notification
```

The app runs a loopback HTTP server on port 9377. The `Stop` and `Notification` hooks POST
a small JSON event to it, authenticated with a shared token at
`~/.config/claude-tray/token` (generated at install; override the location with
`CLAUDE_TRAY_TOKEN_PATH`). Nothing leaves the machine and there is no server to run.

### Tray states

| Icon | State | Meaning |
|------|-------|---------|
| Gray ghost | Idle | No token configured, or auth failed |
| Green ghost | Listening | Ready and receiving |
| Amber ghost | Unread | New notification(s) — click to view |

Left-click opens notification history. Right-click gives quick actions (mark read, clear,
mute system sessions, set token, check for updates, quit).

### Interactive vs system sessions

The `Stop` hook fires identically for a session you are sitting in front of and for
headless runners (scheduled agents, cron jobs, automated fix loops). Runners can easily
outnumber real sessions, burying the notifications that mattered.

Each event carries an `origin`:

- **`interactive`** — notifies normally (sound, alert, amber tray icon).
- **`system`** — collected in a muted **System** tab. No sound, no alert, no tray change.
  Toggle `Mute System Sessions` in the right-click menu to watch a runner live.

`lib/origin.js` decides, in order: a `CLAUDE_TRAY_ORIGIN` env override, the transcript's
`entrypoint` field (`cli` = interactive, `sdk-cli` = headless), then the parent process
command line (`-p`/`--print` = headless). If none of those answer it **fails closed to
`system`** — a misfiled session costs a ping you can still find in the System tab, whereas
the reverse restores the problem this exists to solve.

The working directory is deliberately *not* a signal: headless and interactive runs
routinely share a cwd.

### Reading a conversation

Clicking a notification opens the session window, which has a **Conversation** tab.
`scripts/distill-transcript.py` reads the transcript out of `~/.claude/projects` and
returns it as compact JSON.

It excludes tool results, file contents, thinking blocks, and system reminders **at capture
time**, then scrubs secret-shaped strings from what remains. Scrubbing only catches things
that *look* like credentials, which is exactly why those categories are dropped wholesale
rather than filtered afterwards.

## Multi-machine setup (optional, relay not included)

Local mode only notifies you about sessions on the machine running the app. To collect
sessions from several machines (a remote VM, a second laptop) you need a relay: a small
authenticated HTTP service both ends can reach.

**This repo does not ship a relay.** You have to run your own. Point the app at it by
writing the base URL to `~/.config/claude-tray/relay-url`, and point the hook at it with
`CLAUDE_TRAY_NOTIFY_URL=https://your-relay.example.com/api/notify`.

A relay has to implement three endpoints, all taking `Authorization: Bearer <token>` with
the same token the hook uses:

**`POST /api/notify`** — receives an event from the hook. Store it. The body is:

```json
{
  "type": "stop",
  "session_id": "uuid",
  "project": "my-repo",
  "cwd": "/path/to/project",
  "summary": "first 200 chars of the last assistant message",
  "timestamp": "2026-08-05T12:00:00Z",
  "conv_title": "Fix the login redirect",
  "input_kind": "general",
  "origin": "interactive",
  "entrypoint": "cli",
  "host": "hostname"
}
```

**`GET /api/notify/poll?since=<iso8601>`** (or `?last=<n>` on the first call) — returns
events newer than `since`. The app polls this every 2s:

```json
{ "notifications": [ /* event objects as above */ ] }
```

Return `401` for a bad token; after 3 consecutive 401s the app prompts to re-auth.

**`GET /api/notify/conversation/:sessionId`** — returns the distilled conversation, in the
shape `scripts/distill-transcript.py` emits. Since a session may have run on a different
machine, a relay cannot answer this from its own disk. The sane implementation is to reach
back to the originating machine and run the distiller there, so conversation text is never
stored on the relay. Non-200 responses should carry `{"error": "...", "message": "..."}`;
the app displays `message` verbatim.

Two optional extras, both relay-only:

- `GET /tools/claude-tray-token?callback=<loopback-url>` backs the **Sync Token from
  Server** menu item. It should redirect to `<callback>?token=<new-token>` after
  authenticating the user. The menu item is hidden in local mode.
- Auto-update: write a base URL to `~/.config/claude-tray/update-url` where
  `latest-mac.yml` and the release `.zip` are hosted, and the app will check on startup and
  every 4 hours.

The session id is passed to the distiller on **stdin, never argv**. If your relay invokes
it over SSH, keep that: `ssh` joins trailing argv into one string that the *remote* shell
re-parses, so an argv-passed id is shell-injectable even through `execFile`.

## Development

```bash
npm install
npm start          # Run in dev mode
npm test           # Run tests
npm run lint
npm run build:dir  # Build .app without packaging
npm run build:dmg  # Build .dmg installer
```

Publishing your own builds needs a host you control. `scripts/build-and-host.sh` and
`.github/workflows/build-and-publish.yml` upload over SSH and expect `VM_SSH_HOST`,
`VM_USER`, `VM_REMOTE_DIR`, `VM_SSH_KEY`, and `PUBLIC_DOWNLOAD_URL`. Without those secrets
the publish job skips itself; tests and lint still run.

### Project structure

```
main.js              # Electron main process — tray, window, notifications
lib/
  auth.js            # Token loading and validation
  conversation.js    # Local transcript reads (runs the distiller)
  format.js          # Notification formatting, origin normalization, mute predicate
  origin.js          # Interactive-vs-system classification (also a CLI for the hook)
  poller.js          # Relay polling (multi-machine setups only)
  server.js          # Loopback HTTP server — the local-mode delivery path
  sessions.js        # In-memory session registry
  updater.js         # Auto-update via electron-updater
scripts/
  claude-tray-hook.sh     # Claude Code hook — POSTs events
  distill-transcript.py   # Transcript → scrubbed conversation JSON
  generate-token.sh       # Creates the shared auth token
  install-mac.sh          # Build + install to /Applications
  build-and-host.sh       # Build + upload to your own host
assets/
  ghost-*.png        # Tray icons (idle/listening/unread states)
```

`scripts/distill-transcript.py` is listed in both `build.files` and `build.asarUnpack`. It
has to exist as a real file on disk — an external interpreter cannot read a path inside
`app.asar`.

## License

MIT. See [LICENSE](LICENSE).
