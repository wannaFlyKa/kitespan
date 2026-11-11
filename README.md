# kitespan

[简体中文](README.zh-CN.md)

A browser UI for the Claude Code CLI on your own machine, from a laptop, a phone or a tablet.

Raw Claude Code experience. kitespan adds no ACP layer and no prompt of its own.

kitespan runs the `claude` on your PATH through the Claude Agent SDK, with your own settings, hooks, MCP servers and
model choices. It adds no tool, flag or environment variable of its own, and never reads or forwards your Claude
credentials. Your conversations stay in Claude Code's own transcripts.

## Why it exists

kitespan is a personal project.

I'm a weekly super commuter: every week I fly there and back, and I want to work on the flight as easily as at my
desk. Claude Code keeps running on my own machine. From the plane I keep up with it on my laptop over in-flight Wi-Fi,
or on my phone, where the connection drops and the tab goes to sleep, and I pick up where I left off when the
connection comes back.

Claude's own apps could do that, but many companies allow Claude Code only through a cloud provider's raw API, such as
Bedrock, with no access to the apps, so there is no way to use it from both a phone and a laptop. kitespan is what I
built for that: the Claude Code you already have, in a browser, on every device.

## Who it is for

kitespan is for developers who have Claude Code but not Claude's own apps:

- your company gives you Claude Code through a cloud provider, a gateway or its own build, and the Claude apps are not
  open to you;
- you use Claude Code with a model provider, and have no Claude subscription.

kitespan gives no model access. It runs the `claude` you already have, with your own provider and settings; it does not
promise Claude, and it does not help anyone work around a provider's regional availability.

## What works today

kitespan is for Claude Code only. Each row below is checked by the click-through (`scripts/ui-check.ts`: the real page
in headless Chrome, with a fake Claude Code) and, where it says so, by the opt-in live tests with a real Claude Code
([test/live/README.md](test/live/README.md)).

| Works today | Checked by |
|---|---|
| Chats with your own Claude Code: start one in a project folder, send, and the reply streams in, with thinking, tool calls and their diffs | click-through, live tests |
| Permission, question, plan and form cards | click-through, live tests |
| Model, effort and permission mode per chat; `!` commands | click-through, live tests |
| Files: drop, paste or pick them; type `@` to mention a file | click-through, live tests |
| Search across chats, files, commands and the messages' text | click-through |
| One chat on every device: the draft is kept on the server | click-through, live tests |
| A dropped connection, a sleeping tab or a slow link: the chat picks up where it was | click-through, live tests |
| Update and restart from Settings, at a turn's end | click-through, live tests |
| The Terminal pane, and Open in terminal (it types the resume or fork command, never Enter) | click-through, live tests |
| Rename, archive and delete | click-through, live tests |
| A worktree per chat, and variables per environment | click-through, live tests |
| Send now, for a message that waits | click-through, live tests |
| A side chat (`/btw`) | click-through, live tests |
| Subagents, workflows and background tasks in the chat; background sessions that a chat starts | click-through, live tests |
| Trust this folder | click-through, live tests |
| A turn's changed files and each file's diff, on the laptop and the tablet | click-through, live tests |
| Notifications when a chat needs you | click-through, live tests (Chrome on a laptop) |
| The phone and tablet layouts, and a home-screen app | click-through |
| Four looks, each in light and dark | click-through |
| The browser pane: one shared Chrome on this machine that you and Claude Code both use (see The browser pane, below) | click-through |

| Not yet | Note |
|---|---|
| Sign-in | None in this release (see From another device, below) |
| macOS | Not checked yet |
| Homebrew | Not checked yet (the release workflow runs it on macOS after the push) |
| Notifications in the home-screen app on an iPhone | Not checked yet |
| Windows | Not supported |
| Edit, retry and rewind a message | Later |
| Comments on a diff's lines, and a file editor | Later |
| Groups, pins and export of chats | Later |
| Scheduled tasks | Later |
| Pull request and CI status | Later |

## Requirements

