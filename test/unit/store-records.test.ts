// The store's records (DESIGN.md 4.4): the chat ledger with archivedAt (D48), its write rules, Delete (D48),
// projects.json, settings.json and last-options.json, in scratch folders.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreError } from "../../server/store/files";
import { createStore, type StoreOptions } from "../../server/store/store";
import { SETTINGS_DEFAULTS, type ChatLedger, type ProjectRecord, type UploadRecord } from "../../server/store/types";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-records-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => lstatSync(p).mode & 0o777;

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "abcdefghijabcdefghij";
const PROJECT = "k3m7q2x4ab";
const SESSION = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const T = "2026-10-31T12:00:00.000Z";
const T2 = "2026-10-31T12:05:00.000Z";
const MARK = "the user's pick in this chat on 2026-10-31T12:00:00.000Z";
const NO_PICKS = { model: null, effort: null, permissionMode: null };

const ledger = (over: Partial<ChatLedger> = {}): ChatLedger => ({
  v: 1,
  id: CHAT,
  project: PROJECT,
  cwd: "/srv/work/app",
  agent: "claude-code",
  sessionId: null,
  title: null,
  picks: NO_PICKS,
  createdAt: T,
  seenAt: T,
  lastActivityAt: T,
  lastSeq: 0,
  state: "sleeping",
  lastExit: null,
  archivedAt: null,
  ...over,
});

const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: PROJECT,
  cwd: "/srv/work/app",
  name: "app",
  createdAt: T,
  lastUsedAt: T,
  picks: NO_PICKS,
  ...over,
});

async function opened(opts: StoreOptions = {}) {
  const root = opts.root ?? fresh();
  const writes: string[] = [];
  const store = createStore({ ...opts, root, onWrite: (p) => writes.push(p) });
  await store.open();
  return { root, store, writes };
}

const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as StoreError).code;
const fileOf = (root: string, rel: string) => JSON.parse(readFileSync(join(root, "state", rel), "utf8"));

