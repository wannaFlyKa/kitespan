// The mention chips at send (DESIGN.md 9.3; owner row 54; build checklist C1, the server side): the registry adds each
// chip's reference (messageRef of the absolute path: `@<path>`, quoted when the path has white space; the single-quoted
// path in a `!` command) after the upload chips', for a file inside the chat's folder only; a path that is gone, a
// folder, or one that leaves the folder by a link refuses the send with `mention_gone`, and nothing is sent. Take back
// puts the chips back, and a draft edit keeps them. The message's `user` event names the chips' paths to every page,
// and the chat's notes keep them by the message's uuid, so a page that attaches later, a reload and a restart show the
// same tiles.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERROR_MESSAGES, messageRef, type BashFrame, type ChatEvent, type ChatEventOf, type DraftEditFrame, type SendFrame } from "../../shared/protocol";
import { decorateHistory } from "../../server/chats/history";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, projectRecord, settle, uploadRecord } from "../../server/chats/testing";
import { mentionPaths } from "../../server/search/mention";
import { emptyNotes } from "../../server/store/notes";

const PROJECT = "k3m7q2x4ab";
const UP1 = "abcdefghijklmnop";
const rid = () => crypto.randomUUID();

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-mentions-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const FOLDER = join(ROOT, "app");
const OUTSIDE = join(ROOT, "outside");
for (const f of ["src/upload.ts", "docs/my notes.md", "it's.txt", "web/composer/Composer.tsx"]) {
  mkdirSync(join(FOLDER, f, ".."), { recursive: true });
  writeFileSync(join(FOLDER, f), "x\n");
}
mkdirSync(OUTSIDE);
writeFileSync(join(OUTSIDE, "secret.txt"), "SECRET\n");
symlinkSync(join(OUTSIDE, "secret.txt"), join(FOLDER, "leak.txt"));
symlinkSync("../outside", join(FOLDER, "out-dir"));
symlinkSync("src/upload.ts", join(FOLDER, "alias.ts"));

async function setup() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  const bash = new FakeBash();
  store.projects = [projectRecord(PROJECT, FOLDER)];
  const reg = new ChatRegistry({ driver, store, bash }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
  await reg.boot();
  return { driver, store, reg, bash };
}

const turnEnd = (): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3, error: null, uuids: [] });

/** A chat whose first turn has ended, with a viewer attached. */
async function idleChat(reg: ChatRegistry, driver: FakeDriver) {
  const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "first", picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(o.code);
  const chat = (o.result as { chat: string }).chat;
  const c = driver.last;
  c.emit(turnEnd());
  await settle();
  const v = new RecordingViewer("tab_a");
  await reg.attach(chat, v);
  return { chat, c, v };
}

function send(chat: string, text: string, over: Partial<SendFrame> = {}): SendFrame {
  const r = rid();
  return { t: "send", rid: r, chat, uuid: r, text, draftRev: null, uploads: [], ...over };
}
const bashFrame = (chat: string, input: string, over: Partial<BashFrame> = {}): BashFrame => ({ t: "bash", rid: rid(), chat, input, draftRev: null, uploads: [], ...over });
const draft = (chat: string, over: Partial<DraftEditFrame> = {}): DraftEditFrame => ({ t: "draft", chat, text: "", mode: "chat", command: null, link: false, uploads: [], ...over });

describe("mentionPaths", () => {
  test("a file inside the folder, by the folder's own name; a link to a file inside is one too", async () => {
    expect(await mentionPaths(FOLDER, ["src/upload.ts", "docs/my notes.md", "alias.ts"])).toEqual([join(FOLDER, "src/upload.ts"), join(FOLDER, "docs/my notes.md"), join(FOLDER, "alias.ts")]);
    expect(await mentionPaths(FOLDER, [])).toEqual([]);
  });

  test("gone, a folder, a link out, or a path that is not relative and safe: null", async () => {
    for (const bad of ["src/gone.ts", "src", "leak.txt", "out-dir/secret.txt", "../outside/secret.txt", "/etc/passwd", "src/../src/upload.ts", "a\u0000b", ""]) {
      expect(await mentionPaths(FOLDER, ["src/upload.ts", bad])).toBeNull();
    }
  });
});

