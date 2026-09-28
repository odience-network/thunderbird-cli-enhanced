# Calendar/Tasks backend: Experiment API vs. direct CalDAV/ICS

Status: **proposed** — pending CTO review and CEO sign-off (stack-deviation rule, `docs/PLAN.md` §5) before ODIAA-2306c/d implementation proceeds.

Related: ODIAA-2327 (this spike), ODIAA-2306 (parent), ODIAA-2306c/d (implementation, blocked on this decision).

## Summary

**Recommendation: Option A (vendor a trimmed `calendar` Experiment API).** ATN does sign versions containing Experiment APIs — the failure this spike first hit (`MANIFEST_FIELD_PRIVILEGED` from `addons-linter`) is a Firefox-only lint rule that doesn't apply to Thunderbird add-ons, and this PR fixes the lint gate accordingly (see "Signing" below). The real, ongoing cost of Option A is that ATN requires a **human reviewer** for any version bundling Experiment APIs, on every channel including our self-distributed `unlisted` one — this can take days per release, not the minutes normal automated signing takes. Option B avoids that cost entirely but gives up local-calendar support and duplicates auth, which conflicts with this project's local-first, single-bridge architecture. Given the parent issue's parity goals (`docs/PLAN.md` §4) explicitly want local Thunderbird calendars, not just remote CalDAV, Option A is the right target, and this PR includes a live-verified proof (see below) plus the lint/signing fixes needed to actually ship it.

## Option A — Vendor the `calendar` Experiment API

Thunderbird's WebExtension permission model has no calendar API. The only way to read/write local calendars (including ones backed by local storage, not just CalDAV/ICS) from an extension is a chrome-privileged **Experiment API**: a `schema.json` + parent-context implementation script registered under the `experiment_apis` manifest key, given full `ChromeUtils` access to Thunderbird's calendar manager (`cal.manager`, `calICalendarManagerObserver`, etc.).

