# Claude Tray Notifier

macOS menu bar app (Electron) that delivers native notifications when Claude Code sessions need attention.

## Architecture

```
Claude Code stop/notification hook → relay server → Electron poller (2s) → native macOS notification
```

- **main.js** — Electron main process: tray icon management, notification display, dropdown window, session detail windows
- **lib/poller.js** — Polls relay server for new events (2s interval)
- **lib/updater.js** — Auto-update via electron-updater + shell-based installer (see below)
- **lib/sessions.js** — Session registry: groups notifications by session, tracks project/title/timestamps
- **lib/format.js** — Notification title/body formatting from raw payloads
- **lib/auth.js** — Token loading from `~/.config/claude-tray/token`
- **lib/server.js** — Local HTTP server on port 9377 for direct POST (testing/local use)

## Key Patterns

### Tray States
Three ghost icons: gray (idle), green (listening/connected), amber (unread notifications).

### Session Detail
Clicking a notification in the dropdown opens a session detail BrowserWindow. Max 5 concurrent detail windows. Dock icon shown only when detail windows are open (`LSUIElement: true` hides dock icon normally).

### Auto-Update (Unsigned macOS)
electron-updater's `quitAndInstall()` fails for unsigned apps. Solution: spawn a detached bash script that waits for the Electron process to exit, replaces the `.app` bundle, clears quarantine (`xattr -cr`), and relaunches. See `lib/updater.js`.

CI/CD: GitHub Actions macOS runner builds DMG + ZIP, SCPs to update server. Generic provider points to `latest-mac.yml` manifest.

### Auth
Shared token stored at `~/.config/claude-tray/token`. The `Set Auth Token` menu item allows configuring without CLI access.

## Testing

```bash
npm test  # Node.js built-in test runner
```

6 test files covering all lib/ modules. Tests mock Electron APIs (Notification, dialog, autoUpdater).

## Build & Deploy

```bash
npm run build      # electron-builder → DMG + ZIP
npm run build:dir  # .app without packaging (dev)
```

CI triggers on version tags (`v*`). `CSC_IDENTITY_AUTO_DISCOVERY=false` skips code signing.

## Config Files (User Machine)

- `~/.config/claude-tray/token` — Auth token for relay server
- `~/.config/claude-tray/relay-url` — Relay server URL (default in poller.js)
- `~/.config/claude-tray/update-url` — Auto-update manifest URL
