// kitespan's server (DESIGN.md 4.1, 4.9, 4.10): one Bun process, bound to 127.0.0.1 only.
//
// Boot, in order: the start environment check (bin/kitespan cleaned it; names only are printed), the options, the
// one-time move of the old name's folders (a start from the terminal only, never a restart's successor or `--check`:
// store/move.ts), the store's folder and mode checks and the registry rebuilt from the ledgers with every chat
// asleep, the counts-only logger, the adapters (a bad adapters.json gives the public defaults and one line), the
// guards, the page, the JSON API and both sockets, then Bun.serve. SIGTERM and SIGINT stop new turns, close every
// chat's Claude Code (about 8 s at most), end every Terminal pane's shell, say `bye` to every page and exit; a second
// signal exits at once. A restart (POST /api/restart) drains and closes the same way, starts its successor, releases
// the port and exits once the successor answers on it; else it listens on the port again (chats/drain.ts).
//
// Usage: bin/kitespan [dev] [--port <port>] [--origin <origin>]... [--dist <build folder>]   (Bun must run with
// --no-env-file). `--origin` allows one more exact origin (a forward's) until kitespan stops, a restart's successor
// too, as adapters.json's access.origins does, and is never written anywhere (the successor's lines in
// logs/server-out.log count the flag's origins, never name them); `--help` prints the usage, and `--version` prints
// `kitespan <package.json's version>` (DESIGN-I1 1.4), each before the start environment's check.
//
// How kitespan was installed (DESIGN-I1 3; server/update/kind.ts): a git checkout updates from origin; a release that
// install.sh installed updates by running its own install.sh and restarts into the version that the data folder's
// `current` names; a Homebrew install never checks and never updates itself (`brew upgrade kitespan`).
//
// Two options are the restart's own (4.10): `--bind-wait <seconds>` (a successor retries the bind while the old
// server still holds the port) and `--check` (the preflight: the options, the start environment and every module,
// then the state folder read only and the page; it binds nothing and exits 0 when a start could go on).

// First, before any module that may write to process.env (the SDK does when it loads): the start environment's copy.
import { START_ENV } from "./start-env-copy";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readEnv } from "../shared/legacy";
import { WIRE, type ChatEvent } from "../shared/protocol";
import { APP_EXACT_PATHS, APP_PATH_PREFIXES } from "../shared/route";
import { accessHint, ADAPTER_LIMITS, ADAPTERS_FILE, allowedOrigins, originFlagProblem, readAdapters } from "./adapters/adapters";
import { startEnvProblems } from "./adapters/start-env";
import { runBash } from "./agents/claude/bash";
import { createClaudeDriver } from "./agents/claude/driver";
import { createEnvStore } from "./env/store";
import { Restart } from "./chats/drain";
import { Environments } from "./chats/environments";
import { ChatRegistry } from "./chats/registry";
import { Cached, findRepos, RepoCache, suggestedFolders, SUGGEST_LIMITS } from "./folders/suggest";
import { createGate } from "./gate/guards";
import { Downloads } from "./browser/downloads";
import { PeerCheck } from "./browser/guard";
import { BrowserHost } from "./browser/host";
import { Relay } from "./browser/relay";
import { browserSocketRoute } from "./browser/socket";
import { TabsFileStore } from "./browser/tabs";
import { ChangesBook } from "./changes/book";
import { ChangesStore } from "./changes/store";
import { createApi } from "./http/api";
import { MessageIndex } from "./search/messages";
import { createApp, HTTP_LOG_ROUTES, plainSocketRoute } from "./http/app";
import { listenWithWait } from "./http/listen";
import { loadSite } from "./http/static";
import { buildWorker } from "./http/worker";
import { createPush } from "./push/service";
import { pushTestOrigin } from "./push/store";
import { createLogger, type Logger, type LogEvent, type LogFields } from "./log";
import { machineName } from "./machine";
import { createShellService, type ShellChat } from "./shell";
import { ownUid, StoreError } from "./store/files";
import { holdFolder, moveOldFolders } from "./store/move";
import { createStore, storeDirs } from "./store/store";
import { ReleasedSessions } from "./store/released";
import type { ChatLedger, Store } from "./store/types";
import { prepareUploadFolder, type UploadFolderResult } from "./store/uploads";
import { claudeLines } from "./update/drift";
import { brewSource } from "./update/brew";
import { gitOptions } from "./update/git";
import { createUpdateJobs } from "./update/job";
import { installKind, nextRoot, versionAt } from "./update/kind";
import { versionsLockHeld } from "./update/lock";
import { releaseChecker, releaseSource } from "./update/release";
import { readHealth } from "./update/loopback";
import { noticeSender, standingUpdateNotice, updateNotice } from "./update/notice";
import { checkStart, preflight } from "./update/preflight";
import { gitCheckoutSource } from "./update/source";
import { OUT_LOG, spawnSuccessor } from "./update/successor";
import { createUpdates, UPDATE_NOTICE_ID } from "./update/updates";
import type { UpdateReply } from "./http/api-types";
import { terminalConfigRoot } from "./worktree/host";
import { wsHandlers } from "./ws/handlers";

