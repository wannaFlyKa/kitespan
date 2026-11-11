// Writes the click-through seed for one scene into a scratch folder: kitespan's own state (the ledgers, projects.json,
// a draft that the server holds, the upload records and their files), a CLAUDE_CONFIG_DIR whose projects/ folder
// holds the transcripts, the project folders, and a HOME with a plain shell profile. Nothing outside the folder is
// read or written. Modes follow the store's checks (DESIGN 4.4): folders 0700 and files 0600 under the state folder.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARK_PHRASES, markOf } from "../../../server/agents/types";
import { BG, CHATS, HELD_DRAFT, PROJECTS, PROJECT_FILES, TRUST_FOLDERS, UPLOADS, homeFolders, homeTranscripts, otherTranscripts, uploadNotes, uploadTranscript, workerTranscript, type Folders, type HomeFolders, type TranscriptFile } from "./demo";
import { GATE_IDS, IDS, PART2_IDS } from "./ids";
import { sceneOf, type SeedSceneName } from "./scenes";
import { GATE, SEARCH_FILES, gatePaths, writeGateRepo, type GateKey } from "./search";
import { seedRepos, writeSeedRepos, type SeedRepos } from "./repos";
import { sideSeed } from "./side";
import { pushSeed } from "./push";
import { SEARCH_TEXT_CHATS, searchTextTranscripts } from "./search-text";
import { CHANGES_CHATS, writeExampleChanges } from "./changes";

export interface SeedPaths {
  root: string;
  /** HOME for the server and everything it starts. */
  home: string;
  /** CLAUDE_CONFIG_DIR: the scratch Claude Code folder with projects/<folder>/<session>.jsonl. */
  claudeConfig: string;
  /** XDG_STATE_HOME; kitespan's state folder is its kitespan/. */
  stateHome: string;
  /** kitespan's state folder. */
  state: string;
  /** XDG_CONFIG_HOME (empty: no start-env file, no adapters). */
  configHome: string;
  /** TMPDIR (the Temporary upload folder lives here). */
  tmp: string;
  /** XDG_DATA_HOME: kitespan's records of worktrees in the making go in its kitespan/worktrees/<project id>/ (row 100). */
  data: string;
  folders: Folders;
  /** Folders under the home folder (New environment, D54): two git repositories and a plain folder. */
  homeFolders: HomeFolders;
  /** The search gate's project folders (written in the search scene only): git indexes with no files on disk. */
  gate: Record<GateKey, string>;
  /** Part 2's git repositories under the home folder (written in the worktree scene only, seed/repos.ts). */
  repos: SeedRepos;
}

/** Claude Code's folder name for a project folder: every character outside [a-zA-Z0-9] becomes "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function dir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function file(path: string, body: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The seed's options: `stateFolder`, the state folder's name under XDG_STATE_HOME (the move's tests: the old one). */
export interface SeedOptions {
  stateFolder?: string;
}

export function seedPaths(root: string, opts: SeedOptions = {}): SeedPaths {
  const real = realpathSync(root);
  const home = join(real, "home");
  const work = join(real, "work");
  return {
    root: real,
    home,
    claudeConfig: join(home, ".claude"),
    stateHome: join(real, "state"),
    state: join(real, "state", opts.stateFolder ?? "kitespan"),
    configHome: join(real, "config"),
    tmp: join(real, "tmp"),
    data: join(real, "data"),
    folders: { kitespan: join(work, "kitespan"), notes: join(work, "notes-api"), scratch: join(work, "scratch") },
    homeFolders: homeFolders(home),
    gate: { big: join(work, GATE.big.dir), phone: join(work, GATE.phone.dir) },
    repos: seedRepos(home),
  };
}

