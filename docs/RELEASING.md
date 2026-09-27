# Releasing

One tag ships everything: a GitHub Release with the XPIs, and the npm package
[`@odience-network/thunderbird-cli-enhanced`](https://www.npmjs.com/package/@odience-network/thunderbird-cli-enhanced)
with the `tb`, `tb-bridge` and `tb-mcp` commands.

## What gets published

The repo root `package.json` is the npm package. Its `files` list ships `cli/src/`, `bridge/bridge.js`, `mcp/src/`, their `package.json` files (the bins read their version from them), `server.json`, the companion skill, README, LICENSE and CHANGELOG. `npm run test:pack` pins that list and fails on tests, extension sources, XPIs, `node_modules`, docs or key files.

The `cli/`, `bridge/` and `mcp/` workspaces are `private: true` and keep upstream's names (`thunderbird-cli`, `thunderbird-cli-bridge`, `thunderbird-cli-mcp`). Never publish them: upstream owns those names on npm.

## Cutting a release

1. Bump the version in **all** of these (`npm run test:pack` fails if they disagree):
   `package.json`, `cli/package.json`, `bridge/package.json`, `mcp/package.json`, and both `version` fields in `server.json`. Then run `npm install` so `package-lock.json` follows.
2. Move the `[Unreleased]` section of `CHANGELOG.md` under the new version.
3. Make sure a signed `*-tb.xpi` for the current add-on version is in `dist/releases/` (see the sign-xpi workflow); the release job fails without one.
4. Run `npm run test:all` and `npm run test:pack-smoke` locally, open a PR, merge.
5. Tag the merge commit and push the tag:

   ```bash
   git tag v1.2.0 && git push origin v1.2.0
   ```

The `release` workflow then:

1. checks the tag matches `package.json` (`v1.2.0` ↔ `1.2.0`),
2. runs the tests, the tarball content check and the install smoke test,
3. builds the unsigned XPI and creates the GitHub Release,
4. runs the `npm-publish` job (GitHub environment `npm`) with `npm publish --provenance --access public`. Versions with a pre-release suffix (`1.2.0-rc.1`) go to the `next` dist-tag; everything else goes to `latest`. If the version is already on npm, the job does nothing, so re-running a workflow is safe.

Verify:

```bash
npm view @odience-network/thunderbird-cli-enhanced version dist-tags
npm i -g @odience-network/thunderbird-cli-enhanced && tb --version && tb-bridge --version && tb-mcp --version
```

The package page on npmjs shows a **Provenance** badge linking back to the workflow run.

## npm authentication (one-time setup, org owner)

Publishing uses **trusted publishing (OIDC)**: npm trusts the `npm-publish` job directly, so no npm token is stored anywhere. Set up since 1.2.1; 1.2.0 was the only release published with a token.

1. On npmjs, open the package settings for `@odience-network/thunderbird-cli-enhanced` → **Trusted publishing** → GitHub Actions, with organization `odience-network`, repository `thunderbird-cli-enhanced`, workflow `release.yml` and environment `npm`. All four must match, or the publish fails with a 404/403.
2. In GitHub → Settings → Environments, create `npm`. Add required reviewers if a human should approve each publish.

The job needs `id-token: write` and npm >= 11.5.1 (the workflow upgrades npm). It sets no `NODE_AUTH_TOKEN`; the publish log shows the provenance statement being signed and published to the transparency log.

Never create an npm token for CI, commit one, put one in an `.npmrc` in the repo, or echo one in a workflow step. If trusted publishing ever has to be bypassed, use a short-lived granular token from a local shell, not a repository secret.

## Rollback

npm versions are immutable: a published version number can never be reused, even after unpublishing. Pick the least destructive option:

| Situation | Action |
|---|---|
| Bad version, a fix is coming | Publish the fix as a new patch version. Then warn on the bad one: `npm deprecate @odience-network/thunderbird-cli-enhanced@1.2.0 "Broken X, use 1.2.1"` |
| `latest` must point back at a good version now | `npm dist-tag add @odience-network/thunderbird-cli-enhanced@1.1.9 latest` (and deprecate the bad one) |
| Pre-release went to the wrong tag | `npm dist-tag add …@1.2.0-rc.1 next` and move `latest` back as above |
| Secret or private data was published | `npm unpublish @odience-network/thunderbird-cli-enhanced@1.2.0`, allowed within 72 hours of publishing if nothing depends on it; after that, contact npm support. **Rotate the leaked secret first**: unpublishing doesn't un-leak it. |

Deprecating, moving dist-tags and unpublishing need an npm login with publish rights on the package (an org owner), from a local shell, not CI.

The GitHub Release can be edited or deleted separately; the git tag stays in the history.
