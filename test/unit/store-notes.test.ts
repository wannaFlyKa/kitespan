// A chat's notes (`notes/<chat id>.json`): the closed cards, the `!` rows' own ids, the `!` rows that never ran and the
// messages' mention paths (9.3), which history merges in, so the records survive a reload and a restart (DESIGN.md
// 5.4). In memory first, a 0600 file at most once a second and at shutdown, the caps, a bad file set aside, and Delete
// removes the file.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, type PermissionCard, type QuestionCard } from "../../shared/protocol";
import { StoreError } from "../../server/store/files";
import { noteCard, notesForSave, notesFrom } from "../../server/store/notes";
import { createStore, type StoreOptions } from "../../server/store/store";
import { STORE_LIMITS, type CardNote, type MentionNote, type NotRunNote, type NotesRecord, type StopNote } from "../../server/store/types";

const scratch: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "kitespan-store-notes-"));
  scratch.push(d);
  return d;
};
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const permission = (id: string, input: unknown = { command: "ls" }): PermissionCard => ({
  kind: "permission",
  id,
  toolUseId: id,
  toolName: "Bash",
  title: "Claude wants to run ls",
  displayName: null,
  description: null,
  reason: null,
  blockedPath: null,
  input,
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
});
const cardNote = (id: string, input?: unknown): CardNote => ({
  card: permission(id, input),
  close: { k: "card_close", id, why: "answered", answer: "once" },
  after: id,
});
const notRun = (input = "make test", over: Partial<NotRunNote> = {}): NotRunNote => ({ uuid: crypto.randomUUID(), input, after: "msg_01:0", skip: 1, ...over });
const notes = (over: Partial<NotesRecord> = {}): NotesRecord => ({
  v: 1,
  id: CHAT,
  cards: [cardNote("toolu_1")],
  bash: [{ uuid: UUID, digest: "0123456789abcdef0123456789abcdef", code: 3, ms: 2, timedOut: false, capped: false }],
  notRun: [notRun("make lint", { uuid: UUID })],
  ...over,
});

async function opened(opts: StoreOptions = {}) {
  const root = opts.root ?? fresh();
  const writes: string[] = [];
  const setAside: string[] = [];
  const store = createStore({ notesWriteMs: 200, ...opts, root, onWrite: (p) => writes.push(p), onSetAside: (p) => setAside.push(p) });
  await store.open();
  return { root, store, writes, setAside, file: join(root, "state", "notes", `${CHAT}.json`) };
}
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(20);
}

