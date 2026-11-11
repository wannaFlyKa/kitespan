// The opt-in live test of the browser pane (iteration 7; DESIGN-B1 7.5, the lead's live run B3): Claude Code, through
// the user's own `playwright` MCP server (user scope, --cdp-endpoint http://127.0.0.1:9340: browserMcpCommand in
// shared/browser.ts), drives the one shared browser that kitespan starts, in the tab that the pane shows. It runs 4
// short real turns on KITESPAN_LIVE_MODEL (a Haiku row) through a real bin/kitespan and its sockets, in the scratch
// project. Without KITESPAN_LIVE=1 it is one skipped test. In order:
//
// 0. The preflight, before anything starts: nothing listens on port 9340 on any address (the test never adopts or
//    drives a browser that it did not start), and `claude mcp get playwright`, run in the scratch project (where a
//    local-scope entry would win), shows the entry at user scope, running @playwright/mcp at the pinned version
//    (BROWSER_MCP_VERSION, whose result text kitespan reads) with --cdp-endpoint http://127.0.0.1:9340. Only facts of
//    that output are kept; it can hold the entry's environment values. The Playwright server that its connection check
//    starts is noted under it by its command line, and one that outlives it is ended by its pid.
// 1. The server, with its own browser.json in its temporary config folder (port 9340, loopbackOnly); the scratch
//    project; Start through POST /api/browser/start: kitespan starts its own Chrome (not adopted) with a new profile in
//    the temporary state folder, and the one listener on 9340 is that Chrome. The test's own page server on 127.0.0.1
//    (a port the system picks); one pane socket on /ws/browser with kitespan's Origin, as the page opens it, which views
//    every tab that shows and acks each frame.
// A. Claude opens the word page in the tab that the pane showed after Start, clicks its button and says the word. The
//    button's script fetches the word from the page server, so only a click can show it: the reply holds the word, the
//    chat's events hold mcp__playwright__ calls, "Claude is acting" lit and went out, Claude's tab is the pane's tab,
//    the page server saw the script's fetch (Sec-Fetch-Mode cors and Dest empty, which no navigation sends), and the
//    pane's socket got frames of that tab after the click, of the document that the click ran in. "The pane's tab" is
//    strict: the tab that the pane showed after Start (`how: shown`: Playwright's first page is the start tab, since
//    kitespan's spare never has the lowest target id while a listed tab exists), or kitespan's hidden spare that joined
//    the list once Claude used it, with the server's follow to the socket that showed the start tab (`how: followed`:
//    the safety net). The log line says which; B, C and D log it too.
//    A2. The chip and the mark on real calls (DESIGN-B1 4.4): the click's acting entry names that tab, and the tab
//    list marks it as the chat's (claudeLast).
// B. Claude's click on a link starts a download: kitespan's downloads list holds it (its name and size), and the file
//    is in kitespan's downloads folder with mode 0600 and the bytes that the page server sent.
// C. Claude calls browser_resize (900 x 700): the tab's size shows 900 x 700, set by Claude, and 12 s later it still
//    does, with no other source shown in between (the source is set at a change of size and kept until the next one,
//    never by a timer).
// D. Claude's click on a file field: the pane's socket gets the file chooser frame, and it says that the chooser is
//    Claude's (`by: claude`: the server decides when the chooser opens, while a browser call of this chat runs on that
//    tab); the card that the page draws for that frame (web/browser/fileWords.ts, the rules that FileCard uses) is
//    Claude's: titled "Claude opened a file field", with Leave it to Claude as its plain button (and Esc).
//    D2. The mark follows the newest chat: in B, C and D the tab list marks Claude's tab as that case's chat, and once
//    it did, never as another chat. Each case archives its chat before the next one starts, so only one chat holds a
//    mark at a time: D2 checks that a chat's end takes its mark away, not that the newest of two live chats wins (the
//    unit tests check that).
// Z. The end: Delete for each chat (every one must pass), Stop browser through POST /api/browser/stop, the server
//    stopped by its pid (its temporary folder goes with it), no Playwright server process of the test's still runs,
//    and nothing listens on 9340.
//
// Before each turn, and again after it, the browser on 9340 must still be the Chrome that kitespan started for the
// test: GET /api/browser says running and started, host.json's record still has its start ticks and a command line
// that names the test's profile and port, and every listener on 9340 is held by that process tree. A case whose check
// fails sends no prompt. While a turn runs, the listeners are checked each second (and before each Allow once): when
// they are not that Chrome's, every card is denied and the chat is stopped.
//
// Every case is a new chat in Manual mode. A permission card is answered Allow once only for the Playwright tools that
// the prompts need (browser_navigate, browser_click, browser_resize, browser_snapshot, browser_wait_for, and
// browser_file_upload with no paths) and ToolSearch, which loads them; every other card is denied (browser_evaluate
// and browser_run_code_unsafe among them). After each case the chat is archived, and the Playwright server processes
// that its Claude Code started (noted under it while the turn runs, by their command line and start ticks) must end
// within 15 s; one that does not is ended by its pid. It logs counts, ids, states, tool names and booleans; never a
// reply, a page's text, a URL or the MCP entry's output.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BROWSER_FILE } from "../../server/browser/config";
import { DOWNLOADS_FILE } from "../../server/browser/downloads";
import { HOST_FILE, hostRecordOf, type HostRecord } from "../../server/browser/host";
import { cmdlineCheck, holderOf, listenRows, startOf, systemProc, treeOf } from "../../server/browser/procfs";
import {
  BROWSER_MCP_VERSION,
  BROWSER_TOOL_PREFIX,
  decodeCastFrame,
  type BrowserActing,
  type BrowserDownloadsReply,
  type BrowserDownloadView,
  type BrowserHostView,
  type BrowserReply,
  type BrowserServerFrame,
  type BrowserTabView,
} from "../../shared/browser";
import { PROTOCOL_VERSION, WIRE, type ChatEvent, type ConnectorInfo, type Picks } from "../../shared/protocol";
import { fileIsClaudes, filePlain, fileTitle } from "../../web/browser/fileWords";
import {
  allowOnly,
  blocks,
  cmdline,
  descendantsOf,
  findTranscript,
  hello,
  LIVE_PORTS,
  LiveServer,
  liveSuite,
  makeTemp,
  need,
  nonce,
  ofKind,
  portFree,
  removeTemp,
  rid,
  sessionOf,
  startChat,
  statOf,
  textOf,
  TurnLog,
  until,
  userEnv,
  word,
  type CardPolicy,
  type Page,
} from "./live";

/** The debugging port that the owner's Playwright entry names: the test's browser takes it only while it is free. */
const CDP_PORT = 9340;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const MCP_NAME = "playwright";
const T_TURN = 240_000;
const T_CASE = T_TURN + 120_000;
/** The size that case C asks of browser_resize: neither the Desktop page nor a Phone size. */
const RESIZE = { w: 900, h: 700 } as const;
/** How long after "set by Claude" first shows case C looks again: more than the old rule's 10 s timer. */
const SIZE_KEPT_MS = 12_000;
/** The file card's title for a chooser of Claude's (DESIGN-B1 4.7). */
const CLAUDE_FILE_TITLE = "Claude opened a file field";
/** At most this many tabs viewed at once by the pane's socket (the relay allows 4 casts a tab, 8 in all). */
const MAX_VIEWS = 6;
/** The ports the test's page server never takes: the live ports and the debugging ports. */
const RESERVED = new Set<number>([...LIVE_PORTS, ...Array.from({ length: 10 }, (_, i) => 9340 + i)]);
const UPLOAD_TOOL = `${BROWSER_TOOL_PREFIX}browser_file_upload`;
/**
 * The only tools that a card is allowed for: the Playwright tools that the prompts need (browser_file_upload only with
 * no paths), and ToolSearch, which loads deferred tools (todo.test.ts allows it too). Every other tool is denied, so a
 * tool that a later MCP version adds or renames never runs here.
 */
const ALLOWED = new Set([...["browser_navigate", "browser_click", "browser_resize", "browser_snapshot", "browser_wait_for", "browser_file_upload"].map((t) => `${BROWSER_TOOL_PREFIX}${t}`), "ToolSearch"]);
/** How long a chat's Playwright server may run on after its chat's archive. */
const MCP_END_MS = 15_000;
/** The headers that the page's own requests carry (the sender gate's, and a same-origin fetch's). */
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;
const ANSI = new RegExp(String.fromCharCode(27) + "[[][0-?]*[ -/]*[@-~]", "g");
const UID = process.getuid?.() ?? -1;