// A standard output or error that closed (a terminal that went, a pipe whose reader ended) never ends the server: a
// write to it fails with an `error` event, which would otherwise be an uncaught error (4.10).
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_PORT = 7940;

const say = (line: string) => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`kitespan: ${line}\n`);
function refuse(lines: readonly string[], code = 1): never {
  for (const l of lines) complain(l);
  process.exit(code);
}

// ---------------------------------------------------------------------------------------------------------------
// The help, the start environment and the options

const HELP = `Usage: bin/kitespan [dev] [options]
       bin/kitespan restart [--now] [--port <port>]

  --port <port>        listen on 127.0.0.1:<port> (default ${DEFAULT_PORT})
  --origin <origin>    also allow pages from this exact origin until kitespan stops (a restart
                       keeps it); repeatable, for example https://box.tail1234.ts.net
  --dist <folder>      serve the page from this build folder
  --version            print kitespan's version
  --help               print this help`;
const USAGE = "Usage: bin/kitespan [dev] [--port <port>] [--origin <origin>]... [--dist <build folder>] (bin/kitespan --help)";
/** The options that take a value. */
const VALUE_OPTIONS = new Set(["--port", "--dist", "--bind-wait", "--origin"]);

/** `--help` or `-h` anywhere among the options (never as an option's value). */
function wantsHelp(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return true;
    if (VALUE_OPTIONS.has(a)) i++;
  }
  return false;
}

/** `--version` anywhere among the options (never as an option's value). */
function wantsVersion(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--version") return true;
    if (VALUE_OPTIONS.has(a)) i++;
  }
  return false;
}

function ownVersion(): string {
  try {
    const v = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))?.version;
    return typeof v === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : "0.1.0";
  } catch {
    return "0.1.0";
  }
}
const version = ownVersion();

// The help and the version first: they need no clean start environment, and they start nothing.
if (wantsHelp(process.argv.slice(2))) {
  say(HELP);
  process.exit(0);
}
if (wantsVersion(process.argv.slice(2))) {
  say(`kitespan ${version}`);
  process.exit(0);
}

const envProblems = startEnvProblems(process.env, process.execArgv);
if (envProblems.length) refuse(envProblems);

