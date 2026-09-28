# Signed Release Artifacts

This directory contains **ATN-signed** Thunderbird extension builds. These are the files you should distribute to users — they are the canonical versions that install permanently in standard Thunderbird.

## Files

| File | Version | Signed by | Date |
|---|---|---|---|
| `thunderbird_ai_bridge-2.1.0-tb.xpi` | 2.1.0 (`thunderbird-cli-enhanced@odience.net`) | addons.thunderbird.net, unlisted | 2026-09-27 |
| `thunderbird_cli_enhanced-2.4.0-tb.xpi` (not yet here) | 2.4.0 (`thunderbird-cli-enhanced@odience.net`) | pending ATN manual review | — |

2.1.0 predates the rename, so Thunderbird's Add-ons Manager shows it as "Thunderbird AI Bridge",
and it has no calendar, tasks or Fast Actions. 2.4.0 ("Thunderbird CLI Enhanced", the v1.3.0
add-on) passed ATN automated validation and awaits manual review because of its calendar
Experiment APIs; until it lands here, the unsigned 2.4.0 XPI is attached to the v1.3.0 GitHub
Release.

## Why these are in git

ATN-signed XPIs are tracked in git (not gitignored like `dist/thunderbird-cli-*.xpi`) because:

1. Users need the **exact ATN-served bytes** to get trust — hand-built XPIs from source won't install permanently
2. Mozilla's signing is **out-of-band** (hash-registry based), so the file itself is byte-identical to the uploaded source but ATN holds the trust record
3. Making these available on `main` branch lets users install even before GitHub Releases are set up

## How to install

1. Download the latest `.xpi` from this directory (or from GitHub Releases)
2. Open Thunderbird → **Add-ons and Themes**
3. Click the ⚙ gear icon → **Install Add-on From File…**
4. Select the downloaded `.xpi`
5. Restart Thunderbird

The extension will persist across restarts. No "unsigned" warnings.

## How to release a new version

1. Bump version in `extension/manifest.json`
2. Run `npm run build:xpi` to create the unsigned build in `dist/`
3. Upload the unsigned `.xpi` to https://addons.thunderbird.net as a new version
4. Wait for signing (usually minutes to hours for already-reviewed extensions)
5. Download the signed `.xpi` from ATN's "My Submissions" page
6. Save it to this directory with naming: `<name>-<version>-tb.xpi`, where `<name>` is the manifest name lowercased with non-alphanumerics as `_` (what `npm run sign:xpi` writes)
7. Commit, tag `v<version>`, push — GitHub Actions will attach it to the Release

Steps 2–6 are automated: merging the version bump to `main` runs the `sign-xpi` workflow,
which builds, lints, tests, signs via the ATN API and commits the signed file here. Locally:

```bash
npm run verify
MOZILLA_HUB_JWT_ISSUER=… MOZILLA_HUB_JWT_SECRET=… npm run sign:xpi
```

ATN does not embed a `META-INF/` signature (Thunderbird doesn't require one): "signed" means
ATN validated and approved the version. `sign:xpi` only saves a file once ATN reports it
approved, and only if its sha256 matches the hash ATN publishes for that version.