type Seen = { f: BrowserServerFrame; at: number };
type ActingFrame = Extract<BrowserServerFrame, { t: "acting" }>;
type ChooserFrame = Extract<BrowserServerFrame, { t: "chooser" }>;

// ---------------------------------------------------------------------------------------------------------------
// The Playwright server processes that the test's claude processes start

/** A Playwright server process (npx's, its shell's, or the server's own node), with its start ticks (statOf). */
interface McpProc {
  pid: number;
  start: string;
}

/** A Playwright server's command line: its package or its bin name, or the debugging endpoint of the owner's entry. */
function mcpLike(argv: readonly string[]): boolean {
  const s = argv.join(" ");
  return s.includes("@playwright/mcp") || /(?:^|[\s/])playwright-mcp(?:\s|$)/.test(s) || s.includes(`--cdp-endpoint ${CDP_ENDPOINT}`) || s.includes(`--cdp-endpoint=${CDP_ENDPOINT}`);
}

/** Notes each of `pids` that runs a Playwright server, once by its pid and start. */
function noteMcp(pids: readonly number[], into: Map<string, McpProc>): void {
  for (const pid of pids) {
    const st = statOf(pid);
    if (!st || st.state === "Z" || into.has(`${pid}@${st.start}`) || !mcpLike(cmdline(pid))) continue;
    into.set(`${pid}@${st.start}`, { pid, start: st.start });
  }
}

/** The noted process still runs: the same start ticks, and still a Playwright server's command line. */
function mcpRuns(m: McpProc): boolean {
  const st = statOf(m.pid);
  return st !== null && st.state !== "Z" && st.start === m.start && mcpLike(cmdline(m.pid));
}

/** SIGTERM, then SIGKILL 5 s later, to each of `list` that still runs, each signal after mcpRuns' checks; how many ran. */
async function endMcp(list: readonly McpProc[]): Promise<number> {
  const left = list.filter(mcpRuns);
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    if (!left.some(mcpRuns)) break;
    for (const m of left) {
      if (!mcpRuns(m)) continue;
      try {
        process.kill(m.pid, sig);
      } catch {
        // already gone
      }
    }
    await until(() => !left.some(mcpRuns), 5_000, "the Playwright server processes to end").catch(() => {});
  }
  return left.length;
}

// ---------------------------------------------------------------------------------------------------------------
// The preflight

/** Something listens on the port, on any address (the LISTEN rows of /proc/net/tcp and tcp6), or holds 127.0.0.1's. */
const portTaken = (port: number): boolean => listenRows(systemProc, port).length > 0 || !portFree(port);

interface McpEntry {
  code: number | null;
  named: boolean;
  user: boolean;
  stdio: boolean;
  pkg: boolean;
  /** The version that the entry's package argument names ("" for none), or null when no @playwright/mcp argument. */
  version: string | null;
  pinned: boolean;
  endpoint: boolean;
  connected: boolean;
  /** The Playwright server processes of the connection check that still ran 10 s after it, ended by their pid. */
  outlived: number;
}

/**
 * Claude Code's own view of its `playwright` entry: `claude mcp get playwright` in `cwd`, with no terminal, as the other
 * live files run the user's claude. Only facts of its output are kept (never logged: it lists the entry's environment).
 * The Playwright server that its connection check starts is noted into `seen` while it runs.
 */