describe("the chat ledger", () => {
  test("a ledger is written 0600 and read back after a restart", async () => {
    const { root, store } = await opened();
    const rec = ledger({ sessionId: SESSION, title: { text: "Fix the build", from: "renamed" }, picks: { model: { value: "claude-haiku-5-5", mark: MARK }, effort: null, permissionMode: { value: "plan", mark: MARK } } });
    await store.writeChat(rec);
    expect(mode(join(store.dirs.chats, `${CHAT}.json`))).toBe(0o600);
    expect(await store.readChat(CHAT)).toEqual(rec);
    const again = await createStore({ root }).open();
    expect(again.chats).toEqual([rec]);
  });

  test("archivedAt is kept and cleared again (D48 Archive and Unarchive)", async () => {
    const { root, store } = await opened();
    await store.writeChat(ledger({ archivedAt: T2 }));
    expect(fileOf(root, `chats/${CHAT}.json`).archivedAt).toBe(T2);
    expect((await createStore({ root }).open()).chats[0]?.archivedAt).toBe(T2);
    await store.writeChat(ledger({ archivedAt: null }));
    expect(fileOf(root, `chats/${CHAT}.json`).archivedAt).toBeNull();
  });

  test("the ids of applied requests are kept, the newest 100; a bad one is refused; a ledger with none reads as it is", async () => {
    const { root, store } = await opened();
    const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    await store.writeChat(ledger({ applied: ids }));
    expect((await createStore({ root }).open()).chats[0]?.applied).toEqual(ids);
    const many = Array.from({ length: 130 }, () => crypto.randomUUID());
    await store.writeChat(ledger({ applied: many }));
    expect(fileOf(root, `chats/${CHAT}.json`).applied).toEqual(many.slice(-100));
    for (const applied of [["not-a-uuid"], "x", [1]]) expect(await code(store.writeChat(ledger({ applied: applied as string[] })))).toBe("bad_value");
    await store.writeChat(ledger());
    expect(await store.readChat(CHAT)).toEqual(ledger());
    expect(Object.keys(fileOf(root, `chats/${CHAT}.json`))).not.toContain("applied");
  });

  test("D58: a copy's ledger keeps the session it copies (copyOf); a bad one is refused; a ledger with none reads as it is", async () => {
    const { root, store } = await opened();
    await store.writeChat(ledger({ sessionId: crypto.randomUUID(), copyOf: SESSION }));
    expect((await createStore({ root }).open()).chats[0]?.copyOf).toBe(SESSION);
    for (const copyOf of ["not-a-uuid", 7, null]) expect(await code(store.writeChat(ledger({ copyOf: copyOf as string })))).toBe("bad_value");
    await store.writeChat(ledger());
    expect(Object.keys(fileOf(root, `chats/${CHAT}.json`))).not.toContain("copyOf");
  });

  test("R15 and R16: the ledger keeps a stop and its chat's claude process; a bad one reads as none, never as a bad ledger", async () => {
    const { root, store } = await opened();
    const stop = { why: "running" as const, by: "crash" as const, at: T2 };
    const proc = { pid: 4242, start: "123456789" };
    await store.writeChat(ledger({ stop, proc }));
    expect(fileOf(root, `chats/${CHAT}.json`)).toMatchObject({ stop, proc });
    expect((await createStore({ root }).open()).chats[0]).toEqual(ledger({ stop, proc }));
    await store.writeChat(ledger({ stop: { ...stop, why: "lost" } as never, proc: { pid: -1, start: "x" } }));
    const file = fileOf(root, `chats/${CHAT}.json`);
    expect(Object.keys(file)).not.toContain("stop");
    expect(Object.keys(file)).not.toContain("proc");
  });

  test("L16: the ledger keeps the hand-over's time; a bad one reads as none, never as a bad ledger", async () => {
    const { root, store } = await opened();
    await store.writeChat(ledger({ handedAt: T2 }));
    expect((await createStore({ root }).open()).chats[0]).toEqual(ledger({ handedAt: T2 }));
    await store.writeChat(ledger({ handedAt: "yesterday" }));
    expect(Object.keys(fileOf(root, `chats/${CHAT}.json`))).not.toContain("handedAt");
  });

  test("FIX-W25b 1.5: the ledger keeps its session's transcript flag; a bad one, or one with no session, reads as none", async () => {
    const { root, store } = await opened();
    await store.writeChat(ledger({ sessionId: SESSION, transcript: true }));
    expect(fileOf(root, `chats/${CHAT}.json`).transcript).toBe(true);
    expect((await createStore({ root }).open()).chats[0]).toEqual(ledger({ sessionId: SESSION, transcript: true }));
    for (const [sessionId, transcript] of [
      [SESSION, "yes"],
      [SESSION, false],
      [null, true],
    ] as const) {
      await store.writeChat({ ...ledger({ sessionId }), transcript } as ChatLedger);
      expect(Object.keys(fileOf(root, `chats/${CHAT}.json`))).not.toContain("transcript");
      expect((await createStore({ root }).open()).chats[0]).toEqual(ledger({ sessionId }));
    }
  });

  test("row 116: the ledger keeps the seen flag, written at once (not with the activity fields); a bad one reads as seen", async () => {
    const { root, store } = await opened({ activityWriteMs: 60_000 });
    await store.writeChat(ledger());
    for (const unseen of ["done", "failed"] as const) {
      await store.writeChat(ledger({ unseen }));
      expect(fileOf(root, `chats/${CHAT}.json`).unseen).toBe(unseen);
      expect((await createStore({ root }).open()).chats[0]).toEqual(ledger({ unseen }));
    }
    await store.writeChat(ledger());
    expect(Object.keys(fileOf(root, `chats/${CHAT}.json`))).not.toContain("unseen");
    for (const unseen of ["unread", true, null, 1]) {
      await store.writeChat({ ...ledger(), unseen } as unknown as ChatLedger);
      expect(Object.keys(fileOf(root, `chats/${CHAT}.json`))).not.toContain("unseen");
    }
    // A file that a later build wrote with another value still opens, as seen.
    writeFileSync(join(root, "state", "chats", `${CHAT}.json`), JSON.stringify({ ...ledger(), unseen: "later" }), { mode: 0o600 });
    expect((await createStore({ root }).open()).chats).toEqual([ledger()]);
  });

  test("a longer title is cut to 120 when it is stored", async () => {
    const { store } = await opened();
    await store.writeChat(ledger({ title: { text: "t".repeat(130), from: "generated" } }));
    expect((await store.readChat(CHAT))?.title?.text).toBe("t".repeat(120));
  });

  test("a bad record is refused and never written", async () => {
    const { store } = await opened();
    const bad: Partial<ChatLedger>[] = [
      { id: "NOT-AN-ID" },
      { project: "k3m7q2x9ab" },
      { cwd: "relative/path" },
      { cwd: "/srv/a\nb" },
      { cwd: `/${"a".repeat(4096)}` },
      { sessionId: "not-a-uuid" },
      { state: "dreaming" as never },
      { lastSeq: -1 },
      { lastSeq: 1.5 },
      { createdAt: "yesterday" },
      { archivedAt: "2026-10-31 12:00" },
      { picks: { model: null, effort: { value: "huge", mark: MARK }, permissionMode: null } },
      { picks: { model: { value: "m", mark: "" }, effort: null, permissionMode: null } },
      { lastExit: { code: null, signal: "kill -9", at: T } },
      { title: { text: "", from: "renamed" } },
      { title: { text: "a\u202eb", from: "renamed" } },
    ];
    for (const over of bad) expect(await code(store.writeChat(ledger(over)))).toBe("bad_value");
    expect(readdirSync(store.dirs.chats)).toEqual([]);
  });

  test("readChat of an id that is not a chat id is null and builds no path", async () => {
    const { store } = await opened();
    expect(await store.readChat("../../etc/passwd")).toBeNull();
    expect(await store.readChat(CHAT)).toBeNull();
  });

  test("unknown fields are dropped on the way in", async () => {
    const { root, store } = await opened();
    await store.writeChat({ ...ledger(), text: "the user's prompt" } as ChatLedger);
    expect(Object.keys(fileOf(root, `chats/${CHAT}.json`))).not.toContain("text");
  });

  test("a change of seenAt, lastActivityAt or lastSeq alone is written at most once per window; flush writes it", async () => {
    let now = 1_000_000;
    const { root, store, writes } = await opened({ now: () => now, activityWriteMs: 30_000 });
    await store.writeChat(ledger());
    expect(writes).toEqual([`chats/${CHAT}.json`]);
    now += 1_000;
    await store.writeChat(ledger({ seenAt: T2, lastActivityAt: T2, lastSeq: 7 }));
    expect(writes.length).toBe(1);
    expect((await store.readChat(CHAT))?.lastSeq).toBe(7);
    expect(fileOf(root, `chats/${CHAT}.json`).lastSeq).toBe(0);
    await store.flush();
    expect(writes.length).toBe(2);
    expect(fileOf(root, `chats/${CHAT}.json`).lastSeq).toBe(7);
  });

  test("any other change is written at once, with the activity that waited", async () => {
    let now = 1_000_000;
    const { root, store, writes } = await opened({ now: () => now, activityWriteMs: 30_000 });
    await store.writeChat(ledger());
    now += 1_000;
    await store.writeChat(ledger({ lastSeq: 3 }));
    expect(writes.length).toBe(1);
    await store.writeChat(ledger({ lastSeq: 4, state: "idle" }));
    expect(writes.length).toBe(2);
    expect(fileOf(root, `chats/${CHAT}.json`)).toMatchObject({ lastSeq: 4, state: "idle" });
  });

  test("after the window an activity change goes out on its own timer", async () => {
    const { root, store, writes } = await opened({ activityWriteMs: 40 });
    await store.writeChat(ledger());
    await store.writeChat(ledger({ lastSeq: 9 }));
    expect(writes.length).toBe(1);
    for (let i = 0; i < 100 && writes.length < 2; i++) await Bun.sleep(20);
    expect(writes.length).toBe(2);
    expect(fileOf(root, `chats/${CHAT}.json`).lastSeq).toBe(9);
  });

  test("two writes at once both land, in call order", async () => {
    const { root, store } = await opened();
    await Promise.all([store.writeChat(ledger({ state: "starting" })), store.writeChat(ledger({ state: "idle" }))]);
    expect(fileOf(root, `chats/${CHAT}.json`).state).toBe("idle");
    expect(readdirSync(join(root, "state", "chats"))).toEqual([`${CHAT}.json`]);
  });
});

