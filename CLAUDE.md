# claude-tray-notifier — repo guidance

Electron menu bar app (macOS) that notifies when a Claude Code session finishes or needs
input. **This repository is public.** No hostnames, IPs, tokens, or private paths in
tracked files.

## Two modes, one binary

Mode is chosen at runtime by the presence of `~/.config/claude-tray/relay-url`:

- **Local (default).** The Claude Code hook POSTs to the app's own loopback server on
  `127.0.0.1:9377`. Nothing leaves the machine, no relay exists. The Conversation tab runs
  `scripts/distill-transcript.py` directly.
- **Relay (opt-in).** The app polls a relay you host. **No relay ships in this repo** — the
  README documents its API contract so one can be built.

Anything touching notification delivery, tray state, or the Conversation tab must be
considered in both modes. Local mode is the one a new user gets.

## Non-obvious constraints

- **`scripts/distill-transcript.py` must stay in BOTH `build.files` and `build.asarUnpack`.**
  An external interpreter cannot read a path inside `app.asar`; `distillerPath()` in
  `lib/conversation.js` rewrites `app.asar` → `app.asar.unpacked` to match.
- **`build.files` is an explicit allowlist.** A new HTML / renderer / preload file silently
  vanishes from the packaged app unless it is added there.
- **The session id goes to the distiller on STDIN, never argv.** If a relay invokes it over
  SSH, `ssh` joins trailing argv into one string that the *remote* shell re-parses, so an
  argv-passed id is shell-injectable even through `execFile`.
- **`createServer` takes a token getter, not a value.** The token can be regenerated from
  the tray menu while the server is listening; a captured string keeps 401ing the hook, and
  the hook fails silently by design, so notifications vanish with no error anywhere.
- **Never assume `https`.** A local relay is `http://`; hardcoding the module throws
  ERR_INVALID_PROTOCOL before any request is made.
- **The origin classifier fails closed to `system`.** A session it cannot identify is muted
  into the System tab rather than allowed to interrupt. Do not "fix" this by guessing from
  cwd: headless and interactive runs routinely share one.
- **eslint grants browser globals only to `renderer.js` and `session-renderer.js`.** A new
  renderer file fails lint, and CI runs lint before tests.
- **Keep `build.mac.artifactName` lowercase.** Some origins lowercase URLs on redirect,
  which turns a capitalized artifact name into a 404. electron-builder's default uses
  `${productName}`, which contains spaces and capitals.

## Publishing

`.github/workflows/build-and-publish.yml` runs on a `package.json` push to `main` and only
builds when the **version changed**. Upload needs `VM_SSH_KEY`, `VM_SSH_HOST`, `VM_USER`,
`VM_REMOTE_DIR`; with none set it skips with a warning (so forks pass CI), with some set it
errors. Re-publishing the same version poisons a CDN edge cache (same filename, new hash →
electron-updater refuses to install). **Bump the version instead of republishing.**

The build is unsigned and un-notarized, so downloaded artifacts are Gatekeeper-quarantined.

## Before you commit

`npm test && npm run lint` — both run in CI. Tests are `node --test`, no framework.
