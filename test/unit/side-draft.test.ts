// The side box's draft on every device (FIX-U2 section 2; D49; R124 review finding 7): the server holds it per chat,
// next to the side thread (`side/<chat id>.draft.json`), with the main draft's frame and store rules and a `box: "side"`
// field: the `draft` frame both ways, `attached.sideDraft`, the same 20,000 cap, kept in memory at once and written at
// most once a second and at shutdown, a bad file set aside, Delete removes it. Every page gets each change; a side
// question sent from the side box (one that carries `draftRev`) clears it on every page under the main draft's rule
// (the sender's tab changed it last, or its rev is the one the box showed), while Try again, the message box's /btw, a
// busy ask and a refused one leave it; it is kept across a restart. The message box's draft is never touched by it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, parseClientFrame, type DraftEditFrame, type DraftState, type SideExchange } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord } from "../../server/chats/testing";
import type { Outcome, RegistryOptions } from "../../server/chats/types";
import { StoreError } from "../../server/store/files";
import { createStore, type StoreOptions } from "../../server/store/store";
import type { ChatLedger, DraftRecord } from "../../server/store/types";

const PROJECT = "k3m7q2x4ab";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const RID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const AT = "2026-11-05T09:00:00.000Z";
const rid = () => crypto.randomUUID();
const parse = (o: Record<string, unknown>): { ok: boolean; frame?: unknown; rid?: string | null } => parseClientFrame(JSON.stringify(o));

const sideEdit = (text: string, over: Partial<DraftEditFrame> = {}): DraftEditFrame => ({ t: "draft", chat: CHAT, box: "side", text, mode: "chat", command: null, link: false, uploads: [], ...over });

