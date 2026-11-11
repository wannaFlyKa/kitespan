// U1 (DESIGN-U1 4, 5 and 9): a chat's turns in a scratch repository, the events as the registry passes them on, the
// files changed for real inside and outside the tools' windows. The summary per turn (the tools' changes, not the
// user's, counted apart), the card (at most five files) and its place (the turn's first rows as the page's ids), the
// store's summary and one file's diff, the start mark's deadline (the turn falls back) and a late agent mark, the
// fallback outside a repository (Claude's own edits), the end mark's deadline, the chat's size cap, Delete.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChangesBook, type TurnChanges } from "../../server/changes/book";
import { noteCardKey, pageRowId } from "../../server/changes/rows";
import { ChangesStore } from "../../server/changes/store";
import { ownUid } from "../../server/store/files";
import type { ChatEvent } from "../../shared/protocol";
import { commitAll, scratch, type Scratch } from "./worktree-repo";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const IDS = ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "msg_01Plan:0"];

let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});

function setup(files: Record<string, string> = { "src/a.ts": "a\nb\nc\n", "notes.md": "n\n", "old.txt": "1\n2\n3\n4\n5\n" }, limits = {}) {
  const s = scratch();
  open.push(s);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(s.repo, rel, ".."), { recursive: true });
    writeFileSync(join(s.repo, rel), body);
  }
  commitAll(s.repo, "files");
  const root = join(s.root, "state", "changes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = new ChangesStore(root, ownUid());
  const lines: { count: number | null; ok: boolean }[] = [];
  const book = new ChangesBook({ store, git: s.wg, limits, log: (f) => lines.push({ count: f.count, ok: f.ok }) });
  return { s, store, book, lines, cwd: s.repo };
}

const call = (id: string, name: string, input: unknown = {}): ChatEvent => ({ k: "tool_call", id, name, input, parent: null });
const result = (id: string): ChatEvent => ({ k: "tool_result", id, text: "", isError: false, parent: null, report: null });
const nap = (ms: number) => Bun.sleep(ms);

/** One tool's run: its call, `work` (the tool's own changes), its result. */
async function tool(book: ChangesBook, t: TurnChanges, id: string, name: string, input: unknown, work: () => void): Promise<void> {
  book.note(t, call(id, name, input));
  await nap(5);
  work();
  await nap(5);
  book.note(t, result(id));
}

