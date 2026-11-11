# Security

## Report a vulnerability

Report it privately, with GitHub's private vulnerability reporting: "Report a vulnerability" on this repository's
Security tab. Do not open a public issue for it. Say what an attacker can do, and how to reproduce it.

## Scope

In scope: kitespan's server, its page, and the scripts in `bin/` and `scripts/`.

Not in scope:

- Claude Code and the Claude Agent SDK themselves: report those to Anthropic
  (https://www.anthropic.com/responsible-disclosure-policy).
- Your own way in from another device (an SSH forward, Tailscale, Cloudflare Tunnel, a reverse proxy) and how you set
  it up.
- Chrome and the Playwright MCP server themselves: report those to their projects.

## The model

kitespan runs Claude Code and shell commands as you, on your machine, so anyone who can drive it can act as you. What
keeps others out:

- **The loopback bind.** The server listens on 127.0.0.1 only. Every way in from another device is a forward that you
  bring.
- **No sign-in.** kitespan has no sign-in in this release: anyone who can open its page can run Claude Code as you, and you are responsible for how you connect it from another device.
- **The Origin check.** Every WebSocket upgrade needs an allowed `Origin`: kitespan's own port on `127.0.0.1`,
  `localhost` or `[::1]`, or an exact origin that you allow (`--origin`, or `access.origins` in `adapters.json`). Every
  `POST`, `PUT` and `DELETE` under `/api/` needs that `Origin`, its body type and the header `x-kitespan: 1`, which a
  page on another site cannot send: kitespan answers no `OPTIONS` request and sends no `Access-Control-Allow-Origin`
  header. So another web page in the same browser cannot drive it.
- **The Host allowlist.** Every request needs a `Host` header of kitespan's own (a loopback name with its port, or the
  host of an allowed origin), against DNS rebinding.
- **Text only.** No model output, tool output or file content reaches the page as markup. Every response has a strict
  `Content-Security-Policy` (kitespan's own origin only, no framing), `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`.
- **Claude's credentials.** kitespan never shows a Claude sign-in, and never reads, copies or forwards Claude Code's
  credentials or tokens. It runs your own unmodified `claude`.
- **Its files.** Folders 0700 and files 0600. The logs never hold what you or Claude wrote, and an error sent to the
  page holds no path.
- **The browser pane.** The shared browser's debugging port listens on 127.0.0.1 only, and Chrome starts without
  `--remote-allow-origins`, so no web page can open it. The page never speaks the debugging protocol: kitespan's server
  sends only the calls it names, with arguments it checks, and its own scripts are fixed. Anyone who can open
  kitespan's page can use that browser, with your sign-ins.
- **kitespan's own page and the shared browser.** kitespan's page must never run inside the shared browser: there it
  would give whoever drives that browser, Claude or a web page, your chats, your permission prompts and your terminal.
  The shared browser blocks kitespan's addresses in every tab, and kitespan's server refuses its page to a load that
  another site starts. On this machine's own addresses kitespan also refuses its page, its sockets and every change
  when the connection comes from the shared browser. Through a forward (an origin that you allow with `--origin` or in
  `adapters.json`), kitespan cannot tell the shared browser's connections from yours, so an address that the browser
  opens by itself, as Claude's browser_navigate does, meets only the block in the browser. A program that drives the
  browser's debugging port directly, or Playwright's browser_run_code_unsafe tool, can get past that block, and it can
  reach kitespan's server directly as well.
- **Other accounts on the machine.** The debugging port has no password, and any process on the machine, of any
  account, can connect to a port on 127.0.0.1. On a machine with other accounts, they can control the shared browser
  and read its cookies. This lasts while the browser runs: quitting kitespan stops it, but after a crash of kitespan it
  runs on until you press Stop browser. The Playwright MCP server also opens a socket of its own while it is attached.
- **The profile** holds your sign-ins. Its folder is 0700; kitespan never reads, lists or serves it.
