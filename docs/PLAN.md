# Project Plan — thunderbird-cli-enhanced

Status: draft, baseline established. Tracks issue ODIAA-2303 ("Initialize project").

## 1. Baseline

`main` now starts from `vitalio-sh/thunderbird-cli` upstream `main` (commit `465613d`,
"release: add ATN-signed extension 2.1.0"), pushed to
`odience-network/thunderbird-cli-enhanced`. Remotes for `upstream` and every fork below
are configured in this checkout.

## 2. Fork survey

Studied every fork listed at https://github.com/vitalio-sh/thunderbird-cli/forks and diffed
each fork's default branch against `upstream/main`.

| Fork | Notable unique commits (vs upstream/main) | Assessment |
|---|---|---|
| `KaiSingL` | Extension reload/reconnect wait; server-side search sort/filter/full-text; `tb edit` for drafts; `--keep-unread` on delete/archive; comma-separated to/cc/bcc parsing fix; empty-query search fix; one-command setup scripts (macOS/Linux/Windows) | High value — several independent bug fixes + UX features, low conflict risk |
| `bfg1981` | Native reply recipient control; dependency vulnerability updates; reply identity/quoted-body preservation fix | High value — security-relevant dependency bumps + correctness fix |
| `dboeckenhoff` | `--account` filter fixes for `/recent` and `tb thread` (was silently ignored / always empty); accountId filtering in `collectMessages`; version bump; new thread tests | High value — real correctness bugs in multi-account use |
| `inrainbws` | Auto-append conversation history on reply/forward (2.0.2); one unlabeled `fix` commit | Medium — needs commit inspection before merge |
| `jctots` | `fix/bridge-auth-token`: enforce `TB_AUTH_TOKEN` on the bridge HTTP listener (branch, not on `main`) | High value — security fix, currently unmerged even in jctots' own main |
| `le-dawg` | Concurrent AI client adapters (removed stdio singleton lock); MCP lifecycle/search hardening; exponential backoff reconnect + sleep/wake awareness; shared IPC queue; live MCP tool verification tests; macOS 25 energy audit doc | High value — directly relevant to our MCP/bridge stability goals |
| `reinhardullrich` | Configurable extension access policy; filter-before-limit correctness fix; CLI-only install docs; delete-capability removal from extension; bridge/mail-status hardening; calendar-version docs for private add-on builds | High value — security posture (removable delete capability, access policy) and calendar groundwork |

Two local integration branches already existed in this checkout from prior work and were
verified, not re-created:
- `pr-26` — identical to `upstream/fix/1.1.1` (no diff).
- `pr-27` — near-identical to `upstream/integrate/open-prs`, with test-file differences
  (44 files changed, net -1554 lines vs that upstream branch); needs a diff review before
  reuse, since it's unclear if that divergence was intentional cleanup or accidental.

## 3. Integration strategy (fork commits → main)