describe("send with mention chips", () => {
  test("each chip's reference follows the text and the upload chips, in chip order; a path with a space is quoted", async () => {
    const { reg, driver, store } = await setup();
    const { chat, c, v } = await idleChat(reg, driver);
    store.uploads.set(UP1, uploadRecord(UP1, chat, PROJECT, "red.png"));
    const o = await apply(reg, send(chat, "look at these", { uploads: [UP1], mentions: ["web/composer/Composer.tsx", "docs/my notes.md"] }));
    expect(o).toEqual({ ok: true, result: { queued: false } });
    const text = `look at these @/tmp/kitespan-uploads-test/u-abcdef/red.png @${FOLDER}/web/composer/Composer.tsx @"${FOLDER}/docs/my notes.md"`;
    expect(c.sent[1]!.text).toBe(text);
    expect(v.of("user").map((e) => e.text)).toEqual([text]);
    // A message of chips only.
    expect(await apply(reg, send(chat, "", { mentions: ["src/upload.ts"] }))).toEqual({ ok: true, result: { queued: false } });
    expect(c.sent[2]!.text).toBe(`@${FOLDER}/src/upload.ts`);
  });

  test("a mention that is not a file in the folder refuses the send with its line, and nothing is sent", async () => {
    const { reg, driver } = await setup();
    const { chat, c } = await idleChat(reg, driver);
    for (const bad of ["src/gone.ts", "leak.txt", "out-dir/secret.txt", "src"]) {
      expect(await apply(reg, send(chat, "x", { mentions: ["src/upload.ts", bad] }))).toEqual({ ok: false, code: "mention_gone" });
    }
    expect(c.sent.length).toBe(1);
    expect(ERROR_MESSAGES.mention_gone).toBe("A file in the message box is not in this folder any more. Remove it and try again.");
  });

  test("a `!` command gets each mention as a single-quoted path", async () => {
    const { reg, driver, bash } = await setup();
    const { chat } = await idleChat(reg, driver);
    expect(await apply(reg, bashFrame(chat, "wc -l", { mentions: ["it's.txt", "src/upload.ts", "docs/my notes.md"] }))).toEqual({ ok: true, result: null });
    await settle(20);
    // The shell word is right for a space too: no @ and no double quotes.
    expect(bash.runs.map((r) => r.command)).toEqual([`wc -l '${FOLDER}/it'\\''s.txt' '${FOLDER}/src/upload.ts' '${FOLDER}/docs/my notes.md'`]);
    expect(await apply(reg, bashFrame(chat, "cat", { mentions: ["leak.txt"] }))).toEqual({ ok: false, code: "mention_gone" });
    await settle(20);
    expect(bash.runs.length).toBe(1);
  });
});

describe("the chips in the draft", () => {
  test("a draft edit keeps the mention chips; Take back puts a queued message's chips back", async () => {
    const { reg, driver } = await setup();
    const { chat, c, v } = await idleChat(reg, driver);
    await reg.draftEdit(draft(chat, { text: "see", mentions: ["src/upload.ts"] }), "tab_a");
    expect(v.drafts.at(-1)).toMatchObject({ text: "see", mentions: ["src/upload.ts"] });
    // A turn runs; the next message waits in Claude Code's queue, and Take back returns it with its chips.
    expect((await apply(reg, send(chat, "run it"))).ok).toBe(true);
    const queued = send(chat, "and this", { mentions: ["docs/my notes.md"] });
    expect(await apply(reg, queued)).toEqual({ ok: true, result: { queued: false } });
    expect(c.sent.at(-1)!.text).toBe(`and this @"${FOLDER}/docs/my notes.md"`);
    await reg.draftEdit(draft(chat, { text: "typed meanwhile", mentions: ["src/upload.ts"] }), "tab_a");
    expect(await apply(reg, { t: "take_back", rid: rid(), chat, uuid: queued.uuid })).toEqual({ ok: true, result: { cancelled: true } });
    await settle();
    expect(v.drafts.at(-1)).toMatchObject({ text: "and this\ntyped meanwhile", mode: "chat", mentions: ["docs/my notes.md", "src/upload.ts"] });
  });
});

