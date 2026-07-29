#!/usr/bin/env python3
"""Distill a Claude Code session transcript (JSONL) into compact, readable JSON.

A remote caller invokes this over SSH and reads its stdout. The session id
arrives on stdin (never argv) so a malicious id can never be shell-injected:
the remote command stays a fixed literal. This program only ever globs a fixed
root under the user's home for a strictly-validated UUID; it constructs no path
from input.

Privacy model
-------------
Tool results, `toolUseResult` fields, `thinking` blocks, attachment records and
file-history snapshots are excluded *while building* the output, never merely
stripped afterward -- they are the biggest leak surface (file contents, command
output, API responses). On the small amount of text that remains (user/assistant
prose and short tool labels) we run a secret scrubber as defence in depth.

The scrubber only catches secret-SHAPED strings (key prefixes, high-entropy
tokens, key material, assignment forms, long hex). It CANNOT catch plain-English
sensitive content -- e.g. someone typing a password as ordinary prose, or a
private fact stated in a sentence. That is precisely why tool results and file
contents are dropped wholesale rather than scrubbed: scrubbing is a backstop,
not the primary control.

Stdlib only. No external dependencies.
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone


# --- session id validation --------------------------------------------------

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


# --- structural strippers (title derivation / system-reminder removal) -------

SYSTEM_REMINDER_RE = re.compile(
    r"<system-reminder>.*?</system-reminder>", re.DOTALL | re.IGNORECASE
)
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
COMMAND_BLOCK_RE = re.compile(
    r"<command-[^>]*>.*?</command-[^>]*>", re.DOTALL | re.IGNORECASE
)
COMMAND_SELF_RE = re.compile(r"<command-[^>]*/?>", re.IGNORECASE)
XML_TAG_RE = re.compile(r"<[^>]+>")


# --- secret scrubbing --------------------------------------------------------
# Ordered specific -> generic so that precise patterns claim their matches
# before the broad hex / assignment catch-alls run. Compiled once at module
# load. Each entry is (compiled_pattern, replacement) where replacement is
# either the literal "[REDACTED]" or a callable that keeps a leading key name
# and redacts only the value.

REDACTED = "[REDACTED]"


def _redact_value_after(match):
    """Keep the captured key + separator, redact the value that follows."""
    return match.group(1) + REDACTED


SCRUB_PATTERNS = [
    # PEM private key blocks (BEGIN ... PRIVATE KEY ... END ...)
    (
        re.compile(
            r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*-----",
            re.DOTALL,
        ),
        REDACTED,
    ),
    # Discord webhook URLs
    (
        re.compile(
            r"https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/(?:v\d+/)?"
            r"webhooks/\d+/[A-Za-z0-9_\-]+"
        ),
        REDACTED,
    ),
    # JWTs (three base64url segments)
    (
        re.compile(
            r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b"
        ),
        REDACTED,
    ),
    # Anthropic keys (before the generic sk- rule)
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), REDACTED),
    # GitHub fine-grained PAT
    (re.compile(r"github_pat_[A-Za-z0-9_]{22,}"), REDACTED),
    # GitHub classic / OAuth / app tokens: ghp_ gho_ ghu_ ghs_ ghr_
    (re.compile(r"gh[posur]_[A-Za-z0-9]{36,}"), REDACTED),
    # Google API keys
    (re.compile(r"AIza[0-9A-Za-z_\-]{35}"), REDACTED),
    # Google OAuth access tokens
    (re.compile(r"ya29\.[0-9A-Za-z_\-]+"), REDACTED),
    # Slack tokens
    (re.compile(r"xox[abposr]-[A-Za-z0-9\-]{10,}"), REDACTED),
    # AWS access key ids
    (re.compile(r"AKIA[0-9A-Z]{16}"), REDACTED),
    # Discord bot token shape
    (
        re.compile(r"\b[MNO][A-Za-z0-9_\-]{23}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27,}\b"),
        REDACTED,
    ),
    # Generic sk-... keys (20+ chars) -- runs after sk-ant-
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), REDACTED),
    # Authorization: Bearer <token>  (keep the header name, drop the value)
    (
        re.compile(
            r"(?i)(authorization\s*:\s*bearer\s+)(?!\[REDACTED\])[A-Za-z0-9._\-]+"
        ),
        _redact_value_after,
    ),
    # key=value / key: "value" assignment forms (keep the key, drop the value).
    #
    # The key name is matched with optional surrounding word characters rather than a
    # \b-anchored keyword, because real credential vars are nearly always prefixed or
    # suffixed: DISCORD_TOKEN, GITHUB_TOKEN, DB_PASSWORD, MY_API_KEY. A \b before
    # "token" does not match inside "DISCORD_TOKEN" (both sides are word characters),
    # so the anchored form silently missed the most common shape there is.
    (
        re.compile(
            r"(?i)"
            r"([A-Za-z0-9_.\-]*"
            r"(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token"
            r"|client[_-]?secret|auth[_-]?token|token|credential|webhook)"
            r"[A-Za-z0-9_.\-]*"
            r"\s*[:=]\s*[\"']?)"
            r"(?!\[REDACTED\])[^\s\"',]{3,}"
        ),
        _redact_value_after,
    ),
    # Bare high-entropy hex strings (catch-all, runs last)
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), REDACTED),
]


def scrub(text):
    """Return (scrubbed_text, replacement_count) for one string."""
    if not text:
        return text, 0
    total = 0
    for pattern, replacement in SCRUB_PATTERNS:
        text, n = pattern.subn(replacement, text)
        total += n
    return text, total


# --- transcript resolution ---------------------------------------------------

def resolve_transcript(session_id):
    """Glob the FIXED projects root for <session_id>.jsonl.

    session_id is already validated to hex + hyphens, so it carries no glob
    metacharacters. If several project dirs hold the same id, pick the most
    recently modified. Return a path or None.
    """
    root = os.path.join(
        os.path.expanduser("~"), ".claude", "projects", "*", session_id + ".jsonl"
    )
    matches = glob.glob(root)
    if not matches:
        return None
    matches.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return matches[0]


def session_id_from_path(path):
    """Best-effort session id from a --file path's basename."""
    base = os.path.basename(path)
    if base.endswith(".jsonl"):
        base = base[: -len(".jsonl")]
    if UUID_RE.match(base):
        return base.lower()
    return ""