async function mcpEntry(bin: string, cwd: string, seen: Map<string, McpProc>): Promise<McpEntry> {
  const proc = Bun.spawn([bin, "mcp", "get", MCP_NAME], { cwd, env: userEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 90_000, killSignal: "SIGKILL" });
  // A Playwright server that outlives its claude keeps the inherited pipes open, so the output is read after the wait.
  const stdout = new Response(proc.stdout).text().catch(() => "");
  void new Response(proc.stderr).text().catch(() => "");
  const watch = setInterval(() => noteMcp(descendantsOf(proc.pid), seen), 200);
  try {
    await proc.exited;
  } finally {
    clearInterval(watch);
  }
  const list = [...seen.values()];
  const ended = await until(() => !list.some(mcpRuns), 10_000, "the connection check's Playwright server to end").then(
    () => true,
    () => false,
  );
  const outlived = ended ? 0 : await endMcp(list);
  const text = await Promise.race([stdout, Bun.sleep(5_000).then(() => "")]);
  const lines = text.replace(ANSI, "").split(/\r?\n/);
  const field = (name: string) => {
    const line = lines.find((l) => l.trimStart().startsWith(`${name}:`));
    return line ? line.trimStart().slice(name.length + 1).trim() : "";
  };
  const args = field("Args").split(/\s+/).filter(Boolean);
  const pkg = args.find((a) => a === "@playwright/mcp" || a.startsWith("@playwright/mcp@"));
  const version = pkg === undefined ? null : pkg.slice("@playwright/mcp@".length);
  const at = args.indexOf("--cdp-endpoint");
  const status = field("Status");
  return {
    code: proc.exitCode,
    named: lines.some((l) => l.trim() === `${MCP_NAME}:`),
    user: /^User config\b/.test(field("Scope")),
    stdio: field("Type") === "stdio",
    pkg: pkg !== undefined,
    version,
    pinned: version === BROWSER_MCP_VERSION,
    endpoint: (at >= 0 && args[at + 1] === CDP_ENDPOINT) || args.includes(`--cdp-endpoint=${CDP_ENDPOINT}`),
    connected: /connected/i.test(status) && !/fail|not connected/i.test(status),
    outlived,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The test's own page server

interface Hit {
  path: string;
  /** The request carried the run's key. */
  own: boolean;
  at: number;
  /** Its Sec-Fetch-Mode, Sec-Fetch-Dest and Sec-Fetch-Site (a page script's fetch: cors, empty, same-origin). */
  mode: string | null;
  dest: string | null;
  site: string | null;
}

interface Site {
  base: string;
  port: number;
  /** Every request, newest last. */
  hits: Hit[];
  stop(): void;
}

/** A small counter that changes 4 times a second, so the pane keeps getting frames; hidden from Claude's snapshot. */
const TICKER =
  `<div aria-hidden="true" id="tick" style="position:fixed;right:8px;bottom:8px;font:12px monospace;color:#777">0</div>` +
  `<script>let n = 0; setInterval(() => { document.getElementById("tick").textContent = String(++n); }, 250);</script>`;

function html(title: string, body: string): Response {
  const text = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:24px;font:18px sans-serif">${body}${TICKER}</body></html>`;
  return new Response(text, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * The pages, on 127.0.0.1 only: /a (a button whose script fetches the word from /word and writes it into the page), /b
 * (a link to /note, an attachment), /c (a page for the size check), /d (a file field). /word and /note answer only the
 * run's key.
 */
function startSite(o: { key: string; word: string; note: Uint8Array; noteName: string }): Site {
  const hits: Hit[] = [];
  const plain = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  for (let attempt = 0; attempt < 5; attempt++) {
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        const own = u.searchParams.get("k") === o.key;
        const h = (name: string) => req.headers.get(name);
        hits.push({ path: u.pathname, own, at: Date.now(), mode: h("sec-fetch-mode"), dest: h("sec-fetch-dest"), site: h("sec-fetch-site") });
        switch (u.pathname) {
          case "/a":
            return html(
              "kitespan live: word",
              `<h1>Word check</h1><button id="show" type="button">Show the word</button><p id="out"></p>` +
                `<script>document.getElementById("show").addEventListener("click", async () => {` +
                `const r = await fetch(${JSON.stringify(`/word?k=${o.key}`)}, { cache: "no-store" });` +
                `document.getElementById("out").textContent = "The word is " + (await r.text()) + "."; });</script>`,
            );
          case "/word":
            return own ? new Response(o.word, { headers: plain }) : new Response("", { status: 404 });
          case "/b":
            return html("kitespan live: download", `<h1>Download check</h1><p><a id="note" href="/note?k=${o.key}">Download the note</a></p>`);
          case "/note":
            return own ? new Response(o.note, { headers: { ...plain, "content-disposition": `attachment; filename="${o.noteName}"` } }) : new Response("", { status: 404 });
          case "/c":
            return html("kitespan live: size", `<h1>Size check</h1><p>This page is for a size check.</p>`);
          case "/d":
            return html("kitespan live: file", `<h1>File check</h1><p><label for="notes">Notes file</label> <input id="notes" type="file" accept=".txt"></p>`);
          default:
            return new Response("", { status: 404 });
        }
      },
    });
    const port = Number(srv.port);
    if (Number.isInteger(port) && port > 0 && !RESERVED.has(port)) return { base: `http://127.0.0.1:${port}`, port, hits, stop: () => void srv.stop(true) };
    srv.stop(true);
  }
  throw new Error("the test's page server got a reserved port five times");
}

// ---------------------------------------------------------------------------------------------------------------
// One pane socket, as the page opens it

type Cast = { tab: string; n: number; nav: number; dw: number; dh: number; at: number };

class Viewer {
  readonly frames: Seen[] = [];
  /** The headers of the cast frames that came (never their JPEG bytes), with when each came. */
  readonly casts: Cast[] = [];
  readonly viewed = new Set<string>();
  tabs: BrowserTabView[] = [];
  acting: BrowserActing[] = [];
  closed = false;
  private ping: ReturnType<typeof setInterval> | null = null;
  private pings = 0;

  private constructor(private readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (m) => this.onMessage(m.data);
    ws.onclose = () => {
      this.closed = true;
      if (this.ping) clearInterval(this.ping);
    };
  }

  /** /ws/browser with kitespan's own Origin and a same-origin fetch's headers, then `open` with this protocol's version. */
  static open(server: LiveServer): Promise<Viewer> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WIRE.browserPath}`, {
        headers: { origin: server.origin, ...SAME_ORIGIN, "sec-fetch-mode": "websocket", "sec-fetch-dest": "websocket" },
      });
      const v = new Viewer(ws);
      ws.onopen = () => {
        v.send({ t: "open", v: PROTOCOL_VERSION });
        v.ping = setInterval(() => v.send({ t: "ping", n: ++v.pings }), 15_000);
        v.ping.unref?.();
        ok(v);
      };
      ws.onerror = () => fail(new Error(`the pane's socket on ${WIRE.browserPath} did not open`));
    });
  }

  send(o: unknown): void {
    if (!this.closed) this.ws.send(JSON.stringify(o));
  }

  private onMessage(data: unknown): void {
    const at = Date.now();
    if (typeof data === "string") {
      let f: BrowserServerFrame;
      try {
        f = JSON.parse(data) as BrowserServerFrame;
      } catch {
        return;
      }
      this.frames.push({ f, at });
      if (f.t === "opened") {
        this.tabs = f.tabs;
        this.acting = f.acting;
        this.viewTabs();
      } else if (f.t === "tabs") {
        this.tabs = f.list;
        this.viewTabs();
      } else if (f.t === "acting") this.acting = f.list;
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    const d = bytes ? decodeCastFrame(bytes) : null;
    if (!d) return;
    const h = d.header;
    this.casts.push({ tab: h.tab, n: h.n, nav: h.nav, dw: h.dw, dh: h.dh, at });
    // The page's ack: the cast's credit comes back, so Chrome sends the next frame.
    this.send({ t: "drawn", tab: h.tab, n: h.n });
  }

  /** Every tab that shows (a hidden one is behind another tab of its window: a view would bring it forward). */
  private viewTabs(): void {
    for (const t of this.tabs) {
      if (t.hidden || this.viewed.has(t.id) || this.viewed.size >= MAX_VIEWS) continue;
      this.viewed.add(t.id);
      this.send({ t: "view", tab: t.id, w: 640, h: 400, dpr: 1, q: 40, credit: 2 });
    }
  }

  async opened(ms = 15_000): Promise<Extract<BrowserServerFrame, { t: "opened" }>> {
    await until(() => this.frames.some((x) => x.f.t === "opened"), ms, "the opened frame");
    return this.frames.find((x) => x.f.t === "opened")!.f as Extract<BrowserServerFrame, { t: "opened" }>;
  }

  /** The tab lists that came since `since`, oldest first. */
  private lists(since: number): { at: number; list: BrowserTabView[] }[] {
    const out: { at: number; list: BrowserTabView[] }[] = [];
    for (const x of this.frames) {
      if (x.at < since) continue;
      if (x.f.t === "opened") out.push({ at: x.at, list: x.f.tabs });
      else if (x.f.t === "tabs") out.push({ at: x.at, list: x.f.list });
    }
    return out;
  }

  /** The newest tab that a list since `since` showed at `url`, or null. */
  tabWith(url: string, since: number): string | null {
    for (const l of this.lists(since).reverse()) {
      const t = l.list.find((x) => x.url === url);
      if (t) return t.id;
    }
    return null;
  }

  /** The server told this socket to follow tab `id` from tab `from` since `since` (D-12; the spare's safety net, Q3). */
  followed(id: string, from: string | null, since: number): boolean {
    return this.frames.some((x) => x.at >= since && x.f.t === "follow" && x.f.tab === id && x.f.from === from);
  }

  /** Each view of tab `id` in the lists since `since`, oldest first. */
  views(id: string, since: number): { at: number; view: BrowserTabView }[] {
    return this.lists(since).flatMap((l) => l.list.filter((t) => t.id === id).map((view) => ({ at: l.at, view })));
  }

  /** The acting entries of `chat` in the acting frames since `since`. */
  actingOf(chat: string, since: number): BrowserActing[] {
    return this.frames.filter((x): x is { f: ActingFrame; at: number } => x.at >= since && x.f.t === "acting").flatMap((x) => x.f.list.filter((a) => a.chat === chat));
  }

  /** The acting list as it stood when frame `i` came (the last acting frame before it, else opened's). */
  actingBefore(i: number): BrowserActing[] {
    for (let j = i - 1; j >= 0; j--) {
      const f = this.frames[j]!.f;
      if (f.t === "acting") return f.list;
      if (f.t === "opened") return f.acting;
    }
    return [];
  }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The cards, and one case's chat

/**
 * Allow once only the tools of ALLOWED (browser_file_upload only with no paths), and only while `ours()` says that the
 * browser on 9340 is still the test's; deny every other card.
 */
function browserCards(seen: string[], ours: () => boolean): CardPolicy {
  const rest = allowOnly([]);
  return (card) => {
    if (card.kind !== "permission") {
      seen.push(String(card.kind));
      return rest(card);
    }
    const tool = typeof card.toolName === "string" ? card.toolName : "";
    const paths = (card.input as { paths?: unknown } | null | undefined)?.paths;
    const upload = tool === UPLOAD_TOOL && paths !== undefined && !(Array.isArray(paths) && paths.length === 0);
    const allow = ALLOWED.has(tool) && !upload && ours();
    seen.push(`${tool.startsWith(BROWSER_TOOL_PREFIX) ? tool.slice(BROWSER_TOOL_PREFIX.length) : tool}:${allow ? "once" : "denied"}`);
    return allow ? { kind: "permission", allow: true, scope: "once" } : { kind: "permission", allow: false, message: "This live test allows only the Playwright tools that its prompts name, and no file upload." };
  };
}

interface CaseRun {
  tag: string;
  chat: string;
  ok: boolean;
  subtype: string;
  model: string | null;
  /** Date.now() just before new_chat, and at the turn's end. */
  t0: number;
  t1: number;
  /** The top-level tool calls, each with its last input. */
  calls: { id: string; name: string; input: unknown }[];
  results: Map<string, { isError: boolean }>;
  reply: string;
  cards: string[];
  /** The Playwright server processes that this chat's Claude Code started. */
  mcp: Map<string, McpProc>;
}

/** The Playwright tools that a case called, by their names after the prefix, in order, each once. */
const browserTools = (run: CaseRun): string[] => [...new Set(run.calls.filter((c) => c.name.startsWith(BROWSER_TOOL_PREFIX)).map((c) => c.name.slice(BROWSER_TOOL_PREFIX.length)))];

const navigate = (url: string) => `Use mcp__playwright__browser_navigate to open ${url} in the current tab.`;
const PROMPT = {
  A: (url: string) => `${navigate(url)} Then use mcp__playwright__browser_click to click the button "Show the word". Then reply with only the word that the page shows after the click.`,
  B: (url: string) => `${navigate(url)} Then use mcp__playwright__browser_click to click the link "Download the note". Then reply with the single word done.`,
  C: (url: string) => `${navigate(url)} Then use mcp__playwright__browser_resize with width ${RESIZE.w} and height ${RESIZE.h}. Then reply with the single word done.`,
  D: (url: string) => `${navigate(url)} Then use mcp__playwright__browser_click to click the file field "Notes file". Do not upload a file. Then reply with the single word done.`,
};

/** What the pane's GET routes get: the page's own fetch. */
const pageGet = (server: LiveServer, path: string) => fetch(`${server.origin}${path}`, { headers: SAME_ORIGIN });
/** What the pane's POST routes get: the sender gate's headers, as the page sends them. */
const pagePost = (server: LiveServer, path: string, body: unknown) =>
  fetch(`${server.origin}${path}`, { method: "POST", headers: { "x-kitespan": "1", "content-type": "application/json", origin: server.origin, ...SAME_ORIGIN }, body: JSON.stringify(body) });

async function browserReply(server: LiveServer): Promise<BrowserReply> {
  const r = await pageGet(server, "/api/browser");
  if (!r.ok) throw new Error(`GET /api/browser answered ${r.status}`);
  return (await r.json()) as BrowserReply;
}

/** The host's state until `done` takes it (or `ms` passed): the last one read. */
async function waitHost(server: LiveServer, done: (s: BrowserHostView["state"]) => boolean, ms: number): Promise<BrowserHostView> {
  const end = Date.now() + ms;
  for (;;) {
    const host = (await browserReply(server)).host;
    if (done(host.state) || Date.now() > end) return host;
    await Bun.sleep(250);
  }
}

/** `get()` until it gives a value, for at most `ms`; null when it never did. */
async function poll<T>(get: () => Promise<T | null | undefined>, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get().catch(() => null);
    if (v !== null && v !== undefined) return v;
    if (Date.now() > end) return null;
    await Bun.sleep(250);
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Every LISTEN row of 9340 is this user's and held by the recorded Chrome's process tree, which still runs. */
function heldBy(rec: HostRecord): boolean {
  if (startOf(systemProc, rec.pid) !== rec.start) return false;
  const rows = listenRows(systemProc, CDP_PORT);
  if (rows.length === 0) return false;
  const tree = treeOf(systemProc, rec.pid);
  return rows.every((l) => l.uid === UID && holderOf(systemProc, l.inode, tree) !== null);
}

type Ours = { ok: true; rec: HostRecord } | { ok: false; why: string };

/** One case's look at the tab mark: whether the tab list marked Claude's tab as the case's chat, and what else it named. */
interface Mark {
  tag: string;
  own: boolean;
  /** The chats that the views since the case's start named, by their case (or "another"), in order, each once. */
  named: string[];
  /** The chats other than the case's that a view named after the case's own mark showed. */
  after: string[];
}

liveSuite("test/live/browser.test.ts", {}, (env) => {
  const log = new TurnLog("browser");
  const picks: Picks = { model: env.model, effort: null, mode: "default" };
  const key = nonce();
  const theWord = word();
  const noteName = `kitespan-live-note-${key}.txt`;
  const note = new TextEncoder().encode(`kitespan live download check ${key}\n`);
  let preflight = false;
  let root: string | null = null;
  let server: LiveServer | null = null;
  let page: Page | null = null;
  let project = "";
  let site: Site | null = null;
  let viewer: Viewer | null = null;
  /** The browser's profile folder (BrowserReply.profile), inside the server's temporary state folder. */
  let profile = "";
  let startPosted = false;
  let running = false;
  /** The Chrome that step 1 saw kitespan start: its pid and start ticks (host.json's record then). */
  let first: { pid: number; start: string } | null = null;
  /** The tab that the pane showed first (the strip's first tab after Start). */
  let shown: string | null = null;
  let factsA: { tab: string; clickTab: string | null | undefined; marked: boolean } | null = null;
  /** The mark facts of B, C and D (D2). */
  const marks: Mark[] = [];
  /** Each chat that the test made, with its case: Delete at the end, and the transcripts. */
  const made: { chat: string; tag: string }[] = [];
  /** The Playwright server processes noted: the preflight's, then each case's. */
  const mcpSets: Map<string, McpProc>[] = [];
  /** The cases whose Playwright server processes still ran MCP_END_MS after the chat's archive (ended by their pid). */
  const mcpOutlived: { tag: string; n: number }[] = [];
  const steps = { chats: false, browser: false, closed: false, done: false };

  /**
   * How Claude's tab came to show (D-6, Q3): `shown`, the tab that the pane showed after Start (Playwright's first page
   * is the start tab, since kitespan's spare never has the lowest target id while a listed tab exists); `followed`, it
   * was kitespan's hidden spare, which joined the list once Claude used it, and the server told the socket that showed
   * the start tab to follow it (the safety net); null, neither (Claude's tab is one that the pane neither showed nor
   * followed to).
   */
  const howShown = (V: Viewer, tab: string | null, since: number): "shown" | "followed" | null => (tab === null ? null : tab === shown ? "shown" : V.followed(tab, shown, since) ? "followed" : null);
  const tagOf = (chat: string | null): string => made.find((m) => m.chat === chat)?.tag ?? "another";
  const noteChat = (tag: string, chat: string) => {
    if (!made.some((m) => m.chat === chat)) made.push({ chat, tag });
  };

  /** kitespan's record of the Chrome that it started (host.json), or null. */
  const hostRecord = (): HostRecord | null => (server ? hostRecordOf(readJsonFile(join(server.stateDir, "browser", HOST_FILE))) : null);
  /** The recorded Chrome's command line names the test's own profile and port, and no --remote-allow-origins. */
  const namesOurs = (rec: HostRecord): boolean =>
    profile !== "" && cmdlineCheck(systemProc.read(`/proc/${rec.pid}/cmdline`), [`--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`], ["--remote-allow-origins"]).ok;
  /** The recorded Chrome still runs: the same start ticks, and a command line that names the test's own profile. */
  const chromeLives = (rec: HostRecord): boolean =>
    startOf(systemProc, rec.pid) === rec.start && profile !== "" && cmdlineCheck(systemProc.read(`/proc/${rec.pid}/cmdline`), [`--user-data-dir=${profile}`], []).ok;

  /**
   * The browser on 9340 is still the Chrome that kitespan started for this test: GET /api/browser says running and
   * started (or adopted, when it is the very Chrome that step 1 saw start), host.json's record still has its start ticks
   * and names the test's profile and port, and every listener on 9340 is held by that process tree.
   */
  async function ours(S: LiveServer): Promise<Ours> {
    const reply = await browserReply(S).catch(() => null);
    if (!reply) return { ok: false, why: "GET /api/browser did not answer" };
    const host = reply.host;
    if (host.state !== "running") return { ok: false, why: `the browser's state is ${host.state}` };
    const rec = hostRecord();
    if (!rec) return { ok: false, why: "kitespan has no record (host.json) of the Chrome that runs" };
    const seen = first !== null && rec.pid === first.pid && rec.start === first.start;
    if (host.how !== "started" && !(host.how === "adopted" && seen)) return { ok: false, why: "kitespan's browser is not one that it started for this test" };
    if (host.port !== CDP_PORT || rec.port !== CDP_PORT) return { ok: false, why: `kitespan's browser is not on port ${CDP_PORT}` };
    if (startOf(systemProc, rec.pid) !== rec.start) return { ok: false, why: "the Chrome that host.json records no longer runs" };
    if (!namesOurs(rec)) return { ok: false, why: "the recorded Chrome's command line does not name the test's profile and port" };
    if (!heldBy(rec)) return { ok: false, why: `a listener on port ${CDP_PORT} is not held by the recorded Chrome` };
    return { ok: true, rec };
  }

  /** ours(), logged; throws when it fails, so the case sends no prompt (or fails after its turn). */
  async function guard(tag: string, when: string): Promise<HostRecord> {
    const o = await ours(server!);
    log.line({ step: tag, check: when, ours: o.ok, samePid: o.ok ? o.rec.pid === first?.pid : null, why: o.ok ? null : o.why });
    if (!o.ok) throw new Error(`${when}: ${o.why}. The test never lets Claude's browser tools reach a browser that kitespan did not start for it`);
    return o.rec;
  }

  /**
   * A new chat of the case, its turn (cards answered by browserCards), and what it drew. Before the turn, and after it,
   * guard(); during it, each second, the Playwright server processes under the server's claude children are noted and
   * the listeners on 9340 checked: when they are not the recorded Chrome's, the turn is given up and the chat stopped.
   * A chat whose turn failed is archived here, so its Claude Code does not run on into the next case.
   */
  async function runCase(tag: string, purpose: string, text: string): Promise<CaseRun> {
    const P = page!;
    const S = server!;
    const rec = await guard(tag, `before ${tag}'s turn`);
    const cards: string[] = [];
    const mcp = new Map<string, McpProc>();
    mcpSets.push(mcp);
    const before = new Set(P.rows.map((row) => row.chat));
    const fresh = () => P.rows.map((row) => row.chat).filter((c) => !before.has(c));
    let gone = false;
    let giveUp: (e: Error) => void = () => {};
    const lost = new Promise<never>((_, fail) => {
      giveUp = fail;
    });
    lost.catch(() => {});
    const look = () => {
      noteMcp(S.claudeChildren().flatMap((c) => descendantsOf(c)), mcp);
      if (!gone && !heldBy(rec)) {
        gone = true;
        giveUp(new Error(`during ${tag}'s turn, port ${CDP_PORT} was no longer held by the Chrome that kitespan started for this test: the chat was stopped`));
      }
    };
    const t0 = Date.now();
    const p0 = performance.now();
    const watch = setInterval(look, 1_000);
    const turn = startChat(P, project, text, picks, { ms: T_TURN, policy: browserCards(cards, () => !gone && heldBy(rec)) });
    turn.catch(() => {});
    let r: Awaited<typeof turn> | null = null;
    let failure: unknown = null;
    try {
      r = await Promise.race([turn, lost]);
    } catch (e) {
      failure = e;
    } finally {
      clearInterval(watch);
      look();
    }
    for (const c of fresh()) noteChat(tag, c);
    if (r === null) {
      log.line({ step: tag, failed: gone ? "the browser's check during the turn" : "the turn", cards: cards.join(",") || "none" });
      for (const c of fresh()) await endChat(tag, c, mcp);
      throw failure;
    }
    const after = await ours(S);
    log.line({ step: tag, check: `after ${tag}'s turn`, ours: after.ok, why: after.ok ? null : after.why });
    if (!after.ok) {
      await endChat(tag, r.chat, mcp);
      throw new Error(`after ${tag}'s turn: ${after.why}. Claude's browser tools may have reached a browser that kitespan did not start for this test`);
    }
    const t1 = Date.now();
    const drawn: ChatEvent[] = P.drawn(r.chat);
    const calls = new Map<string, { id: string; name: string; input: unknown }>();
    for (const c of ofKind(drawn, "tool_call")) {
      if (c.parent !== null) continue;
      const prev = calls.get(c.id);
      calls.set(c.id, { id: c.id, name: c.name, input: c.input ?? prev?.input ?? null });
    }
    const results = new Map<string, { isError: boolean }>();
    for (const x of ofKind(drawn, "tool_result")) if (x.parent === null) results.set(x.id, { isError: x.isError });
    const session = sessionOf(drawn);
    const run: CaseRun = {
      tag,
      chat: r.chat,
      ok: r.end.ok,
      subtype: r.end.subtype,
      model: session?.model ?? null,
      t0,
      t1,
      calls: [...calls.values()],
      results,
      reply: textOf(blocks(drawn).filter((b) => b.kind === "text" && b.parent === null)),
      cards,
      mcp,
    };
    log.turn({ purpose: `${tag}: ${purpose}`, model: env.model, chat: r.chat, session: session?.sessionId ?? null, ms: performance.now() - p0, ok: r.end.ok, note: `browser tools: ${browserTools(run).join(",") || "none"}; cards: ${cards.join(",") || "none"}; playwright processes: ${mcp.size}` });
    return run;
  }

  /**
   * Archive (Stop and archive) of a case's chat: its Claude Code ends, and with it its Playwright server, which must end
   * within MCP_END_MS; one that does not is ended by its pid (after mcpRuns' checks) and counted in mcpOutlived.
   */
  async function endChat(tag: string, chat: string, mcp: Map<string, McpProc>): Promise<void> {
    const P = page;
    const S = server;
    let ack: Awaited<ReturnType<Page["request"]>> | null = null;
    let ended: boolean | null = null;
    if (P && !P.closed && S?.running) {
      ack = await P.request({ t: "archive", rid: rid(), chat, on: true, stop: true }, 30_000).catch(() => null);
      ended = await until(() => S.claudeChildren().length === 0, 20_000, "the chat's claude to end").then(
        () => true,
        () => false,
      );
    }
    const list = [...mcp.values()];
    const mcpEnded = await until(() => !list.some(mcpRuns), MCP_END_MS, "the chat's Playwright server to end").then(
      () => true,
      () => false,
    );
    const outlived = mcpEnded ? 0 : await endMcp(list);
    if (outlived > 0) mcpOutlived.push({ tag, n: outlived });
    log.line({ step: "archive", tag, chat, ok: ack?.ok ?? null, ended, playwrightProcesses: list.length, outlived });
  }

  /** The connectors of a live chat (Claude Code's MCP servers), for the log: the playwright row's state. */
  async function playwrightRow(chat: string): Promise<ConnectorInfo | null> {
    const ack = await page!.request({ t: "get", rid: rid(), chat, what: "connectors" }, 30_000).catch(() => null);
    const rows = ack?.ok && Array.isArray(ack.result) ? (ack.result as ConnectorInfo[]) : [];
    return rows.find((c) => c.name === MCP_NAME) ?? null;
  }

  /** The tab mark in the views of `tab` since the case's start (it waits up to 3 s for the case's own mark). */
  async function markOf(run: CaseRun, tab: string): Promise<Mark> {
    const V = viewer!;
    await until(() => V.views(tab, run.t0).some((x) => x.view.claudeLast === run.chat), 3_000, "the tab's mark").catch(() => {});
    const views = V.views(tab, run.t0);
    const at = views.findIndex((x) => x.view.claudeLast === run.chat);
    const names = (list: typeof views) => [...new Set(list.map((x) => x.view.claudeLast).filter((c): c is string => c !== null))];
    return {
      tag: run.tag,
      own: at >= 0,
      named: names(views).map(tagOf),
      after: at < 0 ? [] : names(views.slice(at)).filter((c) => c !== run.chat).map(tagOf),
    };
  }

  /**
   * The end, once: Delete for every chat (its transcript goes too), Stop browser through the route, the sockets, the
   * server by its pid (its temporary folder goes with it), a Chrome of the test's that outlived all of that ended by its
   * recorded pid, every Playwright server process that the test noted ended by its pid, and a transcript that a failed
   * Delete left removed by its session's own file. Then nothing may listen on 9340. Each step runs once, also when
   * afterAll comes after a failure.
   */
  async function teardown(): Promise<Record<string, unknown>> {
    const S = server;
    const out: Record<string, unknown> = {};
    if (!S || steps.done) return out;
    const sessions = new Set<string>();
    if (!steps.chats) {
      steps.chats = true;
      let deleted = 0;
      if (page) for (const m of made) for (const e of [...page.events(m.chat), ...page.drawn(m.chat)]) if (e.k === "session") sessions.add(e.sessionId);
      if (page && !page.closed && S.running) {
        const all = [...new Set([...made.map((m) => m.chat), ...page.rows.map((row) => row.chat)])];
        for (const chat of all) {
          const ok = (await page.request({ t: "delete", rid: rid(), chat }, 60_000).catch(() => null))?.ok === true;
          if (ok && made.some((m) => m.chat === chat)) deleted++;
        }
      }
      out.chats = made.length;
      out.deleted = deleted;
    }
    const rec = hostRecord();
    if (!steps.browser) {
      steps.browser = true;
      if (S.running && startPosted) {
        const r = await pagePost(S, "/api/browser/stop", {}).catch(() => null);
        out.stop = r?.status ?? null;
        out.host = (await waitHost(S, (s) => s === "off", 30_000).catch(() => null))?.state ?? null;
        out.hostFile = existsSync(join(S.stateDir, "browser", HOST_FILE));
      }
    }
    if (!steps.closed) {
      steps.closed = true;
      viewer?.close();
      page?.close();
    }
    await S.stop();
    out.rootLeft = existsSync(S.root);
    out.outlived = false;
    if (rec && chromeLives(rec)) {
      // Only kitespan's own record of its spawn, with the same start ticks, on the test's own profile.
      out.outlived = true;
      for (const sig of ["SIGTERM", "SIGKILL"] as const) {
        if (!chromeLives(rec)) break;
        try {
          process.kill(rec.pid, sig);
        } catch {
          // already gone
        }
        await until(() => !chromeLives(rec), 5_000, "kitespan's Chrome to end").catch(() => {});
      }
    }
    const mcpAll = mcpSets.flatMap((m) => [...m.values()]);
    out.playwrightProcesses = mcpAll.length;
    // The server's stop ends the claude processes that were left; their Playwright servers get 10 s to end with them.
    await until(() => !mcpAll.some(mcpRuns), 10_000, "the Playwright server processes to end").catch(() => {});
    out.playwrightLeft = await endMcp(mcpAll);
    // Delete removes a chat's transcript; one that a failed Delete left goes by its session's own file.
    let transcripts = 0;
    for (const session of sessions) {
      const file = findTranscript(session, env.project);
      if (file && basename(file) === `${session}.jsonl`) {
        rmSync(file, { force: true });
        transcripts++;
      }
    }
    out.transcriptsLeft = transcripts;
    await until(() => !portTaken(CDP_PORT), 15_000, `port ${CDP_PORT} to be free`).catch(() => {});
    out.listeners = listenRows(systemProc, CDP_PORT).length;
    out.free = portFree(CDP_PORT);
    steps.done = true;
    return out;
  }

  afterAll(async () => {
    const t = await teardown().catch(() => ({}) as Record<string, unknown>);
    if (Object.keys(t).length) log.line({ step: "afterAll", ...t });
    // A preflight whose server was never booted: its Playwright server processes, if any are left.
    if (!server) await endMcp(mcpSets.flatMap((m) => [...m.values()]));
    site?.stop();
    // A boot that failed before the server took the temporary folder.
    if (root && !server) removeTemp(root);
    log.summary();
  }, 240_000);

  describe("the browser pane, live: Claude in the tab the pane shows", () => {
    test(
      "0: the preflight: nothing listens on port 9340, and Claude Code's playwright entry is at user scope, on the pinned @playwright/mcp, with --cdp-endpoint http://127.0.0.1:9340",
      async () => {
        const rows = listenRows(systemProc, CDP_PORT).length;
        const free = portFree(CDP_PORT);
        log.line({ step: "preflight", listeners: rows, free });
        if (rows > 0 || !free)
          throw new Error(`something listens on port ${CDP_PORT}: this test starts kitespan's own browser there and never adopts or drives another one; stop that program, then run it again`);
        const seen = new Map<string, McpProc>();
        mcpSets.push(seen);
        const m = await mcpEntry(env.claude, env.project, seen);
        log.line({ step: "preflight", mcpGet: m.code, named: m.named, userScope: m.user, stdio: m.stdio, pkg: m.pkg, version: m.version, pinned: m.pinned, endpoint: m.endpoint, connected: m.connected, playwrightProcesses: seen.size, outlived: m.outlived });
        expect(m.code === 0 && m.named, "claude mcp get playwright found no entry named playwright for the scratch project (test/live/README.md, browser.test.ts)").toBe(true);
        expect(m.user, "the playwright entry that the scratch project gets is not the user-scope one (a local or project entry wins over it)").toBe(true);
        expect(m.pkg && m.endpoint, `the playwright entry does not run @playwright/mcp with --cdp-endpoint ${CDP_ENDPOINT}`).toBe(true);
        expect(
          m.pinned,
          `the playwright entry runs @playwright/mcp ${m.version ? `version ${m.version}` : "with no version"}, not the pinned ${BROWSER_MCP_VERSION} (BROWSER_MCP_VERSION in shared/browser.ts, whose result text kitespan reads)`,
        ).toBe(true);
        preflight = true;
      },
      120_000,
    );

    test(
      "1: the server with its own browser.json (port 9340, loopback only); Start through POST /api/browser/start starts kitespan's own Chrome there with a new profile in the temporary state folder; one pane socket views its tab",
      async () => {
        need(preflight, "the preflight");
        root = makeTemp("browser");
        mkdirSync(join(root, "config"), { mode: 0o700 });
        mkdirSync(join(root, "config", "kitespan"), { mode: 0o700 });
        writeFileSync(join(root, "config", "kitespan", BROWSER_FILE), `${JSON.stringify({ v: 1, port: CDP_PORT, loopbackOnly: true })}\n`, { mode: 0o600 });
        server = await LiveServer.boot(env, { root });
        const S = server;
        page = (await hello(S, "browser-live")).page;
        project = await S.addProject(env.project);
        site = startSite({ key, word: theWord, note, noteName });
        const before = await browserReply(S);
        profile = before.profile;
        expect(before.host.state).toBe("off");
        expect(before.problem, "kitespan refused the test's browser.json").toBeNull();
        expect(before.port).toEqual({ value: CDP_PORT, from: "config" });
        expect(profile.startsWith(`${S.root}/`), "the browser's profile is not in the temporary state folder").toBe(true);
        // A last look, just before the start: kitespan never adopts a browser it did not start, and the test never lets one stand in.
        expect(portTaken(CDP_PORT), `something took port ${CDP_PORT} after the preflight`).toBe(false);
        const t0 = performance.now();
        const r = await pagePost(S, "/api/browser/start", {});
        startPosted = true;
        expect(r.status).toBe(200);
        const host = await waitHost(S, (s) => s !== "starting" && s !== "stopping", 60_000);
        const after = await browserReply(S);
        const rec = hostRecord();
        const listeners = listenRows(systemProc, CDP_PORT);
        const held = rec !== null && heldBy(rec);
        const named = rec !== null && namesOurs(rec);
        log.line({ step: "start", state: host.state, how: host.how ?? null, version: host.version ?? null, from: after.program.from, ms: Math.round(performance.now() - t0), pid: rec?.pid ?? null, listeners: listeners.length, held, named });
        expect(host.state, `the browser did not start: ${host.state}${host.reason ? ` (${host.reason})` : ""}`).toBe("running");
        expect(host.how, "kitespan adopted a browser instead of starting its own").toBe("started");
        expect(host.port).toBe(CDP_PORT);
        expect(rec, "kitespan wrote no host.json for its browser").not.toBeNull();
        expect(held, `the listener on ${CDP_PORT} is not the Chrome that kitespan started`).toBe(true);
        expect(named, "the Chrome that kitespan started does not name the test's profile and port").toBe(true);
        first = { pid: rec!.pid, start: rec!.start };
        running = true;

        viewer = await Viewer.open(S);
        const opened = await viewer.opened();
        shown = viewer.tabs.find((t) => !t.hidden)?.id ?? null;
        const firstFrame = await until(() => viewer!.casts.some((c) => c.tab === shown), 10_000, "a frame of the shown tab").then(
          () => true,
          () => false,
        );
        log.line({ step: "viewer", state: opened.host.state, tabs: opened.tabs.length, viewed: viewer.viewed.size, firstFrame });
        expect(opened.host.state).toBe("running");
        expect(shown, "the pane's socket lists no tab after Start").not.toBeNull();
      },
      120_000,
    );

    test(
      "A: Claude opens the word page in the tab that the pane showed after Start, clicks its button and says the word; its calls are mcp__playwright__ calls; Claude is acting lit and went out; the page's script fetched the word; the pane got frames of that document after the click",
      async () => {
        need(server && page && viewer && site && running, "the browser's start");
        const [V, W] = [viewer, site];
        const url = `${W.base}/a?k=${key}`;
        const run = await runCase("A", "Claude clicks a button in the pane's tab and says the word", PROMPT.A(url));
        try {
          const connector = await playwrightRow(run.chat);
          const out = await until(() => V.acting.every((a) => a.chat !== run.chat), 10_000, "Claude is acting to go out").then(
            () => true,
            () => false,
          );
          const tab = V.tabWith(url, run.t0);
          const words = W.hits.filter((h) => h.path === "/word" && h.own && h.at >= run.t0);
          // The page script's fetch. A navigation straight to /word (the key is in the URL that Claude got) is mode
          // navigate, dest document; Claude's browser_evaluate, which could fetch too, is denied.
          const click = words.find((h) => h.mode === "cors" && h.dest === "empty" && h.site === "same-origin");
          const load = click ? W.hits.filter((h) => h.path === "/a" && h.own && h.at >= run.t0 && h.at <= click.at).at(-1) : undefined;
          // The document that the click ran in: the nav of the tab's last frame between the page's load and the click.
          const navA = tab && click && load ? (V.casts.filter((c) => c.tab === tab && c.at > load.at && c.at < click.at).at(-1)?.nav ?? null) : null;
          const sameDoc = (c: Cast) => click !== undefined && c.tab === tab && c.at > click.at && c.nav === navA;
          if (navA !== null) await until(() => V.casts.some(sameDoc), 10_000, "a frame of the same document after the click").catch(() => {});
          const afterClick = navA !== null ? V.casts.filter(sameDoc).length : 0;
          const lit = V.actingOf(run.chat, run.t0);
          const tools = browserTools(run);
          const said = run.reply.toUpperCase().includes(theWord);
          const how = howShown(V, tab, run.t0);
          if (tab) factsA = { tab, clickTab: lit.find((a) => a.tool === "browser_click")?.tab, marked: (await markOf(run, tab)).own };
          log.line({
            step: "A",
            tools: tools.join(","),
            said,
            wordRequests: words.map((h) => `${h.mode ?? "-"}/${h.dest ?? "-"}`).join(","),
            fetched: click !== undefined,
            lit: [...new Set(lit.map((a) => a.tool))].join(","),
            out,
            tab,
            how,
            sameAsShown: tab !== null && tab === shown,
            viewed: tab !== null && V.viewed.has(tab),
            navA,
            framesAfterClick: afterClick,
            connector: connector ? `${connector.status}/${connector.scope ?? "?"}/${connector.tools}` : null,
          });
          expect(run.ok, `the turn ended with ${run.subtype}`).toBe(true);
          expect(run.model, "Claude Code did not run KITESPAN_LIVE_MODEL").toBe(env.model);
          expect(tools.length, `the chat made no mcp__playwright__ call (Claude Code's playwright server: ${connector?.status ?? "not listed"})`).toBeGreaterThan(0);
          expect(tools).toContain("browser_navigate");
          expect(tools).toContain("browser_click");
          expect(click, "the page server saw no fetch from the page's script (Sec-Fetch-Mode cors, Dest empty): the button's click did not run in the page").toBeDefined();
          expect(said, "the reply does not hold the word that the click showed").toBe(true);
          expect(lit.length, "Claude is acting never lit for this chat").toBeGreaterThan(0);
          expect(out, "Claude is acting did not go out after the turn").toBe(true);
          expect(tab, "no tab in the pane's list showed the word page: Claude's tab is not one that the pane lists").not.toBeNull();
          expect(how, "Claude's MCP acted in another tab than the one that the pane showed after Start, and the server did not tell the pane's socket to follow it there (the spare's safety net)").not.toBeNull();
          expect(V.viewed.has(tab!), "the pane's socket did not view Claude's tab").toBe(true);
          expect(navA, "the pane's socket got no frame of Claude's tab between the word page's load and the click").not.toBeNull();
          expect(afterClick, "the pane's socket got no frame of Claude's tab after the click, of the document that the click ran in").toBeGreaterThan(0);
        } finally {
          await endChat("A", run.chat, run.mcp);
        }
      },
      T_CASE,
    );

    test("A2: the chip and the mark on real calls: the click's acting entry names Claude's tab, and the tab list marks that tab as the chat's", () => {
      need(factsA, "A's tab");
      log.line({ step: "A2", clickTab: factsA.clickTab === factsA.tab ? "the tab" : (factsA.clickTab ?? null), marked: factsA.marked });
      expect(factsA.clickTab, "the browser_click entry of Claude is acting did not name the tab (the chip's In this tab form)").toBe(factsA.tab);
      expect(factsA.marked, "no tab list marked Claude's tab as the chat's (claudeLast)").toBe(true);
    });

    test(
      "B: Claude's click starts a download: kitespan's downloads list holds it with its name and size, and the file is in kitespan's downloads folder with mode 0600 and the page server's bytes",
      async () => {
        need(server && page && viewer && site && running, "the browser's start");
        const [S, V, W] = [server, viewer, site];
        const url = `${W.base}/b?k=${key}`;
        const run = await runCase("B", "Claude's click starts a download", PROMPT.B(url));
        try {
          const tab = V.tabWith(url, run.t0);
          if (tab) marks.push(await markOf(run, tab));
          const row = await poll<BrowserDownloadView>(async () => {
            const list = ((await (await pageGet(S, "/api/browser/downloads")).json()) as BrowserDownloadsReply).downloads;
            return list.find((d) => d.name === noteName && d.state !== "progress");
          }, 30_000);
          const folder = join(S.stateDir, "browser", "downloads");
          const records = (readJsonFile(join(S.stateDir, "browser", DOWNLOADS_FILE)) as { downloads?: { id?: unknown; guid?: unknown }[] } | null)?.downloads ?? [];
          const guid = row ? records.find((d) => d.id === row.id)?.guid : undefined;
          const file = typeof guid === "string" && /^[0-9a-f-]{36}$/.test(guid) ? join(folder, guid) : null;
          const st = file ? lstatSync(file, { throwIfNoEntry: false }) : undefined;
          const bytesOk = !!file && !!st?.isFile() && readFileSync(file).equals(Buffer.from(note));
          const folderMode = (lstatSync(folder, { throwIfNoEntry: false })?.mode ?? 0) & 0o777;
          const via = row ? await pageGet(S, `/api/browser/downloads/${row.id}/file`).catch(() => null) : null;
          const viaOk = via?.ok ? Buffer.from(await via.arrayBuffer()).equals(Buffer.from(note)) : false;
          const frame = V.frames.some((x) => x.at >= run.t0 && x.f.t === "download" && x.f.name === noteName && x.f.state === "completed");
          const served = W.hits.some((h) => h.path === "/note" && h.own && h.at >= run.t0);
          const tools = browserTools(run);
          log.line({
            step: "B",
            tools: tools.join(","),
            tab,
            how: howShown(V, tab, 0),
            sameAsShown: tab !== null && tab === shown,
            served,
            listed: row !== null,
            state: row?.state ?? null,
            size: row?.total ?? null,
            file: !!st?.isFile(),
            mode: st ? (st.mode & 0o777).toString(8) : null,
            folderMode: folderMode.toString(8),
            bytesOk,
            via: via?.status ?? null,
            viaOk,
            frame,
          });
          expect(run.ok, `the turn ended with ${run.subtype}`).toBe(true);
          expect(run.model, "Claude Code did not run KITESPAN_LIVE_MODEL").toBe(env.model);
          expect(tools).toContain("browser_click");
          expect(served, "the page server sent no file: Claude's click did not start the download").toBe(true);
          expect(row, "kitespan's downloads list does not hold the note").not.toBeNull();
          expect(row, "the download did not complete in kitespan's folder (another client's download path?)").toMatchObject({ name: noteName, state: "completed", received: note.length, total: note.length });
          expect(file, "downloads.json names no file for the download").not.toBeNull();
          expect(st?.isFile(), "the file is not in kitespan's downloads folder").toBe(true);
          expect(st!.mode & 0o777).toBe(0o600);
          expect(st!.size).toBe(note.length);
          expect(bytesOk, "the file's bytes are not the ones the page server sent").toBe(true);
          expect(folderMode).toBe(0o700);
          expect(via?.status).toBe(200);
          expect(viaOk, "the download route gave other bytes").toBe(true);
          expect(frame, "the pane's socket got no download frame for it").toBe(true);
        } finally {
          await endChat("B", run.chat, run.mcp);
        }
      },
      T_CASE,
    );

    test(
      "C: Claude calls browser_resize: the tab's size shows 900 x 700, set by Claude, and still does 12 s later",
      async () => {
        need(server && page && viewer && site && running, "the browser's start");
        const [V, W] = [viewer, site];
        const url = `${W.base}/c?k=${key}`;
        const run = await runCase("C", "Claude sets the tab's size with browser_resize", PROMPT.C(url));
        try {
          const call = run.calls.find((c) => c.name === `${BROWSER_TOOL_PREFIX}browser_resize`);
          const input = (call?.input ?? {}) as { width?: unknown; height?: unknown };
          const result = call ? run.results.get(call.id) : undefined;
          const tab = V.tabWith(url, run.t0);
          if (tab) marks.push(await markOf(run, tab));
          const byClaude = (v: BrowserTabView) => v.size.kind === "other" && v.size.w === RESIZE.w && v.size.h === RESIZE.h && v.size.by === "claude";
          if (tab) await until(() => V.views(tab, run.t0).some((x) => byClaude(x.view)), 20_000, "the size set by Claude").catch(() => {});
          const seen = tab ? (V.views(tab, run.t0).find((x) => byClaude(x.view)) ?? null) : null;
          const atSize = tab ? V.casts.filter((c) => c.tab === tab && c.at >= run.t0 && c.dw === RESIZE.w && c.dh === RESIZE.h).length : 0;
          // What the size shows 12 s after "set by Claude" first showed, while the page's counter keeps frames coming,
          // and every tab list in between: still set by Claude.
          if (seen) await Bun.sleep(Math.max(0, seen.at + SIZE_KEPT_MS - Date.now()));
          const later = tab ? (V.tabs.find((t) => t.id === tab)?.size ?? null) : null;
          const laterAt = Date.now();
          const since = tab ? V.views(tab, run.t0) : [];
          const first = since.findIndex((x) => byClaude(x.view));
          const flips = first >= 0 ? since.slice(first).filter((x) => !byClaude(x.view)).length : null;
          const forms = tab ? V.views(tab, run.t0).map((x) => `${x.view.size.kind}:${x.view.size.by}`).filter((s, i, a) => i === 0 || a[i - 1] !== s) : [];
          log.line({
            step: "C",
            tools: browserTools(run).join(","),
            resize: call !== undefined,
            width: typeof input.width === "number" ? input.width : null,
            height: typeof input.height === "number" ? input.height : null,
            resultError: result?.isError ?? null,
            tab,
            how: howShown(V, tab, 0),
            sameAsShown: tab !== null && tab === shown,
            framesAtSize: atSize,
            setByClaude: seen !== null,
            later: later ? `${later.kind}:${later.w}x${later.h}:${later.by}` : null,
            laterMs: seen ? laterAt - seen.at : null,
            flips,
            forms: forms.join(">"),
          });
          expect(run.ok, `the turn ended with ${run.subtype}`).toBe(true);
          expect(run.model, "Claude Code did not run KITESPAN_LIVE_MODEL").toBe(env.model);
          expect(call, "Claude made no browser_resize call").toBeDefined();
          expect([input.width, input.height]).toEqual([RESIZE.w, RESIZE.h]);
          expect(result?.isError, "browser_resize gave an error").toBe(false);
          expect(tab, "no tab in the pane's list showed the size page").not.toBeNull();
          expect(atSize, `no frame of Claude's tab came at ${RESIZE.w} x ${RESIZE.h}`).toBeGreaterThan(0);
          expect(seen, `the tab's size never showed as ${RESIZE.w} x ${RESIZE.h} set by Claude`).not.toBeNull();
          expect(later, `${SIZE_KEPT_MS / 1000} s after the size showed set by Claude, it shows ${later ? `${later.kind} ${later.w} x ${later.h} by ${later.by}` : "no size"}`).toEqual({ kind: "other", w: RESIZE.w, h: RESIZE.h, by: "claude" });
          expect(flips, "after the size showed set by Claude, a tab list showed it otherwise").toBe(0);
        } finally {
          await endChat("C", run.chat, run.mcp);
        }
      },
      T_CASE,
    );

    test(
      "D: Claude's click on a file field: the pane's socket gets the file chooser frame, which says it is Claude's, and the card that the page draws for it says so",
      async () => {
        need(server && page && viewer && site && running, "the browser's start");
        const [V, W] = [viewer, site];
        const url = `${W.base}/d?k=${key}`;
        const run = await runCase("D", "Claude opens a file field", PROMPT.D(url));
        try {
          const tab = V.tabWith(url, run.t0);
          if (tab) marks.push(await markOf(run, tab));
          const isChooser = (x: Seen) => x.at >= run.t0 && x.f.t === "chooser" && x.f.tab === tab;
          if (tab) await until(() => V.frames.some(isChooser), 10_000, "the chooser frame").catch(() => {});
          const i = tab ? V.frames.findIndex(isChooser) : -1;
          const chooser = i >= 0 ? (V.frames[i]!.f as ChooserFrame) : null;
          // The server marks the chooser Claude's when it opens while a browser call of a kitespan chat runs on that
          // tab or on an unknown one (relay.ts chooserOpened), and the page draws the frame's `by` as it came, so the
          // card's title stays when the click's result clears the acting list. The acting list when the frame came
          // shows the call that the server's rule saw.
          const calls = i >= 0 ? V.actingBefore(i).filter((a) => a.chat === run.chat && (a.tab === tab || a.tab === null)) : [];
          const title = chooser ? fileTitle(chooser) : null;
          const plain = chooser ? filePlain(chooser) : null;
          const closed = V.frames.find((x) => x.at >= run.t0 && x.f.t === "chooser_closed" && x.f.tab === tab)?.f;
          const tools = browserTools(run);
          log.line({
            step: "D",
            tools: tools.join(","),
            tab,
            how: howShown(V, tab, 0),
            sameAsShown: tab !== null && tab === shown,
            chooser: chooser !== null,
            by: chooser?.by ?? null,
            cardClaude: chooser ? fileIsClaudes(chooser) : null,
            cardTitle: title === null ? null : title === CLAUDE_FILE_TITLE,
            cardPlain: plain,
            actingThen: calls.map((a) => a.tool).join(","),
            host: chooser ? chooser.host === `127.0.0.1:${W.port}` : null,
            label: chooser ? chooser.label === "Notes file" : null,
            uploads: run.calls.filter((c) => c.name === UPLOAD_TOOL).length,
            closedBy: closed?.t === "chooser_closed" ? closed.by : null,
          });
          expect(run.ok, `the turn ended with ${run.subtype}`).toBe(true);
          expect(run.model, "Claude Code did not run KITESPAN_LIVE_MODEL").toBe(env.model);
          expect(tools).toContain("browser_click");
          expect(tab, "no tab in the pane's list showed the file page").not.toBeNull();
          expect(chooser, "the pane's socket got no file chooser frame for Claude's tab").not.toBeNull();
          expect(chooser!.by, "the chooser frame does not say that the chooser is Claude's").toBe("claude");
          expect(fileIsClaudes(chooser!), "the card that the page draws for that chooser frame is not Claude's").toBe(true);
          expect(title, "the card that the page draws for that chooser frame is not titled as Claude's").toBe(CLAUDE_FILE_TITLE);
          expect(plain, "the card's plain button (and Esc) for that chooser frame is not Leave it to Claude").toBe("Leave it to Claude");
          expect(calls.length, "no browser call of this chat ran on that tab when the chooser came").toBeGreaterThan(0);
          expect(chooser!.host).toBe(`127.0.0.1:${W.port}`);
        } finally {
          await endChat("D", run.chat, run.mcp);
        }
      },
      T_CASE,
    );

    test("D2: the tab mark follows the newest chat: in B, C and D the tab list marks Claude's tab as that case's chat, and once it did, never as another chat", () => {
      need(marks.length > 0, "B, C or D's tab");
      log.line({ step: "D2", marks: marks.map((m) => `${m.tag}:${m.own ? "own" : "not own"}:${m.named.join(">") || "none"}`).join(",") });
      for (const m of marks) {
        expect(m.own, `in ${m.tag}, no tab list marked Claude's tab as ${m.tag}'s chat (claudeLast named ${m.named.join(", ") || "no chat"}): the mark names an older chat`).toBe(true);
        expect(m.after, `in ${m.tag}, after the tab list marked Claude's tab as ${m.tag}'s chat, it named another chat`).toEqual([]);
      }
    });

    test(
      "Z: the end: Delete for each chat, Stop browser through the route, the server stopped by its pid with its temporary folder; kitespan's Chrome and the Playwright servers are gone and nothing listens on port 9340",
      async () => {
        need(server, "the boot");
        const t = await teardown();
        log.line({ step: "Z", ...t, mcpOutlived: mcpOutlived.map((x) => `${x.tag}:${x.n}`).join(",") || "none" });
        expect(t.deleted, "a Delete of a chat that the test made did not pass (its transcript, if left, went by its session's file)").toBe(t.chats);
        if (startPosted) {
          expect(t.stop, "POST /api/browser/stop did not answer 200").toBe(200);
          expect(t.host, "the browser is not off after Stop browser").toBe("off");
          expect(t.hostFile, "host.json is still there after Stop browser").toBe(false);
        }
        expect(t.outlived, "kitespan's browser still ran after Stop browser and the server's stop").toBe(false);
        expect(t.rootLeft, "the temporary folder is still there").toBe(false);
        expect(mcpOutlived, `a chat's Playwright server still ran ${MCP_END_MS / 1000} s after the chat's archive (the test ended it by its pid)`).toEqual([]);
        expect(t.playwrightLeft, "a Playwright server process that a claude of the test's started still ran at the end (the test ended it by its pid)").toBe(0);
        expect(t.listeners, `something still listens on port ${CDP_PORT}`).toBe(0);
        expect(t.free, `port ${CDP_PORT} on 127.0.0.1 is not free`).toBe(true);
      },
      180_000,
    );
  });
});
