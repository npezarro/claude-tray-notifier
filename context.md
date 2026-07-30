# Claude Tray Notifier - Context

## Current State
- Electron menubar app for macOS, polls relay server for Claude Code session notifications
- Version 1.9.2, unsigned macOS app with shell-based auto-update
- Relay runs inside pezant-tools PM2 process on VM (port 3003, Apache proxied at /api/notify)
- Hook script at `scripts/claude-tray-hook.sh` sends notifications on Claude Code Stop and Notification events
- Token auto-sync: right-click menu "Sync Token from Server" or auto-prompted on 401
- Token endpoint: `/tools/claude-tray-token` (OIDC-gated, serves NOTIFY_TOKEN as plain text)

## Recent Changes (2026-06-30)
- **Added:** Auto-detect token expiry (401 from relay) with "Token Expired" status and native notification
- **Added:** "Sync Token from Server" menu item that opens OIDC-gated token endpoint in a BrowserWindow
- **Added:** Poller `updateToken()` method for hot-swapping tokens without restart
- **Root cause of June 23 disconnect:** VM .env was rewritten during deploy, NOTIFY_TOKEN changed, Mac app had the old token

## Recent Changes (2026-05-12)
- **Fixed:** Hook was silently failing because `CLAUDE_TRAY_NOTIFY_URL` was never set in `~/.env`
- Hook now sources `~/.env` as a fallback when the env var isn't in the environment
- Commit: 08e90b6

## Required Environment
- `CLAUDE_TRAY_NOTIFY_URL` must be set (in `~/.env` or shell env) to the relay's `/api/notify` endpoint
- Token file at `~/.config/claude-tray/token` must exist and match VM's `NOTIFY_TOKEN`
- Full session closeout: privateContext/deliverables/closeouts/2026-05-12-claude-tray-notifier-fix.md

## Recent Changes (2026-07-29) — mute system sessions, conversation view

- **Added:** `lib/origin.js` — classifies a session `interactive` vs `system`. Order:
  `CLAUDE_TRAY_ORIGIN` env override, transcript `entrypoint` (`cli` vs `sdk-cli`), parent
  process cmdline (`-p`/`--print`), then **fail closed to `system`**. Also usable as a CLI
  (`node lib/origin.js <transcript>`), which is how the hook calls it — one tested
  implementation instead of a shell/python transliteration that can drift.
  Verified against real transcripts of both kinds (see `test/origin.test.js`).
- **Added:** muted **System** tab. System events never raise an OS notification, never
  play a sound, and never change the tray icon. `Mute System Sessions` in the right-click
  menu overrides it. The decision is the pure `shouldNotify()` predicate in `lib/format.js`
  so it is unit-testable without mocking Electron.
- **Added:** **Conversation** tab in the session window. Pulls the full conversation via
  the relay from the machine that ran the session; nothing is stored server-side. Every
  failure mode (machine offline, transcript pruned, reader missing) gets a plain-language
  message and a retry instead of a stuck spinner.
- **Added:** `scripts/distill-transcript.py` — transcript to scrubbed conversation JSON.
  Excludes tool results / file contents / thinking / system-reminders at capture time,
  then scrubs secret-shaped strings. Streams, so a 17MB transcript costs ~0.2s and 14MB RSS.
- **Changed:** hook payload gained `origin`, `entrypoint`, and `host` (host lets the relay
  route a conversation pull back to the right machine). Title now prefers the transcript's
  `aiTitle` over the first-line-of-first-message heuristic, and is only cached once the
  good title exists so an early fallback is not pinned for the session.

### Why cwd is not the origin signal
A `sdk-cli` (headless) run and an interactive session routinely share a working directory
— confirmed on real data under `/mnt/c/Users/npeza`. Any cwd- or project-name-based guess
is wrong a meaningful fraction of the time, which is why `entrypoint` is used instead.

### Known pre-existing gap (not introduced here)
`lib/poller.js` hardcodes `https`, so an `http://` relay URL (local testing) throws
`ERR_INVALID_PROTOCOL`. `fetchConversation` in `main.js` follows the same assumption.
Fine in production; it just means the poll path cannot be smoke-tested against a local
http stub.

## 2026-07-29 — release publishing fixed (was silently broken since Jul 1)

`Build & Publish` last succeeded 2026-04-27 and failed every run after 2026-07-01, so
`/downloads/latest-mac.yml` still advertised **1.7.1** while package.json reached 1.9.0.
No installed app could auto-update. Two independent faults:

1. **SSH targeted the CDN hostname.** The public hostname moved behind Cloudflare, which
   does not proxy port 22. The step ran
   `ssh-keyscan -H "$VM_HOST" >> known_hosts 2>/dev/null` under `bash -e`, so keyscan could
   not connect, exited non-zero, and killed the step **instantly with zero output and no
   packet reaching the server** — a 5-second mystery failure. Fixed by a new `VM_SSH_HOST`
   secret holding the origin address (falls back to `VM_HOST`), and by deleting the keyscan
   entirely in favour of `StrictHostKeyChecking=accept-new`, which is all it bought.

   **Lesson: never send a diagnostic command's stderr to /dev/null under `set -e`.**

