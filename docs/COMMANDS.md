# CLI Command Reference

All 47 commands in the `tb` CLI. For the quick tour, see the [main README](../README.md). For AI-agent-focused usage, see [CLAUDE.md](CLAUDE.md).

## Global Options

```bash
tb [command] [options]
  -f, --format <type>      # json (default) | compact | table
  --fields <csv>           # comma-separated fields to include (or short|full preset, --output-version 2)
  --compact                # strip null values (default behavior, no-op under --output-version 2)
  --max-body <chars>       # truncate message bodies
  --timeout <ms>           # request timeout (default: 30000)
  --output-version <n>     # 1 (default) | 2 (opt-in leaner output — see "Output Format" below)
  --verbose                # (--output-version 2 only) include nulls/empty arrays
  --envelope               # (--output-version 2 only) wrap output in {ok, data}
  --pretty                 # (--output-version 2 only) pretty-print JSON
  --utc                    # (--output-version 2 only) UTC dates instead of local time
```

## Connection & Status

```bash
tb health                  # check bridge + extension status
tb bridge-status           # bridge-only status (works without extension)
tb access                  # show the access policy enforced by the installed add-on (see ACCESS-CONTROL.md)
tb extension-reload        # reload the extension, wait for reconnection (--no-wait to skip)
```

## Accounts & Identities

```bash
tb accounts                # list all email accounts
tb account <accountId>     # get account details
tb identities              # list all identities (for --from)
```

## Folders

```bash
tb folders <accountId>                    # list folders for account
tb folders --all                          # list all folders across all accounts
tb folder-info <folderId>                 # folder details with message counts
tb folder-create <parentFolderId> <name>  # create subfolder
tb folder-rename <folderId> <newName>     # rename folder
tb folder-delete <folderId> --confirm     # delete folder (requires --confirm)
```

## Stats & Overview

```bash
tb stats                   # global overview (accounts, unread, totals)
tb stats <accountId>       # per-account stats
tb stats --folders         # include per-folder breakdown
```

## Search

```bash
tb search <query> [options]
  -a, --account <id>       # limit to account
  --folder <id>            # limit to folder
  --from <address>         # filter by sender
  --to <address>           # filter by recipient
  --subject <text>         # filter by subject
  --unread                 # unread only
  --flagged                # flagged/starred only
  --tag <tag>              # filter by tag
  --since <date>           # from date (ISO or relative: 7d, 2w, 3m, today, yesterday)
  --until <date>           # to date
  --has-attachment         # only messages with attachments
  --size-min <bytes>       # minimum message size
  --size-max <bytes>       # maximum message size
  --include-junk           # include junk (excluded by default)
  -l, --limit <n>          # max results (default: 25)
```

## List Messages

```bash
tb list <folderId> [options]
  --unread                 # unread only
  --flagged                # flagged only
  --offset <n>             # skip first N (pagination)
  --sort <field>           # date | from | subject | size
  --sort-order <dir>       # asc | desc
  -l, --limit <n>          # max results (default: 25)
```

## Read Messages

```bash
tb read <messageId>                   # default: headers + text body + attachments
tb read <messageId> --headers         # headers only (cheapest)
tb read <messageId> --full            # include HTML body
tb read <messageId> --raw             # raw RFC822
tb read <messageId> --body-only       # just text, no JSON wrapper
tb read <messageId> --check-download  # check download state

tb read-batch <id1,id2,id3>           # read multiple messages at once
tb thread <messageId>                 # full conversation thread
tb thread <messageId> --headers       # thread with headers only (no bodies)
```

