# Diagrams

Built with [archify](https://github.com/tt-a1i/archify). `src/<name>.json` is the source of truth; `<name>.html` (interactive, self-contained) and `<name>.png` / `<name>-dark.png` are generated from it by `npm run build:diagrams`. See [CONTRIBUTING.md](../../CONTRIBUTING.md#diagrams) to install archify and rebuild.

The HTML files are standalone pages: GitHub shows their source, so download one (or clone the repo) and open it in a browser to pan, zoom, switch themes and export.

| Diagram | Type | Shows | Embedded in |
|---|---|---|---|
| [architecture](architecture.html) ([IR](src/architecture.json)) | architecture | Agents, `tb` / `tb-mcp`, bridge, extension, access policy, accounts | [README](../../README.md#how-it-works) |
| [search-sequence](search-sequence.html) ([IR](src/search-sequence.json)) | sequence | One search end to end: auto-start (#13), server-side query (#14), liveness | [README](../../README.md#why-this-fork), [SPEC](../../SPEC.md#request-flow) |
| [access-control](access-control.html) ([IR](src/access-control.json)) | dataflow | Policy from config to build to installed add-on; route classification and `FORBIDDEN` | [ACCESS-CONTROL](../ACCESS-CONTROL.md#how-a-request-is-checked) |
| [release-workflow](release-workflow.html) ([IR](src/release-workflow.json)) | workflow | Version bump → `sign-xpi.yml` → ATN → signed XPI → tag → `release.yml` | [AGENTS](../../AGENTS.md#release) |
| [roadmap](roadmap.html) ([IR](src/roadmap.json)) | lifecycle | Upstream → fork merges → mail today → calendar/contacts/notes/tasks → atbridge parity | [README](../../README.md#roadmap), [PLAN](../PLAN.md#5-roadmap-phases) |

<p>
  <img src="architecture.png" alt="Architecture" width="49%">
  <img src="search-sequence.png" alt="Search sequence" width="49%">
  <img src="access-control.png" alt="Access control data flow" width="49%">
  <img src="release-workflow.png" alt="Release workflow" width="49%">
  <img src="roadmap.png" alt="Roadmap lifecycle" width="49%">
</p>
