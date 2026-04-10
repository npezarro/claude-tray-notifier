#!/usr/bin/env bash
set -euo pipefail

TOKEN_PATH="$HOME/repos/privateContext/claude-tray-token"

if [ -f "$TOKEN_PATH" ]; then
  echo "Token already exists at $TOKEN_PATH"
  echo "Delete it first if you want to regenerate."
  exit 1
fi

openssl rand -hex 32 > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"

# Create config symlink for the app
mkdir -p "$HOME/.config/claude-tray"
ln -sf "$TOKEN_PATH" "$HOME/.config/claude-tray/token"

echo "Token generated at $TOKEN_PATH"
echo "Symlinked to ~/.config/claude-tray/token"
