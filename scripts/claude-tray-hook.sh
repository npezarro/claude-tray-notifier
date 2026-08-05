#!/usr/bin/env bash
# Claude Code hook script — POSTs session events to the tray notifier.
# Usage: cat | claude-tray-hook.sh <stop|notification>
set -uo pipefail

EVENT_TYPE="${1:-stop}"

# Source ~/.env for env vars if not already in environment
[ -z "${CLAUDE_TRAY_NOTIFY_URL:-}" ] && [ -f "$HOME/.env" ] && source "$HOME/.env" 2>/dev/null

TOKEN_PATH="${CLAUDE_TRAY_TOKEN_PATH:-$HOME/.config/claude-tray/token}"

# Default to the app's own loopback server. That is the whole setup for a single machine:
# no relay, no server to run, nothing to configure. Point CLAUDE_TRAY_NOTIFY_URL at a
# relay's /api/notify endpoint only when notifications have to cross machines.
NOTIFY_URL="${CLAUDE_TRAY_NOTIFY_URL:-http://127.0.0.1:9377/notify}"
[ -z "$NOTIFY_URL" ] && exit 0
TITLE_CACHE_DIR="$HOME/.cache/claude-tray-titles"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
SUMMARY=$(echo "$LAST_MSG" | head -c 200)

# --- Origin classification + conversation title ---
#
# Both come from one pass over the transcript in lib/origin.js. Origin decides whether
# this notification pings at all: sessions the user is driving are "interactive", headless
# runners are "system" and are muted. The classifier fails closed to "system", so a
# session it cannot identify is quietly queued rather than allowed to interrupt.
#
# Cached per session, but only once the title is the model-generated one — early in a
# session only a first-message fallback is available, and caching that would pin a worse
# title for the whole session.
mkdir -p "$TITLE_CACHE_DIR" 2>/dev/null || true
META_CACHE="$TITLE_CACHE_DIR/$SESSION_ID.json"
META=""

if [ -f "$META_CACHE" ]; then
  META=$(cat "$META_CACHE" 2>/dev/null || true)
fi

if [ -z "$META" ]; then
  META=$(node "$SCRIPT_DIR/../lib/origin.js" "$TRANSCRIPT" 2>/dev/null || true)
  if [ -n "$META" ] && [ -n "$SESSION_ID" ]; then
    case "$META" in
      *'"titleSource":"aiTitle"'*) echo "$META" > "$META_CACHE" 2>/dev/null || true ;;
    esac
  fi
fi

ORIGIN=$(echo "$META" | jq -r '.origin // ""' 2>/dev/null || echo "")
ENTRYPOINT=$(echo "$META" | jq -r '.entrypoint // ""' 2>/dev/null || echo "")
CONV_TITLE=$(echo "$META" | jq -r '.title // ""' 2>/dev/null || echo "")

# Fail closed: if the classifier produced nothing usable, treat this as a system session
# so a broken classifier degrades into silence rather than into noise.
[ "$ORIGIN" = "interactive" ] || ORIGIN="system"

# Fallback to project name
[ -z "$CONV_TITLE" ] && CONV_TITLE="$PROJECT"

# Which machine ran this — the relay uses it to route a conversation pull back here.
HOST=$(hostname -s 2>/dev/null || echo "unknown")

# Clean stale caches (older than 24h)
find "$TITLE_CACHE_DIR" -type f -mtime +1 -delete 2>/dev/null || true

# --- Input type classification ---
INPUT_KIND="general"

if [ "$EVENT_TYPE" = "notification" ]; then
  TYPE="input_needed"
  INPUT_KIND="attention"
else
  TYPE="response_complete"
  # Analyze last message to classify what kind of input is needed
  if [ -n "$LAST_MSG" ]; then
    INPUT_KIND=$(python3 -c "
import sys
msg = sys.stdin.read().strip()
lower = msg.lower()
last_lines = '\n'.join(msg.split('\n')[-5:]).lower()

# Check for question patterns in the tail of the message
if any(p in last_lines for p in ['which ', 'should i ', 'do you want', 'would you like', 'prefer ']):
    print('choice')
elif '?' in last_lines:
    print('question')
elif any(p in last_lines for p in ['permission', 'approve', 'allow', 'confirm']):
    print('approval')
elif any(p in last_lines for p in ['error', 'failed', 'blocked', 'cannot']):
    print('error')
else:
    print('done')
" <<< "$LAST_MSG" 2>/dev/null || echo "done")
  fi
fi

# Build payload
PAYLOAD=$(jq -n \
  --arg type "$TYPE" \
  --arg session_id "$SESSION_ID" \
  --arg project "$PROJECT" \
  --arg cwd "$CWD" \
  --arg summary "$SUMMARY" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg conv_title "$CONV_TITLE" \
  --arg input_kind "$INPUT_KIND" \
  --arg origin "$ORIGIN" \
  --arg entrypoint "$ENTRYPOINT" \
  --arg host "$HOST" \
  '{type:$type,session_id:$session_id,project:$project,cwd:$cwd,summary:$summary,timestamp:$timestamp,conv_title:$conv_title,input_kind:$input_kind,origin:$origin,entrypoint:$entrypoint,host:$host}'
)

# POST the event — fail silently. A hook must never make Claude Code wait on, or fail
# because of, a notifier that is closed or unreachable.
curl -s -X POST "$NOTIFY_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" \
  --connect-timeout 3 \
  --max-time 5 \
  -o /dev/null 2>/dev/null || true

exit 0
