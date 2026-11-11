// The rename to kitespan (iteration 6, round K1; FIX-K1.md 1 and 2): the one-time move of the three XDG folders from
// the old name to `kitespan`, and the resolver that every process uses to find them. Every case of the brief: a fresh
// install; an old folder only; both present; a cross-device copy; a failure half way (the rename, the copy, a crash
// during the copy, after the switch, before the note); the modes; a second start does nothing. Then who never moves
// (the restart's `--check`, a restart's successor, bin/update.sh's lock), the data folder that stays while it holds an
// old worktree, a live user of the old folder, and the real server's first start on a real-shaped old state folder (the
// click seed: ledgers, notes, queue, side, uploads, push key and devices, changes marks, an environment's variables).
//
// Every folder here is under one mkdtemp folder per test, and each test checks that before it acts: no test reads or
// moves a real folder of the user's.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { LEGACY_BIN, LEGACY_FOLDER, LEGACY_HEADER } from "../../shared/legacy";
import { withUploadRefs } from "../../shared/protocol";
import { createEnvStore } from "../../server/env/store";
import { moveOldFolders, type MoveOptions } from "../../server/store/move";
import { FOLDER_NAME, productFolder, xdgBase } from "../../server/store/places";
import { createStore, storeDirs } from "../../server/store/store";
import { takeLock } from "../../server/update/lock";
import { projectRecords, projectRecordsThere } from "../../server/worktree/place";
import { IDS } from "../click/seed/ids";
import { sideSeed } from "../click/seed/side";
import { writeSeed, type SeedPaths } from "../click/seed/write";
import { LINUX_ONLY, PROCFS } from "../linux";
import { freePort } from "./free-port";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "server", "main.ts");
const NOW = Date.parse("2026-11-07T08:00:00.000Z");
/** The message that waits in the example chat's queue. */
const QUEUED = "8d0c5f8e-7a8b-4c1d-9e2f-3a4b5c6d7e8f";
const TMP = realpathSync(tmpdir());

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tmp(name: string): string {
  const d = realpathSync(mkdtempSync(join(TMP, `kitespan-move-${name}-`)));
  scratch.push(d);
  return d;
}
/** Every path a test acts on is under its own scratch folder in the system's temporary folder. */
function mine(root: string, ...paths: string[]): void {
  if (!root.startsWith(`${TMP}${sep}kitespan-move-`)) throw new Error(`not a scratch folder: ${root}`);
  for (const p of paths) if (!p.startsWith(`${root}${sep}`)) throw new Error(`outside the scratch folder: ${p}`);
}

interface Install {
  root: string;
  home: string;
  env: Record<string, string>;
  bases: { state: string; config: string; data: string };
  old: { state: string; config: string; data: string };
  now: { state: string; config: string; data: string };
}

function install(name: string): Install {
  const root = tmp(name);
  const bases = { state: join(root, "state"), config: join(root, "config"), data: join(root, "data") };
  const home = join(root, "home");
  for (const d of [home, ...Object.values(bases)]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const old = { state: join(bases.state, LEGACY_FOLDER), config: join(bases.config, LEGACY_FOLDER), data: join(bases.data, LEGACY_FOLDER) };
  const now = { state: join(bases.state, FOLDER_NAME), config: join(bases.config, FOLDER_NAME), data: join(bases.data, FOLDER_NAME) };
  mine(root, home, ...Object.values(old), ...Object.values(now));
  return { root, home, env: { XDG_STATE_HOME: bases.state, XDG_CONFIG_HOME: bases.config, XDG_DATA_HOME: bases.data }, bases, old, now };
}

/** A small old install by hand: a state folder as the store keeps it, the user's config files, an empty data folder. */
function smallOld(name: string): Install {
  const i = install(name);
  for (const d of [i.old.state, join(i.old.state, "chats"), join(i.old.state, "uploads"), join(i.old.state, "uploads", "u-abc123"), i.old.config, i.old.data, join(i.old.data, "worktrees")]) {
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
  }
  writeFileSync(join(i.old.state, "settings.json"), '{"v":1}', { mode: 0o600 });
  writeFileSync(join(i.old.state, "uploads", "u-abc123", "a.txt"), "hello", { mode: 0o600 });
  writeFileSync(join(i.old.config, "start-env"), "set KITESPAN_TEST_VALUE=1\n", { mode: 0o600 });
  return i;
}

/** A real-shaped old install: the click seed's main scene written under the old state folder's name. */
function seededOld(name: string): Install & { seed: SeedPaths } {
  const i = install(name);
  const seed = writeSeed(i.root, "main", NOW, { stateFolder: LEGACY_FOLDER });
  if (seed.state !== i.old.state || seed.home !== i.home) throw new Error("the seed's folders are not the test's");
  // Beside the main scene's records (ledgers, projects, a draft, notes, uploads, the push key and device, a turn's
  // changes): a kept side thread, a message that waits, and an environment's variables, as the other scenes write them.
  const at = new Date(NOW).toISOString();
  const record = (rel: string, body: unknown) => {
    mkdirSync(join(i.old.state, rel, ".."), { recursive: true, mode: 0o700 });
    chmodSync(join(i.old.state, rel, ".."), 0o700);
    writeFileSync(join(i.old.state, rel), JSON.stringify(body), { mode: 0o600 });
  };
  record(`side/${IDS.chats.upload}.json`, sideSeed(IDS.chats.upload, NOW));
  record(`queue/${IDS.chats.upload}.json`, { v: 1, id: IDS.chats.upload, msgs: [{ uuid: QUEUED, text: "Then rerun the suite.", userText: "Then rerun the suite.", uploads: [], mentions: [], at }] });
  record(`env/${IDS.projects.kitespan}.json`, { v: 1, id: IDS.projects.kitespan, vars: [{ name: "SEED_TOKEN", value: "seed-value-1", at }] });
  mkdirSync(i.old.config, { mode: 0o700 });
  writeFileSync(join(i.old.config, "adapters.json"), JSON.stringify({ v: 1, access: { hint: "Open it through the moved config's forward." } }), { mode: 0o600 });
  writeFileSync(join(i.old.config, "start-env"), "unset NOTHING_HERE\n", { mode: 0o600 });
  mkdirSync(join(i.old.data, "worktrees", IDS.projects.kitespan), { recursive: true, mode: 0o700 });
  return { ...i, seed };
}

interface Entry {
  type: "dir" | "file" | "link";
  mode: number;
  size: number;
  sha: string;
  mtime: number;
}
/** Every entry under `root` (lstat, never through a link), by its path relative to `root`. */
function snapshot(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (abs: string) => {
    const st = lstatSync(abs);
    const rel = relative(root, abs);
    const type = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file";
    out.set(rel, { type, mode: st.mode & 0o7777, size: type === "file" ? st.size : 0, sha: type === "file" ? createHash("sha256").update(readFileSync(abs)).digest("hex") : "", mtime: Math.floor(st.mtimeMs / 1000) });
    if (type === "dir") for (const n of readdirSync(abs).sort()) walk(join(abs, n));
  };
  walk(root);
  return out;
}
const without = (m: Map<string, Entry>, key: keyof Entry) => new Map([...m].map(([k, v]) => [k, { ...v, [key]: 0 }]));

function lines() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, say: (l: string) => void out.push(l), complain: (l: string) => void err.push(l) };
}
function opts(i: Install, l: ReturnType<typeof lines>, more: Partial<MoveOptions> = {}): MoveOptions {
  return { env: i.env, home: i.home, say: l.say, complain: l.complain, inUse: async () => null, now: () => new Date(NOW), ...more };
}
/** A rename that fails with `code` for a move of the old folder itself, and renames anything else. */
const failingRename =
  (code: string, from: string) =>
  async (a: string, b: string): Promise<void> => {
    if (a === from) throw Object.assign(new Error(code), { code });
    await rename(a, b);
  };
