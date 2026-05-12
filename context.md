# Claude Tray Notifier - Context

## Current State
- Electron menubar app for macOS, polls relay server for Claude Code session notifications
- Version 1.7.1, unsigned macOS app with shell-based auto-update
- Relay runs inside pezant-tools PM2 process on VM (port 3003, Apache proxied at /api/notify)
- Hook script at `scripts/claude-tray-hook.sh` sends notifications on Claude Code Stop and Notification events

## Recent Changes (2026-05-12)
- **Fixed:** Hook was silently failing because `CLAUDE_TRAY_NOTIFY_URL` was never set in `~/.env`
- Hook now sources `~/.env` as a fallback when the env var isn't in the environment
- Commit: 08e90b6

## Required Environment
- `CLAUDE_TRAY_NOTIFY_URL` must be set (in `~/.env` or shell env) to the relay's `/api/notify` endpoint
- Token file at `~/.config/claude-tray/token` must exist and match VM's `NOTIFY_TOKEN`
- Full session closeout: privateContext/deliverables/closeouts/2026-05-12-claude-tray-notifier-fix.md