# --- record parsing ----------------------------------------------------------

def iter_records(path):
    """Yield parsed dict records, streaming one line at a time.

    Malformed lines are skipped without failing the run. Never loads the whole
    file into memory.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                yield obj


def tool_label(name, inp):
    """Derive a short (<=120 char) human descriptor for a tool call.

    Only whitelisted fields are read per tool -- the full input dict is never
    emitted. Unrecognized tools get an empty label (just the tool name).
    """
    if not isinstance(inp, dict):
        inp = {}
    label = ""
    if name == "Bash":
        label = (inp.get("command") or "").split("\n", 1)[0]
    elif name in ("Read", "Write", "Edit", "NotebookEdit"):
        label = inp.get("file_path") or ""
    elif name in ("Grep", "Glob"):
        pattern = inp.get("pattern") or ""
        path = inp.get("path") or ""
        if path and len(path) <= 40:
            label = (pattern + " " + path).strip()
        else:
            label = pattern
    elif name in ("Task", "Agent"):
        label = inp.get("description") or ""
    elif name == "WebFetch":
        label = inp.get("url") or ""
    elif name == "WebSearch":
        label = inp.get("query") or ""
    else:
        label = ""
    if not isinstance(label, str):
        label = ""
    return label[:120]


def extract_message(msg):
    """Pull emittable text + tool labels from one message record.

    Excluded at capture time: tool_result blocks, thinking blocks, and any
    system-reminder span inside text. Returns (text, tools, scrub_count).
    """
    content = msg.get("content")
    parts = []
    tools = []
    scrub_count = 0

    if isinstance(content, str):
        cleaned = SYSTEM_REMINDER_RE.sub("", content)
        cleaned, n = scrub(cleaned)
        scrub_count += n
        if cleaned.strip():
            parts.append(cleaned)
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                cleaned = SYSTEM_REMINDER_RE.sub("", block.get("text") or "")
                cleaned, n = scrub(cleaned)
                scrub_count += n
                if cleaned.strip():
                    parts.append(cleaned)
            elif btype == "tool_use":
                name = block.get("name") or ""
                label, n = scrub(tool_label(name, block.get("input")))
                scrub_count += n
                tools.append({"name": name, "label": label})
            # thinking and tool_result blocks are intentionally dropped.

    return "\n".join(parts).strip(), tools, scrub_count


def derive_title(text):
    """First meaningful line of a user message, wrapper markup removed."""
    if not text:
        return ""
    t = SYSTEM_REMINDER_RE.sub("", text)
    t = HTML_COMMENT_RE.sub("", t)
    t = COMMAND_BLOCK_RE.sub("", t)
    t = COMMAND_SELF_RE.sub("", t)
    t = XML_TAG_RE.sub(" ", t)
    for line in t.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:80]
    return ""


def distill(path, session_id, max_turns):
    """Build the result dict from a transcript.

    Streams the file, keeping only retained turns (bounded to max_turns while
    streaming so a huge transcript never blows up memory). Returns
    (result, dropped_streaming, parsed_any).
    """
    turns = []
    dropped = 0
    scrub_total = 0
    parsed_any = False

    meta_cwd = ""
    meta_branch = ""
    meta_entry = ""
    meta_sid = session_id or ""
    ai_title = ""
    first_user_text = None
    first_ts = None
    last_ts = None

    for obj in iter_records(path):
        parsed_any = True
        rtype = obj.get("type")

        if rtype == "ai-title":
            at = obj.get("aiTitle")
            if isinstance(at, str) and at.strip():
                ai_title = at.strip()  # last one wins
            continue
        if rtype in ("attachment", "file-history-snapshot"):
            continue

        # Capture session metadata from the first record that carries each.
        if not meta_cwd and isinstance(obj.get("cwd"), str):
            meta_cwd = obj["cwd"]
        if not meta_branch and isinstance(obj.get("gitBranch"), str):
            meta_branch = obj["gitBranch"]
        if not meta_entry and isinstance(obj.get("entrypoint"), str):
            meta_entry = obj["entrypoint"]
        if not meta_sid and isinstance(obj.get("sessionId"), str):
            meta_sid = obj["sessionId"]

        # Subagent chatter is not the main conversation.
        if obj.get("isSidechain") is True:
            continue

        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue

        text, tools, n = extract_message(msg)
        scrub_total += n
        if not text and not tools:
            continue

        ts = obj.get("timestamp")
        if not isinstance(ts, str):
            ts = ""
        if first_ts is None and ts:
            first_ts = ts
        if ts:
            last_ts = ts

        turns.append(
            {"role": role, "timestamp": ts, "text": text, "tools": tools}
        )
        if role == "user" and first_user_text is None:
            first_user_text = text

        # Bound memory: drop oldest turns beyond the cap as we stream.
        if len(turns) > max_turns:
            del turns[0]
            dropped += 1

    if ai_title:
        title = ai_title
    elif first_user_text:
        title = derive_title(first_user_text)
    else:
        title = ""

    generated_at = (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )

    result = {
        "meta": {
            "sessionId": meta_sid,
            "title": title,
            "cwd": meta_cwd,
            "gitBranch": meta_branch,
            "entrypoint": meta_entry,
            "firstTimestamp": first_ts or "",
            "lastTimestamp": last_ts or "",
            "turnCount": len(turns),
            "truncated": False,
            "droppedTurns": 0,
            "scrubbedCount": scrub_total,
            "generatedAt": generated_at,
        },
        "turns": turns,
    }
    return result, dropped, parsed_any


# --- truncation --------------------------------------------------------------

def _serialized_size(result):
    return len(json.dumps(result, ensure_ascii=False).encode("utf-8"))


def apply_caps(result, max_turns, max_bytes, already_dropped):
    """Enforce the turn/byte caps by dropping the OLDEST turns first."""
    turns = result["turns"]
    dropped = already_dropped

    if len(turns) > max_turns:
        excess = len(turns) - max_turns
        del turns[:excess]
        dropped += excess

    result["meta"]["turnCount"] = len(turns)
    while len(turns) > 1 and _serialized_size(result) > max_bytes:
        del turns[0]
        dropped += 1
        result["meta"]["turnCount"] = len(turns)

    result["meta"]["turnCount"] = len(turns)
    result["meta"]["droppedTurns"] = dropped
    result["meta"]["truncated"] = dropped > 0


# --- entrypoint --------------------------------------------------------------

def parse_args(argv):
    p = argparse.ArgumentParser(
        description=(
            "Distill a Claude Code transcript to readable JSON. The session id "
            "is read from stdin; nothing is taken from argv in production."
        )
    )
    p.add_argument(
        "--file",
        default=None,
        help=(
            "TEST AFFORDANCE ONLY: read this transcript path directly, bypassing "
            "the ~/.claude/projects glob. Not used by the production caller."
        ),
    )
    p.add_argument("--max-turns", type=int, default=300, dest="max_turns")
    p.add_argument("--max-bytes", type=int, default=400000, dest="max_bytes")
    return p.parse_args(argv)


def run(argv):
    args = parse_args(argv)

    if args.file:
        path = args.file
        if not os.path.isfile(path):
            sys.stderr.write("distill-transcript: --file path does not exist\n")
            return 3
        session_id = session_id_from_path(path)
    else:
        session_id = sys.stdin.read().strip()
        if not UUID_RE.match(session_id):
            return 2
        session_id = session_id.lower()
        path = resolve_transcript(session_id)
        if path is None:
            return 3

    result, dropped, parsed_any = distill(path, session_id, args.max_turns)
    if not parsed_any or not result["turns"]:
        return 4

    apply_caps(result, args.max_turns, args.max_bytes, dropped)

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def main(argv=None):
    """Never raise: the caller treats a crash trace on stdout as a corrupt
    contract, so unexpected failures exit 4 with a message on stderr only."""
    try:
        return run(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 -- deliberate catch-all
        sys.stderr.write("distill-transcript: unexpected error: %s\n" % exc)
        return 4


if __name__ == "__main__":
    sys.exit(main())