const isNote = (p: string, to: string) => {
  const st = lstatSync(p);
  return st.isFile() && (st.mode & 0o777) === 0o600 && readFileSync(p, "utf8").includes(to);
};

describe("the resolver: where each folder is (lstat only; it makes nothing)", () => {
  test("a fresh install: the new folders, and nothing is made", () => {
    const i = install("fresh-resolve");
    for (const k of ["state", "config", "data"] as const) expect(productFolder(k, i.bases[k])).toBe(i.now[k]);
    expect(storeDirs(i.env, i.home).state).toBe(i.now.state);
    expect(storeDirs(i.env, i.home).config).toBe(i.now.config);
    for (const k of ["state", "config", "data"] as const) expect(readdirSync(i.bases[k])).toEqual([]);
  });

  test("the XDG rule: an absolute variable, else the home folder's default", () => {
    expect(xdgBase("state", { XDG_STATE_HOME: "relative" }, "/srv/u")).toBe("/srv/u/.local/state");
    expect(xdgBase("config", {}, "/srv/u")).toBe("/srv/u/.config");
    expect(xdgBase("data", { XDG_DATA_HOME: "" }, "/srv/u")).toBe("/srv/u/.local/share");
    expect(xdgBase("data", { XDG_DATA_HOME: "/x/data" }, "/srv/u")).toBe("/x/data");
  });

  test("an old folder only: it is used in place until the move (pending)", () => {
    const i = smallOld("old-resolve");
    for (const k of ["state", "config", "data"] as const) expect(productFolder(k, i.bases[k])).toBe(i.old[k]);
    const d = storeDirs(i.env, i.home);
    expect([d.state, d.config, d.uploads]).toEqual([i.old.state, i.old.config, join(i.old.state, "uploads")]);
    expect(existsSync(i.now.state)).toBe(false);
  });

  test("anything at the new name wins: a folder, or even a file (which the store then refuses)", () => {
    const i = smallOld("new-wins");
    mkdirSync(i.now.state, { mode: 0o700 });
    writeFileSync(i.now.config, "x");
    expect(productFolder("state", i.bases.state)).toBe(i.now.state);
    expect(productFolder("config", i.bases.config)).toBe(i.now.config);
  });

  test("the note of an earlier move, or a link, at the old name is not a pending folder (a link to a folder is, for config)", () => {
    const i = install("old-kinds");
    writeFileSync(i.old.state, "a note", { mode: 0o600 });
    mkdirSync(join(i.root, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(i.root, "elsewhere"), i.old.data);
    symlinkSync(join(i.root, "elsewhere"), i.old.config);
    expect(productFolder("state", i.bases.state)).toBe(i.now.state);
    expect(productFolder("data", i.bases.data)).toBe(i.now.data);
    expect(productFolder("config", i.bases.config)).toBe(i.old.config);
  });

  test("the worktree records follow it: the old data folder's while it is pending, the new one's on a fresh install", () => {
    const i = smallOld("records");
    expect(projectRecords(i.bases.data, "k3m7q2x4ab")).toBe(join(i.old.data, "worktrees", "k3m7q2x4ab"));
    expect(projectRecordsThere(i.bases.data, "k3m7q2x4ab")).toBe(join(i.old.data, "worktrees", "k3m7q2x4ab"));
    const f = install("records-fresh");
    expect(projectRecords(f.bases.data, "k3m7q2x4ab")).toBe(join(f.now.data, "worktrees", "k3m7q2x4ab"));
    expect(existsSync(f.old.data)).toBe(false);
  });

  test("bin/update.sh's lock goes through the resolver: it never makes an empty new state folder that would block the move", async () => {
    const i = smallOld("lock");
    const lock = await takeLock(storeDirs(i.env, i.home).state);
    expect(lock).not.toBeNull();
    expect(existsSync(join(i.old.state, "update.lock"))).toBe(true);
    expect(existsSync(i.now.state)).toBe(false);
    await lock!.release();
  });
});

describe("the move", () => {
  test("a fresh install: nothing is done and nothing is said (no old state folder: the others are not looked at)", async () => {
    const i = install("fresh");
    const l = lines();
    const r = await moveOldFolders(opts(i, l));
    expect(r).toEqual({ state: "none", config: "skipped", data: "skipped", refuse: null });
    expect([l.out, l.err]).toEqual([[], []]);
    for (const k of ["state", "config", "data"] as const) expect(readdirSync(i.bases[k])).toEqual([]);
  });

  test("an old folder only: each folder is renamed whole, the old path holds a 0600 note, and one line says so per folder", async () => {
    const i = seededOld("rename");
    const before = { state: snapshot(i.old.state), config: snapshot(i.old.config), data: snapshot(i.old.data) };
    const l = lines();
    const r = await moveOldFolders(opts(i, l));
    expect(r).toEqual({ state: "moved", config: "moved", data: "moved", refuse: null });
    for (const k of ["state", "config", "data"] as const) {
      expect(snapshot(i.now[k])).toEqual(before[k]);
      expect(isNote(i.old[k], i.now[k])).toBe(true);
    }
    expect(l.out).toEqual((["state", "config", "data"] as const).map((k) => `kitespan moved ${i.old[k]} to ${i.now[k]}.`));
    expect(l.err).toEqual([]);
  });

  test("the store opens the moved state folder with every record, and the state uploads' paths name the new folder (written once)", async () => {
    const i = seededOld("records-after");
    const ledgers = readdirSync(join(i.old.state, "chats")).sort();
    await moveOldFolders(opts(i, lines()));
    const store = createStore({ env: i.env, home: i.home, tmpRoot: join(i.root, "tmp") });
    const opened = await store.open();
    expect(opened.setAside).toEqual([]);
    expect(opened.chats.map((c) => `${c.id}.json`).sort()).toEqual(ledgers.filter((n) => n.endsWith(".json")));
    expect(store.dirs.state).toBe(i.now.state);
    const ups = await store.listUploads(IDS.chats.upload);
    expect(ups.length).toBeGreaterThan(0);
    for (const u of ups) {
      expect(u.dir.startsWith(join(i.now.state, "uploads") + sep)).toBe(true);
      expect(u.path.startsWith(join(i.now.state, "uploads") + sep)).toBe(true);
      expect(existsSync(u.path)).toBe(true);
    }
    const file = JSON.parse(readFileSync(join(i.now.state, "uploads.json"), "utf8")) as { uploads: { path: string; dir: string; was?: string }[] };
    for (const u of file.uploads) {
      expect([u.path, u.dir].every((p) => p.startsWith(join(i.now.state, "uploads") + sep))).toBe(true);
      expect(u.was).toBe(join(i.old.state, relative(i.now.state, u.path)));
    }
    for (const f of ["push-key.json", "push-devices.json", "projects.json", `notes/${IDS.chats.upload}.json`, `changes/${IDS.chats.upload}/turns.json`]) expect(existsSync(join(i.now.state, f))).toBe(true);
    expect((await store.readQueue(IDS.chats.upload))?.msgs.map((m) => m.uuid)).toEqual([QUEUED]);
    expect((await store.readSide(IDS.chats.upload))?.exchanges.length).toBeGreaterThan(0);
    const env = createEnvStore({ dir: store.dirs.env });
    expect((await env.open()).setAside).toEqual([]);
    expect(env.vars(IDS.projects.kitespan)).toEqual([{ name: "SEED_TOKEN", value: "seed-value-1" }]);
    await store.flush();
  });

  test("an upload of the state folder keeps its path from before the move, and a message that waits names its new path", async () => {
    const i = seededOld("uploads-after");
    const store0 = JSON.parse(readFileSync(join(i.old.state, "uploads.json"), "utf8")) as { uploads: { id: string; path: string }[] };
    const log = store0.uploads.find((u) => u.id === IDS.uploads.log)!;
    const image = store0.uploads.find((u) => u.id === IDS.uploads.image)!;
    // The message that waits at the shutdown: the user's words, then the server's references to both uploads (D50).
    const text = withUploadRefs("Compare the log with the screenshot.", [log.path, image.path], "message");
    writeFileSync(join(i.old.state, "queue", `${IDS.chats.upload}.json`), JSON.stringify({ v: 1, id: IDS.chats.upload, msgs: [{ uuid: QUEUED, text, userText: "Compare the log with the screenshot.", uploads: [IDS.uploads.log, IDS.uploads.image], mentions: [], at: new Date(NOW).toISOString() }] }), { mode: 0o600 });
    await moveOldFolders(opts(i, lines()));
    const store = createStore({ env: i.env, home: i.home, tmpRoot: join(i.root, "tmp") });
    await store.open();
    const ups = new Map((await store.listUploads(IDS.chats.upload)).map((u) => [u.id, u]));
    for (const u of [log, image]) {
      expect(ups.get(u.id)!.was).toBe(u.path);
      expect(ups.get(u.id)!.path).toBe(join(i.now.state, relative(i.old.state, u.path)));
    }
    const queued = (await store.readQueue(IDS.chats.upload))!.msgs[0]!;
    expect(queued.text).toBe(withUploadRefs("Compare the log with the screenshot.", [ups.get(log.id)!.path, ups.get(image.id)!.path], "message"));
    expect(queued.text).not.toContain(i.old.state + sep);
    // Read again after a restart: the same answer (the record keeps `was`; the queue file is not rewritten by a read).
    await store.flush();
    const again = createStore({ env: i.env, home: i.home, tmpRoot: join(i.root, "tmp") });
    await again.open();
    expect((await again.readQueue(IDS.chats.upload))!.msgs[0]!.text).toBe(queued.text);
    expect((await again.listUploads(IDS.chats.upload)).find((u) => u.id === log.id)!.was).toBe(log.path);
    await again.flush();
  });

  test("a cross-device copy: checked, then switched; names, bytes, modes (git's own too) and times are kept; no staging folder stays", async () => {
    const i = seededOld("copy");
    // Git's own modes inside a mark's objects (left to git by the store's check), and an old upload folder's time.
    const objects = join(i.old.state, "changes", IDS.chats.upload, "objects");
    mkdirSync(join(objects, "ab"), { recursive: true, mode: 0o755 });
    chmodSync(join(objects, "ab"), 0o755);
    writeFileSync(join(objects, "ab", "cdef"), "a git object", { mode: 0o444 });
    chmodSync(join(objects, "ab", "cdef"), 0o444);
    const up = readdirSync(join(i.old.state, "uploads")).find((n) => n.startsWith("u-"))!;
    utimesSync(join(i.old.state, "uploads", up), NOW / 1000 - 9 * 86_400, NOW / 1000 - 9 * 86_400);
    const before = { state: snapshot(i.old.state), config: snapshot(i.old.config), data: snapshot(i.old.data) };
    const l = lines();
    const exdev = async (a: string, b: string) => {
      if (Object.values(i.old).includes(a)) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      await rename(a, b);
    };
    const r = await moveOldFolders(opts(i, l, { rename: exdev }));
    expect(r).toEqual({ state: "copied", config: "copied", data: "copied", refuse: null });
    for (const k of ["state", "config", "data"] as const) {
      // Folders' times change as entries go in; each file's time is kept, and each folder's is set back after.
      expect(snapshot(i.now[k])).toEqual(before[k]);
      expect(isNote(i.old[k], i.now[k])).toBe(true);
      expect(readdirSync(i.bases[k]).sort()).toEqual([LEGACY_FOLDER, FOLDER_NAME].sort());
    }
    expect(statSync(join(i.now.state, "changes", IDS.chats.upload, "objects", "ab", "cdef")).mode & 0o777).toBe(0o444);
    expect(statSync(i.now.state).mode & 0o777).toBe(0o700);
    expect(l.out).toHaveLength(3);
    expect(l.err).toEqual([]);
  });

  test("both present: the new one is used, the old one is never touched, and one line says so at each start", async () => {
    const i = smallOld("both");
    mkdirSync(i.now.state, { mode: 0o700 });
    const before = snapshot(i.old.state);
    for (let n = 0; n < 2; n++) {
      const l = lines();
      const r = await moveOldFolders(opts(i, l));
      expect(r.state).toBe("both");
      expect(l.err).toEqual([`${i.old.state} is from before the rename and is not used: ${i.now.state} is.`]);
      expect(snapshot(i.old.state)).toEqual(before);
    }
    expect(productFolder("state", i.bases.state)).toBe(i.now.state);
  });

  test("a second start does nothing and says nothing", async () => {
    const i = smallOld("second");
    await moveOldFolders(opts(i, lines()));
    const after = snapshot(i.now.state);
    const l = lines();
    const r = await moveOldFolders(opts(i, l));
    expect(r).toEqual({ state: "none", config: "none", data: "none", refuse: null });
    expect([l.out, l.err]).toEqual([[], []]);
    expect(snapshot(i.now.state)).toEqual(after);
    expect(isNote(i.old.state, i.now.state)).toBe(true);
  });

  test("the modes: the moved folder keeps 0700 folders and 0600 files; the note is 0600", async () => {
    const i = smallOld("modes");
    await moveOldFolders(opts(i, lines(), { rename: failingRename("EXDEV", join(i.bases.state, LEGACY_FOLDER)) }));
    for (const [rel, e] of snapshot(i.now.state)) expect([rel, e.mode]).toEqual([rel, e.type === "dir" ? 0o700 : 0o600]);
    expect(lstatSync(i.old.state).mode & 0o777).toBe(0o600);
  });
});

describe("a failure half way leaves the old folder untouched, and the start says so in one line", () => {
  test("the rename fails: nothing changes, the old folder is used this time, and the later folders wait", async () => {
    const i = smallOld("rename-fails");
    const before = snapshot(i.old.state);
    const l = lines();
    const r = await moveOldFolders(opts(i, l, { rename: failingRename("EACCES", i.old.state) }));
    expect(r).toEqual({ state: "failed", config: "skipped", data: "skipped", refuse: null });
    expect(l.err).toEqual([`could not move ${i.old.state} to ${i.now.state} (EACCES), so kitespan uses ${i.old.state} this time.`]);
    expect(snapshot(i.old.state)).toEqual(before);
    expect(existsSync(i.now.state)).toBe(false);
    expect(lstatSync(i.old.config).isDirectory()).toBe(true);
    expect(productFolder("state", i.bases.state)).toBe(i.old.state);
  });

  test("the copy fails (a link inside): the staging copy goes, the old folder stays as it was", async () => {
    const i = smallOld("copy-fails");
    mkdirSync(join(i.old.state, "changes", "abcdefghijklmnopqrst", "objects"), { recursive: true, mode: 0o700 });
    for (const d of ["changes", "changes/abcdefghijklmnopqrst", "changes/abcdefghijklmnopqrst/objects"]) chmodSync(join(i.old.state, d), 0o700);
    symlinkSync("/nonexistent", join(i.old.state, "changes", "abcdefghijklmnopqrst", "objects", "info"));
    const before = snapshot(i.old.state);
    const l = lines();
    const r = await moveOldFolders(opts(i, l, { rename: failingRename("EXDEV", i.old.state) }));
    expect(r.state).toBe("failed");
    expect(l.err).toHaveLength(1);
    expect(l.err[0]).toStartWith(`could not move ${i.old.state} to ${i.now.state} (`);
    expect(snapshot(i.old.state)).toEqual(before);
    expect(readdirSync(i.bases.state)).toEqual([LEGACY_FOLDER]);
  });

  test("a crash during an earlier copy: its staging folder goes at the next start, and the move happens", async () => {
    const i = smallOld("stale");
    const stale = join(i.bases.state, ".kitespan-move-Ab12Cd");
    mkdirSync(join(stale, "chats"), { recursive: true, mode: 0o700 });
    writeFileSync(join(stale, "settings.json"), "{}", { mode: 0o600 });
    expect(productFolder("state", i.bases.state)).toBe(i.old.state);
    const r = await moveOldFolders(opts(i, lines()));
    expect(r.state).toBe("moved");
    expect(readdirSync(i.bases.state).sort()).toEqual([LEGACY_FOLDER, FOLDER_NAME].sort());
  });

  test("a cross-device copy: the switch is on disk (its folder synced) before the first entry of the old folder goes", async () => {
    const i = smallOld("switch-synced");
    const before = snapshot(i.old.state);
    let switched = false;
    // Set by the hook below (a closure), so its type is said here.
    let wholeAtSync = null as boolean | null;
    const r = await moveOldFolders(
      opts(i, lines(), {
        rename: async (a, b) => {
          if (a === i.old.state) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
          await rename(a, b);
          if (b === i.now.state) switched = true;
        },
        syncDir: async (dir) => {
          if (!switched || dir !== i.bases.state || wholeAtSync !== null) return;
          try {
            wholeAtSync = Bun.deepEquals(snapshot(i.old.state), before);
          } catch {
            wholeAtSync = false;
          }
        },
      }),
    );
    expect(r.state).toBe("copied");
    expect(wholeAtSync).toBe(true);
    expect(isNote(i.old.state, i.now.state)).toBe(true);
  });

  test("a copy whose switch a crash lost after the old folder began to empty: the next start deletes neither folder and says so", async () => {
    const i = smallOld("lost-switch");
    const stale = join(i.bases.state, ".kitespan-move-Ab12Cd");
    mine(i.root, stale);
    // What the crash left: the whole checked copy under its staging name, and an old folder that had begun to empty.
    Bun.spawnSync(["cp", "-a", i.old.state, stale]);
    const all = [...snapshot(stale).keys()];
    for (const rel of ["settings.json", join("uploads", "u-abc123", "a.txt")]) rmSync(join(i.old.state, rel));
    const l = lines();
    const r = await moveOldFolders(opts(i, l, { rename: failingRename("EXDEV", i.old.state) }));
    expect(r).toEqual({ state: "failed", config: "skipped", data: "skipped", refuse: null });
    expect(l.err).toEqual([`could not move ${i.old.state} to ${i.now.state} (${stale} holds files from an earlier start that ${i.old.state} does not), so kitespan uses ${i.old.state} this time.`]);
    // No file is lost: every entry is still in the copy, and the old folder keeps what it had.
    expect([...snapshot(stale).keys()]).toEqual(all);
    expect(existsSync(join(i.old.state, "chats"))).toBe(true);
    expect(existsSync(i.now.state)).toBe(false);
  });

  test("a crash after the switch, before the old folder went: both are there, the new one is used, the old one untouched", async () => {
    const i = smallOld("after-switch");
    const before = snapshot(i.old.state);
    // What the switch left: a whole copy at the new name.
    Bun.spawnSync(["cp", "-a", i.old.state, i.now.state]);
    const l = lines();
    expect((await moveOldFolders(opts(i, l))).state).toBe("both");
    expect(l.err).toHaveLength(1);
    expect(snapshot(i.old.state)).toEqual(before);
  });

  test("a crash before the note: the new folder and nothing at the old name; nothing is said", async () => {
    const i = smallOld("before-note");
    await rename(i.old.state, i.now.state);
    const l = lines();
    expect((await moveOldFolders(opts(i, l))).state).toBe("none");
    expect(l.err.filter((e) => e.includes(i.bases.state))).toEqual([]);
    expect(existsSync(i.old.state)).toBe(false);
  });
});

describe("what is not moved", () => {
  test("a state folder that fails the store's checks stays, and the store then refuses it by its own path", async () => {
    const i = smallOld("wide");
    chmodSync(i.old.state, 0o755);
    const l = lines();
    const r = await moveOldFolders(opts(i, l));
    expect(r.state).toBe("stays");
    expect(r.config).toBe("skipped");
    expect([l.out, l.err]).toEqual([[], []]);
    expect(lstatSync(i.old.state).isDirectory()).toBe(true);
    const store = createStore({ env: i.env, home: i.home, tmpRoot: join(i.root, "tmp") });
    await expect(store.open()).rejects.toThrow("failed its checks");
    expect(store.dirs.state).toBe(i.old.state);
  });

  test("a state folder that is a symbolic link: the start is refused with one line (the old build refused it too)", async () => {
    const i = install("link");
    mkdirSync(join(i.root, "real-state"), { mode: 0o700 });
    symlinkSync(join(i.root, "real-state"), i.old.state);
    const r = await moveOldFolders(opts(i, lines()));
    expect(r.state).toBe("refused");
    expect(r.refuse).toBe(`${i.old.state} is a symbolic link, so it is not moved: move its folder to ${i.now.state}, then start kitespan again.`);
    expect(lstatSync(i.old.state).isSymbolicLink()).toBe(true);
    expect(existsSync(i.now.state)).toBe(false);
  });

  test("a config folder that is a link to a folder: the link itself is renamed", async () => {
    const i = install("config-link");
    mkdirSync(i.old.state, { mode: 0o700 });
    mkdirSync(join(i.root, "dotfiles"), { mode: 0o700 });
    writeFileSync(join(i.root, "dotfiles", "start-env"), "\n", { mode: 0o600 });
    symlinkSync(join(i.root, "dotfiles"), i.old.config);
    expect((await moveOldFolders(opts(i, lines()))).config).toBe("moved");
    expect(lstatSync(i.now.config).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(i.now.config, "start-env"), "utf8")).toBe("\n");
  });

  test("the data folder stays while it holds a worktree made under it or a record in the making, and moves once it holds none", async () => {
    for (const leftover of ["abcdefgh", "abcdefgh.making"]) {
      const i = smallOld(`data-${leftover.replace(".", "-")}`);
      const p = join(i.old.data, "worktrees", "k3m7q2x4ab");
      mkdirSync(p, { mode: 0o700 });
      if (leftover.endsWith(".making")) writeFileSync(join(p, leftover), "{}", { mode: 0o600 });
      else mkdirSync(join(p, leftover));
      const l = lines();
      const r = await moveOldFolders(opts(i, l));
      expect([r.state, r.config, r.data]).toEqual(["moved", "moved", "stays"]);
      expect(l.out).toHaveLength(2);
      expect(lstatSync(i.old.data).isDirectory()).toBe(true);
      expect(productFolder("data", i.bases.data)).toBe(i.old.data);
      expect(projectRecordsThere(i.bases.data, "k3m7q2x4ab")).toBe(p);
    }
  });

  test("a live user of the old folder: bin/update.sh's lock, or a process of this user inside it (Linux), keeps it in place this time", async () => {
    const i = smallOld("busy");
    const lock = await takeLock(i.old.state);
    const l = lines();
    expect((await moveOldFolders(opts(i, l))).state).toBe("failed");
    expect(l.err[0]).toContain("an update runs");
    await lock!.release();
    if (existsSync("/proc/self/cwd")) {
      const sleeper = Bun.spawn(["sleep", "30"], { cwd: join(i.old.state, "chats"), stdout: "ignore", stderr: "ignore" });
      try {
        const l2 = lines();
        const { inUse: _plugged, ...real } = opts(i, l2);
        expect((await moveOldFolders(real)).state).toBe("failed");
        expect(l2.err[0]).toContain(`process ${sleeper.pid} uses it`);
      } finally {
        sleeper.kill("SIGKILL");
        await sleeper.exited;
      }
    }
    expect(lstatSync(i.old.state).isDirectory()).toBe(true);
    expect(existsSync(i.now.state)).toBe(false);
  });

  test.skipIf(!PROCFS)(`another server of this product on the old folders: its command line and its XDG folders count, with no file open there ${LINUX_ONLY}`, async () => {
    const i = smallOld("other-server");
    // A checkout's shape (its start command and server/main.ts), whose server only waits: it opens nothing in the folder.
    const checkout = join(i.root, "checkout");
    mkdirSync(join(checkout, "bin"), { recursive: true });
    mkdirSync(join(checkout, "server"));
    writeFileSync(join(checkout, LEGACY_BIN), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(checkout, "server", "main.ts"), "await Bun.sleep(60_000);\n");
    const serverOn = (xdg: Record<string, string>) =>
      Bun.spawn([process.execPath, "--no-env-file", join(checkout, "server", "main.ts"), "--port", "1"], { cwd: i.root, env: { PATH: "/usr/bin:/bin", HOME: i.home, ...xdg }, stdout: "ignore", stderr: "ignore" });
    const started = async (pid: number) => {
      for (let n = 0; n < 100 && !readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("main.ts"); n++) await Bun.sleep(20);
    };
    const elsewhere = serverOn({ XDG_STATE_HOME: join(i.root, "elsewhere") });
    try {
      const same = serverOn(i.env);
      try {
        await started(same.pid);
        await started(elsewhere.pid);
        const l = lines();
        const { inUse: _plugged, ...real } = opts(i, l);
        expect(await moveOldFolders(real)).toEqual({ state: "failed", config: "skipped", data: "skipped", refuse: null });
        expect(l.err).toEqual([`could not move ${i.old.state} to ${i.now.state} (process ${same.pid} uses it), so kitespan uses ${i.old.state} this time.`]);
      } finally {
        same.kill("SIGKILL");
        await same.exited;
      }
      // A server of this product whose folders are elsewhere is not a user of these.
      const l = lines();
      const { inUse: _plugged, ...real } = opts(i, l);
      expect((await moveOldFolders(real)).state).toBe("moved");
      expect(l.err).toEqual([]);
    } finally {
      elsewhere.kill("SIGKILL");
      await elsewhere.exited;
    }
  });

  test("something that listens on this start's port keeps the folders in place this time (every system)", async () => {
    const i = smallOld("port");
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const l = lines();
      expect(await moveOldFolders(opts(i, l, { port: listener.port }))).toEqual({ state: "failed", config: "skipped", data: "skipped", refuse: null });
      expect(l.err).toEqual([`could not move ${i.old.state} to ${i.now.state} (port ${listener.port} is in use), so kitespan uses ${i.old.state} this time.`]);
    } finally {
      listener.stop(true);
    }
    expect(lstatSync(i.old.state).isDirectory()).toBe(true);
    expect((await moveOldFolders(opts(i, lines(), { port: freePort() }))).state).toBe("moved");
  });
});