describe("the notes store", () => {
  test("a chat with no notes reads as empty ones; a save is in memory at once and on disk 0600 soon after", async () => {
    const { store, file } = await opened();
    expect(await store.readNotes(CHAT)).toEqual({ v: 1, id: CHAT, cards: [], bash: [], notRun: [] });
    store.saveNotes(notes());
    expect(await store.readNotes(CHAT)).toEqual(notes());
    await until(() => existsSync(file));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(notes());
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  test("the next server life reads the file; flush() writes what waits", async () => {
    const { root, store } = await opened({ notesWriteMs: 60_000 });
    store.saveNotes(notes());
    await store.flush();
    const next = createStore({ root });
    await next.open();
    expect(await next.readNotes(CHAT)).toEqual(notes());
  });

  test("a file that fails its check is set aside and reads as empty notes", async () => {
    const { store, file, setAside } = await opened();
    writeFileSync(file, JSON.stringify({ v: 1, id: CHAT, cards: [{ card: { kind: "nope" } }], bash: [] }), { mode: 0o600 });
    expect(await store.readNotes(CHAT)).toEqual({ v: 1, id: CHAT, cards: [], bash: [], notRun: [] });
    expect(setAside).toEqual([`notes/${CHAT}.json`]);
    expect(existsSync(`${file}.bad`)).toBe(true);
  });

  test("Delete removes the file, and a late save for the chat writes nothing", async () => {
    const { store, file } = await opened();
    store.saveNotes(notes());
    await until(() => existsSync(file));
    await store.deleteChat(CHAT);
    expect(existsSync(file)).toBe(false);
    store.saveNotes(notes());
    await Bun.sleep(300);
    expect(existsSync(file)).toBe(false);
  });

  test("an entry that fails its check is left out, so the others are still written; a bad chat id is bad_value", async () => {
    const { store } = await opened();
    const odd = cardNote("x".repeat(200));
    store.saveNotes(notes({ cards: [odd, cardNote("toolu_2")], bash: [{ uuid: "not-a-uuid", digest: "00", code: null, ms: null, timedOut: false, capped: false }, ...notes().bash] }));
    expect(await store.readNotes(CHAT)).toEqual(notes({ cards: [cardNote("toolu_2")] }));
    expect(() => store.saveNotes({ ...notes(), id: "not-a-chat" })).toThrow(StoreError);
  });
});

describe("the notes' caps", () => {
  test("the oldest cards and rows go first, by count and by the file's 1 MiB", () => {
    const many = Array.from({ length: STORE_LIMITS.noteCards + 5 }, (_, i) => cardNote(`toolu_${i}`));
    const kept = notesForSave(notes({ cards: many }));
    expect(kept.cards.length).toBe(STORE_LIMITS.noteCards);
    expect(kept.cards[0]!.card.id).toBe("toolu_5");
    const big = Array.from({ length: 180 }, (_, i) => cardNote(`toolu_b${i}`, { a: "x".repeat(2_000), b: "y".repeat(2_000), c: "z".repeat(2_000), d: "w".repeat(1_900) }));
    const fit = notesForSave(notes({ cards: big }));
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(STORE_LIMITS.notesBytes);
    expect(fit.cards.at(-1)!.card.id).toBe("toolu_b179");
  });

  test("a card is cut down to what its record shows; a form's schema is not kept", () => {
    const p = noteCard(permission("toolu_1", { command: "x".repeat(9_000), other: Array.from({ length: 20 }, () => "y".repeat(1_000)) })) as PermissionCard;
    expect(((p.input as { command: string }).command).length).toBe(2_000);
    expect(JSON.stringify(p.input).length).toBeLessThan(9_000);
    const q: QuestionCard = { kind: "question", id: "toolu_q", toolUseId: "toolu_q", questions: [{ question: "Q".repeat(3_000), header: "H", multiSelect: true, options: [{ label: "A", description: "d".repeat(3_000) }] }] };
    const qn = noteCard(q) as QuestionCard;
    expect(qn.questions[0]!.question.length).toBe(2_000);
    expect(qn.questions[0]!.options[0]!.description.length).toBe(2_000);
    const e = noteCard({ kind: "elicitation", id: "e1", server: "s", displayName: null, title: null, description: null, message: "m", mode: "form", url: null, elicitationId: null, schema: { type: "object" } });
    expect(e).toMatchObject({ kind: "elicitation", schema: null });
    // The record check reads back what noteCard keeps, and only the known fields.
    const rec = notesFrom({ ...notes(), extra: 1, cards: [{ ...cardNote("toolu_1"), extra: 2 }] });
    expect(rec).toEqual(notes());
  });

  test("a `!` row's note keeps its exit code, duration, timeout and cap; one written without them reads as none", () => {
    const row = { uuid: UUID, digest: "0123456789abcdef0123456789abcdef" };
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [{ ...row, code: null, ms: 120_000, timedOut: true, capped: true }] }).bash).toEqual([{ ...row, code: null, ms: 120_000, timedOut: true, capped: true }]);
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [row] }).bash).toEqual([{ ...row, code: null, ms: null, timedOut: false, capped: false }]);
    for (const bad of [{ code: "3" }, { code: 1.5 }, { ms: -1 }, { timedOut: "yes" }]) expect(() => notesFrom({ v: 1, id: CHAT, cards: [], bash: [{ ...row, ...bad }] })).toThrow();
  });

  test("a Not run row's note keeps its command and its place; a file written before the field reads as none", () => {
    const row = notRun("echo 'my notes.txt'");
    const first = notRun("pwd", { after: null, skip: 0 });
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [], notRun: [first, row] }).notRun).toEqual([first, row]);
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [] }).notRun).toEqual([]);
    const bads: Record<string, unknown>[] = [
      { uuid: "not-a-uuid" },
      { input: 3 },
      { input: "x".repeat(LIMITS.bashInput + 1) },
      { after: "" },
      { after: 7 },
      { skip: -1 },
      { skip: 1.5 },
      { skip: undefined },
    ];
    for (const bad of bads) expect(() => notesFrom({ v: 1, id: CHAT, cards: [], bash: [], notRun: [{ ...row, ...bad }] })).toThrow();
    expect(() => notesFrom({ v: 1, id: CHAT, cards: [], bash: [], notRun: {} })).toThrow();
  });

  test("the oldest Not run rows go first, by count and by the file's 1 MiB; one that fails its check is left out", () => {
    const many = Array.from({ length: STORE_LIMITS.noteNotRun + 3 }, (_, i) => notRun(`echo ${i}`));
    const kept = notesForSave(notes({ notRun: many }));
    expect(kept.notRun.map((n) => n.input)).toEqual(many.slice(3).map((n) => n.input));
    const big = Array.from({ length: STORE_LIMITS.noteNotRun }, (_, i) => notRun(`${i} ${"x".repeat(LIMITS.bashInput - 8)}`));
    const fit = notesForSave(notes({ cards: [], notRun: big }));
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(STORE_LIMITS.notesBytes);
    expect(fit.notRun.length).toBeGreaterThan(0);
    expect(fit.notRun.at(-1)).toEqual(big.at(-1)!);
    expect(notesForSave(notes({ notRun: [notRun("ls", { uuid: "nope" }), row()] })).notRun).toEqual([row()]);
    function row(): NotRunNote {
      return { uuid: UUID, input: "ls", after: null, skip: 2 };
    }
  });
});

