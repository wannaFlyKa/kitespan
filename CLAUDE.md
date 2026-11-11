# kitespan

A browser UI for the Claude Code CLI ([README.md](README.md)). This file is for working on kitespan with Claude Code;
[CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## Layout

- `server/`: the Bun server (`main.ts`, `http/`, `gate/`, `ws/`, `chats/`, `store/`, `shell/`, `update/`, `worktree/`,
  `env/`, `adapters/`, `push/`, `search/`, `changes/`, `folders/`, `log.ts`). `server/agents/types.ts` is the agent
  seam; only `server/agents/claude/` imports `@anthropic-ai/claude-agent-sdk` (a test fails otherwise).
- `shared/`: what the server and the page both import: `protocol.ts` (frames, chat events, validators), `route.ts`
  (the URL table, decoder and encoder), `ids.ts`. No DOM, no Bun API, no import from outside `shared/`.
- `web/`: the page (React). `web/index.html` is its entry.
- `site/`: the landing page for GitHub Pages, cut from the two READMEs, and its demo (`site/demo/`: the page of `web/`
  built a second time with a stand-in for the server that runs in the browser tab). No file of `web/` imports `site/`.
- `bin/kitespan` (the clean start), `bin/update.sh`. `scripts/`: the page's build, the site's build (`build-site.ts`)
  and its check in headless Chrome (`site-check.ts`), the public-clean audit, the CDP click-through driver
  (`ui-check.ts`) and CI's steps.
- `test/unit/`, `test/gate/`, `test/fake-claude/`, `test/click/`, `test/live/` (opt-in, `bun run test:live`). Tests
  that need the DOM go in `test/web/`.
- Type checks: `tsconfig.json` (server, shared, scripts, tests; no DOM) and `tsconfig.web.json` (browser code and the
  DOM tests): `bun run typecheck` runs both.

## Commands

- `bun install --frozen-lockfile --omit=optional`: always with both flags (the SDK's optional packages hold a Claude
  Code binary, and kitespan runs only the `claude` on PATH).
- `bun run ci`: what CI's check job runs, in order (the install, both type checks, `bun test`, `bun run build`, the
  audit of the tree).
- `bun test`, `bun run typecheck`, `bun run build`, `bin/kitespan dev`.
- `bun run ui-check -- --out <folder>`: the click-through in headless Chrome, with the fake claude.
- `bun run audit -- --repo . --scope tree`: the public-clean audit of the tree with its built-in detectors, as CI runs
  it (without `--scope`, also the history, the messages, the authors and the refs).

## Rules

- Never start the real `claude` in a test or in CI; the tests use the fake CLI in `test/fake-claude/`. Only the opt-in
  live tests run real turns.
- The click-through and the tests that boot it use a test port from 7941 to 7949 (`test/click/ports.ts`);
  `KITESPAN_TEST_PORT` picks one. Other tests bind a port that the system picks (`test/unit/free-port.ts`). Never 7940,
  the default port of a real kitespan.
- Sign off every commit: `git commit -s` (the DCO; CONTRIBUTING.md).
- Public-clean: no private host names, account ids, keys, tokens, email addresses or personal paths in code, tests,
  fixtures or docs.

## Bun

- Use Bun, not Node.js: `bun <file>`, `bun test` (with `bun:test`), `bun run <script>`, `bunx <package>`. No jest,
  vitest, webpack, esbuild or vite.
- kitespan runs Bun with `--no-env-file`, so no `.env` file is loaded: do not rely on one, and do not add dotenv.
- `Bun.serve()` serves HTTP and both WebSockets (no express, no ws), on 127.0.0.1 only.
- A child process runs with `Bun.spawn` and an argv array, never a shell string.
- A file that must not follow a symbolic link, or must be checked on the open file, is opened with `node:fs`
  (`O_NOFOLLOW`, then `fstatSync`).
- The page: `bun run build` (`scripts/build-web.ts`) builds `web/index.html` into `dist/web`, which the server serves;
  `bin/kitespan dev` serves `web/index.html` through Bun's HTML import, with hot reload.
- Bun's API docs are in `node_modules/bun-types/docs/**.mdx`.
