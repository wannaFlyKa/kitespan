// The store's boot (DESIGN.md 4.4, "Where the files are"): the XDG folders, the folders made 0700, the refusal of a
// wider mode, another owner or a symbolic link anywhere under the state folder, the tmp sweep and the `.bad` list.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreError } from "../../server/store/files";
import { createStore, storeDirs } from "../../server/store/store";
import type { ChatLedger } from "../../server/store/types";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-open-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => lstatSync(p).mode & 0o777;

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const T = "2026-10-31T12:00:00.000Z";
const ledger = (over: Partial<ChatLedger> = {}): ChatLedger => ({
  v: 1,
  id: CHAT,
  project: "k3m7q2x4ab",
  cwd: "/srv/work/app",
  agent: "claude-code",
  sessionId: null,
  title: null,
  picks: { model: null, effort: null, permissionMode: null },
  createdAt: T,
  seenAt: T,
  lastActivityAt: T,
  lastSeq: 0,
  state: "sleeping",
  lastExit: null,
  archivedAt: null,
  ...over,
});

async function refusal(root: string) {
  const err = await createStore({ root })
    .open()
    .catch((e) => e);
  expect(err).toBeInstanceOf(StoreError);
  expect((err as StoreError).code).toBe("refused");
  return (err as StoreError).problems;
}

describe("the folders", () => {
  test("XDG_STATE_HOME and XDG_CONFIG_HOME when absolute, else the defaults under the home folder", () => {
    const home = "/srv/people/dev";
    expect(storeDirs({}, home)).toEqual({
      state: "/srv/people/dev/.local/state/kitespan",
      config: "/srv/people/dev/.config/kitespan",
      chats: "/srv/people/dev/.local/state/kitespan/chats",
      drafts: "/srv/people/dev/.local/state/kitespan/drafts",
      notes: "/srv/people/dev/.local/state/kitespan/notes",
      uploads: "/srv/people/dev/.local/state/kitespan/uploads",
      logs: "/srv/people/dev/.local/state/kitespan/logs",
      queue: "/srv/people/dev/.local/state/kitespan/queue",
      env: "/srv/people/dev/.local/state/kitespan/env",
      side: "/srv/people/dev/.local/state/kitespan/side",
      changes: "/srv/people/dev/.local/state/kitespan/changes",
    });
    const d = storeDirs({ XDG_STATE_HOME: "/var/state", XDG_CONFIG_HOME: "/etc/conf" }, home);
    expect(d.state).toBe("/var/state/kitespan");
    expect(d.config).toBe("/etc/conf/kitespan");
    const rel = storeDirs({ XDG_STATE_HOME: "relative/state", XDG_CONFIG_HOME: "" }, home);
    expect(rel.state).toBe("/srv/people/dev/.local/state/kitespan");
    expect(rel.config).toBe("/srv/people/dev/.config/kitespan");
  });

  test("open() makes the state folder and its eight folders 0700, and nothing in the config folder", async () => {
    const root = fresh();
    const store = createStore({ root });
    const res = await store.open();
    expect(res).toEqual({ chats: [], setAside: [], swept: 0 });
    for (const d of [store.dirs.state, store.dirs.chats, store.dirs.drafts, store.dirs.notes, store.dirs.uploads, store.dirs.logs, store.dirs.queue, store.dirs.env, store.dirs.side]) {
      expect(lstatSync(d).isDirectory()).toBe(true);
      expect(mode(d)).toBe(0o700);
    }
    expect(existsSync(store.dirs.config)).toBe(false);
  });

  test("the store refuses work before open()", async () => {
    const store = createStore({ root: fresh() });
    expect(((await store.readChat(CHAT).catch((e) => e)) as StoreError).code).toBe("not_open");
    expect(() => store.saveDraft({} as never)).toThrow("not open");
  });
});

describe("refusals", () => {
  test("a state folder made first at 0755 is refused, and so is one of its folders", async () => {
    const root = fresh();
    mkdirSync(join(root, "state", "chats"), { recursive: true, mode: 0o700 });
    chmodSync(join(root, "state"), 0o755);
    chmodSync(join(root, "state", "chats"), 0o750);
    expect(await refusal(root)).toEqual([
      { path: ".", why: "wider-mode" },
      { path: "chats", why: "wider-mode" },
    ]);
  });

  test("a mark's working files at git's own mode do not refuse the boot; the mark folder's own mode still counts (U1 review)", async () => {
    // A mark's private index, git's lock of it and the pathspec file live in changes/<chat>/mark/ while it runs; git
    // writes the lock at 0644 under a 022 umask, and a crash or a kill during a mark leaves them there.
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    const work = join(store.dirs.changes, CHAT, "mark");
    mkdirSync(work, { recursive: true, mode: 0o700 });
    for (const name of ["index", "index.lock", "pathspec"]) {
      writeFileSync(join(work, name), "x");
      chmodSync(join(work, name), 0o644);
    }
    const again = createStore({ root });
    await again.open();
    chmodSync(work, 0o755);
    expect(await refusal(root)).toEqual([{ path: `changes/${CHAT}/mark`, why: "wider-mode" }]);
  });

  test("a ledger file with a group or other bit is refused", async () => {
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    await store.writeChat(ledger());
    chmodSync(join(store.dirs.chats, `${CHAT}.json`), 0o644);
    expect(await refusal(root)).toEqual([{ path: `chats/${CHAT}.json`, why: "wider-mode" }]);
  });

  test("a symbolic link in the place of a folder or a file is refused, and its target is not touched", async () => {
    const root = fresh();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(root, "state"), { mode: 0o700 });
    symlinkSync(elsewhere, join(root, "state", "drafts"));
    writeFileSync(join(elsewhere, "settings.json"), "{}", { mode: 0o600 });
    symlinkSync(join(elsewhere, "settings.json"), join(root, "state", "settings.json"));
    expect(await refusal(root)).toEqual([
      { path: "drafts", why: "symlink" },
      { path: "settings.json", why: "symlink" },
    ]);
    expect(readdirSync(elsewhere)).toEqual(["settings.json"]);
  });

  test("a state folder that is a symbolic link is refused", async () => {
    const root = fresh();
    mkdirSync(join(root, "real"), { mode: 0o700 });
    symlinkSync(join(root, "real"), join(root, "state"));
    expect(await refusal(root)).toEqual([{ path: ".", why: "symlink" }]);
  });

  test("a file in the place of a folder is named", async () => {
    const root = fresh();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(join(root, "state", "chats"), "", { mode: 0o600 });
    expect(await refusal(root)).toEqual([{ path: "chats", why: "not-a-folder" }]);
  });
});

