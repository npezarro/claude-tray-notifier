#!/usr/bin/env bash
set -euo pipefail

echo "=== Building Claude Tray Notifier .dmg ==="

cd "$(dirname "$0")/.."

# 1. Install deps
npm install

# 2. Build .dmg
npx electron-builder --mac dmg

# 3. Find the output
DMG=$(find dist -name '*.dmg' -type f | head -1)
if [ -z "$DMG" ]; then
  echo "ERROR: No .dmg found in dist/"
  exit 1
fi

echo ""
echo "Built: $DMG"
echo ""

# 4. Upload to pezant.ca VM
echo "Uploading to pezant.ca..."
VM_USER="$VM_USER"
VM_HOST="$VM_HOST"
VM_KEY="$VM_KEY_PATH"
REMOTE_DIR="/var/www/pezant-tools/public/downloads"

# Try SSH key locations
if [ ! -f "$VM_KEY" ]; then
  VM_KEY="$HOME/.ssh/id_rsa"
fi
if [ ! -f "$VM_KEY" ]; then
  VM_KEY="$HOME/.ssh/id_ed25519"
fi

ssh -i "$VM_KEY" "$VM_USER@$VM_HOST" "mkdir -p $REMOTE_DIR" 2>/dev/null
scp -i "$VM_KEY" "$DMG" "$VM_USER@$VM_HOST:$REMOTE_DIR/claude-tray-notifier.dmg"

echo ""
echo "=== Done ==="
echo "Download URL: https://pezant.ca/tools/downloads/claude-tray-notifier.dmg"
echo ""
echo "To install: open the .dmg and drag to Applications"
