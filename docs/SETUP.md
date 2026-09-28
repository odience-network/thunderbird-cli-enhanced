# Setup Guide

## Architecture

```
Host (macOS):
  Thunderbird Desktop → Extension (background.js)
       ↕ WebSocket ws://127.0.0.1:7701
  Bridge Server (bridge.js) — stateless HTTP↔WS proxy
       ↕ HTTP http://127.0.0.1:7700

Docker/Devcontainer:
  AI Agent → tb CLI (HTTP client)
       ↕ http://host.docker.internal:7700
```

Almost entirely a plain WebExtension. Requires Thunderbird 128+ (add-on 2.4.0
supports 128.0 – 156.*). The one exception is calendar and task support (`tb calendar
list`/`events`/`create`/`update`/`delete`/`clashes`, `tb tasks`, and the Fast Actions
that create events or tasks — see [docs/decisions/calendar-backend.md](decisions/calendar-backend.md)),
which needs chrome-privileged Experiment APIs (`calendar_calendars`, `calendar_items`,
`calendar_tasks`) since Thunderbird's WebExtension permission model has no calendar
access. Signed releases that include them need a human ATN reviewer, which can take
days — see [Step 2](#step-2-install-the-thunderbird-extension) for which build to install.

## Quick path: npm

```bash
npm i -g @odience-network/thunderbird-cli-enhanced
```

This one package installs all three commands: `tb` (CLI), `tb-bridge` (bridge daemon) and `tb-mcp` (MCP server). Then install the extension (Step 2) and run `tb health`. Steps 1 and 3 below are only needed for a source install.

To run the MCP server without a global install, point your MCP client at `npx -y -p @odience-network/thunderbird-cli-enhanced tb-mcp` (see [mcp/README.md](../mcp/README.md)).

### Migrating from upstream `thunderbird-cli`

The unscoped npm packages `thunderbird-cli`, `thunderbird-cli-bridge` and `thunderbird-cli-mcp` are published by upstream and don't include this fork's changes. They install the same `tb`, `tb-bridge` and `tb-mcp` command names, so remove them before installing this package, or npm refuses to overwrite the bins (or the wrong `tb` wins on your `PATH`):

```bash
npm uninstall -g thunderbird-cli thunderbird-cli-bridge thunderbird-cli-mcp
which -a tb tb-bridge tb-mcp     # should print nothing (Windows: where tb)
npm i -g @odience-network/thunderbird-cli-enhanced
```

If you linked a source checkout with `npm link` or the setup script, run `npm unlink -g thunderbird-cli thunderbird-cli-bridge thunderbird-cli-mcp` first. Stop any running bridge from the old install (`pm2 delete tb-bridge`, or kill the `bridge.js` process) so the new one can take port 7700. Your `~/.config/thunderbird-cli/` config and notes are shared and keep working.

## Source install: setup script

From a clone of [odience-network/thunderbird-cli-enhanced](https://github.com/odience-network/thunderbird-cli-enhanced):

```bash
./setup.sh       # macOS / Linux
.\setup.ps1      # Windows (PowerShell)
```

The script checks that Node.js is installed, runs `npm install` at the repo root, links `tb` globally, and offers to link `tb-bridge` and `tb-mcp` too. Then install the extension (Step 2) and run `tb health`.

## Step 1: Install & Start the Bridge

The CLI and the MCP server start the bridge automatically when they can't reach it: they spawn `bridge/bridge.js` from the same install (npm package or checkout) as a detached process, then wait up to about 15 s for it and about 10 s for the extension to connect. Start it yourself when you want it supervised or logged:

```bash
cd bridge
npm install
node bridge.js
```

You should see:
```
[bridge] HTTP server on http://127.0.0.1:7700
[bridge] WebSocket server on ws://127.0.0.1:7701
[bridge] Waiting for Thunderbird extension to connect...
```

Keep this running. For background operation:
```bash
# pm2
npm install -g pm2
pm2 start tb-bridge --name tb-bridge        # npm install
pm2 start bridge/bridge.js --name tb-bridge # source checkout
pm2 save

# or simple background
nohup node bridge/bridge.js > ~/.tb-bridge.log 2>&1 &
```

## Step 2: Install the Thunderbird Extension

### Option A: Signed XPI (recommended for normal use)

The extension is signed by Mozilla through addons.thunderbird.net for self-distribution. It installs permanently and survives Thunderbird restarts.

> **Which build?** The only ATN-signed build today is **2.1.0** (`thunderbird_ai_bridge-2.1.0-tb.xpi`). It predates the rename, so it shows as "Thunderbird AI Bridge" in the Add-ons Manager, and it has no calendar, tasks or Fast Actions — email, contacts and notes commands work with it. **2.4.0** ("Thunderbird CLI Enhanced", needed for calendar, tasks and Fast Actions) is attached **unsigned** to the [v1.3.0 GitHub Release](https://github.com/odience-network/thunderbird-cli-enhanced/releases/tag/v1.3.0) while ATN's manual review (required for Experiment APIs) is pending. Load it via **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on…** (removed on restart), or install it permanently on a Thunderbird build that allows unsigned add-ons. Once 2.4.0 is signed it lands in `dist/releases/` as `thunderbird_cli_enhanced-2.4.0-tb.xpi`.

1. Download the latest signed XPI (`<name>-<version>-tb.xpi`, currently `thunderbird_ai_bridge-2.1.0-tb.xpi`) from one of these locations:
   - **Directly from `main`:** [`dist/releases/`](../dist/releases/)
   - **GitHub Releases:** https://github.com/odience-network/thunderbird-cli-enhanced/releases, attached by `release.yml` when a `v*` tag is pushed
2. Open Thunderbird → **Add-ons and Themes**
3. Click the ⚙ gear icon → **Install Add-on From File…**
4. Select the downloaded `.xpi`
5. Confirm when Thunderbird asks to install
6. Check the bridge terminal — you should see: `[bridge] Extension connected`

> The signed XPI is built from the source in `extension/` at the version it was signed for, but Mozilla's trust registry marks it as verified. You **must** use the XPI downloaded from ATN (or our GitHub Releases) — a locally-built XPI won't install permanently.

### Option B: Temporary add-on (for developers making changes)

Use this while editing `extension/src/background.js` during development. Temporary add-ons are removed on Thunderbird restart — but they're the only way to test uncommitted changes.

1. Open Thunderbird
2. Navigate to `about:debugging` in the address bar
3. Click **This Thunderbird** in the left sidebar
4. Click **Load Temporary Add-on…**
5. Select `extension/manifest.json`
6. Check the bridge terminal: `[bridge] Extension connected`

When you reload after editing, click **Reload** next to the add-on in `about:debugging`, or run `tb extension-reload`, which waits for the extension to reconnect.

### Access policy

The add-on carries one access policy, fixed at build time, that every caller goes through. Deleting messages and deleting folders are off by default, as are contact, calendar and task writes (`contactsWrite`, `calendarWrite`, `tasksWrite`); a disabled operation returns `FORBIDDEN`. Check the active policy with `tb access`. To change it, copy `access.example.json` to `access.local.json`, edit it, and install a build from `npm run build:xpi -- --access-config access.local.json`. See [ACCESS-CONTROL.md](ACCESS-CONTROL.md).

## Step 3: Install the CLI

Already done if you installed from npm. From a source checkout:

```bash
cd cli
npm install
npm link   # makes `tb` available globally
```

Or without `npm link`:
```bash
alias tb="node /path/to/cli/src/cli.js"
```

## Step 4: Verify

```bash
# Bridge only (works without extension)
tb bridge-status

# Full stack (needs extension connected)
tb health

# List accounts
tb accounts

# Stats overview
tb stats

# Search
tb search "test" --limit 3
```

## Docker / Devcontainer Usage

Set the bridge host to reach the host machine:

```bash
export TB_BRIDGE_HOST=host.docker.internal
tb health
```

Or add to `~/.config/thunderbird-cli/config.json`:
```json
{
  "host": "host.docker.internal",
  "port": 7700
}
```

Or in `.env`:
```
TB_BRIDGE_HOST=host.docker.internal
TB_BRIDGE_PORT=7700
```

## Configuration

Config file location: `~/.config/thunderbird-cli/config.json`

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "httpPort": 7700,
    "authToken": null
  },
  "defaults": {
    "limit": 25,
    "fields": null,
    "compact": false,
    "maxBody": null
  }
}
```

Environment variables override config file values:
- `TB_BRIDGE_HOST` — bridge hostname
- `TB_BRIDGE_PORT` — bridge HTTP port
- `TB_AUTH_TOKEN` — auth token
- `TB_NOTES_DIR` — notes workspace (default `~/.config/thunderbird-cli/notes`, or `notesDir` in the config file)
- `TB_WHISPER_CPP_BIN` / `TB_WHISPER_CPP_MODEL` / `TB_FASTER_WHISPER_BIN` — local speech-to-text engine for `tb notes transcribe` (optional; install [whisper.cpp](https://github.com/ggml-org/whisper.cpp) or [faster-whisper](https://github.com/SYSTRAN/faster-whisper)'s `whisper-ctranslate2`; audio never leaves the machine)

## Troubleshooting

### "Bridge unreachable"
- The CLI and MCP server auto-start the bridge — this error means auto-start failed after ~25s
- Try starting manually to see errors: `node bridge/bridge.js` (or `tb-bridge`)
- Check: `curl http://127.0.0.1:7700/bridge/status`
  (if the bridge was started with `TB_AUTH_TOKEN`, add `-H "Authorization: Bearer $TB_AUTH_TOKEN"`, or the call returns 401)
- In Docker, use `host.docker.internal` instead of `127.0.0.1`

### "Extension not connected"
- Is Thunderbird running?
- Is the extension loaded? Check `about:debugging` in Thunderbird
- Look at Thunderbird error console (Ctrl+Shift+J / Cmd+Shift+J) for WebSocket errors
- The extension auto-reconnects after 3s, backing off to every 15s while the bridge is down (and immediately when you return from idle) — the CLI/MCP server auto-starting the bridge means load order no longer matters

### "Request timed out"
- SMTP send operations can take 30-60 seconds. Use `--timeout 60000`
- Large search queries on many accounts may be slow
- Check Thunderbird isn't stuck on a sync operation

### Extension loads but doesn't connect
- Verify port 7701 is not blocked or in use
- Check bridge is running: `curl http://127.0.0.1:7700/bridge/status` (add `-H "Authorization: Bearer $TB_AUTH_TOKEN"` if auth is enabled)
- Try restarting the bridge, then reload the extension

### Folder counts show 0
- Run `tb sync --all` to trigger IMAP refresh
- Some folders need to be opened in Thunderbird at least once
- Counts update after sync completes
