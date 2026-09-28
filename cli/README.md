# thunderbird-cli

> Low-level CLI to manage Mozilla Thunderbird email, contacts, calendar, tasks and notes from the shell. 74 commands designed for AI agents.

[![tests](https://github.com/odience-network/thunderbird-cli-enhanced/actions/workflows/test.yml/badge.svg)](https://github.com/odience-network/thunderbird-cli-enhanced/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Part of the [Thunderbird CLI Enhanced](https://github.com/odience-network/thunderbird-cli-enhanced) project.

## What it does

`tb` is a thin HTTP client that talks to a local Thunderbird WebExtension via a bridge daemon. It exposes 74 commands across the `messenger.*` APIs and the add-on's calendar/task Experiment APIs:

- **Search & read** — full-text search across accounts, batch reads, threads
- **Compose** — draft, open, or send (defaults to draft for safety)
- **Folders** — list, create, rename, delete, info, sync
- **Attachments** — list and download (base64 → file)
- **Bulk ops** — mark-read, move, delete, tag, fetch with filters
- **Contacts** — search, read, create/update (gated by `contactsWrite`), list address books
- **Calendar & tasks** — calendars, events CRUD, clash detection, task CRUD, action items from an email (add-on 2.4.0; writes gated by `calendarWrite` / `tasksWrite`)
- **Notes** — local Markdown workspace, render to a draft, local voice-memo transcription (`notes transcribe`)
- **Fast Actions** — `email-to-note`, `email-to-task`, `email-to-event`, `email-to-contact`
- **Deterministic skills** — `today`, `week`, `clashes`, `from` render ready-to-show Markdown, no model reasoning required
- **Token-optimized** — `--fields`, `--compact`, `--max-body` for AI use

All output is JSON wrapped in `{ok, data}` / `{ok, error, code}`.

## Prerequisites

This package alone is **not enough**. You need:

1. **Mozilla Thunderbird 128+** with email accounts configured
2. **`tb-bridge`** daemon running on `127.0.0.1:7700` (the CLI auto-starts it)
3. **The Thunderbird CLI Enhanced add-on** loaded in Thunderbird — the ATN-signed 2.1.0 build covers email, contacts and notes; calendar, tasks and Fast Actions need 2.4.0, attached unsigned to the v1.3.0 GitHub Release while ATN review is pending

See the [main repo setup guide](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/docs/SETUP.md) for the full installation.

## Install

From npm (one package ships `tb`, `tb-bridge` and `tb-mcp`; the unscoped `thunderbird-cli` package is upstream's):

```bash
npm i -g @odience-network/thunderbird-cli-enhanced
```

Or from a clone of this repository:

```bash
git clone https://github.com/odience-network/thunderbird-cli-enhanced
cd thunderbird-cli-enhanced
./setup.sh       # or .\setup.ps1 on Windows
```

The setup script links `tb` globally. Without linking: `node cli/src/cli.js health`.

## Quick examples

```bash
tb stats                                    # account/folder counts
tb search "invoice" --since 7d              # find recent invoices
tb read 123 --headers                       # cheap headers-only read
tb compose --to "a@b.com" --body "Hi"       # save as draft
tb compose --to "a@b.com" --body "Hi" --send  # send immediately
tb attachment-download 123 1.2 --output invoice.pdf
```

Full reference: [docs/COMMANDS.md](https://github.com/odience-network/thunderbird-cli-enhanced/blob/main/docs/COMMANDS.md)

## Configuration

| Env var | Default |
|---|---|
| `TB_BRIDGE_HOST` | `127.0.0.1` |
| `TB_BRIDGE_PORT` | `7700` |
| `TB_AUTH_TOKEN` | (none) |
| `TB_NOTES_DIR` | `~/.config/thunderbird-cli/notes` |

Config file: `~/.config/thunderbird-cli/config.json`

## License

MIT
