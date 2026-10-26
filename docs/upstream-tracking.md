# Upstream & forks tracking

State for the weekly upstream & forks scan (ODIAA-2402, scope set by the board on ODIAA-2338).
Each run reads this file first, so nothing gets triaged twice, and updates it in that week's PR.

Rules: read-only on upstream and forks (no PRs, issues, comments or reactions there). Never
copy fork code. Reimplement from the idea and credit it ("idea from `<owner>/<repo>` `<sha>`").
Low-risk fixes (bugs, compatibility, docs) become PRs here. New features, access-policy or
security changes, and anything under `extension/` become backlog issues. Extension changes are
batched into one add-on version and one ATN manual review.

## Watermark

Last run: **2026-10-26** (ODIAA-2614). Previous: 2026-10-19 (ODIAA-2541), 2026-10-12 (ODIAA-2491), 2026-10-05 (ODIAA-2402, first run).

Upstream `vitalio-sh/thunderbird-cli` `main`: **`465613d`** (unchanged since our baseline, 2026-09-14).
Other upstream heads: `fix/1.1.1` `27b8c70` (open PR #26), `integrate/open-prs` `c5e5d02`,
`dependabot/npm_and_yarn/proxy-addr-2.0.8` `0467f53` (open PR #31),
`dependabot/npm_and_yarn/modelcontextprotocol/sdk-1.32.0` `ca02f56` (open PR #32).
Latest upstream release: `v1.1.0` (2026-09-14).

Thunderbird: release 158.0.1, beta 159.0b5, ESR 153.5.1esr. Our
`strict_max_version` is `156.*` (see ODIAA-2403). webext-experiments `calendar/`: latest commit is still `b7f7cb3` (our pin).

Forks (14), last-seen head per branch with commits ahead of upstream `main`:

| Fork | Branch | Ahead | Last-seen SHA |
|---|---|---|---|
| bfg1981 | main | 6 | `35239e1` |
| bfg1981 | feat/reply-recipient-control | 2 | `3980c82` |
| bfg1981 | feat/reply-threading-identity-quoting | 1 | `56f9118` |
| bfg1981 | feat/security-dependency-updates | 1 | `eb742b6` |
| bfg1981 | fix/1.1.1 | 6 | `27b8c70` (= upstream PR #26) |
| broadaxe | main | 8 | `c37c772` |
| broadaxe | bridge-auth-hardening | 2 | `41ed108` |
| ph-fritsch | fix/reply-identity-and-sort-pagination | 1 | `e399149` |
| DreatNU-oss | meu | 15 | `5f25ddd` |
| inrainbws | main | 2 | `5b55c3e` |
| jctots | fix/bridge-auth-token | 1 | `ba56442` |
| le-dawg | main | 16 | `777d58a` |
| reinhardullrich | main | 7 | `879d596` |
| dboeckenhoff | main | 5 | `0a6c974` |
| dboeckenhoff | feat/compose-attachments | 6 | `b784183` |
| marcreynolds | security/bridge-hardening | 2 | `43b5c17` |
| KaiSingL | main | 29 | `0b3a5d7` |

No unique commits: mikepage, FernDragonborn (Dependabot branches only), stutiredboy (new
2026-10-20, `main` = upstream `465613d`), and the `main` of ph-fritsch, DreatNU-oss, jctots and marcreynolds. Dependabot branches on forks are
ignored, because our own `npm audit` covers dependencies.

Our repo `odience-network/thunderbird-cli-enhanced`: no issues and no forks as of 2026-10-26 (only our own PRs #36–#39).

## Triage ledger

Decision values: adopted PR #N, backlog ODIAA-N, rejected (reason), already in main, deferred.

### Seeded from docs/PLAN.md §3/§5 (fork integration, ODIAA-2304)

| Source | Ref | Summary | Decision |
|---|---|---|---|
| jctots | `ba56442` | Enforce `TB_AUTH_TOKEN` on bridge HTTP | already in main (upstream PR #25) |
| bfg1981 | `56f9118` | Preserve reply identity and quoted body | adopted PR #1 |
| bfg1981 | `eb742b6` | Dependency security updates | already in main (newer versions) |
| bfg1981 | `3980c82` | Native reply recipient control (`recipient-control.js`) | deferred: feature touching `extension/`, next extension batch |
| dboeckenhoff | `0a6c974` and 4 others | `--account` filter on `/recent`, accountId in `collectMessages` | already in main |
| inrainbws | `6349728`, `5b55c3e` | Auto-append history on reply/forward; angle-bracket thread fix | adopted PR #3 (hand-adapted) |
| reinhardullrich | `dace9b9` | Filter before limit, accurate `hasMore` | adopted PR #2 |
| reinhardullrich | `b5b7714` | Remove delete capabilities | adopted PR #4, modified: gated by `delete`/`folderDelete` (default off) |
| reinhardullrich | `93178cb` | Configurable access policy | adopted ODIAA-2311 (classification logic only) |
| reinhardullrich | `0b169db` | CLI-only install consolidation | deferred |
| reinhardullrich | `720ff9b` | Bridge hardening and mail-status | deferred: check overlap with PR #25 browser defense |
| reinhardullrich | `db5ca49` | Calendar versions for private builds (docs) | rejected: covered by `docs/decisions/calendar-backend.md` |
| reinhardullrich | `879d596` | Keep fork development on main (docs) | rejected: fork-internal process |
| le-dawg | `9058023`, `260f99a`, `8241c7a`, `b944a49` and others | IPC queue, folder-info cache, energy audit, live smoke tests | adopted ODIAA-2312 / PR #8 (partly); rest rejected as duplicate, see PLAN.md §3 |
| KaiSingL | 28 commits | Setup scripts, search, `tb edit`, `--keep-unread`, output v2, auto-start, reload | adopted PRs #9–#17, #19 (see PLAN.md §3) |
| KaiSingL | `4d0d0e9` | README repositioning (AI-agent-first → CLI-first) | deferred: product-positioning call |

### 2026-10-05

| Source | Ref | Summary | Decision |
|---|---|---|---|
| upstream | issue #30 | MCP `from` needs an identity ID, but no MCP tool lists them | adopted (this PR): `from` accepts an identity's email address |
| upstream | issue #29 | `tb reply --html` ignored (CLI and add-on force plain text) | backlog ODIAA-2403 (extension batch) |
| upstream | issue #15, PR #26 `7fb07cf` | List truncated before sorting | backlog ODIAA-2403: our unread/flagged branch still truncates first; TB 148+ unfiltered path is fine |
| upstream | issue #28 | Timestamps appear to be UTC | rejected: ISO 8601 with `Z` is explicit UTC; `--output-version 2` renders local time (`--utc` opt-out) |
| upstream | issue #18 | Per-account allowlist | backlog ODIAA-2406 (access-policy feature) |
| upstream | issue #22, PR #26 `67723c2` | New WS connection takes over the live extension slot | backlog ODIAA-2404 (bridge security; our `bridge.js` is affected) |
| upstream | PR #26 `dd95a6a` | Full-text index search; timeouts carry `TIMEOUT` | already in main (fullText, PR #14); `TIMEOUT` code check folded into ODIAA-2403 |
| upstream | PR #26 `e7312f3` | Tag writes in MCP `email_mark` | backlog ODIAA-2405 |
| upstream | PR #26 `a520ebf` | Stop claiming the XPI is Mozilla-signed | rejected: our 2.1.0 XPI is ATN-signed and 2.4.0 is documented as pending review |
| upstream | PR #27 | reinhardullrich fixes + access-control proposal | already in main (same commits as reinhardullrich `main`, above) |
| DreatNU-oss | `651d9f1` | Attachment download escapes the output folder | adopted PR #36 (`tb attachment-download --all` path sanitising) |
| DreatNU-oss | `6281fbb` | `setsid` missing on macOS | rejected: we spawn the bridge with Node `detached`, no `setsid` |
| DreatNU-oss | `08bc171`, `bf0f9dd`, `2510fd7` | Remove send/delete; bridge token + CORS; dependency alerts | already in main (`send`/`delete` switches, bridge auth, `npm audit` clean) |
| DreatNU-oss | 11 others | Portuguese docs, personal mailbox triage rules and schedules | rejected: personal deployment, not product |
| dboeckenhoff | `b784183` | Compose `--attach` files, repeated `--header` | backlog ODIAA-2407 |
| ph-fritsch | `e399149` | Reply identity, quoted body, sorted-list pagination | already in main (PR #1, PR #14); unread/flagged sort in ODIAA-2403 |
| broadaxe | `636235a`, `41ed108` | Bearer auth, no CORS, WS origin check | already in main (stricter: timing-safe auth, CORS allowlist, Host check) |
| marcreynolds | `43b5c17`, `dc4fa05` | Bridge transport hardening | already in main (PR #25 browser defense and bridge auth) |
| Thunderbird | 157.0.1 release | Above our `strict_max_version` `156.*` | backlog ODIAA-2403 (extension batch, top item) |

### 2026-10-12

| Source | Ref | Summary | Decision |
|---|---|---|---|
| upstream | `main`, releases, issues, PRs | No change since 2026-10-05 (`main` `465613d`, last activity 2026-09-29) | nothing new |
| upstream | PR #26 `dd95a6a` (`TIMEOUT` part) | Bridge timeouts come back as 500 with no code | adopted PR #38 (bridge-only, so moved out of ODIAA-2403) |
| broadaxe | `1b07d17`…`e895b20` (6 commits) | Teams notifications, `fedtest.yml` workflow, `decode_jwt.sh` | rejected: personal CI, not product |
| Thunderbird | 158.0b5 | 158 release due about 2026-10-27; ODIAA-2403 should target `158.*` or later | backlog ODIAA-2403 (comment added) |
| static9/thunderbird-mcp | idea | Reply/forward quoting that Gmail collapses | deferred: `extension/` change, consider with the #29 reply work in ODIAA-2403 |
| emercons/thundersend-mcp | idea | Compose-only server (least privilege) | already in main (access switches; `contactsWrite`, `calendarWrite`, `tasksWrite`, `delete`, `folderDelete` default off) |

### 2026-10-19

| Source | Ref | Summary | Decision |
|---|---|---|---|
| upstream | `main`, releases, issues #1–#30 | No change since 2026-10-12 (`main` `465613d`) | nothing new |
| upstream | PR #31 `0467f53` (Dependabot) | `proxy-addr` 2.0.8, critical CVE (GHSA-jqcg-44mw-7w3h); our lockfile had 2.0.7 | adopted PR #39 (`npm audit fix`, which also clears 4 other findings in our tree) |
| broadaxe | `fc59337`, `c37c772` | `federated-send` and Adaptive Card workflows | rejected: personal CI, not product |
| other forks | — | No push since 2026-10-12 | nothing new |
| Thunderbird | 158.0 release, ESR 153.5.0esr | 158 shipped; ESR 140 is no longer listed | backlog ODIAA-2403 (comment: target `158.*` or later) |

### 2026-10-26

| Source | Ref | Summary | Decision |
|---|---|---|---|
| upstream | `main`, releases, issues | No change since 2026-10-19 (`main` `465613d`) | nothing new |
| upstream | PR #32 `ca02f56` (Dependabot) | `@modelcontextprotocol/sdk` 1.29.0 → 1.32.0 | already covered: PR #39 moves our lockfile to 1.32.1 |
| `npm audit` | new advisories | `sanitize-html` XSS bypasses (direct dependency; sanitises note HTML), `body-parser` (high), `fast-uri`, `hono` | adopted PR #39 (second lockfile refresh, `8f06b14`) |
| stutiredboy | `main` | New fork (2026-10-20), no commits ahead | nothing new |
| other forks | — | No push since 2026-10-19 | nothing new |
| TKasperczyk/thunderbird-mcp | v0.9.3, GHSA-85q9-f237-654v | Attachment reads followed `X-Mozilla-External-Attachment-URL` to local files or URLs | backlog ODIAA-2615 (live check; fix goes in the ODIAA-2403 batch) |
| Thunderbird | 158.0.1, ESR 153.5.1esr | Point releases; webext-experiments `calendar/` still `b7f7cb3` | backlog ODIAA-2403 (target `158.*` or later, unchanged) |

### Ideas from similar projects (ideas only, no code read)

| Project | Idea | Decision |
|---|---|---|
| tears-mysthrala/thunderbird-local-mcp | Native Messaging transport instead of a localhost port, with writes approved separately | deferred: compare with the bridge auth model when ODIAA-2404 is designed |
| commonpost/thunderbird-mcp-lab | Offline end-to-end lab that runs the real add-on in a network-less Thunderbird | deferred: candidate for CI live tests (today `test:live-smoke` is manual) |
| TKasperczyk/thunderbird-mcp, U-C4N/Thunderbird-MCP | Manage message filters through MCP | deferred: new feature + access switch |
| localai-org/thunderbird-mcp | A few grouped MCP tools (`thunderbird_mail`, `_contacts`, `_calendar`) with an action argument instead of one tool per operation, so the tool list costs less context | deferred: would change our 42-tool MCP contract; consider an opt-in grouped mode |
| commonpost/thunderbird-mcp | Read OpenPGP-encrypted messages through the add-on | deferred: `extension/` + security-sensitive; needs a design and an access switch |
| yuhang2551/thunderbird-mail-agent | Triage digest that only counts low-priority mail instead of listing it | deferred: candidate for a deterministic skill next to `tb today` |
| TKasperczyk/thunderbird-mcp (v0.10.0) | Dry-run compose: report what a send would do (identity, recipients including automatic Cc/Bcc, attachments, size) without sending | deferred: candidate for a `tb send --dry-run` / MCP flag; touches `extension/`, so next extension batch |
| TKasperczyk/thunderbird-mcp (v0.10.0) | Ask Thunderbird to sync an IMAP/Exchange folder or a calendar and wait for the result | deferred: new feature under `extension/` |
| TKasperczyk/thunderbird-mcp (v0.10.0) | Scheduled sending of drafts through the Send Later add-on | deferred: depends on a third-party add-on; new feature |