describe("a sent mention as a tile: the user event names the message's mention paths (9.3)", () => {
  const PATHS = ["docs/my notes.md", "src/upload.ts"];
  const refsText = (text: string, paths: readonly string[]) => [text, ...paths.map((p) => messageRef(`${FOLDER}/${p}`))].filter(Boolean).join(" ");
  const user = (uuid: string, text: string, queued = false, paths?: string[]): ChatEventOf<"user"> => ({ k: "user", uuid, text, queued, ...(paths ? { mentions: paths } : {}) });

  /** A chat whose transcript exists and whose first turn has ended (history then comes from the driver). */
  async function liveChat(reg: ChatRegistry, driver: FakeDriver) {
    const { chat, c, v } = await idleChat(reg, driver);
    const sid = c.input.sessionId!.value;
    driver.transcript(sid);
    return { chat, c, v, sid };
  }
  async function restart(reg: ChatRegistry, driver: FakeDriver, store: MemoryStore, bash: FakeBash): Promise<ChatRegistry> {
    await reg.shutdown();
    const next = new ChatRegistry({ driver, store, bash }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
    await next.boot();
    return next;
  }

  test("every viewer's event carries the paths as the chips held them, in chip order; a message with no chips an empty list", async () => {
    const { reg, driver } = await setup();
    const { chat, c, v } = await idleChat(reg, driver);
    const w = new RecordingViewer("tab_b");
    await reg.attach(chat, w);
    const f = send(chat, "compare", { mentions: PATHS });
    expect((await apply(reg, f)).ok).toBe(true);
    c.emit(turnEnd());
    await settle();
    const plain = send(chat, `typed by hand @${FOLDER}/src/upload.ts`);
    expect((await apply(reg, plain)).ok).toBe(true);
    for (const viewer of [v, w]) {
      expect(viewer.of("user").slice(-2)).toEqual([user(f.uuid, refsText("compare", PATHS), false, PATHS), user(plain.uuid, plain.text, false, [])]);
    }
  });

  test("a queued message's events carry them too: Queued while a turn runs, then the turn that takes it", async () => {
    const { reg, driver } = await setup();
    const { chat, c, v } = await idleChat(reg, driver);
    expect((await apply(reg, send(chat, "run it"))).ok).toBe(true);
    const queued = send(chat, "", { mentions: ["docs/my notes.md"] });
    expect((await apply(reg, queued)).ok).toBe(true);
    c.emit(turnEnd(), { k: "turn_start", by: "user" });
    await settle();
    const text = `@"${FOLDER}/docs/my notes.md"`;
    expect(v.of("user").filter((e) => e.uuid === queued.uuid)).toEqual([user(queued.uuid, text, true, ["docs/my notes.md"]), user(queued.uuid, text, false, ["docs/my notes.md"])]);
  });

  test("a page that attaches during the turn, after it, and after a restart gets them from the notes; an old message keeps none", async () => {
    const { reg, driver, store, bash } = await setup();
    const { chat, c, sid } = await liveChat(reg, driver);
    const f = send(chat, "compare", { mentions: PATHS });
    expect((await apply(reg, f)).ok).toBe(true);
    const text = refsText("compare", PATHS);
    c.emit(turnEnd());
    await settle();
    // A message sent with no chips: its reference typed by hand stays text, so its note is an empty list.
    const plain = send(chat, `typed by hand @${FOLDER}/src/upload.ts`);
    expect((await apply(reg, plain)).ok).toBe(true);
    // The transcript as Claude Code writes it: the message under the host's uuid (a live check), with the text it got.
    // One from before v0.3 (or the terminal) has no note: no key, so the page reads it as before.
    const before = rid();
    const typed = user(before, `@${FOLDER}/src/upload.ts`);
    driver.histories.set(sid, [typed, user(f.uuid, text), user(plain.uuid, plain.text)]);
    const mid = (await reg.attach(chat, new RecordingViewer("tab_mid")))!;
    expect(mid.snapshot.history.filter((e) => e.k === "user")).toEqual([typed, user(f.uuid, text, false, PATHS), user(plain.uuid, plain.text, false, [])]);
    expect(mid.tail.filter((i) => i.e.k === "user")).toEqual([]);
    c.emit(turnEnd());
    await settle();
    for (const r of [reg, await restart(reg, driver, store, bash)]) {
      const p = (await r.attach(chat, new RecordingViewer("tab_late")))!;
      expect(p.snapshot.history.filter((e) => e.k === "user")).toEqual([typed, user(f.uuid, text, false, PATHS), user(plain.uuid, plain.text, false, [])]);
      expect(p.tail.filter((i) => i.e.k === "user")).toEqual([]);
    }
    // Every message this server sent has its note (idleChat's first one too), with its paths or none.
    expect(store.notes.get(chat)!.mentions!.slice(-2)).toEqual([
      { uuid: f.uuid, paths: PATHS },
      { uuid: plain.uuid, paths: [] },
    ]);
  });

  test("history merges the notes by the message's uuid: a message with no note is left as it is", () => {
    const [a, b, n] = [rid(), rid(), rid()];
    const notes = { ...emptyNotes("k3m7q2x4abk3m7q2x4ab"), mentions: [{ uuid: b, paths: ["src/upload.ts"] }, { uuid: n, paths: [] }] };
    const events: ChatEvent[] = [user(a, `@${FOLDER}/src/upload.ts`), user(b, `see @${FOLDER}/src/upload.ts`), user(n, `@${FOLDER}/a.ts`), turnEnd()];
    expect(decorateHistory(events, notes, { ended: true })).toEqual([events[0]!, user(b, `see @${FOLDER}/src/upload.ts`, false, ["src/upload.ts"]), user(n, `@${FOLDER}/a.ts`, false, []), events[3]!]);
    expect(decorateHistory(events, emptyNotes("k3m7q2x4abk3m7q2x4ab"), { ended: true })).toEqual(events);
  });
});