interface Args {
  port: number;
  dev: boolean;
  dist: string;
  /** Seconds to retry the bind while the port is in use (a restart's successor); 0: a busy port ends the start. */
  bindWait: number;
  /** `--bind-wait` was given: a restart's successor, which never moves a folder. */
  successor: boolean;
  check: boolean;
  /**
   * `--origin`'s exact origins, each once, until kitespan stops (a restart's successor gets them too): never written
   * anywhere (row 104's lead note).
   */
  origins: string[];
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { port: DEFAULT_PORT, dev: false, dist: join(ROOT, "dist", "web"), bindWait: 0, successor: false, check: false, origins: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dev") args.dev = true;
    else if (a === "--check") args.check = true;
    else if (VALUE_OPTIONS.has(a)) {
      const v = argv[++i];
      if (v === undefined) return `${a} needs a value`;
      if (a === "--origin") {
        // The access adapter's own rule, and as many as adapters.json takes; a value given twice counts once.
        const problem = originFlagProblem(v);
        if (problem) return problem;
        if (!args.origins.includes(v)) {
          if (args.origins.length >= ADAPTER_LIMITS.origins) return `--origin is given more than ${ADAPTER_LIMITS.origins} times`;
          args.origins.push(v);
        }
      } else if (a === "--port") {
        if (!/^[0-9]{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) return "--port takes a number from 1 to 65535";
        args.port = Number(v);
      } else if (a === "--bind-wait") {
        if (!/^[0-9]{1,2}$/.test(v) || Number(v) > 60) return "--bind-wait takes a number of seconds from 0 to 60";
        args.bindWait = Number(v);
        args.successor = true;
      } else args.dist = isAbsolute(v) ? v : resolve(v);
    } else return `unknown option ${a}`;
  }
  return args;
}

const parsed = parseArgs(process.argv.slice(2));
if (typeof parsed === "string") refuse([parsed, USAGE], 2);
const { port, dev, dist, bindWait } = parsed;

// The restart's preflight: every module is loaded by now (the imports above); the state folder and the page are
// checked, and nothing is bound or written.
if (parsed.check) {
  const problems = await checkStart({ root: ROOT, dist, dev, state: storeDirs(process.env, homedir()).state });
  if (problems.length) refuse(problems);
  process.exit(0);
}

// The one-time move of the old name's folders (iteration 6, round K1): at a start from the terminal only. A restart's
// successor never moves: its predecessor, maybe a build of the old name, goes on writing the old folders after a failed
// health gate. A folder that did not move is used where it is (store/places.ts). Nothing moves while anything listens
// on this start's port: that start ends at the bind.
if (!parsed.successor) {
  const moved = await moveOldFolders({ env: START_ENV, home: homedir(), port, say, complain });
  if (moved.refuse) refuse([moved.refuse]);
}

// ---------------------------------------------------------------------------------------------------------------
// The store, the driver and the registry

// The logger needs the checked logs/ folder, which the store's open makes; until then a line has nowhere to go.
let logger: Logger | null = null;
const log: Logger = {
  log: (ev: LogEvent, fields?: LogFields) => logger?.log(ev, fields),
  sweep: () => logger?.sweep() ?? 0,
  close: () => logger?.close(),
  get failures() {
    return logger?.failures ?? 0;
  },
};

// A file set aside as .bad, and a write that no caller waits for and that failed, are error lines: the code only.
const store = createStore({
  onSetAside: () => log.log("error", { err: "bad_record" }),
  onError: () => log.log("error", { err: "store_write" }),
});
const dirs = store.dirs;
// D60: the environments' variables, under the state folder's env/ (read once the store has checked the folder).
const envStore = createEnvStore({ dir: dirs.env });

// The driver asks for these synchronously at every chat start, so the server keeps them current.
let knownFolders: string[] = [];
let allowBypass = false;
async function refreshFolders(): Promise<void> {
  knownFolders = (await store.listProjects()).map((p) => p.cwd);
  allowBypass = (await store.readSettings())["chats.allowBypass"];
}

const driver = createClaudeDriver({
  knownFolders: () => knownFolders,
  allowBypass: () => allowBypass,
  writeLastOptions: (rec) => store.writeLastOptions(rec),
});

// Row 99: the sessions that an environment's Remove released, so the folder added again lists them; a Continue of one
// makes it a chat's again.
const released = new ReleasedSessions({ dir: dirs.state, uid: ownUid(), onSetAside: () => log.log("error", { err: "bad_record" }) });

// R130: notifications (server/push/): the key and the devices in the state folder, the sender, and the notify rule's
// marks. A push is a plain fetch with the server's own environment, so the user's proxy variables apply to it; nothing
// is sent until a device turns notifications on. KITESPAN_PUSH_TEST_ORIGIN names a test's stub push service on
// 127.0.0.1 (the click-through's notify flow); any other value names none. Its old name is read for one release, with
// one line that names it (shared/legacy.ts).
const push = createPush({
  dir: dirs.state,
  uid: ownUid(),
  testOrigin: pushTestOrigin(readEnv(START_ENV, "KITESPAN_PUSH_TEST_ORIGIN", complain)),
  onSetAside: () => log.log("error", { err: "bad_record" }),
  log: {
    push: (f) => log.log("push", f),
    gone: (f) => log.log("push_gone", f),
    device: (answer) => log.log("push_device", { answer }),
  },
});

// U5: the message search over every chat's messages (server/search/messages.ts), in memory only. It reads the chats
// through the seam: the lite read (sessionInfo's size and time) and the transcript's events.
const messageIndex = new MessageIndex({
  chats: () => registry.searchChats(),
  stamp: async (sessionId, dir) => {
    const info = await driver.sessionInfo(sessionId, dir);
    return info ? { size: info.fileSize ?? -1, mtime: info.lastModified } : null;
  },
  events: (sessionId, dir) => driver.transcriptEvents(sessionId, dir),
  log,
});

// U1: each turn's changes: the git marks of the chat's folder at the turn's start and end, the summaries and their
// cards, under the state folder's changes/ (server/changes/), with kitespan's own git and the start environment.
const changes = new ChangesBook({
  store: new ChangesStore(dirs.changes, ownUid(), () => log.log("error", { err: "bad_record" })),
  log: (f) => log.log("changes", f),
});
// What a mark that a crash or a kill cut left in a chat's mark folder (its private index, git's lock) goes now.
await changes.sweep();

/** Iteration 7: the browser pane's "Claude is acting" and tab mark (server/browser/acting.ts), bound with the relay. */
let browserTool: (chat: string, e: ChatEvent) => void = () => {};
let browserEnded: (chat: string) => void = () => {};

const registry = new ChatRegistry({
  driver,
  store,
  changes,
  tools: (chat, e) => browserTool(chat, e),
  chatEnded: (chat) => browserEnded(chat),
  transcriptChanged: (chat) => messageIndex.touch(chat),
  // The registry's signal ends a `!` command's whole process group early (Delete, Archive, a shutdown); `env` is the
  // live chat's start set of its environment's variables (D60).
  bash: { run: ({ command, cwd, signal, env }) => runBash(command, { cwd, signal, vars: env }) },
  env: envStore,
  log,
  continued: (sessionId) => void released.unrelease([sessionId]).catch(() => log.log("error", { err: "store_write" })),
  releasedFolder: (cwd, sessionId) => released.folderOf(cwd, sessionId),
  push: push.hooks,
});

let setAside: readonly string[] = [];
try {
  setAside = (await registry.boot()).setAside;
  setAside = [...setAside, ...(await envStore.open()).setAside];
  if (setAside.length) complain(`set aside ${setAside.length} file(s) that failed their checks: ${setAside.join(", ")}`);
} catch (e) {
  if (e instanceof StoreError && e.problems?.length) {
    refuse([
      `the state folder ${dirs.state} failed its checks, so kitespan does not start:`,
      ...e.problems.map((p) => `  ${p.path}: ${p.why}`),
      "Folders must be 0700 and files 0600, owned by you, and not symbolic links.",
    ]);
  }
  refuse([`the state folder ${dirs.state} could not be opened (${e instanceof StoreError ? e.code : "error"})`]);
}
// From here to the exit the state folder is open, so another start's folder move sees this server (store/move.ts).
holdFolder(dirs.state);
logger = createLogger({ dir: dirs.logs, routes: HTTP_LOG_ROUTES });
// The files that open() set aside, counted now that the log can take a line.
for (let i = 0; i < setAside.length; i++) log.log("error", { err: "bad_record" });
try {
  await released.open();
} catch {
  refuse([`the state folder ${dirs.state} could not be opened (released sessions)`]);
}
await refreshFolders();

// About's update lines (4.10): the running server's HEAD now, origin's line on the schedule of Check for updates (row
// 108), with kitespan's own git reads (the start environment, scrubbed: server/update/git.ts).
const git = gitOptions(START_ENV);
// DESIGN-I1 3.1: how this kitespan was installed, from its root's real path; the next start's root is read again at
// each look (an update or `brew upgrade` moves it).
const install = installKind(
  (() => {
    try {
      return realpathSync(ROOT);
    } catch {
      return ROOT;
    }
  })(),
  versionAt(ROOT),
);
const releaseCheck = install.kind === "release" ? releaseChecker({ install, env: START_ENV }) : null;
const updates = await createUpdates({
  root: install.kind === "checkout" ? ROOT : install.root,
  dist,
  dev,
  git,
  log,
  state: dirs.state,
  setting: async () => (await store.readSettings())["updates.check"],
  kind: install.kind,
  ...(install.kind === "checkout" ? {} : { next: () => nextRoot(install) }),
  ...(releaseCheck ? { checkOnce: () => releaseCheck.check(), release: releaseCheck } : {}),
});
// Row 108: the Update button's job on this checkout (server/update/source.ts), one at a time; never while a restart is
// asked (from its preflight to its drain's answer: `restartAsks`), drains or closes. When it ends, origin is checked
// again. A release install runs its own install.sh (release.ts); a Homebrew install refuses (brew.ts).
let restartAsks = 0;
const updateJobs = createUpdateJobs({
  source:
    install.kind === "release"
      ? releaseSource({ install, dist, dev, env: START_ENV, checker: releaseCheck! })
      : install.kind === "brew"
        ? brewSource({ dev })
        : gitCheckoutSource({ root: ROOT, dist, dev, git, env: START_ENV }),
  state: dirs.state,
  logs: dirs.logs,
  restarting: () => restartAsks > 0 || restarter.active,
  applied: () => updates.fastForwarded(),
  ended: () => void updates.check(),
  // A `curl | sh` or an `sh install.sh` holds install.sh's own lock: the restart waits for it too.
  ...(install.kind === "release" ? { held: () => versionsLockHeld(install.versions) } : {}),
  log,
});
async function updateFacts(): Promise<UpdateReply> {
  const f = await updates.facts();
  const last = updates.last;
  return { ...f, check: { at: last?.at ?? null, ok: last?.ok ?? true, why: last?.why ?? null, running: updates.checking }, job: updateJobs.view(), can: !dev && install.kind !== "brew" };
}
/** The root that the restart's successor runs: the one that its preflight checked (an install's next start). */
let successorRoot = ROOT;

// ---------------------------------------------------------------------------------------------------------------
// The guards, the page, the API and the sockets

const adapters = readAdapters(join(dirs.config, ADAPTERS_FILE));
// The origins beyond kitespan's own: `--origin`'s, then adapters.json's (a bad file gives none of its own,
// and the flag's still apply). The guards take them as they take the file's.
const allowed = allowedOrigins(port, parsed.origins, adapters.origins);
const gate = createGate(port, allowed.map((a) => a.origin));
// Dev mode makes the service worker from web/sw.ts at start (the build writes sw.js into the build folder).
const devWorker = dev ? await buildWorker(ROOT).catch(() => undefined) : undefined;
const site = loadSite(dist, gate.origins, devWorker ? { worker: devWorker } : {});

// ---------------------------------------------------------------------------------------------------------------
// Iteration 7: the shared browser (server/browser/; DESIGN-B1 2). Off until the user's Start (browser.enabled); then a
// headless Chrome on 127.0.0.1:<browser.json's port> with its own profile in the state folder, started outside this
// process group or adopted after six checks. A restart keeps it and the successor adopts it; a quit stops it (S4).

const browserDir = join(dirs.state, "browser");
/** The URL rule's and the Fetch block's refusals: every allowed origin, and kitespan's port on every loopback name. */
const browserRefusals = () => ({ origins: gate.origins, loopbackPorts: [port] });
const portOfOrigin = (o: string): number => {
  try {
    const u = new URL(o);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
};
const tabsFile = new TabsFileStore(browserDir, ownUid(), browserRefusals, () => log.log("error", { err: "browser" }));
let relay: Relay | null = null;
const downloads = new Downloads({
  dir: browserDir,
  uid: ownUid(),
  keepDays: async () => (await store.readSettings())["uploads.keepDays"],
  onChange: (v) => relay?.broadcast({ t: "download", ...v }),
  ended: (ok, ms) => log.log("browser_download", { ok, ms }),
});
await downloads.open().catch(() => log.log("error", { err: "browser" }));

/** A file chooser's answer: the upload records' own files, each a regular file of this user in its record's folder. */
async function uploadPaths(ids: readonly string[]): Promise<string[] | null> {
  const out: string[] = [];
  for (const id of ids) {
    const rec = await store.findUpload(id);
    if (!rec || dirname(rec.path) !== rec.dir) return null;
    const st = lstatSync(rec.path, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.isSymbolicLink() || st.uid !== ownUid()) return null;
    out.push(rec.path);
  }
  return out;
}

const browserHost: BrowserHost = new BrowserHost({
  state: dirs.state,
  configDir: dirs.config,
  uid: ownUid(),
  env: START_ENV,
  home: homedir(),
  refusedPorts: () => [port, ...allowed.map((a) => portOfOrigin(a.origin))],
  settings: {
    enabled: async () => (await store.readSettings())["browser.enabled"],
    setEnabled: async (on) => void (await store.writeSettings({ "browser.enabled": on })),
  },
  savedTabs: () => tabsFile.count(),
  attach: (cdp, info) => relay!.attach(cdp, info),
  detached: () => relay?.detach(),
  clearTabs: () => tabsFile.clear(),
  beforeStop: () => relay?.freeze() ?? Promise.resolve(),
  log,
});
relay = new Relay({ refused: browserRefusals, tabsFile, downloads, uploadPaths, host: () => browserHost.state, log });
const browserRelay = relay;
browserHost.onState((v) => browserRelay.broadcast({ t: "host", ...v }));
browserTool = (chat, e) => browserRelay.acting.event(chat, e);
browserEnded = (chat) => browserRelay.acting.ended(chat);
/** The peer check: a request from the shared browser's own processes never gets kitespan's page, sockets or changes. */
const peerCheck = new PeerCheck({ serverPort: port, browserPid: () => browserHost.running?.pid ?? null });

/** The API's view of the store: adding a project also refreshes the folders that the driver allows. */
const apiStore: Pick<Store, "listProjects" | "putProject" | "readSettings" | "readChat" | "listUploads" | "putUpload" | "removeUpload"> = {
  listProjects: () => store.listProjects(),
  putProject: async (rec) => {
    await store.putProject(rec);
    await refreshFolders();
  },
  readSettings: () => store.readSettings(),
  readChat: (id) => store.readChat(id),
  listUploads: (chat) => store.listUploads(chat),
  putUpload: (rec) => store.putUpload(rec),
  removeUpload: (id) => store.removeUpload(id),
};

/**
 * The upload folder (4.4). Claude Code's uploads folder needs the chat's session id; before the chat has one (the
 * new-chat form, a chat whose first message has not gone out), the file goes to the Temporary folder, D41's
 * alternative, and the drop line shows that folder.
 */
async function uploadFolder(input: { chat: ChatLedger | null }): Promise<UploadFolderResult> {
  try {
    return await store.uploadFolder(input.chat?.sessionId ?? null);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    return prepareUploadFolder("temp", store.uploadPlaces, { customFolder: null, sessionId: null });
  }
}

// New environment (D54): the git repositories under the home folder, found by a walk in the background (from boot),
// and the folders of Claude Code's past sessions, read in the background too (the SDK may read every transcript).
const home = homedir();
const repos = new RepoCache(() => findRepos(home));
const sessionFolders = new Cached(() => driver.sessionFolders(), [] as string[], { cacheMs: SUGGEST_LIMITS.sessionsCacheMs });

// Row 99: an environment's Rename, Move and Remove; each change reaches every page (the socket's `projects` frame).
const environments = new Environments({
  store: {
    listProjects: () => store.listProjects(),
    putProject: (rec) => store.putProject(rec),
    putProjects: (recs) => store.putProjects(recs),
    removeProject: async (id) => {
      const gone = await store.removeProject(id);
      await refreshFolders();
      return gone;
    },
    listUploads: (chat) => store.listUploads(chat),
  },
  chats: registry,
  env: envStore,
  released,
  notify: (removed) => chatSocket.projects(removed),
  uid: ownUid(),
});

const api = createApi({
  gate,
  safe: site.safe,
  store: apiStore,
  driver,
  uploadFolder,
  chatForSession: (id) => registry.chatForSession(id),
  copyForSession: (id) => registry.copyForSession(id),
  heldSessions: () => registry.heldSessions(),
  messages: messageIndex,
  // U1: a turn's changes summary and one file's diff.
  changes,
  // R131: the read-only view's read of a background session that a launch row of the chat printed.
  backgroundView: (chat, id, q) => registry.backgroundView(chat, id, q),
  info: { port, version, adapters, allowed },
  // Settings writes: the store checks each value; then the registry and the driver read them again (the idle limit,
  // the cap and the bypass switch apply at once), and so does the update's schedule (Check for updates, row 108).
  settingsWriter: {
    write: (change) => store.writeSettings(change),
    reload: async () => {
      await registry.reloadSettings();
      await refreshFolders();
      updates.reload();
    },
  },
  account: (project) => registry.account(project),
  environments,
  releasedOf: (cwd) => released.of(cwd),
  // No short read starts while the restart drains or the server closes (R17, S11).
  mayRead: () => registry.mayRead,
  home,
  suggestedFolders: () => suggestedFolders({ sessionFolders: () => sessionFolders.get(), repos, projects: () => store.listProjects() }),
  logger: log,
  epoch: () => registry.epoch,
  env: envStore,
  // D60: a save that changes a project's variables makes the registry's model list forget its reads of it (L37).
  envChanged: (project) => registry.envChanged(project),
  // The restart (4.10): About's lines, the panes that run a program, the preflight, then the drain (chats/drain.ts).
  restart: {
    facts: () => updates.facts(),
    panes: () => shell.programs(),
    closing: () => restarter.closing,
    asking: () => {
      restartAsks++;
      let on = true;
      return () => {
        if (on) restartAsks--;
        on = false;
      };
    },
    // No restart while an update runs (row 108): its job here, or bin/update.sh (the update lock). An install checks
    // the next start's root and its code (DESIGN-I1 3.5), and the successor runs that root.
    preflight: async () => {
      const next = install.kind === "checkout" ? null : nextRoot(install);
      const line = await preflight({
        root: install.kind === "checkout" ? ROOT : install.root,
        dist,
        dev,
        argv: process.argv.slice(2),
        env: START_ENV,
        git,
        logs: dirs.logs,
        updating: () => updateJobs.busy(),
        ...(install.kind === "checkout" ? {} : { install: { next } }),
      });
      if (line === null) successorRoot = next ?? ROOT;
      return line;
    },
    drain: (when) => restarter.ask(when),
    undrain: () => restarter.cancel(),
  },
  // Row 108: About's update facts, Check now and the Update button.
  update: {
    facts: updateFacts,
    check: async () => {
      await updates.check();
      return updateFacts();
    },
    start: async () => {
      const a = await updateJobs.start();
      return a.ok ? a : { ok: false, line: a.line };
    },
  },
  // R130: Settings > Notifications' key and devices.
  push: push.api,
  // Iteration 7: Settings > Browser and the browser's downloads.
  browser: {
    reply: () => browserHost.reply(),
    // The start goes on after the answer; the pane's socket says how it went.
    start: async () => {
      await Promise.race([browserHost.start(), Bun.sleep(100)]);
      return browserHost.reply();
    },
    stop: async () => {
      await browserHost.stop();
      return browserHost.reply();
    },
    clear: async () => ((await browserHost.clear()) ? browserHost.reply() : null),
    downloads: () => downloads.list(),
    downloadFile: (id) => downloads.fileOf(id),
    removeDownload: (id) => downloads.remove(id),
  },
});

// The Terminal pane asks for a chat synchronously; the folder, the session id and the archive mark are kept here from
// the ledgers, and whether a Claude Code of the chat may be alive (its own, or kitespan's orphan of the server before
// this one) comes from the registry at each ask.
const shellChats = new Map<string, Omit<ShellChat, "processOpen">>();
/** D60: each chat's project, for its pane's environment variables. */
const shellProjects = new Map<string, string>();
async function rememberShellChat(id: string): Promise<void> {
  const rec = await store.readChat(id);
  if (rec) {
    // L28: a chat in its own worktree names its project folder, for the command's --project-config-root.
    shellChats.set(id, { cwd: rec.cwd, sessionId: rec.sessionId, archived: rec.archivedAt !== null, configRoot: terminalConfigRoot(rec) });
    shellProjects.set(id, rec.project);
  } else {
    shellChats.delete(id);
    shellProjects.delete(id);
  }
}
await Promise.all(registry.list().map((row) => rememberShellChat(row.chat)));
registry.subscribe((d) => {
  if ("gone" in d) {
    shellChats.delete(d.chat);
    shellProjects.delete(d.chat);
  } else void rememberShellChat(d.chat).catch(() => {});
});

const shell = createShellService({
  host: {
    chat(id) {
      const known = shellChats.get(id);
      // A session id that the chat's first start picked shows on the next ask (the pane's type_resume comes later).
      void rememberShellChat(id).catch(() => {});
      if (!known || !registry.has(id)) return null;
      return { ...known, processOpen: registry.processLives(id) };
    },
    // D60 (L38): the pane's shell gets the chat's environment's variables, as its Claude Code does.
    vars(id) {
      const project = shellProjects.get(id);
      return project ? envStore.vars(project) : [];
    },
    // R127: Open in terminal on a refused folder's line types `cd <folder> && claude` for the server's own match.
    trustPath: (id, toolUse) => registry.trustRowPath(id, toolUse),
    // R131: Open in terminal for a background session types `claude attach <id>` only for an id in the chat's book.
    backgroundId: (id, bg) => registry.backgroundHas(id, bg),
  },
  // The start environment (E4), never the server's process.env, which holds the SDK's own names.
  env: START_ENV,
  allowOrigin: (origin) => gate.originAllowed(origin),
  log,
});
// The chat owns its shell (D52): Archive and Delete end it, and every pane on it gets `exit`.
registry.subscribe((d) => {
  if ("gone" in d || d.archived === true) void shell.end(d.chat).catch(() => {});
});
// U5: a deleted chat's messages leave the message search at once.
registry.subscribe((d) => {
  if ("gone" in d) messageIndex.forget(d.chat);
});

// The drain's notice stands while it waits: a page that says hello then gets it too (S9); so does an update job's line
// (row 108: a phone that slept through a step sees the step that runs now).
const chatSocket = wsHandlers(registry, {
  version,
  log,
  host: machineName(),
  update: () => updates.welcome(),
  notices: () => [...restarter.standing(), ...standingUpdateNotice(updates.remote, updateJobs.view())],
});
// A change of origin's line or of the update job is one notice to every page: its id replaces the last one, and `gone`
// takes it away (server/update/notice.ts).
const sendUpdateNotice = noticeSender(
  (n) => chatSocket.notice(n?.text ?? "", undefined, n ? { id: n.id, ...(n.actions ? { actions: n.actions } : {}) } : { id: UPDATE_NOTICE_ID, gone: true }),
  updateNotice(updates.remote, updateJobs.view()),
);
const updateNoticeNow = () => sendUpdateNotice(updateNotice(updates.remote, updateJobs.view()));
updates.onChange(updateNoticeNow);
updateJobs.onChange(updateNoticeNow);
const app = createApp({
  gate,
  site,
  api,
  sockets: { [WIRE.path]: plainSocketRoute(WIRE.path, chatSocket, log), [WIRE.shellPath]: shell, [WIRE.browserPath]: browserSocketRoute({ relay: browserRelay, log }) },
  logger: log,
  peer: peerCheck,
});

// Dev mode serves the page through Bun's HTML import with hot reload (4.6); everything else goes through the table.
let routes: Record<string, unknown> | undefined;
if (dev) {
  const page = join(ROOT, "web", "index.html");
  if (!existsSync(page)) refuse(["dev mode serves web/index.html, which does not exist yet"]);
  const index = (await import(page)).default;
  routes = Object.fromEntries([...APP_EXACT_PATHS.map((p) => [p, index]), ...APP_PATH_PREFIXES.map((p) => [`${p}*`, index])]);
}

// ---------------------------------------------------------------------------------------------------------------
// Serve

/**
 * The one listener; a restart's successor retries it while the old server still holds the port (`--bind-wait`).
 * `reusePort: false` in so many words: with `development: false`, Bun 1.3.14 binds a port that another process holds
 * (SO_REUSEPORT), so a second server would share this one's connections instead of ending at a busy port.
 */
const serve = () =>
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    reusePort: false,
    // Uploads stream in and are measured against Largest upload by the route, and a JSON body is read as a stream to
    // its 16 KiB cap and no further (api.ts readCapped); Bun's own limit stays out of the way.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    idleTimeout: 60,
    ...(routes ? { routes: routes as Record<string, never>, development: { hmr: true, console: true } } : { development: false }),
    fetch: (req, srv) => app.fetch(req, srv),
    websocket: app.websocket,
  });