describe("one install is the three folders", () => {
  test("two starts at once: the second finds the folders moved and goes on, with no line about a failure", async () => {
    const i = smallOld("race");
    const slow = (ms: number) => async (a: string, b: string) => {
      await Bun.sleep(ms);
      await rename(a, b);
    };
    const la = lines();
    const lb = lines();
    const [ra, rb] = await Promise.all([moveOldFolders(opts(i, la, { rename: slow(10) })), moveOldFolders(opts(i, lb, { rename: slow(60) }))]);
    // Whichever renames first moves the state folder; the other finds it moved. Each folder moves once, and neither
    // start says that a move failed.
    expect([ra.state, rb.state].sort()).toEqual(["moved", "none"]);
    expect([la.err, lb.err]).toEqual([[], []]);
    expect([...la.out, ...lb.out].sort()).toEqual((["state", "config", "data"] as const).map((k) => `kitespan moved ${i.old[k]} to ${i.now[k]}.`).sort());
    for (const k of ["state", "config", "data"] as const) expect(isNote(i.old[k], i.now[k])).toBe(true);
    expect(storeDirs(i.env, i.home).state).toBe(i.now.state);
  });

  test("a scratch state base, with the home folder's old config and data: nothing moves and nothing is said", async () => {
    const i = install("split-xdg");
    const old = { config: join(i.home, ".config", LEGACY_FOLDER), data: join(i.home, ".local", "share", LEGACY_FOLDER) };
    mine(i.root, old.config, old.data);
    for (const d of [join(i.home, ".config"), old.config, join(i.home, ".local"), join(i.home, ".local", "share"), old.data]) mkdirSync(d, { mode: 0o700 });
    writeFileSync(join(old.config, "adapters.json"), "{}", { mode: 0o600 });
    const l = lines();
    const r = await moveOldFolders(opts(i, l, { env: { XDG_STATE_HOME: i.bases.state } }));
    expect(r).toEqual({ state: "none", config: "skipped", data: "skipped", refuse: null });
    expect([l.out, l.err]).toEqual([[], []]);
    expect(lstatSync(old.config).isDirectory()).toBe(true);
    expect(lstatSync(old.data).isDirectory()).toBe(true);
    expect(readdirSync(join(i.home, ".config"))).toEqual([LEGACY_FOLDER]);
  });

  test("a config folder whose move failed after the state folder's: the next start moves it (the state's note names the install)", async () => {
    const i = smallOld("config-waits");
    const first = await moveOldFolders(opts(i, lines(), { rename: failingRename("EACCES", i.old.config) }));
    expect([first.state, first.config, first.data]).toEqual(["moved", "failed", "skipped"]);
    const l = lines();
    expect(await moveOldFolders(opts(i, l))).toEqual({ state: "none", config: "moved", data: "moved", refuse: null });
    expect(l.out).toEqual([`kitespan moved ${i.old.config} to ${i.now.config}.`, `kitespan moved ${i.old.data} to ${i.now.data}.`]);
  });
});

