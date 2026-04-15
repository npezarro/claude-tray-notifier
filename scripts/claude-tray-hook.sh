#!/usr/bin/env bash
# Claude Code hook script — POSTs to pezant.ca relay for the tray notifier
# Usage: cat | claude-tray-hook.sh <stop|notification>
set -uo pipefail

EVENT_TYPE="${1:-stop}"
TOKEN_PATH="$HOME/repos/privateContext/claude-tray-token"
NOTIFY_URL="https://pezant.ca/api/notify"
TITLE_CACHE_DIR="$HOME/.cache/claude-tray-titles"

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

# --- Conversation title ---
# Cache per session so we only parse the transcript once
mkdir -p "$TITLE_CACHE_DIR" 2>/dev/null || true
TITLE_CACHE="$TITLE_CACHE_DIR/$SESSION_ID"
CONV_TITLE=""

if [ -f "$TITLE_CACHE" ]; then
  CONV_TITLE=$(cat "$TITLE_CACHE")
elif [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  # Extract first human message from JSONL transcript and summarize to a title
  CONV_TITLE=$(python3 -c "
import json, sys
title = ''
try:
    with open(sys.argv[1]) as f:
        for line in f:
            try:
                msg = json.loads(line)
            except:
                continue
            # Look for first human/user message
            role = msg.get('role', '')
            if role in ('human', 'user'):
                content = msg.get('content', '')
                if isinstance(content, list):
                    # Extract text from content blocks
                    parts = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text']
                    content = ' '.join(parts)
                # Clean up: first meaningful line, strip system tags
                for line in content.split('\n'):
                    line = line.strip()
                    if line and not line.startswith('<system') and not line.startswith('<!--'):
                        title = line[:80]
                        break
                if title:
                    break
except:
    pass
print(title)
" "$TRANSCRIPT" 2>/dev/null || echo "")
  # Cache it
  if [ -n "$CONV_TITLE" ] && [ -n "$SESSION_ID" ]; then
    echo "$CONV_TITLE" > "$TITLE_CACHE" 2>/dev/null || true
  fi
fi

# Fallback to project name
[ -z "$CONV_TITLE" ] && CONV_TITLE="$PROJECT"

# Clean stale title caches (older than 24h)
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
  '{type:$type,session_id:$session_id,project:$project,cwd:$cwd,summary:$summary,timestamp:$timestamp,conv_title:$conv_title,input_kind:$input_kind}'
)

# POST to pezant.ca relay — fail silently
curl -s -X POST "$NOTIFY_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" \
  --connect-timeout 3 \
  --max-time 5 \
  -o /dev/null 2>/dev/null || true

exit 0