`thunderbird/webext-experiments` on GitHub has a draft calendar Experiment API, at `calendar/experiments/calendar/`. Checked against upstream `main` at commit `b7f7cb3e76807903a785a03784d6e7df7b213f21` (this spike's first pass had read the stale `master` branch, which no longer exists — corrected here): it already uses `ChromeUtils.importESModule(".../calUtils.sys.mjs")` and the `cal.manager` accessor, matching our Thunderbird 128+ floor. It's not usable as-is for a minimal read-only spike for one reason:

- It exposes the full calendar CRUD surface (create/delete calendars, full item CRUD, batch mode, observers, a `calendar.items` namespace) across six source files. That's a large, unaudited privileged surface for a single-issue spike, and most of it (event/task CRUD) is explicitly ODIAA-2306c/d's job, not this one's.

**What this spike actually did**: vendored just `experiments/calendar/parent/ext-calendar-calendars.js` + its schema from the pinned commit above, trimmed to the `query` function only (list calendars), and added an `onShutdown` that invalidates Thunderbird's startup cache (required for any Experiment API per [Thunderbird's Experiments docs](https://developer.thunderbird.net/add-ons/mailextensions/experiments) — this is currently the only `experiment_apis` entry in the manifest, so it's the one that has to carry it). This lives in `extension/experiments/calendar/`, wired to a new ungated `GET /calendars` route. ODIAA-2306c/d should vendor the remaining functions (`get`/`create`/`update`/`remove`/`calendar.items`) the same way — pin the commit, trim to what's needed — rather than rewrite them.

### Cost

- New privileged surface: any experiment API script gets unrestricted chrome access, unlike the sandboxed `browser.*` WebExtension APIs the rest of this codebase uses exclusively. Every capability added under `experiment_apis` needs its own review; there's no permission-manifest declaration Thunderbird enforces for it — the single manifest-install consent covers everything.
- Signing: every release touching the calendar Experiment needs a human ATN reviewer (see below) — this PR fixes the lint gate that was blocking that, but the manual-review wait is still a real, ongoing cost, not a one-time fix.
- Ongoing maintenance cost tied to comm-central's internal (non-public-API) calendar module surface, which has already broken once (the 2023 ESM migration) and can again without notice, since experiment APIs are explicitly exempt from Mozilla's WebExtension API stability guarantees.

### Risk

- If comm-central changes calendar-manager internals again, `ext-calendar-calendars.js` breaks silently at runtime (chrome-context errors aren't surfaced through the normal WebExtension error channel) — needs its own smoke test, not just unit mocks.
- Minimum Thunderbird version: unaffected by this API choice per se (current floor is 128.0, and calendar-manager internals via `.sys.mjs` are already present at 128.0), but any future comm-central-internal change could force a floor bump with little warning, since Experiment APIs don't participate in Thunderbird's public compatibility promises the way `browser.*` does.

## Option B — Direct CalDAV/ICS from bridge/CLI, bypassing Thunderbird

Skip the extension entirely; have the bridge or CLI speak CalDAV (or parse `.ics`) directly against the calendar server(s) the user has configured.

### Cost

- Duplicate auth: Thunderbird already holds credentials/OAuth tokens for each calendar account. Option B means storing or re-deriving separate credentials outside Thunderbird's profile, which cuts against this repo's "no plaintext secrets" and local-first, single-source-of-truth posture.
- Loses local calendars: any calendar that is local-only (not backed by a remote CalDAV/ICS URL) is invisible to Option B entirely — no local storage backend to read from outside Thunderbird's own process. `docs/PLAN.md` §4 asks for calendars generally, not just remote CalDAV.
- Duplicates work Thunderbird already does (sync, conflict resolution, timezone handling) — a second implementation of that logic, in the bridge/CLI, is a second thing to keep correct.

### Risk

- Divergence between what Thunderbird's UI shows and what the CLI reports, since they'd be two independent clients against the calendar data (or, worse, two independent sources of truth if local calendars aren't mirrored anywhere Option B can see).

## Signing pipeline: does `sign-xpi.yml`/ATN sign an XPI with `experiment_apis`?

**Yes — with a manual-review cost, not a hard rejection.** This spike's first pass got this wrong; corrected below with the actual fix now included in this PR.

`npm run build:xpi` succeeds — the build script doesn't know or care about `experiment_apis`, so the XPI builds cleanly (12 files, valid manifest round-trip). `npm run lint` initially failed:

```
ERRORS:
MANIFEST_FIELD_PRIVILEGED  /experiment_apis: privileged manifest fields
  are only allowed in privileged extensions.
```

That error comes from `addons-linter`, and `scripts/lint.mjs`'s own header comment already notes why it can be misleading here: **addons-linter targets Firefox.** The "privileged extension" tier it's pointing at (`mozilla-extensions/xpi-manifest`) is Mozilla's internal Firefox signing program — it has nothing to do with Thunderbird or ATN, and `MOZILLA_HUB_JWT_ISSUER`/`_SECRET` were never going to need it.

What ATN actually requires is documented in its [review policy](https://thunderbird.github.io/atn-review-policy/): an add-on "will require manual review, if it … includes one or more Experiments," rejected only when a built-in WebExtension API already covers the same ground (none exists for calendars), and this applies "regardless of how they are distributed" — including our self-distributed `unlisted` channel. So ATN signs Experiment-bearing versions; it just can't do it automatically. The real cost is a **human ATN reviewer on every release that touches the calendar Experiment**, which can take days, far longer than `sign-xpi.mjs`'s `ATN_SIGN_TIMEOUT` (900s default) waits.

**Fix (this PR):**
- `scripts/lint.mjs` now parses `addons-linter`'s JSON output and tolerates exactly one error: `MANIFEST_FIELD_PRIVILEGED` at `instancePath: "/experiment_apis"`. Any other error still fails the build.
- `scripts/sign-xpi.mjs` distinguishes "still queued for manual review" (`processed && valid && !reviewed` at timeout) from a real failure. The former now exits `0` with a message pointing at the ATN validation URL, instead of failing the job — `sign-xpi.yml` documents re-running (`workflow_dispatch`) once ATN has a decision; the existing HTTP-409 "already uploaded" handling resumes polling from there.
- A genuine validation failure or review rejection still fails the script (`fail()`), as before — only the benign "awaiting a human" state changes.

## Minimum Thunderbird version impact

**Update after merge (2026-09-27):** the first `sign-xpi` run on `main` got this from ATN: `400 — A "strict_max_version" is required for Thunderbird Mail Experiments`. So Experiments also add a **maximum** version. Extension 2.2.0 declares `strict_max_version: "155.*"`, the newest version checked live. Thunderbird will refuse to load the add-on on a later major until we test there, bump the max, and re-sign, which means another manual ATN review. That's an ongoing per-major-release cost of Option A on top of the per-release review.

None beyond the current floor (128.0) for the calendar-manager APIs used here (`cal.manager` and the `.sys.mjs` module it lives in have been present since the 2023 ESM migration, well before 128.0; this spike's live check ran on Thunderbird 155.0.1 without changes). The real version-compatibility risk isn't a floor bump — it's that Experiment APIs reach into internal, non-public-API surface, so any future comm-central-internal refactor of the calendar manager can break `ext-calendar-calendars.js` at any Thunderbird version, without the deprecation warning a public `browser.*` API change would get.

## How the access policy gates privileged calls

Unchanged mechanism, same as every other route: `extension/src/access-control.js`'s `enforceAccess()` fails closed on any unclassified path. The new `GET /calendars` route is classified as **ungated** (added to `UNGATED_GET` alongside `contacts`/`accounts`/etc.) because it's read-only and calendar listing carries no more sensitivity than the other ungated read routes (e.g. `accounts`, `identities`). This was a deliberate, minimal choice for the spike's proof requirement ("ungated read route") — it does **not** set a precedent for calendar *item* reads/writes or task CRUD, which ODIAA-2306c/d will need their own classification for (per `docs/PLAN.md` §5, new write switches default to `false`/opt-in, per the non-negotiables). The privileged chrome-context access happens entirely inside the Experiment API's parent script, outside the WebExtension permission model — `enforceAccess()` is what still gates *which HTTP routes* on the bridge-facing side can reach that privileged code at all, which is the only gate available since Thunderbird itself doesn't scope Experiment API capabilities per-call.

## What was actually built and verified in this spike

- `extension/experiments/calendar/schema/calendar-calendars.json` + `extension/experiments/calendar/parent/ext-calendar-calendars.js` — vendored/trimmed `calendar.calendars.query` only, from upstream `main` at `b7f7cb3e76807903a785a03784d6e7df7b213f21`, plus the required `onShutdown` cache invalidation.
- `extension/manifest.json` — `experiment_apis.calendar_calendars` entry.
- `GET /calendars` — new ungated route: `extension/src/background.js` (dispatch) → `extension/src/access-control.js` (`UNGATED_GET`) → `cli/src/cli.js` (`tb calendars`) → `mcp/src/tools.js` (`calendar_list` tool). Returns `{ error: "calendar experiment not loaded" }` instead of throwing if the experiment failed to load.
- `scripts/lint.mjs` / `scripts/sign-xpi.mjs` / `.github/workflows/sign-xpi.yml` — the signing-pipeline fix described above.
- Tests: `test/extension.test.mjs`, `test/access-control.test.mjs`, `test/sign-xpi.test.mjs` — all passing (mocked `messenger.calendar.calendars.query` for the WebExtension-facing surface; the signing-path fix has real subprocess/HTTP-mock coverage).
- Verified: `npm run build:xpi` succeeds; `npm run lint` passes (tolerating only the one expected, scoped error).
- **Verified live**, end-to-end, in an isolated Thunderbird 155.0.1 instance (throwaway profile, `--no-remote`, bridge on ports 17700/17701 to avoid this environment's other running Thunderbird+bridge, which belongs to an unrelated project and was left untouched):
  ```
  $ tb calendars
  {"ok":true,"data":[{"id":"d5836c5a-9458-4844-91fe-7e80d872d752","type":"storage",
    "name":"Home","url":"moz-storage-calendar://","readOnly":false,"enabled":false,
    "color":null}]}
  ```
  This is the profile's default local "Home" calendar, returned through the real `cal.manager.getCalendars()` call — not a mock. (`enabled: false` reflects this calendar's actual `disabled` property in a freshly created profile that's never had its calendar pane opened; the field is passed through as reported, not a bug in the route.)

## Next steps (for ODIAA-2306c/d, pending this decision's approval)

1. Vendor `get`/`create`/`update`/`remove` and `calendar.items` (event/task CRUD) from the same pinned upstream commit, trimmed the same way `query` was.
2. Classify calendar item read/write and task CRUD routes explicitly in `access-control.js`; default all writes to disabled per the non-negotiables.
3. Budget ATN's manual-review turnaround (days, not minutes) into the release process for any change that touches `extension/experiments/calendar/` or adds to `experiment_apis`.