describe("Delete (D48)", () => {
  const upload = (id: string, chat: string | null): UploadRecord => ({
    v: 1,
    id,
    chat,
    project: PROJECT,
    name: "notes.txt",
    size: 3,
    type: "text/plain",
    path: `/tmp/kitespan-uploads-x/u-AbC123/notes.txt`,
    folder: "temp",
    dir: `/tmp/kitespan-uploads-x/u-AbC123`,
    at: T,
  });

  test("unlinks the ledger and the draft and forgets the chat's upload records; the rest stays", async () => {
    const { root, store } = await opened();
    await store.writeChat(ledger());
    await store.writeChat(ledger({ id: OTHER }));
    store.saveDraft({ v: 1, id: CHAT, rev: 1, text: "hello", mode: "chat", command: null, link: false, uploads: [], by: null, at: T });
    await store.flush();
    await store.putUpload(upload("aaaaaaaaaaaaaaaa", CHAT));
    await store.putUpload(upload("bbbbbbbbbbbbbbbb", OTHER));
    expect(existsSync(join(store.dirs.drafts, `${CHAT}.json`))).toBe(true);
    await store.deleteChat(CHAT);
    expect(readdirSync(store.dirs.chats)).toEqual([`${OTHER}.json`]);
    expect(readdirSync(store.dirs.drafts)).toEqual([]);
    expect(await store.readChat(CHAT)).toBeNull();
    expect(await store.listUploads(CHAT)).toEqual([]);
    expect((await store.listUploads(OTHER)).map((u) => u.id)).toEqual(["bbbbbbbbbbbbbbbb"]);
    const again = await createStore({ root }).open();
    expect(again.chats.map((c) => c.id)).toEqual([OTHER]);
  });

  test("iteration 7: the browser pane's own upload has no chat and no project, kept over a reopen; a chat's upload names its project", async () => {
    const { root, store } = await opened();
    await store.putUpload({ ...upload("cccccccccccccccc", null), project: null });
    expect(await code(store.putUpload({ ...upload("dddddddddddddddd", CHAT), project: null }))).toBe("bad_value");
    // The project's removal takes the form's uploads, never the browser's.
    await store.removeProject(PROJECT);
    expect((await store.listUploads(null)).map((u) => [u.id, u.project])).toEqual([["cccccccccccccccc", null]]);
    const again = createStore({ root });
    await again.open();
    expect((await again.listUploads(null)).map((u) => u.id)).toEqual(["cccccccccccccccc"]);
  });

  test("a pending draft or ledger write never brings a deleted chat back", async () => {
    let now = 1_000_000;
    const { store } = await opened({ now: () => now, activityWriteMs: 30_000 });
    await store.writeChat(ledger());
    now += 1_000;
    await store.writeChat(ledger({ lastSeq: 5 }));
    store.saveDraft({ v: 1, id: CHAT, rev: 1, text: "typing", mode: "chat", command: null, link: false, uploads: [], by: null, at: T });
    await store.deleteChat(CHAT);
    await store.writeChat(ledger({ state: "ending" }));
    store.saveDraft({ v: 1, id: CHAT, rev: 2, text: "late", mode: "chat", command: null, link: false, uploads: [], by: null, at: T });
    await store.flush();
    await Bun.sleep(20);
    expect(readdirSync(store.dirs.chats)).toEqual([]);
    expect(readdirSync(store.dirs.drafts)).toEqual([]);
    expect(await store.readChat(CHAT)).toBeNull();
  });

  test("deleting a chat with no files is fine; a bad id is refused", async () => {
    const { store } = await opened();
    await store.deleteChat(CHAT);
    expect(await code(store.deleteChat("../x"))).toBe("bad_value");
  });
});

