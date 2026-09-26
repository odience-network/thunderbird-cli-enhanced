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
1. `jctots` bridge auth token enforcement
2. `bfg1981` dependency security updates + reply identity fix
3. `dboeckenhoff` multi-account filter fixes
4. `reinhardullrich` access policy + delete-capability removal
5. `le-dawg` MCP/bridge concurrency & reconnect hardening
6. `KaiSingL` search/UX features + setup scripts
7. `inrainbws` reply/forward history (after inspecting the unlabeled `fix` commit)

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

- Should the `pr-27` divergence from `upstream/integrate/open-prs` (test file deletions) be
  treated as accidental and discarded, or intentional and kept? Needs a decision before any
  fork-integration PR builds on top of it.
- Signing credentials for the Thunderbird extension (AMO/private signing key) — where are
  these stored/injected? Needed before the signed-build workflow can run in CI.