describe("a sent message's mentions (9.3): the paths of its mention chips, by the message's uuid", () => {
  const PATHS = ["notes/会議メモ 2026.md", "assets/\u{1f680} launch plan.md", "src/upload.ts"];
  const mention = (paths: string[] = PATHS, uuid: string = crypto.randomUUID()): MentionNote => ({ uuid, paths });

  test("a save keeps them; the file and the next server life read them back", async () => {
    const { root, store, file } = await opened({ notesWriteMs: 60_000 });
    const rec = notes({ mentions: [mention(PATHS, UUID)] });
    store.saveNotes(rec);
    expect(await store.readNotes(CHAT)).toEqual(rec);
    await store.flush();
    expect((JSON.parse(readFileSync(file, "utf8")) as NotesRecord).mentions).toEqual([{ uuid: UUID, paths: PATHS }]);
    const next = createStore({ root });
    await next.open();
    expect(await next.readNotes(CHAT)).toEqual(rec);
  });

  test("a file written before the field reads as none, and none is no key", () => {
    expect("mentions" in notesFrom({ v: 1, id: CHAT, cards: [], bash: [] })).toBe(false);
    expect("mentions" in notesFrom({ v: 1, id: CHAT, cards: [], bash: [], mentions: [] })).toBe(false);
    expect("mentions" in notesForSave(notes())).toBe(false);
  });

  test("a message sent with no chips is a note with no paths: its text then has no tile after a reload or a restart", () => {
    const none = mention([], UUID);
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [], mentions: [none] }).mentions).toEqual([{ uuid: UUID, paths: [] }]);
    expect(notesForSave(notes({ mentions: [none, mention()] })).mentions).toEqual([none, expect.anything()]);
  });

  test("a note that is not a uuid with 0 to 100 paths relative to the chat's folder fails its check; on save it is left out", () => {
    const bads: unknown[] = [
      { uuid: "not-a-uuid", paths: PATHS },
      { paths: PATHS },
      { uuid: UUID },
      { uuid: UUID, paths: "a.ts" },
      { uuid: UUID, paths: ["a.ts", "/etc/passwd"] },
      { uuid: UUID, paths: ["../secret"] },
      { uuid: UUID, paths: ["a\nb"] },
      { uuid: UUID, paths: Array.from({ length: LIMITS.sendMentions + 1 }, (_, i) => `f${i}.ts`) },
      "a.ts",
    ];
    for (const bad of bads) expect(() => notesFrom({ v: 1, id: CHAT, cards: [], bash: [], mentions: [bad] })).toThrow();
    expect(() => notesFrom({ v: 1, id: CHAT, cards: [], bash: [], mentions: {} })).toThrow();
    // Repeats go, the order kept, as the frame's own check does; only the known fields are kept.
    expect(notesFrom({ v: 1, id: CHAT, cards: [], bash: [], mentions: [{ uuid: UUID, paths: ["b.ts", "a.ts", "b.ts"], extra: 1 }] }).mentions).toEqual([{ uuid: UUID, paths: ["b.ts", "a.ts"] }]);
    const good = mention();
    expect(notesForSave(notes({ mentions: [{ uuid: "nope", paths: PATHS }, good] })).mentions).toEqual([good]);
  });

  test("the oldest go first, by count and by the file's 1 MiB, before any card or row", () => {
    const many = Array.from({ length: STORE_LIMITS.noteMentions + 4 }, (_, i) => mention([`f${i}.ts`]));
    expect(notesForSave(notes({ mentions: many })).mentions).toEqual(many.slice(4));
    // 40 messages of 100 paths of 1,000 characters each: about 4 MB.
    const big = Array.from({ length: 40 }, (_, i) => mention(Array.from({ length: LIMITS.sendMentions }, (_, j) => `${i}/${j}/${"x".repeat(990)}`)));
    const fit = notesForSave(notes({ mentions: big }));
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(STORE_LIMITS.notesBytes);
    expect(fit.mentions!.length).toBeGreaterThan(0);
    expect(fit.mentions!.at(-1)).toEqual(big.at(-1)!);
    expect([fit.cards, fit.bash, fit.notRun]).toEqual([notes().cards, notes().bash, notes().notRun]);
  });
});