describe("who moves: only a start from the terminal (the real server, on a real-shaped old install)", () => {
  const PORT = freePort();
  const OWN = `http://127.0.0.1:${PORT}`;
  const i = seededOld("server");
  const bin = join(i.root, "bin");
  const dist = join(i.root, "dist");
  mkdirSync(bin);
  mkdirSync(dist);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.311 (Claude Code)"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>kitespan</title>\n");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: i.home,
    CLAUDE_CONFIG_DIR: i.seed.claudeConfig,
    ...i.env,
    TMPDIR: i.seed.tmp,
    SHELL: "/bin/sh",
    [`${LEGACY_FOLDER.toUpperCase()}_PUSH_TEST_ORIGIN`]: "http://127.0.0.1:9",
  };
  mine(i.root, bin, dist, i.seed.tmp, i.seed.claudeConfig);

  /** A server of this test on `port`; with `listens` false, the start is expected to end by itself (its exit code). */
  async function boot(args: string[], port = PORT, listens = true): Promise<{ pid: number; code: number | null; out: string; err: string; stop: () => Promise<void> }> {
    const proc = Bun.spawn([process.execPath, "--no-env-file", MAIN, "--port", String(port), "--dist", dist, ...args], { env, cwd: i.root, stdout: "pipe", stderr: "pipe" });
    let out = "";
    let err = "";
    const pump = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => {
      const rd = s.getReader();
      for (;;) {
        const r = await rd.read().catch(() => ({ done: true as const, value: undefined }));
        if (r.done) break;
        add(new TextDecoder().decode(r.value));
      }
    };
    const pumped = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, (t) => (out += t)), pump(proc.stderr as ReadableStream<Uint8Array>, (t) => (err += t))]);
    const line = `kitespan listens on http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    while (!out.includes(line) && proc.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    const stop = async () => {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited;
    };
    if (!listens) {
      const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => false)]);
      if (!ended) await stop();
      await pumped;
    } else if (!out.includes(line)) {
      await stop();
      throw new Error(`the server did not start:\n${out}\n${err}`);
    }
    return {
      pid: proc.pid,
      get code() {
        return proc.exitCode;
      },
      get out() {
        return out;
      },
      get err() {
        return err;
      },
      stop,
    };
  }
  /** How many of the process's open descriptors lead into `folder` (Linux). */
  const openIn = (pid: number, folder: string) => readdirSync(`/proc/${pid}/fd`).filter((fd) => {
    try {
      const to = readlinkSync(`/proc/${pid}/fd/${fd}`);
      return to === folder || to.startsWith(`${folder}${sep}`);
    } catch {
      return false;
    }
  }).length;
  const get = async (path: string) => (await fetch(`${OWN}${path}`)).json() as Promise<Record<string, unknown>>;

  test("the restart's --check reads the old folder in place and moves nothing", () => {
    const r = Bun.spawnSync([process.execPath, "--no-env-file", MAIN, "--check", "--port", String(PORT), "--dist", dist], { env, cwd: i.root, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(lstatSync(i.old.state).isDirectory()).toBe(true);
    expect(existsSync(i.now.state)).toBe(false);
  });

  test("a restart's successor (--bind-wait) runs on the old folders in place and moves nothing", async () => {
    const s = await boot(["--bind-wait", "0"]);
    try {
      const projects = (await get("/api/projects")).projects as { id: string }[];
      expect(projects.map((p) => p.id)).toContain(IDS.projects.kitespan);
      expect(s.out).not.toContain("kitespan moved");
    } finally {
      await s.stop();
    }
    expect(lstatSync(i.old.state).isDirectory()).toBe(true);
    for (const k of ["state", "config", "data"] as const) expect(existsSync(i.now[k])).toBe(false);
  });

  test("a server that runs on the old folders in place, with no log line yet: a start from the terminal moves nothing, and a busy port ends it", async () => {
    const running = await boot(["--bind-wait", "0"]);
    try {
      // From its boot it holds the state folder open, so another start sees it (Linux), before any log line.
      if (existsSync(`/proc/${running.pid}/fd`)) expect(openIn(running.pid, i.old.state)).toBeGreaterThan(0);
      expect(existsSync(join(i.old.state, "logs", `kitespan-${new Date().toISOString().slice(0, 10)}.log`))).toBe(false);
      const second = await boot([], PORT, false);
      expect(second.code).toBe(1);
      expect(second.out).not.toContain("kitespan moved");
      expect(second.err).toContain(`kitespan: could not move ${i.old.state} to ${i.now.state} (`);
      expect(second.err).toContain(`kitespan: port ${PORT} is in use`);
      if (existsSync(`/proc/${running.pid}/fd`)) {
        // Another port: the running server is still a user of the folders (Linux), so the start runs on them in place.
        const other = await boot([], freePort());
        await other.stop();
        expect(other.out).not.toContain("kitespan moved");
        expect(other.err).toContain(`kitespan: could not move ${i.old.state} to ${i.now.state} (process ${running.pid} uses it), so kitespan uses ${i.old.state} this time.`);
      }
      for (const k of ["state", "config", "data"] as const) {
        expect(lstatSync(i.old[k]).isDirectory()).toBe(true);
        expect(existsSync(i.now[k])).toBe(false);
      }
      // The running server still writes its own folder.
      const post = await fetch(`${OWN}/api/settings`, { method: "POST", headers: { "content-type": "application/json", origin: OWN, "x-kitespan": "1" }, body: JSON.stringify({ "chats.sessionsOpenElsewhere": true }) });
      expect(post.status).toBe(200);
      expect(existsSync(join(i.old.state, "settings.json"))).toBe(true);
    } finally {
      await running.stop();
    }
  });

  test("a start from the terminal moves the three folders, then serves the old chats, uploads, push device and config from the new ones", async () => {
    const s = await boot([]);
    try {
      for (const k of ["state", "config", "data"] as const) expect(s.out).toContain(`kitespan moved ${i.old[k]} to ${i.now[k]}.`);
      // The config moved first, so its hint is the boot's access line.
      expect(s.out).toContain("Open it through the moved config's forward.");
      // The old environment name is read for this release, with one line that names both names and not its value.
      expect(s.err).toContain(`${LEGACY_FOLDER.toUpperCase()}_PUSH_TEST_ORIGIN`);
      expect(s.err).toContain("KITESPAN_PUSH_TEST_ORIGIN");
      expect(s.err).not.toContain("127.0.0.1:9");
      // Every record read back with its checks: nothing was set aside.
      expect(s.err).not.toContain("set aside");
      const projects = (await get("/api/projects")).projects as { id: string }[];
      expect(projects.map((p) => p.id)).toContain(IDS.projects.kitespan);
      const ups = (await get(`/api/chats/${IDS.chats.upload}/uploads`)).uploads as { id: string; path: string; was?: string }[];
      expect(ups.length).toBeGreaterThan(0);
      for (const u of ups) {
        expect(u.path.startsWith(join(i.now.state, "uploads") + sep)).toBe(true);
        // Its path from before the move, which the earlier messages' references hold.
        expect(u.was).toBe(join(i.old.state, relative(i.now.state, u.path)));
        expect((await get(`/api/chats/${IDS.chats.upload}/uploads/${u.id}/exists`)).exists).toBe(true);
      }
      const push = await get("/api/push");
      expect(push.key).toBe(JSON.parse(readFileSync(join(i.now.state, "push-key.json"), "utf8")).publicKey);
      expect((push.devices as unknown[]).length).toBe(1);
      // A page loaded before the restart sends the old header: the sender gate takes it for one release.
      const post = (headers: Record<string, string>) => fetch(`${OWN}/api/restart/cancel`, { method: "POST", headers: { "content-type": "application/json", origin: OWN, ...headers }, body: "{}" });
      expect((await post({ "x-kitespan": "1" })).status).toBe(200);
      expect((await post({ [LEGACY_HEADER]: "1" })).status).toBe(200);
      expect((await post({})).status).toBe(403);
    } finally {
      await s.stop();
    }
    for (const k of ["state", "config", "data"] as const) expect(isNote(i.old[k], i.now[k])).toBe(true);
    expect(readdirSync(join(i.now.state, "logs")).some((n) => /^kitespan-\d{4}-\d{2}-\d{2}\.log$/.test(n))).toBe(true);
  });

  test("the next start finds the new folders and says nothing about the old ones", async () => {
    const s = await boot([]);
    try {
      expect(s.out).not.toContain("kitespan moved");
      expect(s.err).not.toContain(i.old.state);
    } finally {
      await s.stop();
    }
  });
});
