// U1 review: whose changes a turn's card holds, in a real scratch repository. Two chats in one folder: chat B's Edit
// while chat A's long command runs is B's, not A's; a `!` command of another chat while A runs no command of its own
// is not A's. The user's edit while a permission card waits, or after a denied Edit of that file, is the user's. A
// folder with too many untracked files takes no mark (no objects grow, each turn); a folder whose start mark came late
// does not hold the next message, until a start mark is done in time again.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChangesBook, type TurnChanges } from "../../server/changes/book";
import { ChangesStore } from "../../server/changes/store";
import { ownUid } from "../../server/store/files";
import type { Card, ChatEvent } from "../../shared/protocol";
import { commitAll, scratch, type Scratch } from "./worktree-repo";

const A = "k3m7q2x4abk3m7q2x4ab";
const B = "m7q2x4abk3m7q2x4abk3";
const IDS_A = ["7c9e6679-7425-40de-944b-e07fc1f90ae7"];
const IDS_B = ["8c9e6679-7425-40de-944b-e07fc1f90ae7"];

let open: Scratch[] = [];
afterEach(() => {
  for (const s of open) s.cleanup();
  open = [];
});

function setup(files: Record<string, string> = { "a.ts": "a\n", "b.ts": "b\n", "c.ts": "c\n", "mine.md": "m\n" }, limits = {}) {
  const s = scratch();
  open.push(s);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(s.repo, rel), body);
  commitAll(s.repo, "files");
  const root = join(s.root, "state", "changes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = new ChangesStore(root, ownUid());
  const book = new ChangesBook({ store, git: s.wg, limits });
  return { s, store, book, cwd: s.repo };
}

const call = (id: string, name: string, input: unknown = {}): ChatEvent => ({ k: "tool_call", id, name, input, parent: null });
const result = (id: string): ChatEvent => ({ k: "tool_result", id, text: "", isError: false, parent: null, report: null });
const nap = (ms: number) => Bun.sleep(ms);
const paths = async (book: ChangesBook, chat: string, id: string | undefined) => (id ? (await book.summary(chat, id))! : null);

