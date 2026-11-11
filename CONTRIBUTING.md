# Contributing to kitespan

Thank you for your help. This file says how to build and test kitespan, how to sign off your commits, and what a pull
request needs. [CLAUDE.md](CLAUDE.md) gives the layout of the code.

## Build and test

You need Linux, git and Bun 1.3.14.

```sh
bun install --frozen-lockfile --omit=optional
bun run ci
```

`bun run ci` runs the steps of CI's check job in order and stops at the first failure: the install, both type checks
(`bun run typecheck`: `tsconfig.json` for the server, the shared code, the scripts and the tests; `tsconfig.web.json`
for the page and the tests that need the DOM), `bun test`, the page's build (`bun run build`) and the public-clean
audit of the tree.

- **No real Claude Code in a test.** The tests use the fake claude in `test/fake-claude/`, which replays recorded
  output. A test never starts the real `claude`, and CI has no credential and runs no model turn. A test that needs
  more of Claude Code's behaviour gets a fixture for the fake.
- **Test ports.** The click-through and the tests that boot it use a test port from 7941 to 7949: set
  `KITESPAN_TEST_PORT` to pick one. `bun run ci` uses 7941, as CI does, unless you set it; `bun test` alone takes the
  first free one. The other tests bind a free port that the system picks. Port 7940 is the default port of a real
  kitespan, and no test uses it.
- **The click-through.** `bun run ui-check -- --out <folder>` builds the page, starts kitespan on a test port with a
  seed and the fake claude, and checks every route, action and flow in headless Chrome at a laptop, a tablet and a
  phone size, in dark and light, with a screenshot of each. It finds Chrome with `--chrome <binary>` or
  `CHROME_PATH`, else on PATH or in the usual install caches. The full run takes about an hour; `--checks`, `--routes`
  and `--skip` pick a part (`bun scripts/ui-check.ts --help` lists the options). It runs on Linux only: its harness
  (`test/click/harness.ts`) reads `/proc` to stop only the processes that it started, so on a system without `/proc`
  (macOS) it stops at once with a line that says so, and the tests that boot it skip there.
- **The live tests** are opt-in and are never run in CI: `bun run test:live` runs real turns with your own Claude Code,
  and each turn costs what a turn costs you. [test/live/README.md](test/live/README.md) says what each file checks and
  which variables it needs.

## Sign off every commit (DCO)

kitespan uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/). When you sign off a
commit, you certify the four points of the DCO for it: in short, that you have the right to submit it under the
project's licence (Apache-2.0), and that the contribution and its sign-off, with your name and email, are public and
kept for good.

Sign off with `git commit -s`. It adds this line to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and the email of the sign-off must be the commit author's (a GitHub noreply address works for both). CI's
dco job checks every commit of a pull request, except a clean merge (git's own merge of its two parents, such as
GitHub's Update branch makes) and, in Dependabot's own pull request, Dependabot's commits. A merge with changes of its
own, such as a conflict resolved by hand, needs a sign-off too. Rebase your branch on main rather than merge main into
it. To sign off commits that you already made:

```sh
git rebase --signoff origin/main
git push --force-with-lease
```

## Keep it public-clean

No private host names, account ids, keys, tokens, email addresses or personal paths in code, tests, fixtures or docs:
use `example.com` names and made-up paths. CI's audit checks the tree with its built-in detectors (account ids, access
keys, private keys and email addresses other than a GitHub noreply address); `bun run audit -- --repo . --scope tree`
runs the same check here.

## The Agent SDK

kitespan ships one tested version of the Claude Agent SDK per release, pinned in `package.json` and `bun.lock`.
Dependabot opens a weekly pull request for a newer SDK. That pull request fails on the pins by design, until a
maintainer:

1. reads the SDK's changes, and in its `sdk.d.ts` the "Requires Claude Code" and "older binary" notes on the options
   that kitespan passes;
2. moves `SDK_VERSION` (`server/agents/claude/options.ts`), the option gate's tables and the pin tests, and
   `CLAUDE_CODE_MINIMUM` (`server/agents/claude/background.ts`) when a note needs a newer Claude Code, in a signed-off
   commit in that pull request;
3. runs the live tests with their own Claude Code.

## A pull request's checklist

- [ ] `bun run ci` passes, and CI is green.
- [ ] Every commit is signed off.
- [ ] A test that fails before the change, where a test can.
- [ ] No new dependency without a reason in the description.
- [ ] The README still says what kitespan does.
- [ ] No private names, keys or paths (above).