describe("the boot reads", () => {
  test("stray *.tmp files are swept and the files beside them are intact", async () => {
    const root = fresh();
    const first = createStore({ root });
    await first.open();
    await first.writeChat(ledger());
    await first.putProject({ id: "k3m7q2x4ab", cwd: "/srv/work/app", name: "app", createdAt: T, lastUsedAt: T, picks: { model: null, effort: null, permissionMode: null } });
    writeFileSync(join(first.dirs.state, ".projects.json.0123456789abcdef.tmp"), '{"v":1,"proj', { mode: 0o600 });
    writeFileSync(join(first.dirs.chats, `.${CHAT}.json.fedcba9876543210.tmp`), "{", { mode: 0o600 });
    const second = createStore({ root });
    const res = await second.open();
    expect(res.swept).toBe(2);
    expect(res.chats.map((c) => c.id)).toEqual([CHAT]);
    expect((await second.listProjects()).map((p) => p.name)).toEqual(["app"]);
    expect(readdirSync(second.dirs.chats)).toEqual([`${CHAT}.json`]);
  });

  test("a ledger that fails its check is set aside as .bad and reported once; the others are read", async () => {
    const root = fresh();
    const first = createStore({ root });
    await first.open();
    const other = "abcdefghijabcdefghij";
    await first.writeChat(ledger());
    await first.writeChat(ledger({ id: other }));
    writeFileSync(join(first.dirs.chats, `${other}.json`), "{torn", { mode: 0o600 });
    const second = createStore({ root });
    const res = await second.open();
    expect(res.chats.map((c) => c.id)).toEqual([CHAT]);
    expect(res.setAside).toEqual([`chats/${other}.json`]);
    expect(readdirSync(second.dirs.chats).sort()).toEqual([`${other}.json.bad`, `${CHAT}.json`].sort());
    const third = await createStore({ root }).open();
    expect(third.setAside).toEqual([]);
    expect(third.chats.map((c) => c.id)).toEqual([CHAT]);
  });

  test("a ledger whose id is not its file name is set aside", async () => {
    const root = fresh();
    const first = createStore({ root });
    await first.open();
    await first.writeChat(ledger());
    const other = "abcdefghijabcdefghij";
    writeFileSync(join(first.dirs.chats, `${other}.json`), readFileSync(join(first.dirs.chats, `${CHAT}.json`)), { mode: 0o600 });
    const res = await createStore({ root }).open();
    expect(res.setAside).toEqual([`chats/${other}.json`]);
    expect(res.chats.map((c) => c.id)).toEqual([CHAT]);
  });

  test("bad projects.json and settings.json are set aside and read as empty and as the defaults", async () => {
    const root = fresh();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(join(root, "state", "projects.json"), '{"v":1,"projects":[{"id":"BAD"}]}', { mode: 0o600 });
    writeFileSync(join(root, "state", "settings.json"), '{"chats.maxLive":0}', { mode: 0o600 });
    const store = createStore({ root });
    const res = await store.open();
    expect(res.setAside.sort()).toEqual(["projects.json", "settings.json"]);
    expect(await store.listProjects()).toEqual([]);
    expect((await store.readSettings())["chats.maxLive"]).toBe(10);
    expect(existsSync(join(root, "state", "projects.json.bad"))).toBe(true);
  });

  test("names in chats/ that are not ledgers are left alone", async () => {
    const root = fresh();
    const store = createStore({ root });
    await store.open();
    writeFileSync(join(store.dirs.chats, "README"), "x", { mode: 0o600 });
    writeFileSync(join(store.dirs.chats, "ABC.json"), "x", { mode: 0o600 });
    const res = await createStore({ root }).open();
    expect(res).toEqual({ chats: [], setAside: [], swept: 0 });
    expect(readdirSync(store.dirs.chats).sort()).toEqual(["ABC.json", "README"]);
  });
});