let server: ReturnType<typeof Bun.serve>;
let listening = false;

// The restart (4.10 steps 3 to 7): the drain, the close, the successor, the release and the health gate.
const outLog = join(dirs.logs, OUT_LOG);
const restarter = new Restart({
  registry,
  notice: (text, chat, more) => chatSocket.notice(text, chat, more),
  bye: (reason) => chatSocket.bye(reason),
  closeShells: () => shell.closeAll(),
  updates,
  spawn: () =>
    spawnSuccessor({
      root: successorRoot,
      argv: process.argv.slice(2),
      env: START_ENV,
      logs: dirs.logs,
      // The next version serves its own page.
      ...(install.kind === "checkout" ? {} : { dropDist: join(install.root, "dist", "web") }),
    }),
  release: async () => {
    listening = false;
    // The successor adopts the shared browser once it listens, and maps the tabs by tabs.json: the newest first, and
    // none from this server after it (a restart that does not happen thaws it in relisten).
    await browserRelay.freeze().catch(() => log.log("error", { err: "browser" }));
    // Under Bun 1.3.14 the promise of stop(true) never settles while a socket is still closing (bye's 1001); the port
    // is free at once all the same, and an awaited promise that never settles would let the process end here.
    await Promise.race([server.stop(true), Bun.sleep(200)]);
  },
  // The restart did not happen: the same port again, so every page comes back to this server's epoch.
  relisten: async () => {
    if (listening) return;
    browserRelay.thaw();
    try {
      server = await listenWithWait(serve, 10);
      listening = true;
    } catch {
      log.log("error", { err: "unknown" });
      complain(`could not listen on 127.0.0.1:${port} again after the restart failed, so kitespan stops.`);
      log.close();
      process.exit(1);
    }
  },
  // A plain socket to 127.0.0.1, never fetch, which would go through the user's HTTP proxy (update/loopback.ts).
  health: (timeoutMs) => readHealth(port, timeoutMs),
  done: (successor) => {
    // The successor adopts the shared browser: this server only lets its connection go (a restart never stops it).
    browserHost.release();
    log.log("restart", { ok: true });
    log.close();
    // The line reaches a pipe before the exit (a closed one fails at once, and the exit comes anyway).
    setTimeout(() => process.exit(0), 1_000).unref();
    process.stdout.write(`kitespan restarted as process ${successor.pid}; its lines go to ${outLog}.\n`, () => process.exit(0));
  },
  failed: () => {
    log.log("restart", { ok: false });
    complain(`the restart did not happen: the new server did not start. Its lines are in ${outLog}.`);
  },
  // bin/update.sh began during the drain (row 108): no successor on a checkout that does not match its build yet.
  updating: () => updateJobs.busy(),
});