Rather than one large merge, integrate fork-by-fork as separate reviewable PRs against
`origin/main`, in this priority order (security/correctness first):
1. `jctots` bridge auth token enforcement — **already fully merged into `origin/main`**
   (via upstream PR #25, commit `a052c8d`/`71f111f`). Verified by cherry-picking
   `ba56442` onto `origin/main`: every conflict resolved to an empty diff, i.e. the
   substantive change already exists there. No PR needed for this fork.
2. `bfg1981` dependency security updates + reply identity fix — the dependency-update
   half is **already superseded** on `origin/main` (newer package versions than the
   fork, `npm audit` clean). Only the reply-identity/quoted-body-preservation fix was
   genuinely outstanding; shipped as PR #1 (`fork/bfg1981-reply-identity-quoting`),
   adapted by hand against the current `background.js` (a blind cherry-pick of the
   fork's `56f9118` would have reverted concurrency, thread-matching, and
   browser-origin-defense work added since). All test suites green (48 extension /
   38 MCP / 46 quick / 15 bridge-auth / 33 bridge-security); CI green.
3. `dboeckenhoff` multi-account filter fixes — **already fully present on `origin/main`**
   (no PR needed). Verified by diffing all 5 fork commits' end state against current
   `background.js`/`thread-utils.js`: `collectMessages` already filters `accountId` inside
   the pagination loop (not post-filter-capped), `/recent` already passes `accountId` through,
   and the thread endpoint already uses `getRaw()` + `buildThreadIds()`/`stripAngleBrackets()`/
   `parseReferences()` from `thread-utils.js` (hand-adapted differently from the fork's
   version — ES exports vs. globals — but functionally equivalent, and `test/thread-utils.test.mjs`
   plus the 66 extension / 46 quick tests are green). Extension version (`2.1.0`) already
   exceeds the fork's `2.0.2` bump.
4. `reinhardullrich` access policy + delete-capability removal — split into pieces:
   - **Shipped** (PR #2, commit `dace9b9` equivalent): search filter-before-limit +
     accurate `hasMore` + list-iterator cleanup. Self-contained, no policy implications.
   - **Shipped, modified per board decision**: `b5b7714` (removal of all delete capability)
     was *not* merged as-is. The board chose to keep the code and gate it instead: deletion
     is off by default behind build-time access-policy switches `delete` / `folderDelete`
     (`extension/src/access-control.js`, `docs/ACCESS-CONTROL.md`). Shipped as PR #4
     (`fd494b7`).
   - **Shipped** (ODIAA-2311): the rest of `93178cb`'s configurable access-policy feature —
     the remaining switches (`downloadAttachments`, `compose`, `send`, `move`, `copy`,
     `archive`, `mark`, `tag`, `tagCreate`, `folderCreate`, `folderRename`), deny-by-default
     for any unclassified route, and the `tb access` CLI command. Not a blind port of
     `93178cb`: only its access-control classification logic was adapted, layered onto PR #4's
     already-merged `access-config.js`/`access-control.js` foundation; the fork's bundled
     "reviewed correctness fixes" (pagination, bulk filters, thread lookups, MCP validation,
     bridge hardening) were left out as unrelated to this feature. New switches default `true`
     (no behavior change for existing installs); `delete`/`folderDelete` stay `false` per the
     ODIAA-2304 board decision.
   - Not yet assessed: `0b169db` (CLI-only install consolidation), `720ff9b` (bridge
     hardening/mail-status — check for overlap with already-merged browser-defense work
     from PR #25 first), `db5ca49`/`879d596` (docs-only).
5. `le-dawg` MCP/bridge concurrency & reconnect hardening — ~15 commits outstanding
   (tracked as its own child issue, ODIAA-2312).
6. `KaiSingL` search/UX features + setup scripts — ~25+ commits outstanding
   (tracked as its own child issue, ODIAA-2313).
7. `inrainbws` reply/forward history — **shipped** (PR #3). Inspected the unlabeled `fix`
   commit `5b55c3e` first: it was a real bugfix (angle-bracket stripping so thread
   resolution wasn't always empty), already superseded by the equivalent fix in main's
   `thread-utils.js`. Hand-adapted the actual feature (`6349728`) on top of current
   `background.js` rather than cherry-picking: extracted `resolveReferencedMessages()` /
   `resolveThreadReferenceIds()` out of the `/thread` handler so `/reply` and `/forward`
   reuse the same upstream-reference resolution (and existing `thread-utils.js` helpers)
   instead of duplicating it, added `buildConversationHistory()`, and wired
   `includeHistory` (default `true`) through `/reply`, `/forward`, the CLI (`--no-history`),
   and MCP (`email_reply`/`email_forward`). Excludes the message being replied to/forwarded
   itself (already quoted separately) — the fork's version didn't, which looked like an
   unintended duplication bug. 7 new tests added (`test/extension.test.mjs`); all 205
   existing tests plus the new ones green.

Each item becomes its own child issue with a scoped PR so conflicts are resolved in small,
reviewable batches instead of one mega-merge.

## 4. Feature parity target: atbridge.ai

Surveyed https://atbridge.ai. Feature areas to reach parity with, beyond current mailbox-only
CLI/extension/bridge:

- **Calendar**: create/update/delete events, cross-calendar clash detection.
- **Contacts**: search/create/update across all Thunderbird address books.
- **Notes**: local Markdown workspace; "Use as Context" (note → AI chat) and "Save to Notes"
  (AI reply → note); voice memo transcription; render note as HTML email draft.
- **Tasks**: extract action items from an email into a checklist; create Thunderbird tasks.
- **Fast Actions**: Email→Note, Email→Task, Email→Event, Email→Contact one-click conversions.
- **Skills**: deterministic slash commands (`/today`, `/week`, `/clashes`, `/from`-style) that
  don't spend LLM tokens — maps well onto our existing MCP tool model.
- **Security posture to match/exceed**: local-first bridge on 127.0.0.1, opt-in (off by
  default) write access for AI agents, draft-only mode.

Not in scope to copy: their pricing/subscription mechanics — this project is open tooling,
not a metered SaaS.

## 5. Roadmap phases

1. **Fork integration** (child issues per fork, section 3) — bring `main` up to the best
   known-good state across all forks.
2. **Calendar, Contacts, Notes, Tasks** — extend `extension`, `bridge`, `cli`, and `mcp`
   surfaces to cover the atbridge.ai-equivalent feature list in section 4, reusing the
   existing mailbox architecture and access-policy model from the `reinhardullrich` fork.
3. **Extension stability pass** — audit `extension/` against the hardening commits already
   identified (reconnect/backoff, IPC queue, lifecycle fixes) and add regression coverage.
4. **Signed extension build pipeline** — GitHub Actions workflow (and a local pre-push
   equivalent) that builds, lints, tests, and produces a signed Thunderbird XPI, committed
   to `dist/releases/` per the existing `.gitignore` carve-out.

## 6. Open questions for the CEO / board

- ~~Should the `pr-27` divergence from `upstream/integrate/open-prs` (test file deletions)
  be treated as accidental and discarded, or intentional and kept?~~ **Resolved**: the two
  branches were never meant to match. `pr-27` (head `879d596`) is reinhardullrich's actual
  fork PR #27 head; `upstream/integrate/open-prs` (`c5e5d02`) is a stale pre-merge staging
  ref for a different, already-superseded PR aggregation effort (already merged into
  `origin/main` via PR #25). The "44 files / -1554 lines" figure was a reversed-direction
  diff between two unrelated branches, not a deletion within one branch's history — no
  accidental data loss occurred. `pr-27` is safe to use as-is for fork #4 (reinhardullrich)
  integration.
- Signing credentials for the Thunderbird extension (AMO/private signing key) — where are
  these stored/injected? Needed before the signed-build workflow can run in CI.