- Linux. macOS is not checked yet; Windows is not supported.
- Bun 1.3.14 or later, as `bun` on your PATH ([Bun's install page](https://bun.com/docs/installation)). kitespan never
  installs Bun for you; Homebrew installs it with kitespan.
- Claude Code 2.1.296 or later, signed in, as `claude` on your PATH. kitespan runs that one and no other.
- git, for an install from source.

## Install

Pick one way. Each is free, installs into your own folders and needs no sudo.

### With the install script

```sh
curl -fsSL https://github.com/wannaFlyKa/kitespan/releases/latest/download/install.sh | sh
```

It checks first and changes nothing until every check passes: Linux or macOS, `curl` or `wget`, `tar`, `gzip`,
`sha256sum` or `shasum`, and Bun 1.3.14 or later. It also looks for your `claude`, and says so when it is missing or
older than 2.1.296; the install goes on. Then it downloads the latest release and its `SHA256SUMS`, checks the archive's
SHA-256, unpacks it into `~/.local/share/kitespan/versions/<version>/` (or `$XDG_DATA_HOME/kitespan/versions/`),
installs its packages from the lockfile (`bun install --frozen-lockfile --omit=optional --production`), builds the page,
and only then makes `~/.local/bin/kitespan` start it. It keeps the version before as well. It never edits your shell's
startup files: when `~/.local/bin` is not on your PATH, it prints the line to add.

To read the script before it runs: download `install.sh` and `SHA256SUMS` from the latest release, compare
`sha256sum install.sh` (on macOS `shasum -a 256 install.sh`) with its line in `SHA256SUMS`, then run `sh install.sh`.
Each release's files have a build provenance attestation:
`gh attestation verify kitespan-<version>.tar.gz --repo wannaFlyKa/kitespan`.

| Command | What it does |
|---|---|
| `KITESPAN_VERSION=0.1.0 sh install.sh` | installs that release instead of the latest (also the way back to an older one) |
| `sh install.sh --list` | lists the installed versions, and which one `kitespan` starts |
| `sh install.sh --uninstall` | removes `~/.local/bin/kitespan` and the installed versions; your chats, settings and config stay |

Through the pipe, an option goes after `sh -s --`, for example
`curl -fsSL https://github.com/wannaFlyKa/kitespan/releases/latest/download/install.sh | sh -s -- --uninstall`.

### With Homebrew

```sh
brew install wannaFlyKa/tap/kitespan
```

It installs Bun from Homebrew too. `brew uninstall kitespan` removes kitespan; your chats, settings and config stay.

### From source

```sh
git clone <this repository> kitespan
cd kitespan
bun install --frozen-lockfile --omit=optional
bun run build
```

`--omit=optional` keeps the SDK's bundled Claude Code binaries out, so only your own `claude` runs. The Claude Agent SDK
is Anthropic's, under its own terms (https://code.claude.com/docs/en/legal-and-compliance); `bun install` fetches it
from npm, and this repository does not include it. Each install way above fetches it the same way.

## Start

```sh
kitespan
```

From source: `bin/kitespan`. It listens on 127.0.0.1 only, on port 7940 (`--port <port>` for another). Open
http://127.0.0.1:7940 in a browser on the same machine, or from another device through a forward that you trust
(below). `kitespan --help` lists the options, and `kitespan --version` prints the version. Ctrl+C stops the server and
the Claude Code of every open chat.

Before Bun starts, `bin/kitespan` removes the variables of a Claude Code session that started it and, on a Claude
Desktop host, that host's credentials, and Bun loads no `.env` file. Lines of your own go in
`~/.config/kitespan/start-env`; the comment at the top of `bin/kitespan` gives their form.

## Update

| Installed with | How to update |
|---|---|
| the install script | Settings > About > Update, or the install command again |
| Homebrew | `brew upgrade kitespan` |
| from source | Settings > About > Update, or `bin/update.sh` |

Then restart kitespan to run the new version: Settings > About > Restart, or `kitespan restart` (from source
`bin/kitespan restart`). After `brew upgrade`, restart it at once: Homebrew removes the old version's folder.

An install from the script updates as it installs: the new release goes beside the running one, and `kitespan` starts it
once every step finished; the running kitespan goes on until you restart it. A source checkout's update refuses a
checkout with local changes; then it fetches from origin and fast-forwards only (never a merge, and never over an
ignored file of yours that origin starts to track), installs from the lockfile with `--frozen-lockfile --omit=optional`,
and builds the page. Each stops at the first failure.

Settings > About > Check for updates looks for a new version Daily (the default), Every 3 hours, or Manually (only when
you press Check now). A source checkout asks its origin (`git ls-remote`); an install from the script downloads the
latest release's `SHA256SUMS` from GitHub, a request that names no version, no machine and no account. A Homebrew
install never checks: `brew outdated` does that. kitespan never updates or restarts by itself.

## Files

kitespan keeps its state in `~/.local/state/kitespan/` (or `$XDG_STATE_HOME/kitespan/`): the chat list, the drafts,
its settings, and logs that never hold what you or Claude wrote. Your own config is in `~/.config/kitespan/` (or
`$XDG_CONFIG_HOME/kitespan/`): `adapters.json` and `start-env`, which kitespan reads and never writes. Its records of
worktrees that it is making are in `~/.local/share/kitespan/` (or `$XDG_DATA_HOME/kitespan/`). An install from the
script keeps each version in `~/.local/share/kitespan/versions/`, and `~/.local/share/kitespan/current` names the one
that `kitespan` starts. Folders are 0700 and files 0600.

`browser.json` in the config folder names the browser program and its port; kitespan reads it and never writes it:

```json
{ "v": 1, "chrome": "/usr/bin/google-chrome-stable", "port": 9340 }
```

With no file, kitespan uses Google Chrome or Chromium from your `PATH`, on port 9340. The browser's profile, with your
sign-ins, is in `~/.local/state/kitespan/browser/`. A backup of the state folder carries your sign-ins.

## From another device

kitespan has no sign-in in this release: anyone who can open its page can run Claude Code as you, and you are responsible for how you connect it from another device.

Anyone who can open kitespan's page can also use its browser pane, with your sign-ins (see The browser pane, below).

kitespan accepts a page only from its own port on `127.0.0.1`, `localhost` or `[::1]`, and from the origins that you
allow. Any other origin gets 403, so a page on another site cannot reach it.

| Way in | What to allow |
|---|---|
| `ssh -L 7940:127.0.0.1:7940 <host>`, then `http://localhost:7940` | nothing |
| `ssh -L 8080:127.0.0.1:7940 <host>`, then `http://localhost:8080` | `--origin http://localhost:8080` |
| Tailscale Serve: `tailscale serve 7940` on the host, then `https://<machine>.<tailnet>.ts.net` | `--origin https://<machine>.<tailnet>.ts.net` |
| Cloudflare Tunnel to `http://127.0.0.1:7940`, with Cloudflare Access in front of it | `--origin https://kitespan.example.com` (its public hostname) |
| Another reverse proxy | `--origin` with the exact origin that the browser shows, with its port when it is not 443 |

For example:

```sh
bin/kitespan --origin https://box.tail1234.ts.net
```

At start, kitespan prints each origin that it allows beyond its own, and where it came from. `--origin` is not saved:
it lasts until you stop kitespan, and a restart from Settings, `bin/kitespan restart` or the restart after an update
keeps it. To drop it, stop kitespan and start it again without the flag. To keep an origin, list it in
`access.origins` of `~/.config/kitespan/adapters.json` (or `$XDG_CONFIG_HOME/kitespan/adapters.json`, a file of your
own, mode 0600, that kitespan never writes):

```json
{ "v": 1, "access": { "origins": ["https://kitespan.example.com"] } }
```

kitespan reads the file when it starts, so restart it after a change. A forward must pass the browser's `Origin` header
unchanged; it may pass the public name or `localhost:<port>` as the Host. Put an access gate in front of any forward
that leaves your own machine (Cloudflare Access, your tailnet's own access rules).

The ways in above are examples from each product's own docs, not checks that kitespan makes:
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve),
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) and
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

## The browser pane

The browser pane shows one shared Chrome on this machine, which you and Claude Code both use. It keeps its own
profile, so sites you sign in to stay signed in, for Claude too. Anyone who can open kitespan's page can use that
browser, with your sign-ins.

kitespan starts the browser only after you press Start browser. A restart of kitespan (Settings, `bin/kitespan restart`
or an update) keeps it running, with its tabs. When you quit kitespan, it stops the browser too, and the browser stays
off until you press Start browser again. A crash of kitespan cannot stop it: the browser then keeps running, with your
sign-ins and its debugging port open, until you press Stop browser in Settings > Browser or the machine shuts down.
Stop it before you leave a shared machine.

Clear browsing data in Settings > Browser stops the browser, removes its whole profile (sign-ins, cookies, history, site
data and cache) and starts it again with no tabs. Downloads stay until you remove them.

To let Claude Code use the same browser, add the Playwright MCP server to your Claude Code configuration once:

```sh
claude mcp add -s user playwright -- npx @playwright/mcp@0.0.84 --cdp-endpoint http://127.0.0.1:9340 --no-webmcp --output-dir ~/.cache/playwright-mcp-output
```

kitespan never changes your Claude Code configuration. The Claude is acting chip lights only for a server named
`playwright`. Settings > Browser shows this command for the port in use.

The Playwright MCP server's `browser_run_code_unsafe` tool runs any code on this machine, outside the browser, as you.
Treat a request to use it as you would a shell command, or deny the tool in Claude Code's permission settings: a deny
rule for `mcp__playwright__browser_run_code_unsafe`, which you can add with Claude Code's `/permissions`.

Claude Code uses the tab its browser tools pick, which may be one of your tabs. Every tab that Claude uses shows among
the pane's tabs, and a pane that still shows the blank tab the browser started with follows Claude to that tab. Ask
Claude to open its own tab first, for example: use browser_tabs to open a new tab, then work there.

If you pick a file in the pane while Claude works in the same tab, Claude's browser tools then report an open file
chooser. Claude clears it with browser_file_upload and no paths.

Chrome's debugging port (127.0.0.1:9340) has no password: any program on this machine can control the shared browser.
Never forward that port.

A screen reader cannot read a page through the pane; the page is a picture.

## Development

```sh
bun install --frozen-lockfile --omit=optional
bun run ci
bin/kitespan dev
```

`bun run ci` runs what CI's check job runs: both type checks, the tests, the page's build and the public-clean audit.
The tests use a fake Claude Code and never start the real `claude`. The live tests are opt-in: `bun run test:live` runs
real turns with your own Claude Code ([test/live/README.md](test/live/README.md)).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Every commit is signed off (`git commit -s`).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

Apache-2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Trademarks

Claude and Claude Code are trademarks of Anthropic, PBC. kitespan is an independent, personal project, not made or
endorsed by Anthropic or by any employer; it names Claude Code only to say what it runs.
