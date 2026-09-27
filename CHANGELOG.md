# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Message and folder deletion are now **disabled by default** by a build-time add-on access policy (`delete`, `folderDelete`, both `false`). Delete routes return `FORBIDDEN` before any side effect, and the `messagesDelete` permission is only requested when `delete` is enabled. Re-enable with `npm run build:xpi -- --access-config access.local.json` — see [docs/ACCESS-CONTROL.md](docs/ACCESS-CONTROL.md). `GET /access` reports the loaded policy. Moving to Trash is unaffected.
- The build-time access policy now covers every write/send route, not just deletion: `downloadAttachments`, `compose`, `send`, `move`, `copy`, `archive`, `mark`, `tag`, `tagCreate`, `folderCreate`, `folderRename` (all default `true`, unchanged behavior for existing installs), alongside the existing `delete`/`folderDelete` (default `false`). A route with no policy classification is refused (deny-by-default) instead of silently allowed. New `tb access` command and bridge `FORBIDDEN` → HTTP 403 mapping. See [docs/ACCESS-CONTROL.md](docs/ACCESS-CONTROL.md).

### Changed
- The extension's add-on ID is now `thunderbird-cli-enhanced@odience.net` (was `thunderbird-ai@extension`,
  which belongs to the upstream author's addons.thunderbird.net account and can't be signed by this fork).
  Thunderbird treats it as a separate add-on: remove the old "Thunderbird AI Bridge" before installing.
- `tb delete` (to trash) and `tb archive` now mark messages read by default before refiling,
  preventing unread clutter in Trash/Archive. Use `--keep-unread` (CLI) / `keepUnread` (MCP
  `email_archive`) to preserve the old behavior.

### Added
- `--keep-unread` on `tb delete` and `tb archive` (`keepUnread` on MCP `email_archive`) — keep
  the unread state instead of marking read before refiling.
- `tb reply` / `tb forward` and MCP `email_reply` / `email_forward` now append the earlier
  thread (resolved the same way as `tb thread`, oldest first, quoted `>` style) below the body.
  On by default; opt out with `--no-history` / `includeHistory: false`.
- Signed-release pipeline: `npm run sign:xpi` signs the built XPI through the
  addons.thunderbird.net API and saves it to `dist/releases/`; the `sign-xpi` workflow runs
  build → lint → test → sign → commit when the extension version changes on `main`.
  `npm run verify` (build, `node --check` + addons-linter, all test suites) is the local
  equivalent, wired as an opt-in pre-push hook via `git config core.hooksPath .githooks`.
  ATN approves files rather than embedding a `META-INF/` signature, so `sign:xpi` waits for
  ATN approval and checks the download against ATN's published sha256.

### Fixed
- Search tag and size filters are applied by Thunderbird before the result limit, so
  matching messages beyond the first unfiltered batch are not missed.
- Limited message collection checks for an additional matching message before reporting
  `hasMore`, including when truncating within the final page, and releases unfinished
  message lists.
- `tb reply` / `email_reply` now preserve Thunderbird's native reply relationship and
  generated quotation/signature instead of replacing the whole compose body with plain text.
  When the identity doesn't quote by default, a deterministic plain-text quotation is added.
- Reply identity is inferred from the original message's account and addressed recipients,
  with explicit override via `tb reply --from <identityId>` / MCP `email_reply.from`.
- Reply results expose `identityId`, `type`, `relatedMessageId`, and `quotedOriginal` for
  verification.
- `tb attachment-download` infers a file extension from the attachment's content type when
  saving without an explicit output filename, instead of writing an extensionless file.
- `tb search` / `email_search` with a plain query (no `subject`/`from` filter) now searches
  across message body, subject, and author with OR semantics, instead of body only.
- `tb search` / `email_search` with an empty or omitted query and at least one other filter
  no longer errors.
- `tb compose` / `tb reply` / `tb forward` `--to`/`--cc`/`--bcc` now split comma-separated
  addresses into separate recipients instead of putting them all in one recipient field.

