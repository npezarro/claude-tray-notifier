#!/usr/bin/env bash
set -euo pipefail

echo "=== Claude Tray Notifier — macOS Install ==="

# 1. Set up auth token
TOKEN_DIR="$HOME/.config/claude-tray"
mkdir -p "$TOKEN_DIR"

if [ ! -f "$TOKEN_DIR/token" ]; then
  echo ""
  echo "No token found at $TOKEN_DIR/token"
  echo "Paste your auth token (from privateContext/claude-tray-token):"
  read -r TOKEN_INPUT
  echo "$TOKEN_INPUT" > "$TOKEN_DIR/token"
  chmod 600 "$TOKEN_DIR/token"
  echo "Token saved."
else
  echo "Token already exists at $TOKEN_DIR/token"
fi

# 1b. Set up auto-update URL
UPDATE_URL_FILE="$TOKEN_DIR/update-url"
if [ ! -f "$UPDATE_URL_FILE" ]; then
  echo ""
  echo "No auto-update URL configured."
  echo "Enter the base URL where update artifacts are hosted (or press Enter to skip):"
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

echo ""
echo "=== Install complete ==="
echo ""
echo "  App:        /Applications/Claude Tray Notifier.app"
echo "  Auto-start: $PLIST"
echo "  Token:      $TOKEN_DIR/token"
echo ""
echo "Launch now with:  open '/Applications/Claude Tray Notifier.app'"
echo "Or it will start automatically on next login."
