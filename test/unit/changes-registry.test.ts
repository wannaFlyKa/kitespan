// U1 (DESIGN-U1 4.1, 5 and 18) in the registry, with the scripted driver, MemoryStore and a real changes book over a
// scratch repository: a message that starts a turn goes on the input only once the turn's start mark is taken; a
// message that joins the running turn takes no mark and keeps its order; the file tools' patches never reach a page;
// at the turn's end every page gets the `changes` card, and history gives it right after the turn's end (once, with no
// copy in a snapshot's tail); a `!` command's reply turn waits for its mark too; Delete removes the chat's changes folder.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChangesBook, type TurnChanges } from "../../server/changes/book";
import { ChangesStore } from "../../server/changes/store";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle } from "../../server/chats/testing";
import { ownUid } from "../../server/store/files";
import type { ChatEvent, NewChatFrame } from "../../shared/protocol";
import { commitAll, scratch, type Scratch } from "./worktree-repo";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();

let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});

/** The book, noting when each turn's start mark was done. */
class SpyBook extends ChangesBook {
  readonly starts: number[] = [];
  override begin(chat: string, cwd: string, by: "user" | "agent"): TurnChanges {
    const t = super.begin(chat, cwd, by);
    void t.start.then(() => this.starts.push(performance.now()));
    return t;
  }
}

async function setup() {
  const s = scratch();
  open.push(s);
  writeFileSync(join(s.repo, "a.ts"), "a\nb\n");
  commitAll(s.repo, "a");
  const root = join(s.root, "state", "changes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const changesStore = new ChangesStore(root, ownUid());
  const changes = new SpyBook({ store: changesStore, git: s.wg });
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT, s.repo)];
  const sentAt: number[] = [];
  driver.script = () => void sentAt.push(performance.now());
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash(), changes }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  return { s, reg, driver, store, changes, changesStore, sentAt, cwd: s.repo };
}

/** The chat's first summary, once the store's list holds it. */
async function firstTurn(store: ChangesStore, chat: string, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const [rec] = await store.read(chat);
    if (rec) return rec;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

async function until(f: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

const call = (id: string, name: string, input: unknown): ChatEvent => ({ k: "tool_call", id, name, input, parent: null });
const result = (id: string): ChatEvent => ({ k: "tool_result", id, text: "ok", isError: false, parent: null, report: null });
const turnEnd = (uuids: string[] = []): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 9, error: null, uuids });

