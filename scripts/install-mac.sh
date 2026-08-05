#!/usr/bin/env bash
set -euo pipefail

echo "=== Claude Tray Notifier — macOS Install ==="

# 1. Set up auth token
#
# Generated, not pasted. In the default (local) setup this is only a shared secret
# between the hook and the app on this one machine, so there is nowhere to paste it from.
TOKEN_DIR="$HOME/.config/claude-tray"
mkdir -p "$TOKEN_DIR"

if [ ! -f "$TOKEN_DIR/token" ]; then
  openssl rand -hex 32 > "$TOKEN_DIR/token"
  chmod 600 "$TOKEN_DIR/token"
  echo "Generated an auth token at $TOKEN_DIR/token"
else
  echo "Token already exists at $TOKEN_DIR/token"
fi

# 1b. Relay URL — optional. Without one the app runs in local mode: the hook POSTs to the
# app's own loopback server and nothing leaves the machine.
RELAY_URL_FILE="$TOKEN_DIR/relay-url"
if [ ! -f "$RELAY_URL_FILE" ]; then
  echo ""
  echo "Relay URL (only needed to receive notifications from OTHER machines)."
  echo "Press Enter to skip and run in local mode:"
  read -r RELAY_URL_INPUT
  if [ -n "$RELAY_URL_INPUT" ]; then
    echo "$RELAY_URL_INPUT" > "$RELAY_URL_FILE"
    echo "Relay URL saved. You must also set CLAUDE_TRAY_NOTIFY_URL for the hook."
  else
    echo "Local mode (configure later at $RELAY_URL_FILE if you build a relay)."
  fi
else
  echo "Relay URL already configured at $RELAY_URL_FILE"
fi

# 1c. Set up auto-update URL
UPDATE_URL_FILE="$TOKEN_DIR/update-url"
if [ ! -f "$UPDATE_URL_FILE" ]; then
  echo ""
  echo "Auto-update URL — only if you host your own build artifacts."
  echo "Enter the base URL, or press Enter to skip:"
  read -r UPDATE_URL_INPUT
  if [ -n "$UPDATE_URL_INPUT" ]; then
    echo "$UPDATE_URL_INPUT" > "$UPDATE_URL_FILE"
    echo "Update URL saved."
  else
    echo "Auto-update disabled (can configure later at $UPDATE_URL_FILE)"
  fi
else
  echo "Update URL already configured at $UPDATE_URL_FILE"
fi

# 2. Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# 3. Build the .app
echo ""
echo "Building macOS app..."
npx electron-builder --mac dir

# 4. Copy to /Applications
APP_PATH="dist/mac-arm64/Claude Tray Notifier.app"
if [ ! -d "$APP_PATH" ]; then
  APP_PATH="dist/mac/Claude Tray Notifier.app"
fi

if [ -d "$APP_PATH" ]; then
  echo ""
  echo "Installing to /Applications..."
  cp -R "$APP_PATH" "/Applications/Claude Tray Notifier.app"
  echo "Installed to /Applications/Claude Tray Notifier.app"
else
  echo ""
  echo "Build output not found at expected path. Check dist/ directory."
  ls -la dist/ 2>/dev/null || true
  exit 1
fi

# 5. Create LaunchAgent for auto-start on login
PLIST="$HOME/Library/LaunchAgents/ca.pezant.claude-tray-notifier.plist"
cat > "$PLIST" << 'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ca.pezant.claude-tray-notifier</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/Claude Tray Notifier.app/Contents/MacOS/Claude Tray Notifier</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
PLIST_EOF

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "=== Install complete ==="
echo ""
echo "  App:        /Applications/Claude Tray Notifier.app"
echo "  Auto-start: $PLIST"
echo "  Token:      $TOKEN_DIR/token"
echo ""
echo "LAST STEP — add these hooks to ~/.claude/settings.json, or nothing will ever"
echo "reach the app:"
echo ""
cat <<EOF
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "$REPO_DIR/scripts/claude-tray-hook.sh stop" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command",
        "command": "$REPO_DIR/scripts/claude-tray-hook.sh notification" } ] }
    ]
  }
EOF
echo ""
echo "Launch now with:  open '/Applications/Claude Tray Notifier.app'"
echo "Or it will start automatically on next login."