/** Write the seed of `scene` under `root` (an empty scratch folder). `now` is the seed's clock. */
export function writeSeed(root: string, scene: SeedSceneName, now: number = Date.now(), opts: SeedOptions = {}): SeedPaths {
  const p = seedPaths(root, opts);
  const sc = sceneOf(scene);
  const min = 60_000;

  for (const d of [p.home, p.claudeConfig, join(p.claudeConfig, "projects"), p.stateHome, p.state, p.configHome, p.tmp, p.data]) dir(d);
  for (const sub of ["chats", "drafts", "notes", "uploads", "logs"]) dir(join(p.state, sub));

  // The project folders: the files the chats talk about, the kitespan one a git repository with the fix uncommitted.
  for (const [key, files] of Object.entries(PROJECT_FILES) as [keyof Folders, Record<string, string>][]) {
    dir(p.folders[key], 0o755);
    for (const [rel, body] of Object.entries(files)) file(join(p.folders[key], rel), body, 0o644);
  }
  // The search flows' rows (9.3): a 300-character path, CJK and emoji names; committed with the rest.
  for (const [rel, body] of Object.entries(SEARCH_FILES)) file(join(p.folders.kitespan, rel), body, 0o644);
  gitRepo(p.folders.kitespan, p.home);
  // R127 (the trust scene): the two task folders that Claude Code refused, made after the project's commit. The nested
  // one is a repository of its own (a `.git` folder is all that marks one for the server's file reads).
  if (sc.slots.trust) {
    dir(join(p.folders.kitespan, TRUST_FOLDERS.nested, ".git"), 0o755);
    dir(join(p.folders.kitespan, TRUST_FOLDERS.inRepo), 0o755);
  }
  // R131 (the background scene): the worker's task folder, a repository of its own with the brief and the cart code.
  if (sc.bg) {
    const w = join(p.folders.kitespan, BG.folder);
    dir(join(w, ".git"), 0o755);
    file(join(w, "BRIEF-investigate.md"), "# Investigate: negative quantity\n\nFind why a negative quantity gets through the cart, and say where to fix it.\n", 0o644);
    file(join(w, "src", "cart", "check.ts"), "export function check(qty: number, max: number): boolean {\n  return !(qty > max);\n}\n", 0o644);
  }
  const gates = (sc.gate ?? []).filter((key) => writeGateRepo(p.gate[key], gatePaths(GATE[key].rows), p.home));

  // New environment's Browse and Suggested: a `.git` entry is all that marks a repository.
  for (const d of [join(p.homeFolders.website, ".git"), join(p.homeFolders.infra, ".git"), p.homeFolders.documents]) dir(d, 0o755);
  // Part 2 (row 73, row 100): three real repositories under ~/code, in the worktree scenes only.
  if (sc.repos && !writeSeedRepos(p.repos, p.home)) throw new Error("the worktree scene needs git on this host");

  // A plain shell for the Terminal pane and ! commands: no rc file of the user's own is read.
  for (const rc of [".bash_profile", ".bashrc", ".zshrc", ".profile"]) file(join(p.home, rc), "PS1='demo$ '\nPROMPT='demo%# '\n", 0o600);

  // Transcripts (Claude Code's own files, in the scratch CLAUDE_CONFIG_DIR).
  const transcripts: TranscriptFile[] = [uploadTranscript(p.folders.kitespan, now - 200 * min, sc.slots), ...otherTranscripts(p.folders, now), ...homeTranscripts(p.homeFolders, now)];
  // R131: the worker's own transcript, under its folder's own slug (the project's lists never show it: sdk-ts).
  if (sc.bg) transcripts.push(workerTranscript(join(p.folders.kitespan, BG.folder), now - 6 * min));
  // U5 (the search-text scene): the three chats whose messages hold the message search's words.
  if (sc.searchText) transcripts.push(...searchTextTranscripts(p.folders, now));
  for (const t of transcripts) {
    const path = join(p.claudeConfig, "projects", projectDirName(t.cwd), `${t.sessionId}.jsonl`);
    file(path, t.lines.join("\n") + "\n");
    // The file's time is its last record's, as Claude Code leaves it: the session lists put the newest first by it.
    const last = Date.parse((JSON.parse(t.lines[t.lines.length - 1]!) as { timestamp: string }).timestamp) / 1000;
    utimesSync(path, last, last);
  }
  file(join(p.claudeConfig, "settings.json"), "{}\n");

  // projects.json, with the picks that kitespan remembers per folder (Forget clears them).
  const marked = (v: string | undefined, phrase: (typeof MARK_PHRASES)[keyof typeof MARK_PHRASES], at: number) => (v ? { value: v, mark: markOf(phrase, new Date(at)) } : null);
  const projects = PROJECTS.map((pr) => ({
    id: pr.id,
    cwd: p.folders[pr.key],
    name: pr.name,
    createdAt: iso(now - 30 * 24 * 60 * min),
    lastUsedAt: iso(now - Math.min(...CHATS.filter((c) => c.project === pr.key).map((c) => c.lastActivity)) * min),
    picks: {
      model: marked(pr.picks.model, MARK_PHRASES.remembered, now - 2 * 24 * 60 * min),
      effort: marked(pr.picks.effort, MARK_PHRASES.remembered, now - 2 * 24 * 60 * min),
      permissionMode: marked(pr.picks.mode, MARK_PHRASES.remembered, now - 2 * 24 * 60 * min),
    },
    // Row 97: what the example project's last chat reported 3 h ago, for Settings while no chat is live.
    ...(pr.key === "kitespan"
      ? {
          account: { at: iso(now - 180 * min), provider: "bedrock" },
          facts: { at: iso(now - 180 * min), fastMode: { state: "off", reason: "not_first_party" }, skills: ["review-notes"], plugins: [{ name: "notes-tools", version: "1.2.0" }], outputStyle: "Explanatory" },
        }
      : {}),
  }));
  const none = { model: null, effort: null, permissionMode: null };
  for (const key of gates) {
    projects.push({ id: GATE_IDS.projects[key], cwd: p.gate[key], name: GATE[key].name, createdAt: iso(now - 60 * min), lastUsedAt: iso(now - 30 * min), picks: none });
  }
  // Row 99 in part 2: ~/code/shop as an environment with Worktree on, and its one variable in env/<id>.json (D60).
  const shop = sc.shopEnv ? [{ id: PART2_IDS.shop, cwd: p.repos.shop, name: "shop", createdAt: iso(now - 60 * min), lastUsedAt: iso(now - 60 * min), picks: none, worktree: true }] : [];
  if (sc.shopEnv) file(join(p.state, "env", `${PART2_IDS.shop}.json`), JSON.stringify({ v: 1, id: PART2_IDS.shop, vars: [{ ...PART2_IDS.variable, at: iso(now - 60 * min) }] }));
  file(join(p.state, "projects.json"), JSON.stringify({ v: 1, projects: [...projects, ...shop] }, null, 2));

  // One ledger per chat; every chat is asleep at boot (4.1).
  for (const c of [...CHATS, ...(sc.searchText ? SEARCH_TEXT_CHATS : []), ...(sc.changes ? CHANGES_CHATS : [])]) {
    const isUpload = c.id === IDS.chats.upload;
    const mode = isUpload && sc.upload.mode ? sc.upload.mode : c.picks.mode;
    const archivedAt = isUpload ? (sc.upload.archived ? 30 : undefined) : c.archived;
    const pickAt = now - (c.lastActivity + 5) * min;
    const ledger = {
      v: 1,
      id: c.id,
      project: PROJECTS.find((pr) => pr.key === c.project)!.id,
      cwd: p.folders[c.project],
      agent: "claude-code",
      sessionId: c.sessionId,
      title: { text: c.title, from: c.from },
      picks: {
        model: marked(c.picks.model, MARK_PHRASES.pick, pickAt),
        effort: marked(c.picks.effort, MARK_PHRASES.pick, pickAt),
        permissionMode: marked(mode, MARK_PHRASES.pick, pickAt),
      },
      createdAt: iso(now - c.created * min),
      seenAt: iso(now - c.lastActivity * min),
      lastActivityAt: iso(now - c.lastActivity * min),
      lastSeq: 0,
      state: "sleeping",
      lastExit: null,
      archivedAt: archivedAt === undefined ? null : iso(now - archivedAt * min),
      // Row 116: an end that no page has seen, in the scenes that ask for one (the dots scene).
      ...(sc.unseen?.[c.id] ? { unseen: sc.unseen[c.id] } : {}),
    };
    file(join(p.state, "chats", `${c.id}.json`), JSON.stringify(ledger));
  }
  // The search gate's chats: one per gate folder, with no message yet (no session, no transcript).
  for (const key of gates) {
    const at = iso(now - 30 * min);
    const ledger = { v: 1, id: GATE_IDS.chats[key], project: GATE_IDS.projects[key], cwd: p.gate[key], agent: "claude-code", sessionId: null, title: { text: GATE[key].title, from: "renamed" }, picks: none, createdAt: at, seenAt: at, lastActivityAt: at, lastSeq: 0, state: "sleeping", lastExit: null, archivedAt: null };
    file(join(p.state, "chats", `${ledger.id}.json`), JSON.stringify(ledger));
  }

  // The draft that another device typed in "Summarize the server logs" (D49).
  file(
    join(p.state, "drafts", `${HELD_DRAFT.chat}.json`),
    JSON.stringify({ v: 1, id: HELD_DRAFT.chat, rev: HELD_DRAFT.rev, text: HELD_DRAFT.text, mode: "chat", command: null, link: false, uploads: [], by: HELD_DRAFT.by, at: iso(now - 7 * min) }),
  );

  // RD-8: what waited in the example chat when kitespan stopped (the not-sent scene); boot restores it Not sent.
  if (sc.notSent?.length) {
    dir(join(p.state, "queue"));
    const msgs = sc.notSent.map((m) => ({ uuid: m.uuid, text: m.text, userText: m.text, uploads: [], mentions: [], at: iso(now - 3 * min) }));
    file(join(p.state, "queue", `${IDS.chats.upload}.json`), JSON.stringify({ v: 1, id: IDS.chats.upload, msgs }));
  }

  // R124: the example chat's kept side thread (kitespan's own file, never the transcript), in the side scene.
  if (sc.side) file(join(p.state, "side", `${IDS.chats.upload}.json`), JSON.stringify(sideSeed(IDS.chats.upload, now)));

  // R130: notifications on for one other device (the main scene's), whose endpoint the server never calls.
  if (sc.push) {
    const push = pushSeed(now);
    file(join(p.state, "push-key.json"), push.key);
    file(join(p.state, "push-devices.json"), push.devices);
  }

  // The server's own notes of the example chat: an answered permission card, whose record history shows (5.4).
  file(join(p.state, "notes", `${IDS.chats.upload}.json`), JSON.stringify(uploadNotes(IDS.chats.upload)));

  // U1: the example chat's first turn's changes summary, under the route examples' id (the main and changes scenes).
  if (sc.name === "main" || sc.changes) {
    // The transcript's first record when no slot names it (demo.ts Transcript: the session's first group, then 1).
    const first = sc.slots.message ?? `${IDS.sessions.upload.slice(0, 8)}-0000-4000-8000-${"1".padStart(12, "0")}`;
    writeExampleChanges(p.state, IDS.chats.upload, p.folders.kitespan, p.home, [first], now);
  }

  // The example chat's uploads, in kitespan's own upload folder: a fresh u-XXXXXX folder each (D37).
  const uploads = UPLOADS.map((u) => {
    const d = join(p.state, "uploads", u.dir);
    const body = u.body();
    dir(d);
    file(join(d, u.name), body);
    return { v: 1, id: u.id, chat: IDS.chats.upload, project: IDS.projects.kitespan, name: u.name, size: body.byteLength, type: u.type, path: join(d, u.name), folder: "state", dir: d, at: iso(now - u.minutes * min) };
  });
  file(join(p.state, "uploads.json"), JSON.stringify({ v: 1, uploads }, null, 2));
  return p;
}

