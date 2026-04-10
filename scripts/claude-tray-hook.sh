#!/usr/bin/env bash
# Claude Code hook script — POSTs to the tray notifier app
# Usage: cat | claude-tray-hook.sh <stop|notification>
set -uo pipefail

EVENT_TYPE="${1:-stop}"
TOKEN_PATH="$HOME/repos/privateContext/claude-tray-token"
NOTIFY_URL="http://127.0.0.1:9377/notify"

# Read token — exit silently if missing
TOKEN=$(cat "$TOKEN_PATH" 2>/dev/null || true)
[ -z "$TOKEN" ] && exit 0

# Read hook JSON from stdin
INPUT=$(cat)

# Extract fields
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
PROJECT=$(basename "$CWD" 2>/dev/null || echo "unknown")
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null || echo "")
SUMMARY=$(echo "$LAST_MSG" | head -c 200)

# Map event type
if [ "$EVENT_TYPE" = "notification" ]; then
  TYPE="input_needed"
else
  TYPE="response_complete"
fi

# Build payload
PAYLOAD=$(jq -n \
  --arg type "$TYPE" \
  --arg session_id "$SESSION_ID" \
  --arg project "$PROJECT" \
  --arg cwd "$CWD" \
  --arg summary "$SUMMARY" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{type:$type,session_id:$session_id,project:$project,cwd:$cwd,summary:$summary,timestamp:$timestamp}'
)

# POST to notifier — fail silently
curl -s -X POST "$NOTIFY_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" \
  --connect-timeout 1 \
  --max-time 3 \
  -o /dev/null 2>/dev/null || true

exit 0