2. **Artifacts were undownloadable even when published.** Apache lowercases any URL
   containing capitals (`RewriteMap lc int:tolower`, with an exclusion list for
   `/blog`, `/grocerygenius`, `/sts`). The default electron-builder name is
   `Claude Tray Notifier-<v>-arm64-mac.zip`, so every artifact URL 301'd to a lowercased
   path that did not exist and 404'd. Fixed at the source with
   `build.mac.artifactName = "${name}-${version}-${arch}-mac.${ext}"`, which yields
   `claude-tray-notifier-<v>-arm64-mac.zip` — lowercase, no spaces, no redirect.
   **Keep artifact names lowercase.** The alternative (adding `!^/downloads` to the Apache
   exclusion list) was deliberately not taken, to avoid a production web-server change.

### Other hardening in the same pass
- **Upload order: binaries first, manifest last.** The manifest advertises the new version,
  so landing it before the zip meant a client checking in mid-upload would 404.
- Manifest uploaded to a temp name then `mv`, so no client reads a half-written manifest.
- **Post-upload verification step.** The job previously echoed `Uploaded v<x>` and passed —
  a claim, not a check. It now fetches the public manifest (cache-busted, since the CDN
  edge-caches), asserts the version matches, and range-requests the advertised zip with
  `-L` to prove it is actually downloadable. Following redirects is what catches fault 2.
- **Retention: keep the 5 newest zips.** Nothing ever pruned, so the directory had reached
  2.1GB across 19 versions on a disk at 81% use. Never touches the manifest or dmg.

### 2026-07-29 follow-up: two more publish faults found by verifying, not assuming

3. **The manifest advertised a dmg that 404'd.** The workflow uploaded the dmg only to the
   stable name `claude-tray-notifier.dmg`, while `latest-mac.yml` lists it under its
   versioned name. The updater uses the zip, so nothing complained and the dmg link was
   simply dead. It slipped past the new verification because that only checked the zip —
   verification now walks EVERY url in the manifest.

4. **A stale edge object can defeat a correct release.** After re-publishing 1.9.0 a second
   time, the origin held the new zip and the manifest its new sha512, but the CDN kept
   serving the FIRST build for that same filename (`cf-cache-status: HIT`, `age: 434`,
   `max-age=14400`). Same size, HTTP 206, so a status-only check passed — and
   electron-updater would have refused to install on the sha512 mismatch. Verification now
   downloads the served zip and compares its hash to the manifest.

   Normal releases are immune: a version bump changes the filename, so the URL is
   cache-cold. Only re-publishing the same version poisons the cache. A `Purge CDN cache`
   step now handles that, gated on `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`.
   **Not yet enabled** — the existing CF token in privateContext is valid but lacks the
   Cache Purge permission (API code 10000), so a purge-scoped token is needed.

### Release invariants worth keeping
- Artifact names must stay **lowercase** (`build.mac.artifactName`) or the origin's
  lowercasing rewrite 404s them.
- Upload binaries first, manifest last; manifest via temp name + `mv`.
- Verify: version matches, every advertised url resolves following redirects, and the
  served zip's sha512 matches the manifest.
- `latest-mac.yml` is edge-cacheable (observed 4h TTL), so a release can take up to that
  long to be noticed by clients unless purged. A CF cache rule bypassing
  `/downloads/latest-mac.yml` would remove the delay.

### 2026-07-29 — manifest edge-caching solved without a purge token

`latest-mac.yml` never changes filename, so the edge cache could hold it for the full TTL
(observed `max-age=14400`) and clients would not notice a release for up to 4h.

Fixed at the CDN instead of with a purge credential: the zone's existing **bypass** cache rule
now also matches `http.request.uri.path eq "/downloads/latest-mac.yml"`. Verified
`cf-cache-status: DYNAMIC` on the manifest, while versioned artifacts still cache normally
(`MISS`→`HIT`) because their filenames are immutable.

Consequence for the `Purge CDN cache` workflow step: it is now **optional hardening only**. The
one case versioned URLs do not cover is re-publishing the SAME version — the filename is
unchanged, so the edge keeps the old bytes and the new manifest's sha512 no longer matches,
which makes electron-updater refuse to install. Bumping the version avoids that entirely and
needs no credential. The step stays disabled (skips with a warning) unless
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` are set.

Note the CDN token in privateContext has **Cache Rules: Edit but not Cache Purge** — a purge
call returns `code 10000 Authentication error`, which looks like a bad token but is a missing
permission. Check a token's actual grants rather than inferring from its name.

### 2026-07-30 — the updater bricked the app on the first successful update

Updating 1.7.1 -> 1.9.1 left the app unable to launch. The published artifact was fine
(sha512 matched the manifest, `zip -t` clean, bundle complete at 1.9.1 with every expected
file). The installer was the problem:

```bash
unzip -o "$zip" -d "$appDir"     # merges INTO the existing bundle
```

electron-builder **ad-hoc code-signs** the mac build, and
`Contents/_CodeSignature/CodeResources` hashes all 268 files in the bundle. `unzip -o`
overwrites files but never removes ones the new version dropped, so leftovers from 1.7.1
stayed behind, invalidated the signature, and macOS silently refused to launch. Output went
to `/dev/null`, so the failure was invisible.

Fixed by replacing the bundle wholesale: extract to a staging dir, verify the `.app` is
inside, move the old bundle aside, move the new one in, and only then delete the old copy —
so a mid-way failure restores the previous app instead of leaving a half-written one. Output
now goes to `~/Library/Logs/claude-tray-notifier-update.log`.

**Never `unzip -o` over a signed .app bundle.** It is not an update, it is a merge, and the
result fails signature validation. Also never send an installer's output to `/dev/null`: a
silent installer failure is indistinguishable from "nothing happened".

This bug was latent since the shell-based installer was written; it only fired now because
this was the first successful publish since April.
