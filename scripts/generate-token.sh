#!/usr/bin/env bash
set -euo pipefail

TOKEN_PATH="${CLAUDE_TRAY_TOKEN_PATH:-$HOME/.config/claude-tray/token}"

if [ -f "$TOKEN_PATH" ]; then
  echo "Token already exists at $TOKEN_PATH"
  echo "Delete it first if you want to regenerate."
  exit 1
fi

mkdir -p "$(dirname "$TOKEN_PATH")"
openssl rand -hex 32 > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"

echo "Token generated at $TOKEN_PATH"