describe("a turn in a repository", () => {
  test("its tools' changes are the turn's; the user's own edit between them is counted apart", async () => {
    const { book, store, cwd, lines } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "e1", "Edit", { file_path: join(cwd, "src/a.ts") }, () => writeFileSync(join(cwd, "src/a.ts"), "a\nB\nc\nd\n"));
    // The user's own edit, well outside every window.
    await nap(150);
    writeFileSync(join(cwd, "notes.md"), "n\nmine\n");
    await nap(150);
    await tool(book, t, "b1", "Bash", { command: "mv old.txt docs/moved.txt" }, () => {
      mkdirSync(join(cwd, "docs"));
      writeFileSync(join(cwd, "docs/moved.txt"), readFileSync(join(cwd, "old.txt")));
      unlinkSync(join(cwd, "old.txt"));
      writeFileSync(join(cwd, "logo.bin"), Buffer.from([0, 1, 2, 3]));
    });
    const card = await book.end(CHAT, cwd, t, IDS);
    expect(card).toEqual({
      id: card!.id,
      at: [IDS[0]!, pageRowId(IDS[1]!)],
      how: "git",
      total: 3,
      added: 2,
      removed: 1,
      files: [
        { path: "docs/moved.txt", status: "R", added: 0, removed: 0, from: "old.txt" },
        { path: "logo.bin", status: "A", added: 0, removed: 0, binary: true },
        { path: "src/a.ts", status: "M", added: 2, removed: 1 },
      ],
    });
    expect(card!.at[1]).toBe("msg_01Plan-0");
    expect(card!.id).toMatch(/^[a-z2-7]{10}$/);
    // The whole summary, from the store, with the count of the user's own change.
    expect(await book.summary(CHAT, card!.id)).toEqual({ ...card!, others: 1 });
    expect((await book.cards(CHAT)).get(noteCardKey(IDS))).toEqual({ k: "changes", ...card! });
    // One file's diff, with both numbers.
    const d = await book.file(CHAT, cwd, card!.id, "src/a.ts");
    expect(d).toEqual({
      state: "diff",
      diff: { path: "src/a.ts", status: "M", added: 2, removed: 1, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, context: "", lines: [" a", "-b", "+B", " c", "+d"] }] },
    });
    expect((await book.file(CHAT, cwd, card!.id, "logo.bin")).state).toBe("diff");
    expect(await book.file(CHAT, cwd, card!.id, "notes.md")).toEqual({ state: "no_file" });
    expect(await book.file(CHAT, cwd, "aaaaaaaaaa", "src/a.ts")).toEqual({ state: "no_turn" });
    expect(lines[0]).toEqual({ count: 3, ok: true });
    // The store's files: the summaries and the objects, nothing of the marks' copies.
    expect(existsSync(join(store.dirOf(CHAT), "turns.json"))).toBe(true);
    expect(existsSync(join(store.dirOf(CHAT), "index"))).toBe(false);
  });
  test("a turn that changed nothing, or only what the user changed, has no card and no summary", async () => {
    const { book, store, cwd } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "r1", "Read", { file_path: join(cwd, "notes.md") }, () => {});
    await nap(120);
    writeFileSync(join(cwd, "notes.md"), "mine\n");
    expect(await book.end(CHAT, cwd, t, IDS)).toBeNull();
    expect(await store.read(CHAT)).toEqual([]);
  });
  test("more than five files: the card carries five, the summary every one", async () => {
    const { book, cwd } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "b1", "Bash", { command: "bun run gen" }, () => {
      for (let i = 0; i < 8; i++) writeFileSync(join(cwd, `gen-${i}.ts`), `export const n = ${i};\n`);
    });
    const card = (await book.end(CHAT, cwd, t, IDS))!;
    expect(card.total).toBe(8);
    expect(card.files.map((f) => f.path)).toEqual(["gen-0.ts", "gen-1.ts", "gen-2.ts", "gen-3.ts", "gen-4.ts"]);
    expect((await book.summary(CHAT, card.id))!.files.length).toBe(8);
  });
  test("an interrupted turn's changes before its end are shown (the end mark runs at every end)", async () => {
    const { book, cwd } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    book.note(t, call("b1", "Bash", { command: "sleep 30" }));
    writeFileSync(join(cwd, "half.txt"), "half\n");
    // No result: the Stop ended it.
    const card = await book.end(CHAT, cwd, t, IDS);
    expect(card!.files.map((f) => f.path)).toEqual(["half.txt"]);
  });
  test("the next turn's start mark waits for this turn's end mark (one at a time)", async () => {
    const { book, cwd } = setup();
    const t1 = book.begin(CHAT, cwd, "user");
    await t1.ready;
    await tool(book, t1, "w1", "Write", { file_path: join(cwd, "one.md") }, () => writeFileSync(join(cwd, "one.md"), "1\n"));
    const end1 = book.end(CHAT, cwd, t1, IDS);
    const t2 = book.begin(CHAT, cwd, "user");
    await t2.ready;
    await tool(book, t2, "w2", "Write", { file_path: join(cwd, "two.md") }, () => writeFileSync(join(cwd, "two.md"), "2\n"));
    const c2 = await book.end(CHAT, cwd, t2, ["8c9e6679-7425-40de-944b-e07fc1f90ae7"]);
    expect((await end1)!.files.map((f) => f.path)).toEqual(["one.md"]);
    expect(c2!.files.map((f) => f.path)).toEqual(["two.md"]);
  });
});

