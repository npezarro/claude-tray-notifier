# Claude Tray Notifier

System tray notifier for Claude Code CLI sessions. Sits in the macOS menu bar as a ghost icon and delivers native notifications when Claude needs attention — session complete, input needed, errors, etc.

## How It Works

```
Claude Code CLI hook → your-server.com relay server → Electron poller (2s) → native macOS notification
```

The Claude Code `stop` hook (`scripts/claude-tray-hook.sh`) POSTs session events to a relay endpoint on your-server.com. The Electron app polls that endpoint and displays native notifications with context about what happened (project name, conversation title, input type).

### Tray States

| Icon | State | Meaning |
|------|-------|---------|
| Gray ghost | Idle | App running, not yet connected |
| Green ghost | Listening | Connected to relay, polling |
| Amber ghost | Unread | New notification(s) — click to view |

Clicking the tray icon opens a dropdown showing notification history. Right-click for quick actions (mark read, clear, check for updates, quit).

## Setup

### 1. Generate auth token

```bash
./scripts/generate-token.sh
```

This creates a shared secret at `~/.config/claude-tray/token`. Override with `CLAUDE_TRAY_TOKEN_PATH` env var.

### 2. Install the app

```bash
./scripts/install-mac.sh
```

This builds the Electron app, copies it to `/Applications`, and sets up a LaunchAgent so it starts on login.

### 3. Configure Claude Code hook

Add to your Claude Code `settings.json` hooks:

```json
{
  "hooks": {
    "stop": [
      {
        "command": "cat | ~/repos/claude-tray-notifier/scripts/claude-tray-hook.sh stop"
      }
    ],
    "notification": [
      {
        "command": "cat | ~/repos/claude-tray-notifier/scripts/claude-tray-hook.sh notification"
      }
    ]
  }
}
```

## Updating

Configure the auto-update URL (where `latest-mac.yml` and the `.zip` are hosted):

```bash
echo "https://your-server.com/downloads/" > ~/.config/claude-tray/update-url
```

The app checks for updates automatically on startup and every 4 hours. When an update is available, you'll get a notification — click "Restart" to apply it.

You can also check manually: **right-click tray icon → Check for Updates**.

### Manual update

```bash
cd ~/repos/claude-tray-notifier
git pull
./scripts/install-mac.sh
```

## Publishing a New Version

1. Bump version in `package.json`
2. Run `./scripts/build-and-host.sh`
3. The script builds the `.dmg` and `.zip`, then uploads both plus `latest-mac.yml` to your-server.com
4. Running instances will auto-detect the update within 4 hours

## Development

```bash
npm install
npm start          # Run in dev mode
npm test           # Run tests
npm run build:dir  # Build .app without packaging
npm run build:dmg  # Build .dmg installer
```

### Project Structure

```
main.js              # Electron main process — tray, window, notifications
lib/
  auth.js            # Token loading and validation
  format.js          # Notification formatting, origin normalization, mute predicate
  origin.js          # Interactive-vs-system classification (also a CLI for the hook)
  poller.js          # Polls your-server.com relay for new events
  server.js          # Local HTTP server (testing/direct POST)
  updater.js         # Auto-update via electron-updater
scripts/
  claude-tray-hook.sh     # Claude Code hook — POSTs events to relay
  distill-transcript.py   # Reads a transcript into a scrubbed conversation (runs on the
                          # machine that has the transcript, invoked by the relay)
  generate-token.sh       # Creates shared auth token
  install-mac.sh          # Build + install to /Applications
  build-and-host.sh       # Build + upload to your-server.com
assets/
  ghost-*.png        # Tray icons (idle/listening/unread states)
```

### Interactive vs system sessions

The Claude Code `Stop` hook fires identically for a session you are sitting in front of
and for headless runners (scheduled agents, cron jobs, automated fix loops). Those
runners heavily outnumber real sessions, so notifications that mattered were getting
buried.

Each event now carries an `origin`:

- **`interactive`** — notifies normally (sound, alert, amber tray icon).
- **`system`** — collected in a muted **System** tab. No sound, no alert, no tray change.
  Toggle `Mute System Sessions` in the tray's right-click menu to watch a runner live.

`lib/origin.js` decides, in order: a `CLAUDE_TRAY_ORIGIN` env override, the transcript's
`entrypoint` field (`cli` = interactive, `sdk-cli` = headless), then the parent process
command line (`-p`/`--print` = headless). If none of those answer it **fails closed to
`system`** — a misfiled session costs you a ping you can still find in the System tab,
whereas the reverse restores the problem this exists to solve.

The working directory is deliberately *not* a signal: headless and interactive runs
routinely share a cwd.

### Reading a full conversation

Clicking a notification opens the session window, which has a **Conversation** tab. The
relay stores metadata only; the conversation body is pulled on demand from the machine
that ran the session, so transcripts are never stored on the server. That machine can
legitimately be offline, in which case the tab says so and offers a retry.

`scripts/distill-transcript.py` does the reading. It excludes tool results, file
contents, thinking blocks, and system reminders **at capture time**, then scrubs
secret-shaped strings from what remains. Scrubbing only catches things that *look* like
credentials, which is exactly why those categories are excluded wholesale rather than
filtered afterwards.