describe("projects.json", () => {
  test("add, replace by id, and read after a restart", async () => {
    const { root, store } = await opened();
    await store.putProject(project());
    await store.putProject(project({ id: "abcdefghij", cwd: "/srv/work/api", name: "api" }));
    await store.putProject(project({ name: "app renamed", lastUsedAt: T2 }));
    expect((await store.listProjects()).map((p) => p.name)).toEqual(["app renamed", "api"]);
    expect(mode(join(root, "state", "projects.json"))).toBe(0o600);
    expect(fileOf(root, "projects.json").v).toBe(1);
    const again = createStore({ root });
    await again.open();
    expect((await again.listProjects()).map((p) => p.id)).toEqual([PROJECT, "abcdefghij"]);
  });

  test("a remembered plan mode is refused (D11), and so is a second project for one folder", async () => {
    const { store } = await opened();
    expect(await code(store.putProject(project({ picks: { model: null, effort: null, permissionMode: { value: "plan", mark: MARK } } })))).toBe("bad_value");
    await store.putProject(project({ picks: { model: null, effort: null, permissionMode: { value: "acceptEdits", mark: MARK } } }));
    expect(await code(store.putProject(project({ id: "abcdefghij" })))).toBe("bad_value");
    expect(await code(store.putProject(project({ name: "n".repeat(81) })))).toBe("bad_value");
    expect((await store.listProjects()).length).toBe(1);
  });

  test("a file that holds a plan pick fails its read check", async () => {
    const root = fresh();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const p = project({ picks: { model: null, effort: null, permissionMode: { value: "plan", mark: MARK } } });
    writeFileSync(join(root, "state", "projects.json"), JSON.stringify({ v: 1, projects: [p] }), { mode: 0o600 });
    const store = createStore({ root });
    expect((await store.open()).setAside).toEqual(["projects.json"]);
    expect(await store.listProjects()).toEqual([]);
  });

  test("a returned list is a copy", async () => {
    const { store } = await opened();
    await store.putProject(project());
    const list = await store.listProjects();
    list[0]!.name = "changed";
    expect((await store.listProjects())[0]?.name).toBe("app");
  });
});