try {
  server = await listenWithWait(serve, bindWait);
  listening = true;
} catch (e) {
  await registry.shutdown().catch(() => {});
  log.close();
  refuse([(e as NodeJS.ErrnoException)?.code === "EADDRINUSE" ? `port ${port} is in use` : `could not listen on 127.0.0.1:${port}`]);
}

// A restart's successor prints into logs/server-out.log, a file: there --origin's values are counted, not named.
for (const line of accessHint(port, adapters, allowed, { toFile: parsed.successor })) say(line);
for (const line of claudeLines(registry.claudeStatus)) say(line);
if (adapters.problem) complain(adapters.problem);
if (!site.built && !dev) say(`The page is not built yet: run bun run build (it writes ${dist}).`);
void repos.warm();
void sessionFolders.warm();
updates.start();
// The shared browser starts again, or is adopted, only when the user had started it (browser.enabled).
void browserHost.boot().catch(() => log.log("error", { err: "browser" }));

// ---------------------------------------------------------------------------------------------------------------
// Signals and crashes (4.10)

let stopping = false;
async function stop(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  if (stopping) {
    complain(`${signal} again: exiting now`);
    process.exit(1);
  }
  stopping = true;
  // A shutdown, never a restart: a drain that waits ends here.
  restarter.halt();
  updates.stop();
  // An update's running step ends with its process group (the next Update runs its steps again).
  updateJobs.stop();
  say("kitespan is stopping: closing the Claude Code of every chat.");
  // Past this, something hangs: the chats' own limit is about 8 s.
  setTimeout(() => process.exit(1), 15_000).unref();
  // No new connection from here; the open pages still see their chats go to sleep, then get `bye`.
  server.stop(false);
  // S4: a quit stops the shared browser too (Browser.close, then the signals after their checks), and leaves it off
  // until the user's next Start; a restart never comes here, and a crash cannot stop it.
  await Promise.all([
    registry.shutdown().catch(() => log.log("error", { err: "unknown" })),
    browserHost.quit().catch(() => log.log("error", { err: "browser" })),
  ]);
  await shell.closeAll().catch(() => log.log("error", { err: "shell" }));
  chatSocket.bye("shutdown");
  server.stop(true);
  log.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));

function crash(e: unknown): void {
  log.log("error", { err: "uncaught" });
  complain(`stopping after an uncaught error: ${e instanceof Error ? e.name : "error"}`);
  log.close();
  // process.exit runs the exit hooks: the SDK sends SIGTERM to each claude child it started (4.10).
  process.exit(1);
}
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
