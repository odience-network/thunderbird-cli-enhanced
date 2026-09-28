# Contributing to Thunderbird CLI Enhanced

Thanks for your interest in contributing! This project provides AI agents (and humans) with a low-level interface to Mozilla Thunderbird.

## Project structure

```
thunderbird-cli-enhanced/
├── extension/          Thunderbird WebExtension (manifest_version 2)
├── bridge/             HTTP↔WebSocket proxy daemon
├── cli/                tb command-line tool
├── mcp/                MCP server for Claude Desktop
├── scripts/            XPI build/sign/lint, diagram build
├── test/               Integration tests
└── docs/               User and AI agent documentation
    └── diagrams/       archify diagrams (src/*.json is the source of truth)
```

The four runtime components are intentionally separated:

- **extension** — runs inside Thunderbird, calls `messenger.*` APIs (plus vendored calendar/task Experiment APIs), talks to bridge over WebSocket
- **bridge** — stateless HTTP↔WS proxy, no business logic
- **cli** — thin HTTP client, parses args, formats JSON output (74 commands; the notes workspace and local transcription run in `cli/` itself)
- **mcp** — MCP server, exposes 42 curated tools to Claude Desktop and other MCP clients

## Local development

Prerequisites: Node.js 20+, Thunderbird 128+ for live testing.

```bash
git clone https://github.com/odience-network/thunderbird-cli-enhanced
cd thunderbird-cli-enhanced
npm install     # installs all workspace deps (cli, bridge, mcp)
```

### Running the stack

```bash
# Terminal 1: bridge daemon
node bridge/bridge.js

# In Thunderbird: about:debugging → Load Temporary Add-on → extension/manifest.json

# Terminal 2: test the CLI
node cli/src/cli.js health
node cli/src/cli.js stats
```

### Tests

```bash
npm test                     # CLI/bridge integration (mock bridge)
npm run test:bridge-auth     # bridge TB_AUTH_TOKEN enforcement (real bridge process)
npm run test:bridge-security # bridge browser-origin defenses (real bridge process)
npm run test:extension       # background script, thread utils, access policy, action items, calendar clashes (mocked messenger API)
npm run test:sign            # XPI signing script (mock ATN API)
npm run test:docs            # docs/COMMANDS.md and README match `tb --help`; diagrams are complete
npm run test:notes           # notes workspace and transcription (stubbed STT engine)
npm run test:skills          # deterministic skills (today/week/clashes/from)
npm run test:mcp             # MCP server integration (spawns server)
npm run test:all             # all of the above + MCP concurrency + npm pack check
npm run verify               # everything CI runs: build XPI, lint, all test suites
```

To run `npm run verify` before every push: `git config core.hooksPath .githooks`.

The suites use a mock bridge + mock extension running in-process — no Thunderbird needed.

For live testing against your real Thunderbird:

```bash
TB_BRIDGE_HOST=127.0.0.1 node cli/src/cli.js health
```

## Diagrams

The diagrams in [`docs/diagrams/`](docs/diagrams/) are built with [archify](https://github.com/tt-a1i/archify). Each one has three committed forms:

| File | Role |
|---|---|
| `docs/diagrams/src/<name>.json` | archify IR — **the source of truth**; edit this |
| `docs/diagrams/<name>.html` | self-contained interactive viewer (`archify deliver`) |
| `docs/diagrams/<name>.png`, `<name>-dark.png` | static images the docs embed, linked to the HTML |

Never hand-edit the HTML or PNGs; change the IR and rebuild.

**Install archify** (project-local, git-ignored, pinned by hash in `skills-lock.json`):

```bash
npx skills experimental_install          # restore the pinned version from skills-lock.json
# or, first time / to update the pin:
npx skills add tt-a1i/archify --skill archify --agent claude-code -y
```

The first command puts the CLI at `.agents/skills/archify/bin/archify.mjs`, the second at `.claude/skills/archify/bin/archify.mjs`; the build script checks both. Set `ARCHIFY_BIN` to use a checkout elsewhere.

**Rebuild:**

```bash
npm run build:diagrams                 # validate + deliver + PNG export, all diagrams
npm run build:diagrams -- roadmap      # just one
npm run build:diagrams -- --no-png     # skip PNG export (no browser needed)
```

The script sets `ARCHIFY_UPDATE_CHECK_DISABLED=1`, runs `archify validate <type> --quality showcase` (a failed check stops the build), then `archify deliver`. PNG export drives headless Chrome/Chromium over the DevTools protocol and uses the viewer's own **Export → PNG** path, once per theme. Browser lookup order: `ARCHIFY_CHROME` / `CHROME_PATH`, then `chromium`, `chromium-browser`, `google-chrome` on `PATH`, then Playwright's cache. If you have none: `npx playwright install chromium`. On Linux hosts where Chromium's sandbox is blocked (e.g. Ubuntu's AppArmor user-namespace restriction), set `ARCHIFY_CHROME_NO_SANDBOX=1`; the script only loads the local diagram files.

`npm run test:docs` checks that every IR has its HTML and both PNGs, so commit all of them together.

## Adding a new CLI command

1. Add the route handler in `extension/src/background.js` (use `messenger.*` APIs)
2. Classify the route in `extension/src/access-control.js` — unclassified routes are refused with `FORBIDDEN` (see [docs/ACCESS-CONTROL.md](docs/ACCESS-CONTROL.md))
3. Add the command in `cli/src/cli.js` using commander.js
4. Add a test case in `test/quick-test.mjs` against the mock bridge
5. Document the command and its flags in `docs/COMMANDS.md` (`npm run test:docs` enforces this)
6. If the new capability is useful for AI agents, expose it as an MCP tool in `mcp/src/tools.js`

The bridge (`bridge/bridge.js`) is a dumb proxy — you don't need to modify it for new routes.

## Adding a new MCP tool

1. Add the tool definition to `mcp/src/tools.js` with proper JSON Schema for `inputSchema`
2. Add a test case in `test/mcp-test.mjs`
3. Update the tools table in `mcp/README.md`

Keep MCP tools **high-level and AI-friendly**. Bulk admin operations belong in the CLI, not as MCP tools.

## Code style

- ES modules throughout (`"type": "module"`)
- No TypeScript (kept simple for contributor accessibility)
- Pretty-print JSON output by default, accept `--compact` for one-liners
- Always wrap output in `{ok, data}` / `{ok, error, code}` envelope
- No comments unless the logic isn't self-evident

## Security

Email is an open channel. The CLI must:

- Strip technically hidden content (HTML comments, white-on-white, zero-width chars)
- Never auto-send messages — `compose/reply/forward` default to draft
- Require `--confirm` for destructive operations (`delete --permanent`, `bulk delete`, `folder-delete`)
- Exclude junk from search results by default

See [SECURITY.md](SECURITY.md) for the full threat model.

## Reporting bugs

Use the GitHub issue templates. Include:

- OS and Thunderbird version
- Output of `tb health` and `tb bridge-status`
- Bridge daemon logs (stderr from `node bridge/bridge.js`)
- Steps to reproduce

## Pull requests

- Fork, branch, PR against `main`
- Include tests for new functionality
- Update docs (`README.md`, `docs/COMMANDS.md`, `docs/CLAUDE.md`, `mcp/README.md`) if user-facing; `npm run test:docs` fails when a `tb` command or flag is undocumented
- If the change alters the architecture, request flow, access policy, release flow or roadmap, update the matching diagram IR and run `npm run build:diagrams`
- Run `npm run test:all` before submitting

## License

By contributing, you agree your contributions will be licensed under the MIT License.