describe("the frames", () => {
  test("a draft frame with box side is the side box's: plain text in chat mode, with its link mark", () => {
    const f = { t: "draft", chat: CHAT, box: "side", text: "Which file holds the cap?", mode: "chat", command: null, link: true, uploads: [] };
    expect(parse(f)).toEqual({ ok: true, frame: f });
    // Absent is the message box's, as before.
    const main = { t: "draft", chat: CHAT, text: "x", mode: "slash", command: "compact", link: false, uploads: [] };
    expect(parse(main)).toEqual({ ok: true, frame: main });
  });

  test("the side box's draft has no mode, chip, upload or mention of its own; another box name is refused", () => {
    const base = { t: "draft", chat: CHAT, box: "side", text: "x", mode: "chat", command: null, link: false, uploads: [] };
    for (const over of [{ mode: "bash" }, { mode: "slash", command: "compact" }, { uploads: ["aaaaaaaaaaaaaaaa"] }, { mentions: ["src/a.ts"] }, { box: "main" }, { box: "other" }, { box: 1 }]) expect(parse({ ...base, ...over }).ok).toBe(false);
  });

  test("side_question's draftRev: absent is not from the side box (no key); null or a rev is the side box's", () => {
    const q = { t: "side_question", rid: RID, chat: CHAT, id: rid(), text: "Why?" };
    const absent = parse(q);
    expect(absent.ok).toBe(true);
    expect("draftRev" in (absent.frame as object)).toBe(false);
    expect(parse({ ...q, draftRev: null })).toEqual({ ok: true, frame: { ...q, draftRev: null } });
    expect(parse({ ...q, draftRev: 7 })).toEqual({ ok: true, frame: { ...q, draftRev: 7 } });
    for (const v of [-1, 1.5, "7", true]) expect(parse({ ...q, draftRev: v })).toMatchObject({ ok: false, rid: RID });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The store: side/<chat id>.draft.json

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-side-draft-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const sideRec = (over: Partial<DraftRecord> = {}): DraftRecord => ({ v: 1, id: CHAT, box: "side", rev: 1, text: "Which file?", mode: "chat", command: null, link: false, uploads: [], by: "tab-1", at: AT, ...over });

async function opened(opts: StoreOptions = {}) {
  const root = opts.root ?? fresh();
  const writes: string[] = [];
  const setAside: string[] = [];
  const store = createStore({ draftWriteMs: 200, ...opts, root, onWrite: (p) => writes.push(p), onSetAside: (p) => setAside.push(p) });
  await store.open();
  return { root, store, writes, setAside, file: join(root, "state", "side", `${CHAT}.draft.json`), mainFile: join(root, "state", "drafts", `${CHAT}.json`) };
}
const onDisk = (file: string) => JSON.parse(readFileSync(file, "utf8")) as DraftRecord;
async function until(ok: () => boolean, what = "a condition", ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("the store", () => {
  test("no file reads as an empty side draft with rev 0; the message box's draft is another record", async () => {
    const { store, file } = await opened();
    expect(await store.readDraft(CHAT, "side")).toMatchObject({ v: 1, id: CHAT, box: "side", rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null });
    expect("box" in (await store.readDraft(CHAT))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  test("in memory at once, in side/<chat>.draft.json (0600) at most once per window with the newest state, and at flush", async () => {
    const { store, writes, file, mainFile } = await opened({ draftWriteMs: 400 });
    store.saveDraft(sideRec({ rev: 1, text: "a" }));
    expect((await store.readDraft(CHAT, "side")).text).toBe("a");
    expect((await store.readDraft(CHAT)).text).toBe("");
    await until(() => writes.length > 0, "the first write");
    expect(writes).toEqual([`side/${CHAT}.draft.json`]);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    store.saveDraft(sideRec({ rev: 2, text: "ab" }));
    store.saveDraft(sideRec({ rev: 3, text: "abc" }));
    await Bun.sleep(60);
    expect(writes.length).toBe(1);
    expect(onDisk(file)).toMatchObject({ box: "side", rev: 1, text: "a" });
    await until(() => writes.length > 1, "the second write");
    expect(onDisk(file)).toMatchObject({ rev: 3, text: "abc" });
    store.saveDraft(sideRec({ rev: 4, text: "abcd" }));
    await store.flush();
    expect(onDisk(file)).toMatchObject({ rev: 4, text: "abcd" });
    // The message box's file was never written.
    expect(existsSync(mainFile)).toBe(false);
  });

  test("the two boxes' drafts of one chat are kept apart, and both survive a restart", async () => {
    const { root, store } = await opened();
    store.saveDraft(sideRec({ rev: 5, text: "side text" }));
    store.saveDraft({ v: 1, id: CHAT, rev: 9, text: "main text", mode: "chat", command: null, link: false, uploads: [], by: "tab-2", at: AT });
    await store.flush();
    const again = createStore({ root });
    await again.open();
    expect(await again.readDraft(CHAT, "side")).toEqual(sideRec({ rev: 5, text: "side text" }));
    expect(await again.readDraft(CHAT)).toMatchObject({ rev: 9, text: "main text", by: "tab-2" });
  });

  test("the same cap as the message box's: 20,000 UTF-16 units, never cut inside a surrogate pair", async () => {
    const { store } = await opened();
    store.saveDraft(sideRec({ text: "a".repeat(20_001) }));
    expect((await store.readDraft(CHAT, "side")).text.length).toBe(LIMITS.draftText);
    store.saveDraft(sideRec({ text: "a".repeat(19_999) + "\u{1F600}" }));
    expect((await store.readDraft(CHAT, "side")).text).toBe("a".repeat(19_999));
  });

  test("a side draft with a mode, a chip, an upload or a mention is refused at once", async () => {
    const { store, file } = await opened();
    for (const over of [{ mode: "bash" as const }, { mode: "slash" as const, command: "compact" }, { uploads: ["aaaaaaaaaaaaaaaa"] }, { mentions: ["src/a.ts"] }, { box: "other" as never }]) {
      let err: unknown = null;
      try {
        store.saveDraft(sideRec(over));
      } catch (e) {
        err = e;
      }
      expect((err as StoreError).code).toBe("bad_value");
    }
    await store.flush();
    expect(existsSync(file)).toBe(false);
  });

  test("a bad side file is set aside, and the side box starts empty; a message box record there is a bad file too", async () => {
    for (const body of ['{"v":1,"id":', JSON.stringify({ ...sideRec(), box: undefined }), JSON.stringify(sideRec({ mode: "bash" })), JSON.stringify(sideRec({ id: "abcdefghijabcdefghij" }))]) {
      const ctx = await opened();
      writeFileSync(ctx.file, body, { mode: 0o600 });
      expect(await ctx.store.readDraft(CHAT, "side")).toMatchObject({ rev: 0, text: "" });
      expect(ctx.setAside).toEqual([`side/${CHAT}.draft.json`]);
      expect(readdirSync(join(ctx.root, "state", "side"))).toEqual([`${CHAT}.draft.json.bad`]);
    }
    // A side record in the message box's file is not the message box's draft.
    const ctx = await opened();
    writeFileSync(ctx.mainFile, JSON.stringify(sideRec()), { mode: 0o600 });
    expect(await ctx.store.readDraft(CHAT)).toMatchObject({ rev: 0, text: "" });
    expect(ctx.setAside).toEqual([`drafts/${CHAT}.json`]);
  });

  test("Delete removes the side draft's file, and a later save for the chat is dropped", async () => {
    const { store, file } = await opened();
    store.saveDraft(sideRec());
    await store.flush();
    expect(existsSync(file)).toBe(true);
    await store.deleteChat(CHAT);
    expect(existsSync(file)).toBe(false);
    store.saveDraft(sideRec({ rev: 2 }));
    await store.flush();
    expect(existsSync(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The registry: two pages, a side question, a restart

function ledger(over: Partial<ChatLedger> = {}): ChatLedger {
  return {
    v: 1,
    id: CHAT,
    project: PROJECT,
    cwd: "/srv/work/app",
    agent: "claude-code",
    sessionId: SID,
    transcript: true,
    title: { text: "Fix the flaky upload test", from: "first-prompt" },
    picks: { model: null, effort: null, permissionMode: null },
    createdAt: "2026-11-05T08:00:00.000Z",
    seenAt: "2026-11-05T08:00:00.000Z",
    lastActivityAt: "2026-11-05T08:00:00.000Z",
    lastSeq: 0,
    state: "sleeping",
    lastExit: null,
    archivedAt: null,
    ...over,
  };
}

function world() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  store.chats.set(CHAT, ledger());
  driver.transcript(SID);
  return { driver, store };
}
async function life(w: ReturnType<typeof world>, opts: RegistryOptions = {}): Promise<ChatRegistry> {
  const reg = new ChatRegistry({ driver: w.driver, store: w.store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, ...opts });
  await reg.boot();
  return reg;
}
/** Two pages on CHAT: page A (tab_a) and page B (tab_b). */
async function twoPages(reg: ChatRegistry) {
  const a = new RecordingViewer("tab_a");
  const b = new RecordingViewer("tab_b");
  const pa = await reg.attach(CHAT, a);
  const pb = await reg.attach(CHAT, b);
  return { a, b, attachedA: pa!.attached, attachedB: pb!.attached };
}
const ask = (text: string, more: { draftRev?: number | null; id?: string } = {}) => {
  const { id = rid(), ...rest } = more;
  return { t: "side_question" as const, rid: rid(), chat: CHAT, id, text, ...rest };
};
const answered = (o: Outcome): SideExchange => {
  if (!o.ok) throw new Error(`refused: ${o.code}`);
  return (o.result as { answered: SideExchange }).answered;
};
const texts = (list: readonly DraftState[]) => list.map((d) => `${d.rev}:${d.text}:${d.by}`);

/** CHAT live and idle: a first turn ran. */
async function liveChat(reg: ChatRegistry, driver: FakeDriver) {
  autoReply(driver);
  const u = rid();
  expect((await apply(reg, { t: "send", rid: u, chat: CHAT, uuid: u, text: "Run the upload test.", draftRev: null, uploads: [] })).ok).toBe(true);
  await until(() => reg.stateOf(CHAT) === "idle", "the first turn's end");
  driver.script = null;
  return driver.last;
}

describe("the registry", () => {
  test("attached carries the side box's draft beside the message box's; an edit reaches every page as the side draft", async () => {
    const w = world();
    const reg = await life(w);
    const { a, b, attachedA } = await twoPages(reg);
    expect(attachedA.sideDraft).toMatchObject({ rev: 0, text: "", mode: "chat", command: null, link: false, uploads: [], by: null });
    expect(attachedA.draft).toMatchObject({ rev: 0, text: "" });
    await reg.draftEdit(sideEdit("Which file holds the cap?"), "tab_a");
    for (const v of [a, b]) {
      expect(texts(v.sideDrafts)).toEqual(["1:Which file holds the cap?:tab_a"]);
      // Never the message box's draft.
      expect(v.drafts).toEqual([]);
    }
    expect(reg.draftOf(CHAT, "side")).toMatchObject({ rev: 1, text: "Which file holds the cap?", by: "tab_a" });
    expect(reg.draftOf(CHAT)).toMatchObject({ rev: 0, text: "" });
    expect(w.store.sideDrafts.get(CHAT)).toMatchObject({ v: 1, id: CHAT, box: "side", rev: 1, text: "Which file holds the cap?", by: "tab_a" });
    expect(w.store.drafts.has(CHAT)).toBe(false);
    // The same text again changes nothing; the link mark is the side box's too; the main box's edit stays apart.
    await reg.draftEdit(sideEdit("Which file holds the cap?"), "tab_b");
    expect(a.sideDrafts).toHaveLength(1);
    await reg.draftEdit(sideEdit("Which file holds the cap?", { link: true }), "tab_b");
    expect(a.sideDrafts.at(-1)).toMatchObject({ rev: 2, link: true, by: "tab_b" });
    await reg.draftEdit({ t: "draft", chat: CHAT, text: "the main box", mode: "chat", command: null, link: false, uploads: [] }, "tab_a");
    expect(texts(b.drafts)).toEqual(["1:the main box:tab_a"]);
    expect(b.sideDrafts).toHaveLength(2);
    // The same 20,000 cap as the message box's.
    await reg.draftEdit(sideEdit("q".repeat(LIMITS.draftText + 1)), "tab_a");
    expect(reg.draftOf(CHAT, "side")!.text).toHaveLength(LIMITS.draftText);
    // A page that attaches later gets it.
    const c = new RecordingViewer("tab_c");
    expect((await reg.attach(CHAT, c))!.attached.sideDraft).toMatchObject({ rev: 3, by: "tab_a" });
    await reg.shutdown();
  });

  test("a side question from the side box clears it on every page; Try again and the message box's /btw leave it", async () => {
    const w = world();
    const reg = await life(w);
    await liveChat(reg, w.driver);
    const { a, b } = await twoPages(reg);
    await reg.draftEdit(sideEdit("Why did the second test time out?"), "tab_a");
    // Page B shows rev 1 and sends it: the rev is the one its box showed.
    const x = answered(await apply(reg, ask("Why did the second test time out?", { draftRev: 1 }), { tab: "tab_b" }));
    expect(x.state).toBe("answered");
    for (const v of [a, b]) expect(texts(v.sideDrafts)).toEqual(["1:Why did the second test time out?:tab_a", "2::tab_b"]);
    expect(w.store.sideDrafts.get(CHAT)).toMatchObject({ rev: 2, text: "", by: "tab_b" });
    // Try again (the thread's own question) and /btw from the message box carry no draftRev: the side box keeps its text.
    await reg.draftEdit(sideEdit("And the third?"), "tab_a");
    answered(await apply(reg, ask("Why did the second test time out?", { id: x.id }), { tab: "tab_a" }));
    answered(await apply(reg, ask("A question from the message box"), { tab: "tab_a" }));
    expect(reg.draftOf(CHAT, "side")).toMatchObject({ rev: 3, text: "And the third?" });
    // The sender's own last change is cleared whatever rev its box showed (null too), as the message box's is.
    answered(await apply(reg, ask("And the third?", { draftRev: null }), { tab: "tab_a" }));
    expect(reg.draftOf(CHAT, "side")).toMatchObject({ rev: 4, text: "", by: "tab_a" });
    // The message box's draft never moved.
    expect(a.drafts).toEqual([]);
    await reg.shutdown();
  });

  test("another page typed since the box showed it: its newer text stays", async () => {
    const w = world();
    const reg = await life(w);
    await liveChat(reg, w.driver);
    const { a } = await twoPages(reg);
    await reg.draftEdit(sideEdit("Mine"), "tab_a");
    await reg.draftEdit(sideEdit("Typed on page B since"), "tab_b");
    answered(await apply(reg, ask("Mine", { draftRev: 1 }), { tab: "tab_a" }));
    expect(reg.draftOf(CHAT, "side")).toMatchObject({ rev: 2, text: "Typed on page B since", by: "tab_b" });
    expect(a.sideDrafts).toHaveLength(2);
    await reg.shutdown();
  });

  test("a busy ask and a refused one leave the side draft as it is (the page puts the question back)", async () => {
    const w = world();
    const reg = await life(w);
    const chat = await liveChat(reg, w.driver);
    await twoPages(reg);
    let release!: (v: { response: string; synthetic: boolean; fallback: null }) => void;
    chat.sideReply = () => new Promise((r) => (release = r));
    const first = apply(reg, ask("The slow one"), { tab: "tab_a" });
    await until(() => chat.sideAsks.length === 1, "the ask");
    await reg.draftEdit(sideEdit("Second one"), "tab_b");
    expect(await apply(reg, ask("Second one", { draftRev: 1 }), { tab: "tab_b" })).toEqual({ ok: false, code: "busy" });
    expect(reg.draftOf(CHAT, "side")).toMatchObject({ rev: 1, text: "Second one" });
    release({ response: "Done.", synthetic: false, fallback: null });
    answered(await first);
    // The restart's drain refuses it with nothing stored.
    expect(reg.drain("finish")).toEqual({ ok: true });
    expect(await apply(reg, ask("Second one", { draftRev: 1 }), { tab: "tab_b" })).toEqual({ ok: false, code: "restarting" });
    reg.undrain();
    expect(reg.draftOf(CHAT, "side")).toMatchObject({ rev: 1, text: "Second one" });
    await reg.shutdown();
  });

  test("kept across a restart: the next server life's pages get it at attach, with its rev, and it goes on from there", async () => {
    const w = world();
    const first = await life(w);
    await twoPages(first);
    await first.draftEdit(sideEdit("Half a side question"), "tab_a");
    await first.shutdown();
    const second = await life(w);
    const { a, b, attachedA, attachedB } = await twoPages(second);
    for (const at of [attachedA, attachedB]) expect(at.sideDraft).toMatchObject({ rev: 1, text: "Half a side question", by: "tab_a" });
    await second.draftEdit(sideEdit("Half a side question, now whole?"), "tab_b");
    for (const v of [a, b]) expect(texts(v.sideDrafts)).toEqual(["2:Half a side question, now whole?:tab_b"]);
    await second.shutdown();
  });

  test("an archived chat takes no side draft, and Delete takes it with the chat", async () => {
    const w = world();
    const reg = await life(w);
    const { a } = await twoPages(reg);
    await reg.draftEdit(sideEdit("Kept?"), "tab_a");
    expect((await apply(reg, { t: "archive", rid: rid(), chat: CHAT, on: true, stop: false })).ok).toBe(true);
    await reg.draftEdit(sideEdit("While archived"), "tab_a");
    expect(texts(a.sideDrafts)).toEqual(["1:Kept?:tab_a"]);
    expect((await apply(reg, { t: "archive", rid: rid(), chat: CHAT, on: false, stop: false })).ok).toBe(true);
    expect((await apply(reg, { t: "delete", rid: rid(), chat: CHAT })).ok).toBe(true);
    expect(w.store.sideDrafts.has(CHAT)).toBe(false);
    await reg.shutdown();
  });
});