## [1.1.0] — 2026-09-14

npm packages `thunderbird-cli`, `thunderbird-cli-bridge`, `thunderbird-cli-mcp` 1.1.0; Thunderbird extension 2.1.0.

### Security
- Bridge rejects requests from web pages in the user's browser: HTTP `Origin` outside `TB_BRIDGE_CORS_ORIGINS`, non-local `Host` headers (DNS rebinding; extend with `TB_BRIDGE_ALLOWED_HOSTS`), and WebSocket handshakes from web origins that could take over the extension slot. Previously a page could blindly `POST /compose` with `send: true`.
- Optional `TB_AUTH_TOKEN` enforcement on the bridge HTTP listener (#21).
- Dependencies patched for all open Dependabot alerts: ws 8.21.3, adm-zip 0.6.1, hono 4.13.7, @hono/node-server 1.19.17, fast-uri 3.1.7, qs 6.16.0, body-parser 2.3.0, ip-address 10.7.0, express-rate-limit 8.7.0.

### Fixed
- `tb thread` returned an empty thread: headers are now parsed from the raw message and Message-IDs queried without angle brackets (#4). Replies matched only by subject are labelled `threadMatch: "subject"`.
- `tb recent --account` and `--unread` were ignored by the extension (#4).

### Changed
- Extension reconnects with backoff (3s → 15s cap) and immediately on return from idle; bridge drops unresponsive extension sockets via ping/pong (#20). Extension now requests the `idle` permission.
- `read-batch`, bulk tag/fetch, folder fetch and thread lookups run with bounded parallelism; attachment base64 encoding is chunked (#20).
- MCP `email_search` accepts filters without a text query (#20).
- `tb health` / `GET /health` reports the loaded extension's real version instead of a fixed "2.0.0".
- Bridge explains a port already in use at startup instead of crashing.

## [1.0.2] — 2026-04-18

### Added
- `server.json` at repo root, enabling submission to the Official MCP Registry (`io.github.vitalio-sh/thunderbird-cli`).
- `mcpName` field in `mcp/package.json` — required by the MCP Registry to match an npm package to a server entry.

### Changed
- npm `keywords` expanded from 6–7 per package to the full 18-item discovery set per DISTRIBUTION-PLAN §2.2 (adds `mcp-server`, `anthropic`, `email-client`, `smtp`, `ai-agent`, `ai-tools`, `agentic`, `automation`, `localhost`, `privacy`).

### No runtime changes
Metadata-only release. No code changes since 1.0.1.

## [1.0.1] — 2026-04-08

### Fixed
- **Bridge timeout was hardcoded at 30s**, causing SMTP send operations to fail silently when delivery took longer (typical for Migadu, Protonmail, and other providers with strict outbound checks).
- Bridge now defaults to **120 seconds** and is fully configurable.

### Added
- `TB_BRIDGE_TIMEOUT` environment variable on the bridge daemon (default: 120000 ms)
- `X-TB-Timeout` HTTP header for per-request override
- CLI and MCP HTTP clients now propagate their `--timeout` value to the bridge via the new header
- `defaultTimeoutMs` field in `/bridge/status` response (so clients can introspect)
- Automated GitHub Release workflow (attaches signed XPI to version tags) — added in 1.0.0 dev cycle
- `npm run build:xpi` build script for cross-platform XPI packaging — added in 1.0.0 dev cycle
- Demo GIF recording instructions in `assets/README.md` — added in 1.0.0 dev cycle

## [1.0.0] — 2026-04-08

Initial public release. First stable version after live-testing against 22 real Thunderbird accounts with 249,000+ messages.

### Added

**Thunderbird WebExtension**
- Pure WebExtension 2.0, no Experiment APIs
- Compatible with Thunderbird 128+ (ESR through latest)
- 43 route handlers using `messenger.*` APIs
- Auto-reconnect WebSocket client (3s retry)
- Signed and approved on addons.thunderbird.net for self-distribution

**Bridge daemon (`bridge/`)**
- Stateless HTTP↔WebSocket proxy
- HTTP server on `127.0.0.1:7700`
- WebSocket server on `127.0.0.1:7701`
- Request/response correlation via UUIDs
- 30-second default timeout, configurable

**CLI (`cli/`) — 38 commands**
- **Connection:** `health`, `bridge-status`
- **Accounts:** `accounts`, `account`, `identities`
- **Folders:** `folders` (with `--all`), `folder-info`, `folder-create`, `folder-rename`, `folder-delete`
- **Stats:** `stats` (with `--folders`)
- **Search:** `search` with 15 filter options (`--from`, `--to`, `--subject`, `--unread`, `--flagged`, `--tag`, `--since`/`--until` with relative dates, `--has-attachment`, `--size-min`/`--size-max`, `--include-junk`)
- **List:** `list` with `--sort`, `--sort-order`, `--offset`, `--unread`, `--flagged`
- **Read:** `read` with 5 modes (default, `--headers`, `--full`, `--raw`, `--body-only`, `--check-download`), `read-batch`, `thread`
- **Recent:** `recent` with `--hours`, `--account`, `--unread`
- **Actions:** `move`, `copy`, `delete` (with `--permanent --confirm`), `archive`, `mark` (batch)
- **Tags:** `tags`, `tag` (add/remove), `tag-create`
- **Compose:** `compose`, `reply`, `forward` — all with `--draft`/`--open`/`--send` modes, `--body-file`, `--html`, `--from`, `--priority`
- **Attachments:** `attachments` (list), `attachment-download` (single + `--all`)
- **Fetch/sync:** `fetch`, `download-status`, `sync`, `sync-status`
- **Contacts:** `contacts`, `contacts-search`, `contact`
- **Bulk:** `mark-read`, `move`, `delete`, `tag`, `fetch` — all with filters (`--older-than`, `--from`, `--subject`)

**Output system**
- Standard JSON envelope: `{ok: true, data: ...}` / `{ok: false, error: ..., code: ...}`
- Global `--fields <csv>` for field selection (token optimization)
- Global `--compact` to strip null values
- Global `--max-body <chars>` for body truncation
- Global `--timeout <ms>` for request timeout
- Formats: `json` (default, pretty), `compact`, `table`

**MCP server (`mcp/`) — 12 tools for Claude Desktop**
- `email_stats`, `email_search`, `email_list`, `email_read`, `email_thread`
- `email_compose`, `email_reply`, `email_forward` (all default to draft)
- `email_mark`, `email_archive`, `email_attachments`, `email_folders`
- Stdio transport via `@modelcontextprotocol/sdk`
- Safe defaults — destructive operations gated behind explicit flags
- Reuses CLI HTTP client, no code duplication

**Security**
- All traffic localhost-only (`127.0.0.1`)
- No credentials leave the machine — Thunderbird handles all IMAP/SMTP
- `--confirm` required for permanent delete, folder delete, bulk delete
- Search excludes junk by default
- Prompt injection defenses documented in `SECURITY.md`

**Testing**
- 46 CLI/bridge integration tests (mock bridge + extension, in-process)
- 34 MCP server integration tests (spawns server, sends JSON-RPC over stdio)
- 80 total tests, all passing
- Live-tested against 22 accounts, 249,203 messages, 86,825 unread
- GitHub Actions CI on Node 20 and 22

**Documentation**
- `README.md` — project overview, quick start, full command reference
- `docs/SETUP.md` — installation guide (signed XPI + temporary add-on paths)
- `docs/CLAUDE.md` — AI agent usage guide with security rules
- `mcp/README.md` — Claude Desktop integration guide
- `SPEC.md` — full technical specification
- `SECURITY.md` — threat model, 8 CLI defenses, 7 agent patterns
- `CONTRIBUTING.md` — dev guide, code style, PR process
- `ROADMAP.md` — release roadmap and decision log *(in `/workspace/docs/`)*
- Issue templates (bug report, feature request)