describe("a turn's changes in the registry", () => {
  test("the message waits for the start mark; the card reaches every page and history, once; the patch never does", async () => {
    const { reg, driver, changes, sentAt, cwd } = await setup();
    const uuid = rid();
    const f: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid, text: "fix it", picks: { model: null, effort: null, mode: null }, uploads: [] };
    const o = await apply(reg, f);
    if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
    const chat = (o.result as { chat: string }).chat;
    const v = new RecordingViewer();
    await reg.attach(chat, v);
    const c = driver.last;
    await until(() => c.sent.length === 1);
    expect(changes.starts.length).toBe(1);
    expect(sentAt[0]!).toBeGreaterThanOrEqual(changes.starts[0]!);
    const sid = c.input.sessionId!.value;
    driver.transcript(sid);
    c.emit({ k: "session", sessionId: sid, model: "claude-haiku-5-5", mode: "default", version: "2.1.317", bypass: false });
    c.emit(call("toolu_w", "Write", { file_path: join(cwd, "new.md"), content: "n\n" }));
    await settle();
    writeFileSync(join(cwd, "new.md"), "n\n");
    await Bun.sleep(5);
    c.emit(result("toolu_w"), { k: "edit_patch", id: "toolu_w", path: join(cwd, "new.md"), create: true, added: 1, removed: 0, hunks: [], cut: false, parent: null });
    c.emit({ k: "block", key: "msg_01Done:0", kind: "text", text: "Done.", parent: null }, turnEnd([uuid]));
    await until(() => v.items.some((i) => i.e.k === "changes"));
    const kinds = v.items.map((i) => i.e.k);
    expect(kinds).not.toContain("edit_patch");
    expect(kinds.indexOf("changes")).toBeGreaterThan(kinds.indexOf("turn_end"));
    const card = v.items.find((i) => i.e.k === "changes")!.e as Extract<ChatEvent, { k: "changes" }>;
    expect(card).toMatchObject({ k: "changes", at: [uuid, "toolu_w"], how: "git", total: 1, added: 1, removed: 0, files: [{ path: "new.md", status: "A", added: 1, removed: 0 }] });

    // History: the turn's rows, its end, then its card; a new page's tail holds no second copy.
    driver.histories.set(sid, [{ k: "user", uuid, text: "fix it", queued: false }, call("toolu_w", "Write", { file_path: join(cwd, "new.md") }), result("toolu_w"), { k: "block", key: "msg_01Done:0", kind: "text", text: "Done.", parent: null }]);
    const late = (await reg.attach(chat, new RecordingViewer("tab_b")))!;
    const history = late.snapshot!.history.map((e) => e.k);
    expect(history.slice(-2)).toEqual(["turn_end", "changes"]);
    expect(late.snapshot!.history.find((e) => e.k === "changes")).toEqual(card);
    expect(late.tail.filter((i) => i.e.k === "changes")).toEqual([]);
  });

  test("a message that joins the running turn takes no mark and goes after the first", async () => {
    const { reg, driver, changes } = await setup();
    const f: NewChatFrame = { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "one", picks: { model: null, effort: null, mode: null }, uploads: [] };
    const chat = ((await apply(reg, f)) as { result: { chat: string } }).result.chat;
    const r2 = rid();
    expect((await apply(reg, { t: "send", rid: r2, chat, uuid: r2, text: "two", draftRev: null, uploads: [] })).ok).toBe(true);
    const c = driver.last;
    await until(() => c.sent.length === 2);
    expect(c.sent.map((m) => m.text)).toEqual(["one", "two"]);
    expect(changes.starts.length).toBe(1);
  });

  test("a permission card holds its call's window: the user's edit while it waits is not the turn's (U1 review)", async () => {
    const { reg, driver, changesStore, cwd } = await setup();
    const uuid = rid();
    const chat = ((await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid, text: "go", picks: { model: null, effort: null, mode: null }, uploads: [] })) as { result: { chat: string } }).result.chat;
    const c = driver.last;
    await until(() => c.sent.length === 1);
    c.emit(call("toolu_p", "Bash", { command: "touch made.txt" }));
    await settle();
    const asked = c.ask({ kind: "permission", id: "toolu_p", toolUseId: "toolu_p", toolName: "Bash", title: null, displayName: null, description: null, reason: null, blockedPath: null, input: { command: "touch made.txt" }, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null });
    await settle();
    await Bun.sleep(150);
    // The user edits a.ts at the laptop while the card waits.
    writeFileSync(join(cwd, "a.ts"), "a\nb\nmine\n");
    await Bun.sleep(150);
    expect((await apply(reg, { t: "answer", rid: rid(), chat, card: "toolu_p", answer: { kind: "permission", allow: true, scope: "once" } })).ok).toBe(true);
    expect(await asked.answer).toMatchObject({ allow: true });
    writeFileSync(join(cwd, "made.txt"), "");
    await Bun.sleep(5);
    c.emit(result("toolu_p"), turnEnd([uuid]));
    // The store writes turns.json and then its list (store.ts add): wait for the list, not for the file.
    const rec = await firstTurn(changesStore, chat);
    expect(rec.files.map((f) => f.path)).toEqual(["made.txt"]);
    expect(rec.others).toBe(1);
  });

  test("Delete removes the chat's changes folder", async () => {
    const { reg, driver, changesStore, cwd } = await setup();
    const uuid = rid();
    const chat = ((await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid, text: "go", picks: { model: null, effort: null, mode: null }, uploads: [] })) as { result: { chat: string } }).result.chat;
    const c = driver.last;
    await until(() => c.sent.length === 1);
    c.emit(call("toolu_b", "Bash", { command: "touch made.txt" }));
    await settle();
    writeFileSync(join(cwd, "made.txt"), "");
    await Bun.sleep(5);
    c.emit(result("toolu_b"), turnEnd([uuid]));
    await until(() => existsSync(join(changesStore.dirOf(chat), "turns.json")));
    expect((await apply(reg, { t: "delete", rid: rid(), chat } as never)).ok).toBe(true);
    expect(existsSync(changesStore.dirOf(chat))).toBe(false);
  });
});