describe("settings.json", () => {
  test("every default when the file is absent", async () => {
    const { store } = await opened();
    expect(await store.readSettings()).toEqual(SETTINGS_DEFAULTS);
  });

  test("a change is merged, written 0600 with only the keys set, and kept after a restart", async () => {
    const { root, store } = await opened();
    const s = await store.writeSettings({ "chats.maxLive": 3, "appearance.look": "editor", "chats.untypedMethods.cancelAsyncMessage": false });
    expect(s).toEqual({ ...SETTINGS_DEFAULTS, "chats.maxLive": 3, "appearance.look": "editor", "chats.untypedMethods.cancelAsyncMessage": false });
    expect(fileOf(root, "settings.json")).toEqual({ "chats.maxLive": 3, "appearance.look": "editor", "chats.untypedMethods.cancelAsyncMessage": false });
    expect(mode(join(root, "state", "settings.json"))).toBe(0o600);
    const again = createStore({ root });
    await again.open();
    expect((await again.readSettings())["chats.maxLive"]).toBe(3);
  });

  test("undefined puts a key back to its default", async () => {
    const { store } = await opened();
    await store.writeSettings({ "chats.maxLive": 3 });
    expect((await store.writeSettings({ "chats.maxLive": undefined }))["chats.maxLive"]).toBe(10);
  });

  test("an unknown key or a bad value is refused and changes nothing", async () => {
    const { store } = await opened();
    await store.writeSettings({ "chats.maxLive": 3 });
    const bad: Record<string, unknown>[] = [
      { "server.port": 8080 },
      { "chats.maxLive": 0 },
      { "chats.keepIdleMinutes": -1 },
      { "chats.keepIdleMinutes": 1.5 },
      { "chats.bashReply": "sometimes" },
      { "claudeCode.prefer": "bundled" },
      { "uploads.folder": "desktop" },
      { "uploads.maxMB": 0 },
      { "uploads.customFolder": "relative" },
      { "chats.untypedMethods.cancelAsyncMessage": "yes" },
      { "chats.untypedMethods.": true },
      { "chats.maxLive": 4, "chats.allowBypass": "on" },
    ];
    for (const change of bad) expect(await code(store.writeSettings(change as never))).toBe("bad_value");
    expect((await store.readSettings())["chats.maxLive"]).toBe(3);
  });

  test("a custom upload folder is stored as its real path, and a missing one is refused", async () => {
    const { root, store } = await opened();
    const real = join(root, "real-folder");
    mkdirSync(real, { mode: 0o755 });
    symlinkSync(real, join(root, "link-folder"));
    const s = await store.writeSettings({ "uploads.folder": "custom", "uploads.customFolder": join(root, "link-folder") });
    // The temporary folder itself may sit behind a link (macOS's /var, a linked home folder): the real path is past both.
    expect(s["uploads.customFolder"]).toBe(realpathSync(real));
    expect(await code(store.writeSettings({ "uploads.customFolder": join(root, "no-such-folder") }))).toBe("bad_value");
    writeFileSync(join(root, "a-file"), "x");
    expect(await code(store.writeSettings({ "uploads.customFolder": join(root, "a-file") }))).toBe("bad_value");
    expect((await store.writeSettings({ "uploads.customFolder": null }))["uploads.customFolder"]).toBeNull();
  });

  test("a key that this version does not know is dropped from the file it reads", async () => {
    const root = fresh();
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(join(root, "state", "settings.json"), JSON.stringify({ "chats.maxLive": 4, "old.removed": true }), { mode: 0o600 });
    const store = createStore({ root });
    expect((await store.open()).setAside).toEqual([]);
    const s = await store.readSettings();
    expect(s["chats.maxLive"]).toBe(4);
    expect("old.removed" in s).toBe(false);
  });

  test("a write of a look this version does not know is refused, and the kept look stays", async () => {
    const { root, store } = await opened();
    expect((await store.writeSettings({ "appearance.look": "mono" }))["appearance.look"]).toBe("mono");
    for (const look of ["noir", "solarized", "Glass", "constructor", 1]) expect(await code(store.writeSettings({ "appearance.look": look as never }))).toBe("bad_value");
    expect(fileOf(root, "settings.json")).toEqual({ "appearance.look": "mono" });
    expect((await store.readSettings())["appearance.look"]).toBe("mono");
  });
});