describe("without both marks", () => {
  test("the start mark's deadline: the message goes, and the turn falls back to Claude's own edits", async () => {
    const { book, cwd } = setup(undefined, { startMs: 1 });
    const t = book.begin(CHAT, cwd, "user");
    const began = performance.now();
    await t.ready;
    expect(performance.now() - began).toBeLessThan(1000);
    await tool(book, t, "e1", "Edit", { file_path: join(cwd, "src/a.ts") }, () => writeFileSync(join(cwd, "src/a.ts"), "a\nB\nc\n"));
    book.note(t, { k: "edit_patch", id: "e1", path: join(cwd, "src/a.ts"), create: false, added: 1, removed: 1, hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ["-b", "+B"] }], cut: false, parent: null });
    // A command's change is not in a fallback card.
    await tool(book, t, "b1", "Bash", { command: "touch x" }, () => writeFileSync(join(cwd, "x"), ""));
    const card = (await book.end(CHAT, cwd, t, IDS))!;
    expect(card.how).toBe("edits");
    expect(card.files).toEqual([{ path: "src/a.ts", status: "M", added: 1, removed: 1 }]);
    const s = (await book.summary(CHAT, card.id))!;
    expect(s.why).toBe("no_start");
    expect(await book.file(CHAT, cwd, card.id, "src/a.ts")).toEqual({
      state: "diff",
      diff: { path: "src/a.ts", status: "M", added: 1, removed: 1, hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, context: "", lines: ["-b", "+B"] }], edits: true },
    });
  });
  test("an agent's own turn: its mark holds only if it was done before the first tool call", async () => {
    const { book, cwd } = setup();
    const t = book.begin(CHAT, cwd, "agent");
    // The tool call comes before the mark is done.
    book.note(t, call("w1", "Write", { file_path: join(cwd, "fast.md") }));
    writeFileSync(join(cwd, "fast.md"), "f\n");
    book.note(t, result("w1"));
    book.note(t, { k: "edit_patch", id: "w1", path: join(cwd, "fast.md"), create: true, added: 1, removed: 0, hunks: [], cut: false, parent: null });
    const card = (await book.end(CHAT, cwd, t, IDS))!;
    expect(card.how).toBe("edits");
    expect((await book.summary(CHAT, card.id))!.why).toBe("no_start");
    // One that was: git's.
    const t2 = book.begin(CHAT, cwd, "agent");
    await t2.start;
    await tool(book, t2, "w2", "Write", { file_path: join(cwd, "slow.md") }, () => writeFileSync(join(cwd, "slow.md"), "s\n"));
    expect((await book.end(CHAT, cwd, t2, ["9c9e6679-7425-40de-944b-e07fc1f90ae7"]))!.how).toBe("git");
  });
  test("a folder that is not a repository: Claude's own edits, with the reason", async () => {
    const { book, s } = setup();
    const plain = join(s.root, "plain");
    mkdirSync(plain);
    const t = book.begin(CHAT, plain, "user");
    await t.ready;
    book.note(t, call("w1", "Write", { file_path: join(plain, "new.md") }));
    book.note(t, { k: "edit_patch", id: "w1", path: join(plain, "new.md"), create: true, added: 2, removed: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }], cut: false, parent: null });
    book.note(t, result("w1"));
    const card = (await book.end(CHAT, plain, t, IDS))!;
    expect(card).toMatchObject({ how: "edits", total: 1, added: 2, files: [{ path: "new.md", status: "A", added: 2, removed: 0 }] });
    expect((await book.summary(CHAT, card.id))!.why).toBe("not_git");
  });
  test("the end mark's deadline: the turn falls back, `failed`", async () => {
    const { book, cwd } = setup(undefined, { endMs: 1 });
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "w1", "Write", { file_path: join(cwd, "n.md") }, () => writeFileSync(join(cwd, "n.md"), "n\n"));
    book.note(t, { k: "edit_patch", id: "w1", path: join(cwd, "n.md"), create: true, added: 1, removed: 0, hunks: [], cut: false, parent: null });
    const card = (await book.end(CHAT, cwd, t, IDS))!;
    expect(card.how).toBe("edits");
    expect((await book.summary(CHAT, card.id))!.why).toBe("failed");
  });
  test("past the chat's size cap, no more marks: the next turn falls back, `full`", async () => {
    const { book, cwd } = setup(undefined, { chatBytes: 1 });
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "w1", "Write", { file_path: join(cwd, "n.md") }, () => writeFileSync(join(cwd, "n.md"), "n\n"));
    expect((await book.end(CHAT, cwd, t, IDS))!.how).toBe("git");
    const t2 = book.begin(CHAT, cwd, "user");
    await t2.ready;
    book.note(t2, { k: "edit_patch", id: "w2", path: join(cwd, "m.md"), create: true, added: 1, removed: 0, hunks: [], cut: false, parent: null });
    const card = (await book.end(CHAT, cwd, t2, ["9c9e6679-7425-40de-944b-e07fc1f90ae7"]))!;
    expect((await book.summary(CHAT, card.id))!.why).toBe("full");
  });
});

