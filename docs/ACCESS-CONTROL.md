# Access control

The add-on enforces one installation-wide access policy for every caller — CLI, MCP and
direct bridge requests. The policy is embedded in the XPI at build time; no client can
change it at runtime.

Today the policy covers deletion only. Everything else behaves as before.

| Key | Default | What it allows |
|---|---|---|
| `delete` | `false` | `tb delete` (to Trash and `--permanent`), `tb bulk delete`, MCP `email_archive operation=delete` |
| `folderDelete` | `false` | `tb folder-delete` (removes the folder and potentially its contents) |

With a switch off, the route returns `FORBIDDEN: '<key>' is disabled by the add-on access
policy …` before touching the mailbox. Moving messages to Trash with `tb move` is not
affected. The existing `--confirm` requirements still apply when a switch is on.

## Enable deletion

1. Copy `access.example.json` to `access.local.json` (ignored by Git).
2. Set the switches you need to `true`.
3. Run `npm run build:xpi -- --access-config access.local.json`.
4. Install the built XPI (Add-ons Manager → ⚙️ → Install Add-on From File). Thunderbird
   asks to approve the `messagesDelete` permission when `delete` is enabled.
5. Check the **loaded** add-on's policy: `curl -H "Authorization: Bearer $TB_AUTH_TOKEN"
   http://127.0.0.1:7700/access`. Restart Thunderbird if the update has not taken effect.

Editing the JSON alone changes nothing: the builder validates it, writes it into
`src/access-config.js` inside the XPI, and derives the manifest permissions from it.
Unknown keys, non-boolean values and invalid JSON fail the build. Without
`--access-config`, the source defaults (all off) are used.

## Boundaries

- Enabling a switch is not authorization for an AI to use it; agents must still get
  explicit user approval (see `skills/thunderbird-cli/SKILL.md`).
- Normal deletion follows account settings and can be irreversible, especially inside Trash.
  `delete=true` does not mean "trash only".
- This does not protect against a program that can modify the add-on or the Thunderbird
  profile. Keep bridge authentication (`TB_AUTH_TOKEN`) and OS protections.
- Previously installed or signed XPIs predate this policy and still allow deletion; install
  a new build to get it.