describe("two chats in one folder", () => {
  test("chat B's Edit while chat A's long command runs is B's alone; A's card keeps its own change", async () => {
    const { book, cwd } = setup();
    const ta = book.begin(A, cwd, "user");
    const tb = book.begin(B, cwd, "user");
    await Promise.all([ta.ready, tb.ready]);
    book.note(ta, call("a1", "Bash", { command: "bun test" }));
    await nap(20);
    writeFileSync(join(cwd, "a.ts"), "a\nA\n");
    await nap(100);
    book.note(tb, call("b1", "Edit", { file_path: join(cwd, "b.ts") }));
    await nap(5);
    writeFileSync(join(cwd, "b.ts"), "b\nB\n");
    await nap(5);
    book.note(tb, result("b1"));
    await nap(100);
    book.note(ta, result("a1"));
    const ca = await book.end(A, cwd, ta, IDS_A);
    const cb = await book.end(B, cwd, tb, IDS_B);
    expect(ca?.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(cb?.files.map((f) => f.path)).toEqual(["b.ts"]);
    const sa = (await paths(book, A, ca?.id))!;
    // b.ts is counted apart as the other chat's, not as changed while Claude was not running a tool.
    expect([sa.others, sa.elsewhere]).toEqual([0, 1]);
  });
  test("another chat's `!` command while this turn runs no command is not this turn's; during its command it is", async () => {
    const { book, cwd } = setup();
    const ta = book.begin(A, cwd, "user");
    await ta.ready;
    // A runs a Read (no command), while chat B's `!` command changes c.ts.
    book.note(ta, call("r1", "Read", { file_path: join(cwd, "a.ts") }));
    await nap(10);
    const bang = book.command(B, cwd);
    await nap(5);
    writeFileSync(join(cwd, "c.ts"), "c\nC\n");
    await nap(5);
    bang();
    await nap(10);
    book.note(ta, result("r1"));
    await nap(100);
    // Then A's own command runs while another `!` of B changes b.ts: both may have made it, so it counts for A.
    book.note(ta, call("a2", "Bash", { command: "make" }));
    await nap(10);
    const bang2 = book.command(B, cwd);
    writeFileSync(join(cwd, "b.ts"), "b\nB\n");
    await nap(5);
    bang2();
    await nap(10);
    book.note(ta, result("a2"));
    const ca = (await book.end(A, cwd, ta, IDS_A))!;
    expect(ca.files.map((f) => f.path)).toEqual(["b.ts"]);
    expect((await book.summary(A, ca.id))!.elsewhere).toBe(1);
  });
});

describe("the user's edits while nothing runs", () => {
  const permission = (id: string, toolName: string, input: unknown): ChatEvent => ({
    k: "card_open",
    card: { kind: "permission", id, toolUseId: id, toolName, title: null, displayName: null, description: null, reason: null, blockedPath: null, input, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null } as Card,
  });
  test("while a permission card waits: the user's; after the Allow, the command's", async () => {
    const { book, cwd } = setup();
    const t = book.begin(A, cwd, "user");
    await t.ready;
    book.note(t, call("b1", "Bash", null));
    book.note(t, call("b1", "Bash", { command: "make" }));
    book.note(t, permission("b1", "Bash", { command: "make" }));
    await nap(150);
    writeFileSync(join(cwd, "mine.md"), "m\nmine\n");
    await nap(150);
    book.note(t, { k: "card_close", id: "b1", why: "answered", answer: "once" });
    await nap(5);
    writeFileSync(join(cwd, "a.ts"), "a\nmade\n");
    await nap(5);
    book.note(t, result("b1"));
    const card = (await book.end(A, cwd, t, IDS_A))!;
    expect(card.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect((await book.summary(A, card.id))!.others).toBe(1);
  });
  test("a question card's wait has no window", async () => {
    const { book, cwd } = setup();
    const t = book.begin(A, cwd, "user");
    await t.ready;
    book.note(t, call("q1", "AskUserQuestion", null));
    book.note(t, call("q1", "AskUserQuestion", { questions: [] }));
    await nap(150);
    writeFileSync(join(cwd, "mine.md"), "m\nmine\n");
    await nap(150);
    book.note(t, result("q1"));
    await nap(100);
    await (async () => {
      book.note(t, call("e1", "Edit", { file_path: join(cwd, "a.ts") }));
      await nap(5);
      writeFileSync(join(cwd, "a.ts"), "a\nedit\n");
      await nap(5);
      book.note(t, result("e1"));
    })();
    const card = (await book.end(A, cwd, t, IDS_A))!;
    expect(card.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect((await book.summary(A, card.id))!.others).toBe(1);
  });
  test("a denied Edit names nothing: the user's later edit of that file is the user's", async () => {
    const { book, cwd } = setup();
    const t = book.begin(A, cwd, "user");
    await t.ready;
    book.note(t, call("e1", "Edit", { file_path: join(cwd, "b.ts") }));
    book.note(t, { k: "denied", id: "e1", tool: "Edit", reasonType: null, reason: null, parent: null });
    await nap(150);
    writeFileSync(join(cwd, "b.ts"), "b\nmine\n");
    await nap(150);
    await (async () => {
      book.note(t, call("e2", "Edit", { file_path: join(cwd, "a.ts") }));
      await nap(5);
      writeFileSync(join(cwd, "a.ts"), "a\nedit\n");
      await nap(5);
      book.note(t, result("e2"));
    })();
    const card = (await book.end(A, cwd, t, IDS_A))!;
    expect(card.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect((await book.summary(A, card.id))!.others).toBe(1);
  });
});

describe("a folder whose marks cost too much", () => {
  test("too many bytes of untracked files: no mark (`big`), and the chat's objects do not grow turn after turn", async () => {
    const { book, store, cwd } = setup(undefined, { markBytes: 1_000_000 });
    mkdirSync(join(cwd, "data"));
    for (let i = 0; i < 20; i++) writeFileSync(join(cwd, "data", `f${i}.bin`), Buffer.alloc(100_000, i));
    for (let turn = 0; turn < 3; turn++) {
      const t = book.begin(A, cwd, "user");
      await t.ready;
      book.note(t, call(`w${turn}`, "Write", { file_path: join(cwd, `n${turn}.md`) }));
      writeFileSync(join(cwd, `n${turn}.md`), "n\n");
      book.note(t, result(`w${turn}`));
      book.note(t, { k: "edit_patch", id: `w${turn}`, path: join(cwd, `n${turn}.md`), create: true, added: 1, removed: 0, hunks: [], cut: false, parent: null });
      const card = (await book.end(A, cwd, t, [`${turn}c9e6679-7425-40de-944b-e07fc1f90ae7`]))!;
      expect(card.how).toBe("edits");
      expect((await book.summary(A, card.id))!.why).toBe("big");
    }
    const objects = join(store.dirOf(A), "objects");
    expect(readdirSync(objects)).toEqual([]);
  });
  test("a start mark past its deadline: the next message is not held, until a start mark is done in time", async () => {
    const { s, book, cwd } = setup(undefined, { startMs: 400 });
    // A git that takes 300 ms a call: the start mark (several calls) passes its 400 ms deadline.
    const slow = join(s.root, "slow-git");
    writeFileSync(slow, `#!/bin/sh\nsleep 0.3\nexec "${s.wg.git}" "$@"\n`);
    chmodSync(slow, 0o700);
    const fast = s.wg.git;
    s.wg.git = slow;
    const t1 = book.begin(A, cwd, "user");
    await t1.ready;
    expect((await t1.start).why).toBe("no_start");
    await book.end(A, cwd, t1, IDS_A);
    // The next message goes at once: its mark is not waited for (git is fast again, but the chat does not know yet).
    s.wg.git = fast;
    const order = (t: TurnChanges) => {
      const seen: string[] = [];
      void t.start.then(() => seen.push("mark"));
      void t.ready.then(() => seen.push("send"));
      return seen;
    };
    const t2 = book.begin(A, cwd, "user");
    const o2 = order(t2);
    await t2.ready;
    await t2.start;
    expect(o2).toEqual(["send", "mark"]);
    expect((await t2.start).mark).toBeDefined();
    await book.end(A, cwd, t2, IDS_B);
    // That mark was done in time: the message after it waits for its mark again.
    const t3 = book.begin(A, cwd, "user");
    const o3 = order(t3);
    await t3.ready;
    await t3.start;
    expect(o3).toEqual(["mark", "send"]);
  }, 20_000);
});