Each thread entry carries `threadMatch`: `"references"` when it was found through the
`References` / `In-Reply-To` headers, or `"subject"` when it was only matched by identical
normalized subject (later replies that don't reference the message yet). Subject matches are a
heuristic — treat them with more suspicion.

## Recent / Timeline

```bash
tb recent [options]
  --hours <n>              # lookback period (default: 24)
  --unread                 # unread only
  --account <id>           # filter by account
  -l, --limit <n>          # max results (default: 50)
```

## Move, Copy, Delete, Archive

```bash
tb move <messageIds> <folderId>               # move (comma-separated IDs)
tb copy <messageIds> <folderId>               # copy
tb delete <messageIds>                        # delete (to trash, marked read by default)
tb delete <messageIds> --keep-unread          # delete to trash, keep unread state
tb delete <messageIds> --permanent --confirm  # permanent delete
tb archive <messageIds>                       # archive (marked read by default)
tb archive <messageIds> --keep-unread         # archive, keep unread state
```

Deletion (`tb delete`, `tb bulk delete`, `tb folder-delete`) is disabled by default and
returns `FORBIDDEN` unless the add-on was built with it enabled — see
[ACCESS-CONTROL.md](ACCESS-CONTROL.md).

## Mark & Tags

```bash
tb mark <messageIds> --read           # mark read (supports batch)
tb mark <messageIds> --unread         # mark unread
tb mark <messageIds> --flagged        # flag/star
tb mark <messageIds> --unflagged      # unflag
tb mark <messageIds> --junk           # mark junk
tb mark <messageIds> --not-junk       # mark not junk

tb tags                               # list available tags
tb tag <messageId> <tagKey>           # add tag
tb tag <messageId> <tagKey> --remove  # remove tag
tb tag-create <key> <label> <color>   # create new tag
```

## Compose, Reply, Forward

Default mode is **draft** (saves to Drafts folder without opening UI).

```bash
tb compose [options]
  --to <address>           # required, comma-separated for multiple
  --cc <address>           # CC
  --bcc <address>          # BCC
  --subject <text>         # subject line
  --body <text>            # message body (inline)
  --body-file <path>       # read body from file
  --html                   # treat body as HTML
  --from <identityId>      # send from specific identity (see: tb identities)
  --priority <level>       # highest | high | normal | low | lowest
  --header <key:value>     # custom header
  --draft                  # save as draft (default)
  --open                   # open in Thunderbird compose window
  --send                   # send immediately

tb reply <messageId> [options]
  --body <text>            # reply text
  --body-file <path>       # read from file
  --all                    # reply to all
  --html                   # treat body as HTML
  --from <identityId>      # override the identity inferred from the message account
  --no-history             # don't append the earlier thread as quoted conversation history
  --draft / --open / --send

tb forward <messageId> [options]
  --to <address>           # required
  --body <text>            # additional text
  --from <identityId>      # override the identity inferred from the message account
  --no-history             # don't append the earlier thread as quoted conversation history
  --draft / --open / --send

tb edit <messageId> [options]
  --to <address>           # replace To (comma-separated)
  --cc <address>           # replace CC
  --bcc <address>          # replace BCC
  --subject <text>         # replace subject
  --body <text>            # replace body
  --body-file <path>       # read body from file
  --html                   # treat body as HTML
  --from <identityId>      # change sending identity
  --priority <level>       # highest | high | normal | low | lowest
  --draft                  # save as draft (default)
  --open                   # open in Thunderbird compose window
  --send                   # send immediately

# Only drafts (folder type drafts). Pass only fields to change.
# After save, messageId may change (IMAP) — use returned messageId.
# At least one field required unless --open.
```

Replies preserve Thunderbird's native reply relationship, generated signature,
and quotation. When `--from` is omitted, the identity is selected from the
original message's account by matching its addressed recipients (forward
does the same). `--from` may name an identity from any account.