describe("a diff's read", () => {
  test("a large untracked file's row: its size, no lines; marks whose objects are gone: gone", async () => {
    const { book, store, cwd } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "b1", "Bash", { command: "make" }, () => {
      writeFileSync(join(cwd, "dump.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
      writeFileSync(join(cwd, "src/a.ts"), "z\n");
    });
    const card = (await book.end(CHAT, cwd, t, IDS))!;
    expect(card.files).toEqual([
      { path: "dump.bin", status: "A", added: 0, removed: 0, large: true },
      { path: "src/a.ts", status: "M", added: 1, removed: 3 },
    ]);
    expect(await book.file(CHAT, cwd, card.id, "dump.bin")).toEqual({ state: "diff", diff: { path: "dump.bin", status: "A", added: 0, removed: 0, large: { bytes: 9 * 1024 * 1024 }, hunks: [] } });
    // The repository moved away: its folder is no repository any more.
    const moved = `${cwd}-moved`;
    renameSync(cwd, moved);
    expect(await book.file(CHAT, cwd, card.id, "src/a.ts")).toEqual({ state: "gone" });
    expect(statSync(store.dirOf(CHAT)).isDirectory()).toBe(true);
  });
});

describe("Delete", () => {
  test("the chat's changes folder goes, and a mark that ends later writes nothing", async () => {
    const { book, store, cwd } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "w1", "Write", { file_path: join(cwd, "n.md") }, () => writeFileSync(join(cwd, "n.md"), "n\n"));
    expect(await book.end(CHAT, cwd, t, IDS)).not.toBeNull();
    const t2 = book.begin(CHAT, cwd, "user");
    await book.forget(CHAT);
    expect(existsSync(store.dirOf(CHAT))).toBe(false);
    await tool(book, t2, "w2", "Write", { file_path: join(cwd, "m.md") }, () => writeFileSync(join(cwd, "m.md"), "m\n"));
    expect(await book.end(CHAT, cwd, t2, IDS)).toBeNull();
    expect(existsSync(store.dirOf(CHAT))).toBe(false);
  });
});

describe("the caps and the diff's deadline", () => {
  test("more than 1,000 files: the summary lists 1,000 in path order, its totals count every one", async () => {
    const { book, cwd } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "b1", "Bash", { command: "bun run gen" }, () => {
      mkdirSync(join(cwd, "gen"));
      for (let i = 0; i < 1005; i++) writeFileSync(join(cwd, "gen", `f${String(i).padStart(4, "0")}.ts`), `export const n = ${i};\n`);
    });
    const card = (await book.end(CHAT, cwd, t, IDS))!;
    expect([card.total, card.added, card.files.length]).toEqual([1005, 1005, 5]);
    const s = (await book.summary(CHAT, card.id))!;
    expect(s.files.length).toBe(1000);
    expect(s.files[999]!.path).toBe("gen/f0999.ts");
  }, 30_000);
  test("a diff's read past its deadline fails (Try again), and nothing is kept of it", async () => {
    const { book, store, cwd } = setup(undefined, { diffMs: 1 });
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "e1", "Edit", { file_path: join(cwd, "src/a.ts") }, () => writeFileSync(join(cwd, "src/a.ts"), "x\n"));
    const card = (await book.end(CHAT, cwd, t, IDS))!;
    expect(await book.file(CHAT, cwd, card.id, "src/a.ts")).toEqual({ state: "failed" });
    expect((await store.read(CHAT)).length).toBe(1);
  });
});

describe("a shutdown's wait", () => {
  test("idle resolves once every queued mark and summary is done", async () => {
    const { book, store, cwd } = setup();
    const t = book.begin(CHAT, cwd, "user");
    await t.ready;
    await tool(book, t, "w1", "Write", { file_path: join(cwd, "late.md") }, () => writeFileSync(join(cwd, "late.md"), "l\n"));
    void book.end(CHAT, cwd, t, IDS);
    await book.idle();
    expect((await store.read(CHAT)).length).toBe(1);
    await book.idle();
  });
});
