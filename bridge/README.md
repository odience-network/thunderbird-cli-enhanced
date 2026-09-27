# thunderbird-cli-bridge

> Stateless HTTP↔WebSocket bridge daemon between thunderbird-cli (or any HTTP client) and the Thunderbird WebExtension.

[![tests](https://github.com/odience-network/thunderbird-cli-enhanced/actions/workflows/test.yml/badge.svg)](https://github.com/odience-network/thunderbird-cli-enhanced/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Part of the [Thunderbird CLI Enhanced](https://github.com/odience-network/thunderbird-cli-enhanced) project.

## What it does

A small Node.js daemon (`tb-bridge`) that runs on your machine and forwards HTTP requests to the Thunderbird WebExtension over WebSocket. No business logic — pure proxy.

```
HTTP client (CLI / MCP / curl) ──HTTP→ tb-bridge ──WS→ Thunderbird Extension
                                       :7700           :7701
```

- **Stateless** — each request gets a UUID, response correlated, then forgotten
- **Localhost-only** — listens on `127.0.0.1` (no external exposure). Note that this bounds *remote* access only: any process running as the same OS user can reach the bridge. Set `TB_AUTH_TOKEN` to require a token — see [Authentication](#authentication)
- **Auto-reconnect on the extension side** — the extension retries after 3s, backing off to every 15s while the bridge is down, and immediately when the machine returns from idle
- **Zero config** — works out of the box with default ports

## Install

From a clone of this repository (the published npm package comes from upstream and lags this fork):

```bash
git clone https://github.com/odience-network/thunderbird-cli-enhanced
cd thunderbird-cli-enhanced
./setup.sh       # or .\setup.ps1 on Windows
```

Say yes when it offers to link `tb-bridge`. You rarely need to start it by hand: `tb` and `tb-mcp` auto-start `bridge/bridge.js` when it isn't reachable.

## Run

```bash
tb-bridge
```

You should see:
```
[bridge] HTTP server on http://127.0.0.1:7700
[bridge] WebSocket server on ws://127.0.0.1:7701
[bridge] Auth: disabled — any local process can call this bridge (set TB_AUTH_TOKEN to require a token)
[bridge] Waiting for Thunderbird extension to connect...
```

Keep it running. For background operation:

```bash
# pm2
pm2 start tb-bridge --name tb-bridge
pm2 save

# or simple background
nohup tb-bridge > ~/.tb-bridge.log 2>&1 &
```

## Authentication

Binding to `127.0.0.1` keeps the bridge off the network, but it is not access control: every
process running as the same OS user can reach it, including any local agent or script that was
never wired up to the CLI. Where that matters — a shared machine, or an AI agent that should not
have mailbox access — set a token:

```bash
TB_AUTH_TOKEN=$(openssl rand -hex 32) tb-bridge
```

The startup banner then reports `[bridge] Auth: enabled`, and every HTTP request must carry it:

```bash
curl -H "Authorization: Bearer $TB_AUTH_TOKEN" http://127.0.0.1:7700/bridge/status
```

Requests with a missing, malformed, or incorrect token get `401` with a JSON error body. The
comparison is constant-time. `tb` and `tb-mcp` send the header automatically when `TB_AUTH_TOKEN`
is set in their environment or `bridge.authToken` in `~/.config/thunderbird-cli/config.json`.

Two behaviours are deliberate:

- **Unset `TB_AUTH_TOKEN` disables authentication** and the bridge says so at startup. This keeps
  the default zero-config setup working.
- **An empty `TB_AUTH_TOKEN` is refused at startup.** Failing open on an empty value would leave
  the bridge unauthenticated with nothing in the log to say so. Unset the variable to run without
  auth.

Give the token only to the callers that should have mailbox access — putting it somewhere every
local process can read it (a world-readable file, a shared shell profile) puts you back where you
started.

> The WebSocket listener on `:7701`, which the Thunderbird extension connects to, is **not**
> covered by `TB_AUTH_TOKEN`.

## Browser protections

Independently of the token, the bridge refuses traffic that can only come from a web page in
the user's browser, so a hostile site cannot send mail, delete messages, or impersonate the
extension:

- HTTP requests with an `Origin` header not listed in `TB_BRIDGE_CORS_ORIGINS` get `403`
  (default allowlist: the bridge's own `http://127.0.0.1:<port>` and `http://localhost:<port>`).
- HTTP requests whose `Host` is not an IP literal, `localhost`, `*.localhost` or `*.internal`
  (e.g. `host.docker.internal`) get `403` — this blocks DNS rebinding. Add other names with
  `TB_BRIDGE_ALLOWED_HOSTS=name1,name2`.
- WebSocket handshakes from `http:`, `https:`, `file:` or `null` origins are refused.

`tb`, `tb-mcp` and `curl` send no `Origin` header and are unaffected.

The bridge also pings the extension every 30 s (`TB_BRIDGE_WS_HEARTBEAT_MS`) and drops sockets
that stop answering, so requests fail fast after the machine sleeps instead of hanging.

## Endpoints

### `GET /bridge/status`

Returns bridge state without requiring the extension. Use this to check the daemon is up.
Subject to authentication when `TB_AUTH_TOKEN` is set.

```bash
curl http://127.0.0.1:7700/bridge/status
# {"bridge":"running","extension":"connected","httpPort":7700,"wsPort":7701}
```

### Everything else

All other paths get forwarded to the Thunderbird extension via WebSocket and the response is returned as JSON. See [SPEC.md](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/SPEC.md) for the full route list.

## Prerequisites

The bridge alone does nothing useful — you need:

1. **Mozilla Thunderbird 128+** with the signed extension from [`dist/releases/`](https://github.com/odience-network/thunderbird-cli-enhanced/tree/main/dist/releases) installed
2. **Optional:** the `tb` CLI (`cli/`) or the `tb-mcp` server (`mcp/`) as the HTTP client

See the [main repo setup guide](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/docs/SETUP.md).

## License

MIT