`--draft` (the default) confirms the save: the response carries the draft's
`messageId` and the `folder` it landed in, and the command errors instead of
reporting `draft_saved` when Thunderbird returns no saved message. When the
draft lands outside the account's real drafts folder — e.g. a Gmail account's
bare `/Drafts` instead of `/[Gmail]/Drafts` — the response includes a
`warning`; fix the identity's drafts-folder setting. The draft is deliberately
not moved (moving between Gmail's two drafts folders fails server-side).

Both `reply` and `forward` append the earlier messages in the thread (resolved
the same way as `tb thread`, oldest first, quoted `>` style) below the body by
default. Pass `--no-history` to omit it.

## Attachments

```bash
tb attachments <messageId>                                     # list attachments
tb attachment-download <messageId> <partName> --output <path>  # download one
tb attachment-download <messageId> --all --output-dir <dir>    # download all
```

## Fetch & Sync

```bash
tb fetch <messageId>                      # force download from IMAP
tb fetch --folder <folderId> --limit <n>  # batch fetch
tb download-status <messageId>            # check: full | headers_only

tb sync <folderId>                        # trigger folder sync
tb sync --all                             # sync all accounts
tb sync-status <folderId>                 # check sync status
```

## Contacts

```bash
tb contacts                               # list all contacts
tb contacts --book <bookId> --limit <n>   # filter by address book
tb contacts-search <query> [--book <bookId>] [-l <n>]  # search contacts
tb contact <contactId>                    # contact details

# Requires the contactsWrite access switch (default off, see docs/ACCESS-CONTROL.md)
tb contacts create --book <bookId> [--display-name <name>] [--email <email>] \
  [--second-email <email>] [--first-name <name>] [--last-name <name>] [--phone <phone>] [--org <org>]
tb contacts update <contactId> [--display-name <name>] [--email <email>] \
  [--second-email <email>] [--first-name <name>] [--last-name <name>] [--phone <phone>] [--org <org>]
```

## Notes

Local Markdown workspace (`~/.config/thunderbird-cli/notes` by default, override with
`notesDir` in config or `TB_NOTES_DIR`). Storage only — no Thunderbird round-trip
except `to-draft`.

```bash
tb notes list                                        # list all notes
tb notes read <name>                                 # read a note's body + metadata
tb notes save <name> --body "text" [--title <t>] [--source <messageId>]     # create/overwrite
tb notes save <name> --body-file <path>                                    # from a file
tb notes append <name> --body "more text" [--body-file <path>] [--title <t>] [--source <messageId>]
                                                       # append, creates if missing
tb notes delete <name> --confirm                      # delete a note
tb notes search <query>                               # search titles and bodies
tb notes to-draft <name> --to <address> [--cc <a>] [--bcc <a>] [--subject <t>] [--from <identityId>] [--open]
                                                       # render Markdown to sanitized HTML, open as draft (never sends)
```

## Calendars

Experimental (see `docs/decisions/calendar-backend.md`). Calendar listing and event reads are
ungated; `create`/`update`/`delete` require the `calendarWrite` access switch (default `false`,
see `docs/ACCESS-CONTROL.md`).

```bash
tb calendar list                          # list calendars
tb calendar events --start <date> --end <date> [--calendar <calendarId>]
                                           # list events in a range
tb calendar create --calendar <calendarId> --title <title> --start <date> --end <date>
                    [--all-day] [--location <l>] [--description <d>]
                                           # create an event (requires calendarWrite)
tb calendar update <eventId> --calendar <calendarId> [--title <t>] [--start <d>] [--end <d>]
                    [--all-day] [--location <l>] [--description <d>]
                                           # update an event (requires calendarWrite)
tb calendar delete <eventId> --calendar <calendarId>
                                           # delete an event (requires calendarWrite)
tb calendar clashes --start <date> --end <date>
                                           # find overlapping events across all calendars
```

## Deterministic Skills

Zero-LLM-reasoning shortcuts (ODIAA-2332): each composes existing read-only endpoints above and
prints compact, pre-formatted Markdown by default — pass `--format json|compact|table` to get the
underlying structured data instead (e.g. for scripting). All read-only, ungated.

```bash
tb today                                  # today's calendar events + unread/flagged mail counts
tb week                                   # calendar events for the next 7 days, grouped by day
tb clashes [--days <n>]                   # overlapping events across all calendars (default: next 7 days)
tb from <address> [-l, --limit <n>]       # recent mail from a sender/domain, grouped into threads
```

## Tasks

Calendar tasks (VTODO), through the vendored `calendar.tasks` Experiment API (see
`docs/decisions/calendar-backend.md`).

```bash
tb tasks list [--calendar <calendarId>] [--completed] [--pending]  # list tasks

# Requires tasksWrite access switch (default off, see docs/ACCESS-CONTROL.md)
tb tasks create --calendar <calendarId> --title <title> [--due <date>] [--all-day] \
  [--priority <n>] [--description <description>] [--source <messageId>]
tb tasks update <taskId> --calendar <calendarId> [--title <title>] [--due <date>] [--all-day] \
  [--priority <n>] [--description <description>] [--source <messageId>] [--completed] [--pending]
```

## Action Items

```bash
tb action-items <messageId>   # deterministic (no LLM) extraction of candidate action items
                               # from a message body, rendered as a Markdown checklist
```

## Fast Actions

One-click Email → Note / Task / Event / Contact (ODIAA-2333). Each command reuses
the same route (and access switch) as its underlying resource — there is no
bypass for these composite commands.

```bash
tb address-books # list address books

tb email-to-note <messageId> [--name <name>] [--append]
# save a message to the local notes workspace (no access switch — notes are local-only)

tb email-to-task <messageId> --calendar <calendarId> [--due <date>] [--all-day] [--priority <n>]
# create a task from deterministic action-item extraction (requires tasksWrite)

tb email-to-event <messageId> --calendar <calendarId>
# create a calendar event via deterministic date/time/location parsing (requires calendarWrite)
# falls back to a draft event (status TENTATIVE) when no date/time could be detected —
# review and correct it before relying on it

tb email-to-contact <messageId> --book <bookId>
# add the message's sender as a contact, deduped by email address (requires contactsWrite)

tb notes listen [--timeout <ms>] [--name <name>] [--append]
# waits for a "Save to Notes" context-menu click in Thunderbird, then saves the note.
# Thunderbird can't write to the local filesystem, so the extension pushes a
# note-save-requested event over the bridge and this command is the CLI-side
# listener that turns it into a note; run it (or the equivalent MCP tool,
# notes_listen_once) before clicking "Save to Notes" in Thunderbird.
```

## Bulk Operations

```bash
tb bulk mark-read <folderId> [-l <n>]             # mark all read
tb bulk move <from> <to> [filters] [-l <n>]
tb bulk delete <folderId> --confirm [filters] [-l <n>]
tb bulk tag <folderId> <tagKey> [filters] [-l <n>]
tb bulk fetch <folderId> [-l <n>]                 # force IMAP download

# filters (move / delete / tag):
  --older-than <days>      # only messages older than N days
  --from <address>         # filter by sender
  --subject <pattern>      # filter by subject
  -l, --limit <n>          # batch size (default: 100)
```

## Output Format

By default, all commands output JSON wrapped in a standard envelope:

```json
// Success
{ "ok": true, "data": { ... } }

// Error
{ "ok": false, "error": "Message not found", "code": "NOT_FOUND" }
```

### Default output (v2) — opt-in

`--output-version 2` (or `TB_OUTPUT_VERSION=2`) switches to a leaner, more
human-readable shape: table format on a TTY, compact JSON when piped, no
envelope by default (`--envelope` restores it), nulls/empty arrays stripped
(`--verbose` restores them), short field presets on `search`/`list`/`recent`
(`--fields full` restores all fields), and local-time dates (`--utc` restores
UTC). It's opt-in — the v1 envelope above stays the default so existing
scripts/agents aren't broken by a silent shape change. See `CLAUDE.md` for
examples.

### Token Optimization

```bash
# Field selection — only return what you need
tb search "invoice" --fields id,from,subject,date

# Body truncation — limit body size
tb read 123 --max-body 2000

# Compact mode — strip nulls and whitespace
tb stats --compact
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TB_BRIDGE_HOST` | `127.0.0.1` | Bridge host (`host.docker.internal` in Docker) |
| `TB_BRIDGE_PORT` | `7700` | Bridge HTTP port |
| `TB_AUTH_TOKEN` | (none) | Auth token for bridge |

Config file: `~/.config/thunderbird-cli/config.json`

## Error Codes

| Code | Meaning |
|------|---------|
| `BRIDGE_UNREACHABLE` | Bridge is not running |
| `EXTENSION_DISCONNECTED` | Thunderbird extension not connected |
| `TIMEOUT` | Request timed out (30s default) |
| `NOT_FOUND` | Message/folder/account not found |
| `INVALID_ARGS` | Bad arguments or missing `--confirm` |
| `THUNDERBIRD_ERROR` | Error from Thunderbird messenger API |
| `EVENT_TIMEOUT` | No matching bridge event arrived before the wait timeout |
| `RECONNECT_TIMEOUT` | Extension did not reconnect after `tb extension-reload` |