describe("last-options.json", () => {
  test("written 0600, callbacks as [function], replaced at the next start", async () => {
    const { root, store } = await opened();
    const opts = { cwd: "/srv/work/app", model: "claude-haiku-5-5", canUseTool: async () => ({ behavior: "allow" }), includePartialMessages: true };
    await store.writeLastOptions({ v: 1, writtenAt: T, sdk: "0.3.322", chat: CHAT, options: opts, marks: { model: MARK } });
    const f = fileOf(root, "last-options.json");
    expect(f).toEqual({ v: 1, writtenAt: T, sdk: "0.3.322", chat: CHAT, options: { cwd: "/srv/work/app", model: "claude-haiku-5-5", canUseTool: "[function]", includePartialMessages: true }, marks: { model: MARK } });
    expect(mode(join(root, "state", "last-options.json"))).toBe(0o600);
    await store.writeLastOptions({ v: 1, writtenAt: T2, sdk: "0.3.322", chat: OTHER, options: {}, marks: {} });
    expect(fileOf(root, "last-options.json").chat).toBe(OTHER);
    expect(readdirSync(join(root, "state")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a bad record is refused", async () => {
    const { store } = await opened();
    expect(await code(store.writeLastOptions({ v: 1, writtenAt: T, sdk: "0.3.322", chat: "x", options: {}, marks: {} }))).toBe("bad_value");
  });
});
