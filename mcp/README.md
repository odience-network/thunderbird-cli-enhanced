# thunderbird-cli MCP Server

[![npm version](https://img.shields.io/npm/v/@odience-network/thunderbird-cli-enhanced.svg)](https://www.npmjs.com/package/@odience-network/thunderbird-cli-enhanced)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**MCP server that gives Claude Desktop full access to your email through Mozilla Thunderbird.**

Read, search, compose, reply, and manage 22+ email accounts and 250K+ messages from any MCP-compatible client. All credentials stay in Thunderbird — nothing leaves your machine.

Part of [thunderbird-cli-enhanced](https://github.com/odience-network/thunderbird-cli-enhanced), a maintained fork of [thunderbird-cli](https://github.com/vitalio-sh/thunderbird-cli). `tb-mcp` ships in the npm package `@odience-network/thunderbird-cli-enhanced` together with `tb` and `tb-bridge`.

## What it does

Exposes 42 tools to Claude Desktop (and any other MCP client):

**Email (14)**

| Tool | Description |
|---|---|
| `email_stats` | Account/folder overview, unread counts, totals |
| `email_search` | Cross-account search (15 filter options, relative dates) |
| `email_list` | List folder contents with sort/pagination |
| `email_read` | Read message (5 modes: default, headers, full, raw, check-download) |
| `email_thread` | Get full conversation thread |
| `email_compose` | Send/draft new email (default: draft, never auto-sends) |
| `email_reply` | Reply to message (default: draft) |
| `email_forward` | Forward to new recipient (default: draft) |
| `email_edit` | Edit an existing draft in place (default: draft; returned messageId may change) |
| `email_mark` | Read/flagged/junk flags (batch supported) |
| `email_archive` | Archive, move, or delete messages |
| `email_attachments` | List + download attachments (base64) |
| `email_folders` | List folders, get info, trigger sync |
| `email_action_items` | Extract candidate action items from a message as a Markdown checklist (deterministic, no LLM) |

**Contacts (4)**

| Tool | Description |
|---|---|
| `contact_search` | Search or list contacts across all address books |
| `address_book_list` | List address books (id, name) — pick a target for `contact_create` / `email_to_contact` |
| `contact_create` | Create a contact (requires `contactsWrite`) |
| `contact_update` | Update contact properties by id (requires `contactsWrite`) |

**Notes (7)** — local Markdown workspace, no Thunderbird round-trip except where noted

| Tool | Description |
|---|---|
| `note_list` | List notes (title, created, source message, size) |
| `note_read` | Read a note's Markdown body and metadata ("Use as Context") |
| `note_save` | Save/overwrite a note ("Save to Notes") |
| `note_append` | Append to a note, creating it if missing |
| `note_transcribe` | Transcribe a local audio file with a local STT engine (whisper.cpp / faster-whisper) into a note |
| `note_to_draft` | Render a note to HTML and open it as a new email draft (default: draft) |
| `notes_listen_once` | Wait for a "Save to Notes" click in Thunderbird, then save the note |

**Tasks (3)**

| Tool | Description |
|---|---|
| `task_list` | List calendar tasks (VTODO), per calendar or by completion state |
| `task_create` | Create a task (requires `tasksWrite`) |
| `task_update` | Update task properties by id (requires `tasksWrite`) |

**Calendar (6)**

| Tool | Description |
|---|---|
| `calendar_list` | List calendars (id, name, type, read-only/enabled, color) |
| `calendar_events` | List events in a date range; recurring events expanded |
| `calendar_event_create` | Create an event (requires `calendarWrite`) |
| `calendar_event_update` | Update event properties by id (requires `calendarWrite`) |
| `calendar_event_delete` | Delete an event by id (requires `calendarWrite`) |
| `calendar_clashes` | Detect overlapping events across all calendars (DST- and all-day-aware) |

**Skills (4)** — deterministic, return ready-to-show Markdown

| Tool | Description |
|---|---|
| `skill_today` | Today's events plus unread/flagged counts |
| `skill_week` | Next 7 days of events, grouped by day |
| `skill_clashes` | Overlapping events in the next N days (default 7) |
| `skill_from` | Recent mail from a sender address or domain, grouped into threads |

**Fast Actions (4)**

| Tool | Description |
|---|---|
| `email_to_note` | Save an email to the notes workspace (no access switch) |
| `email_to_task` | Create a task from an email via action-item extraction (requires `tasksWrite`) |
| `email_to_event` | Create an event from an email via deterministic date/time/location parsing (requires `calendarWrite`) |
| `email_to_contact` | Add the sender as a contact, deduped by address (requires `contactsWrite`) |

**Safe defaults:** compose/reply/forward/edit all default to **draft mode**. Claude must explicitly pass `mode: "send"` to actually send anything; `note_to_draft` has no send mode at all. Permanent delete requires `confirm: true`, and `delete` is refused unless the add-on was built with `delete: true`. Contact, calendar and task writes are gated behind the `contactsWrite`, `calendarWrite` and `tasksWrite` access switches, all **off** by default — see [ACCESS-CONTROL.md](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/docs/ACCESS-CONTROL.md). Calendar and task tools need Thunderbird's calendar Experiment APIs, which ship in add-on 2.4.0+.

## Architecture

```
Claude Desktop ──stdio──> tb-mcp ──HTTP──> bridge daemon ──WS──> Thunderbird Extension
                                                                      ↓
                                                            All your email accounts
```

The MCP server is stateless. It calls the bridge daemon which forwards to the Thunderbird WebExtension. Your email accounts stay configured in Thunderbird where they always were.

## Prerequisites

You need three things:

1. **Mozilla Thunderbird 128+** with your email accounts configured
2. **The thunderbird-cli bridge daemon** — the MCP server auto-starts it if not running (~25s on first call, instant thereafter)
3. **The thunderbird-cli WebExtension** loaded in Thunderbird

See the [main repo setup guide](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/docs/SETUP.md) for installing the bridge and extension.

## Installation

### Option A: npx (recommended, no install)

Add to your Claude Desktop config (no installation step needed — npx fetches it on demand):

```json
{
  "mcpServers": {
    "thunderbird": {
      "command": "npx",
      "args": ["-y", "-p", "@odience-network/thunderbird-cli-enhanced", "tb-mcp"]
    }
  }
}
```

The package holds three commands, so `-p` names the package and `tb-mcp` picks the one to run.

For Claude Code:

```bash
claude mcp add thunderbird -- npx -y -p @odience-network/thunderbird-cli-enhanced tb-mcp
```

### Option B: Global install

```bash
npm install -g @odience-network/thunderbird-cli-enhanced   # tb, tb-bridge and tb-mcp
```

Coming from upstream's `thunderbird-cli-mcp`? Uninstall it first, since it installs the same `tb-mcp` command:

```bash
npm uninstall -g thunderbird-cli-mcp thunderbird-cli thunderbird-cli-bridge
```

Then in Claude Desktop config:

```json
{
  "mcpServers": {
    "thunderbird": {
      "command": "tb-mcp"
    }
  }
}
```

### Option C: From source

```bash
git clone https://github.com/odience-network/thunderbird-cli-enhanced
cd thunderbird-cli-enhanced
npm install
```

Then in Claude Desktop config:

```json
{
  "mcpServers": {
    "thunderbird": {
      "command": "node",
      "args": ["/absolute/path/to/thunderbird-cli-enhanced/mcp/src/server.js"]
    }
  }
}
```

## Claude Desktop Config Location

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

After editing, **restart Claude Desktop**. You should see "thunderbird" in the MCP servers list when you click the tool icon.

## Recommended: also install the companion skill

The MCP server gives Claude *access* to the email tools. The companion [Claude Skill](https://agentskills.io) teaches Claude *how to use them well* — token-efficient `fields` selection, draft-by-default safety, trust-metadata checks, recipes for common workflows.

One command on Claude Code, from a source checkout:

```bash
cp -r skills/thunderbird-cli ~/.claude/skills/
```

The npm package ships the skill too:

```bash
cp -r "$(npm root -g)/@odience-network/thunderbird-cli-enhanced/skills/thunderbird-cli" ~/.claude/skills/
```

On Claude.ai, zip and upload at **Settings → Capabilities → Skills**:

```bash
cd skills && zip -r thunderbird-cli.zip thunderbird-cli
# upload thunderbird-cli.zip
```

Full skill docs: [`skills/thunderbird-cli/SKILL.md`](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/skills/thunderbird-cli/SKILL.md).

Skipping the skill is fine — the MCP still works — but with it, Claude's defaults get noticeably safer (never-auto-send, junk-excluded, truncated bodies) without the user having to re-prompt.

## Configuration

The MCP server reads these environment variables (set in your Claude Desktop config under `env`):

| Variable | Default | Purpose |
|---|---|---|
| `TB_BRIDGE_HOST` | `127.0.0.1` | Bridge daemon host |
| `TB_BRIDGE_PORT` | `7700` | Bridge daemon HTTP port |
| `TB_AUTH_TOKEN` | (none) | Optional auth token |

Example with custom bridge host:

```json
{
  "mcpServers": {
    "thunderbird": {
      "command": "npx",
      "args": ["-y", "-p", "@odience-network/thunderbird-cli-enhanced", "tb-mcp"],
      "env": {
        "TB_BRIDGE_HOST": "127.0.0.1",
        "TB_BRIDGE_PORT": "7700"
      }
    }
  }
}
```

## Example prompts

Once configured, try these in Claude Desktop:

> "How many unread emails do I have across all accounts?"

> "Search for invoices from AWS in the last 30 days"

> "Show me the thread about the GMI Cloud SCALE program"

> "Reply to message ID 118 saying I'll be there Monday — save as draft so I can review"

> "List all attachments on message 245 and download the PDF"

> "Mark all messages from noreply@github.com in my inbox as read"

## Safety

- **Compose/reply/forward default to draft mode.** Claude cannot send emails without explicitly requesting `mode: "send"`.
- **Permanent delete is gated** behind `confirm: true`, and refused outright unless the add-on was built with `delete: true`.
- **Contact, calendar and task writes are off by default** (`contactsWrite`, `calendarWrite`, `tasksWrite` access switches).
- **Search excludes junk/spam by default** to prevent prompt injection from adversarial emails.
- **All traffic stays on localhost.** Bridge listens on `127.0.0.1` only.
- **No credentials are exposed.** Thunderbird handles all IMAP/SMTP — your passwords never leave its config.

See [SECURITY.md](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/SECURITY.md) for the full threat model and prompt-injection defenses.

## Troubleshooting

### "Bridge unreachable" / connection errors
- The MCP server auto-starts the bridge daemon — this error means auto-start failed after ~25s
- Is the bridge installed? Run `node bridge/bridge.js` (or `tb-bridge`) manually to check for errors
- Test directly: `curl http://127.0.0.1:7700/bridge/status`
  (if the bridge was started with `TB_AUTH_TOKEN`, add `-H "Authorization: Bearer $TB_AUTH_TOKEN"`, or the call returns 401)
- Is Thunderbird running with the extension loaded?
- Check Thunderbird's add-on debugging console for WebSocket errors

### Tools don't appear in Claude Desktop
- Did you restart Claude Desktop after editing the config?
- Check the Claude Desktop logs (View → Developer → Open Logs)
- Verify the JSON config is valid

### "Request timed out" on send
- SMTP send can take 30-60s on first connection
- The MCP server uses a 30s default — for sends, use the CLI directly with `--timeout 60000`

## Development

```bash
git clone https://github.com/odience-network/thunderbird-cli-enhanced
cd thunderbird-cli-enhanced
npm install
npm run test:mcp    # integration tests against a mock bridge
```

## License

MIT — see [LICENSE](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/LICENSE)