/** The kitespan folder as a git repository on main, with the fix and its test changed and the doc new (git status). */
function gitRepo(cwd: string, home: string): void {
  const git = ["/usr/bin/git", "/bin/git"].find((g) => existsSync(g));
  if (!git) return;
  const env = { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C" };
  const run = (...args: string[]) => spawnSync(git, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", ...args], { env, stdio: "ignore" }).status === 0;
  const current = { upload: PROJECT_FILES.kitespan["src/upload.ts"]!, test: PROJECT_FILES.kitespan["test/upload.test.ts"]! };
  const before = {
    upload: 'export async function uploadFile(url: string, body: ReadableStream) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const res = await fetch(url, { method: "PUT", body });\n    if (res.ok) return res;\n  }\n  throw new Error("upload failed");\n}\n',
    test: current.test.replace('  expect(fetch.bodies).toEqual(["hello", "hello", "hello"]);\n', ""),
  };
  writeFileSync(join(cwd, "src", "upload.ts"), before.upload);
  writeFileSync(join(cwd, "test", "upload.test.ts"), before.test);
  const doc = join(cwd, "docs", "UPLOAD-RETRIES.md");
  const docBody = PROJECT_FILES.kitespan["docs/UPLOAD-RETRIES.md"]!;
  // Best effort: without git the folder is a plain folder, and the Environment card shows no branch.
  if (run("init", "-q", "-b", "main") && run("add", "-A", ".", ":!docs")) run("commit", "-q", "-m", "Upload client and its test");
  writeFileSync(join(cwd, "src", "upload.ts"), current.upload);
  writeFileSync(join(cwd, "test", "upload.test.ts"), current.test);
  writeFileSync(doc, docBody);
}