describe("the stop lines (D32, R15): each line's notice id, its text and its place, as a Not run row's", () => {
  const line = (over: Partial<StopNote> = {}): StopNote => ({ id: crypto.randomUUID(), text: "kitespan stopped while this chat was running. Send a message to continue.", after: "msg_01:0", skip: 1, ...over });

  test("a save keeps them, the next server life reads them back, and none is no key", async () => {
    const { root, store } = await opened({ notesWriteMs: 60_000 });
    const rec = notes({ stops: [line({ after: null, skip: 0 }), line()] });
    store.saveNotes(rec);
    await store.flush();
    const next = createStore({ root });
    await next.open();
    expect(await next.readNotes(CHAT)).toEqual(rec);
    expect("stops" in notesFrom({ v: 1, id: CHAT, cards: [], bash: [] })).toBe(false);
    expect("stops" in notesForSave(notes({ stops: [] }))).toBe(false);
  });

  test("a line that fails its check fails the file, and on save it is left out; the oldest go first past 200", () => {
    const good = line();
    for (const bad of [{ id: "" }, { id: 7 }, { text: "" }, { text: "x".repeat(501) }, { after: "" }, { skip: -1 }, { skip: 1.5 }])
      expect(() => notesFrom({ v: 1, id: CHAT, cards: [], bash: [], stops: [{ ...good, ...bad }] })).toThrow();
    expect(notesForSave(notes({ stops: [{ ...good, skip: -1 }, good] })).stops).toEqual([good]);
    const many = Array.from({ length: STORE_LIMITS.noteStops + 2 }, () => line());
    expect(notesForSave(notes({ stops: many })).stops).toEqual(many.slice(2));
  });
});
