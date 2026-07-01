# Claude Tray Notifier - Context

## Current State
- Electron menubar app for macOS, polls relay server for Claude Code session notifications
- Version 1.8.0, unsigned macOS app with shell-based auto-update
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
