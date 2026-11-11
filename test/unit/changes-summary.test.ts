// U1 (DESIGN-U1 4.2, 4.4 and 5): which changes are the turn's, with no git and no disk. The tool windows (a change's
// ctime inside a call's window, with 50 ms of slack, a background task's window open until its task ends or the turn
// ends), a file tool's target, a delete in a turn that ran a command; and the summary per turn: an edit, a new file, a
// delete, a rename, a binary file, a large untracked file, a gitlink, a mode change, a file changed outside every
// window (left out, counted in `others`); then the fallback from the file tools' own patches.
import { describe, expect, test } from "bun:test";
import { TurnActivity } from "../../server/changes/activity";
import type { RawChange } from "../../server/changes/patch";
import { editsTally, gitTally, inFolder, type GitFacts, type LargeFile } from "../../server/changes/summary";
import type { ChatEvent } from "../../shared/protocol";

const call = (id: string, name: string, input: unknown = {}, parent: string | null = null): ChatEvent => ({ k: "tool_call", id, name, input, parent });
const result = (id: string, isError = false): ChatEvent => ({ k: "tool_result", id, text: "", isError, parent: null, report: null });
const ID = (n: number) => n.toString(16).padStart(40, "0");
const raw = (status: string, path: string, added: number | null, removed: number | null, more: Partial<RawChange> = {}): RawChange => ({
  status,
  path,
  oldMode: status === "A" ? "000000" : "100644",
  newMode: status === "D" ? "000000" : "100644",
  oldId: ID(1),
  newId: ID(2),
  added,
  removed,
  ...more,
});

/** A turn: Edit of a.ts from 1,000 to 1,100 ms, Bash from 2,000 to 3,000 ms, closed at 5,000 ms. */
function turn(): TurnActivity {
  const a = new TurnActivity(50);
  a.note(call("e1", "Edit", { file_path: "/srv/app/src/a.ts" }), 1000);
  a.note(result("e1"), 1100);
  a.note(call("b1", "Bash", { command: "bun run format" }), 2000);
  a.note(result("b1"), 3000);
  a.close(5000);
  return a;
}

function facts(a: TurnActivity, ctimes: Record<string, number | null>, more: Partial<GitFacts> = {}): GitFacts {
  const targets = new Set<string>();
  for (const t of a.targets) {
    const rel = inFolder(t, "/srv/app");
    if (rel) targets.add(rel);
  }
  return { activity: a, targets, ctimes: new Map(Object.entries(ctimes)), startLarge: new Map(), endLarge: new Map(), ...more };
}

describe("the tool windows (rule 2)", () => {
  test("a ctime inside a call's window, with 50 ms of slack on each side", () => {
    const a = turn();
    expect(a.inWindow(1050)).toBe(true);
    expect(a.inWindow(951)).toBe(true);
    expect(a.inWindow(1149)).toBe(true);
    expect(a.inWindow(1200)).toBe(false);
    expect(a.inWindow(1949)).toBe(false);
    expect(a.inWindow(2500)).toBe(true);
    expect(a.inWindow(3060)).toBe(false);
    expect(a.firstCall).toBe(1000);
    expect(a.ranCommand).toBe(true);
  });
  test("a call's window opens at its second event (its whole input), not at the stream's first word of it", () => {
    const a = new TurnActivity(0);
    a.note(call("w1", "Write", null), 100);
    a.note(call("w1", "Write", { file_path: "/srv/app/n.md", content: "x" }), 400);
    a.note(result("w1"), 500);
    a.close(900);
    expect(a.inWindow(150)).toBe(false);
    expect(a.inWindow(450)).toBe(true);
    expect(a.firstCall).toBe(100);
    expect([...a.targets]).toEqual(["/srv/app/n.md"]);
  });
  test("a call that went to the background keeps its window open until its task ends, else until the turn ends", () => {
    const a = new TurnActivity(0);
    a.note(call("b1", "Bash", { command: "sleep 30", run_in_background: true }), 1000);
    a.note({ k: "task", ev: "started", taskId: "t1", toolUseId: "b1", taskType: "local_bash", subagentType: null, description: "", workflowName: null, background: true, prompt: null, parentTaskId: null }, 1010);
    a.note(result("b1"), 1020);
    a.note(call("b2", "Bash", { command: "sleep 30" }), 2000);
    a.note(result("b2"), 2100);
    a.note({ k: "task", ev: "updated", taskId: "t2", toolUseId: "b2", status: null, error: null, background: true }, 2200);
    a.note({ k: "task", ev: "done", taskId: "t1", toolUseId: "b1", status: "completed", summary: null, usage: null }, 4000);
    a.close(9000);
    expect(a.inWindow(3000)).toBe(true);
    expect(a.inWindow(4500)).toBe(true);
    expect(a.inWindow(8999)).toBe(true);
    expect(a.inWindow(9001)).toBe(false);
  });
  test("a subagent's calls count too; a denied or stopped call's window ends there", () => {
    const a = new TurnActivity(0);
    a.note(call("s1", "Write", { file_path: "/srv/app/sub.md" }, "agent_1"), 100);
    a.note({ k: "denied", id: "s1", tool: "Write", reasonType: null, reason: null, parent: "agent_1" }, 200);
    a.note(call("s2", "Bash", {}, "agent_1"), 300);
    a.note({ k: "tool_stopped", id: "s2", parent: "agent_1" }, 400);
    a.close(1000);
    // The denied Write changed nothing: its file is not a target (rule 1 waits for a result that is not an error).
    expect(a.targets.has("/srv/app/sub.md")).toBe(false);
    expect(a.inWindow(250)).toBe(false);
    expect(a.inWindow(350)).toBe(true);
    expect(a.inWindow(600)).toBe(false);
  });
  test("a NotebookEdit's notebook counts once its result is not an error", () => {
    const a = new TurnActivity(0);
    a.note(call("n1", "NotebookEdit", { notebook_path: "/srv/app/nb.ipynb" }), 1);
    a.note(result("n1"), 2);
    a.note(call("n2", "NotebookEdit", { notebook_path: "/srv/app/bad.ipynb" }), 3);
    a.note(result("n2", true), 4);
    expect(a.notebooks).toEqual(["/srv/app/nb.ipynb"]);
  });
});

describe("the summary per turn (git)", () => {
  test("an edit, a new file, a rename and a delete in a turn that ran a command; a change outside every window is the user's", () => {
    const a = turn();
    const t = gitTally(
      [raw("M", "src/a.ts", 2, 1), raw("A", "src/b.ts", 12, 0), raw("R", "docs/new.md", 0, 0, { from: "docs/old.md" }), raw("D", "tmp/gone.txt", 0, 60), raw("M", "notes.txt", 3, 0)],
      // a.ts changed after its Edit (the formatter): still the turn's (its tool named it). notes.txt: the user's, at 4,000 ms.
      facts(a, { "src/a.ts": 2500, "src/b.ts": 2600, "docs/new.md": 2700, "notes.txt": 4000 }),
    );
    expect(t.files).toEqual([
      { path: "docs/new.md", status: "R", added: 0, removed: 0, from: "docs/old.md" },
      { path: "src/a.ts", status: "M", added: 2, removed: 1 },
      { path: "src/b.ts", status: "A", added: 12, removed: 0 },
      { path: "tmp/gone.txt", status: "D", added: 0, removed: 60 },
    ]);
    expect([t.total, t.added, t.removed, t.others]).toEqual([4, 14, 61, 1]);
  });
  test("a delete in a turn that ran no command is not the turn's; one its file tool named is", () => {
    const a = new TurnActivity(50);
    a.note(call("e1", "Write", { file_path: "/srv/app/kept.md" }), 100);
    a.note(result("e1"), 200);
    a.close(300);
    const t = gitTally([raw("D", "old.md", 0, 3), raw("D", "kept.md", 0, 1)], facts(a, {}));
    expect(t.files.map((f) => f.path)).toEqual(["kept.md"]);
    expect(t.others).toBe(1);
  });
  test("a binary file has no counts; a gitlink is left out; a change of the mode alone is counted apart", () => {
    const a = turn();
    const t = gitTally(
      [raw("A", "assets/logo.bin", null, null), raw("A", "vendor/nested", 1, 0, { newMode: "160000" }), raw("M", "run.sh", 0, 0, { oldId: ID(7), newId: ID(7), newMode: "100755" })],
      facts(a, { "assets/logo.bin": 2100, "vendor/nested": 2100, "run.sh": 2100 }),
    );
    expect(t.files).toEqual([{ path: "assets/logo.bin", status: "A", added: 0, removed: 0, binary: true }]);
    expect([t.total, t.others]).toEqual([1, 1]);
  });
  test("a large untracked file: new, changed, unchanged, crossed the cap, gone", () => {
    const a = turn();
    const L = (size: number, at: number): LargeFile => ({ size, mtimeMs: at, ctimeMs: at });
    const startLarge = new Map([
      ["same.bin", L(9e6, 10)],
      ["grew.bin", L(9e6, 10)],
      ["shrank.bin", L(9e6, 10)],
      ["gone.bin", L(9e6, 10)],
    ]);
    const endLarge = new Map([
      ["same.bin", L(9e6, 10)],
      ["grew.bin", L(1e7, 2500)],
      ["new.bin", L(9e6, 2500)],
      ["crossed.bin", L(9e6, 2500)],
    ]);
    const t = gitTally(
      // crossed.bin was small at the start (in that mark) and is left out of the end's: git calls it deleted.
      // shrank.bin is small at the end (in that mark): git calls it added.
      [raw("D", "crossed.bin", 0, 10), raw("A", "shrank.bin", 4, 0)],
      facts(a, { "grew.bin": 2500, "new.bin": 2500, "crossed.bin": 2500, "shrank.bin": 2600, "gone.bin": null }, { startLarge, endLarge }),
    );
    expect(t.files).toEqual([
      { path: "crossed.bin", status: "M", added: 0, removed: 0, large: true },
      { path: "gone.bin", status: "D", added: 0, removed: 0, large: true },
      { path: "grew.bin", status: "M", added: 0, removed: 0, large: true },
      { path: "new.bin", status: "A", added: 0, removed: 0, large: true },
      { path: "shrank.bin", status: "M", added: 0, removed: 0, large: true },
    ]);
  });
  test("a path that a URL may not hold is counted and not listed; an unsafe old path is dropped", () => {
    const a = turn();
    const t = gitTally([raw("M", "bad\u0007name.txt", 1, 1), raw("R", "ok.txt", 0, 0, { from: "bad\u0007old.txt" })], facts(a, { "bad\u0007name.txt": 2500, "ok.txt": 2500 }));
    expect(t.files).toEqual([{ path: "ok.txt", status: "R", added: 0, removed: 0 }]);
    expect([t.total, t.added, t.removed]).toEqual([2, 1, 1]);
  });
});

describe("a path in the chat's folder", () => {
  test("relative to the folder or its real path; outside it, none", () => {
    expect(inFolder("/srv/app/src/a.ts", "/srv/app")).toBe("src/a.ts");
    expect(inFolder("/real/app/src/a.ts", "/srv/app", "/real/app")).toBe("src/a.ts");
    expect(inFolder("src/./b.ts", "/srv/app")).toBe("src/b.ts");
    expect(inFolder("/srv/other/a.ts", "/srv/app")).toBeNull();
    expect(inFolder("../a.ts", "/srv/app")).toBeNull();
    expect(inFolder("/srv/app", "/srv/app")).toBeNull();
    expect(inFolder("/srv/app/..hidden", "/srv/app")).toBe("..hidden");
  });
});

describe("the fallback: Claude's own edits", () => {
  const patch = (id: string, path: string, added: number, removed: number, create = false): ChatEvent => ({
    k: "edit_patch",
    id,
    path,
    create,
    added,
    removed,
    hunks: [{ oldStart: 1, oldLines: removed, newStart: 1, newLines: added, lines: [...Array(removed).fill("-x"), ...Array(added).fill("+y")] }],
    cut: false,
    parent: null,
  });
  test("counts summed over the turn's edits; a Write that created a file is new; a notebook has no counts", () => {
    const a = new TurnActivity(0);
    a.note(patch("e1", "/srv/app/src/a.ts", 2, 1), 1);
    a.note(patch("e2", "/srv/app/src/a.ts", 3, 0), 2);
    a.note(patch("w1", "/srv/app/docs/new.md", 5, 0, true), 3);
    a.note(patch("w2", "/srv/elsewhere/x.md", 1, 0, true), 4);
    a.note(call("n1", "NotebookEdit", { notebook_path: "/srv/app/nb.ipynb" }), 5);
    a.note(result("n1"), 6);
    const t = editsTally(a, "/srv/app", null);
    expect(t.files).toEqual([
      { path: "docs/new.md", status: "A", added: 5, removed: 0 },
      { path: "nb.ipynb", status: "M", added: 0, removed: 0, notebook: true },
      { path: "src/a.ts", status: "M", added: 5, removed: 1 },
    ]);
    // The edit outside the folder is counted, never listed.
    expect([t.total, t.added, t.removed, t.others]).toEqual([4, 11, 1, 0]);
    expect(t.hunks.get("src/a.ts")!.length).toBe(2);
  });
  test("the hunks kept stop at the cap", () => {
    const a = new TurnActivity(0);
    for (let i = 0; i < 50; i++) a.note(patch(`e${i}`, "/srv/app/a.ts", 100, 0), i);
    const t = editsTally(a, "/srv/app", null, 4096);
    expect(JSON.stringify([...t.hunks.values()]).length).toBeLessThanOrEqual(4096);
    expect(t.files[0]!.added).toBe(5000);
  });
  test("no edits: nothing", () => {
    expect(editsTally(new TurnActivity(0), "/srv/app", null).total).toBe(0);
  });
});

describe("another chat in the same folder (review: whose changes)", () => {
  /** This turn: a long Bash from 1,000 to 6,000 ms and a Read from 7,000 to 7,500 ms, closed at 9,000 ms. */
  function long(): TurnActivity {
    const a = new TurnActivity(50);
    a.note(call("b1", "Bash", { command: "bun test" }), 1000);
    a.note(result("b1"), 6000);
    a.note(call("r1", "Read", { file_path: "/srv/app/a.ts" }), 7000);
    a.note(result("r1"), 7500);
    a.close(9000);
    return a;
  }
  const other = (targets: string[], windows: { start: number; end: number }[] = []) => ({
    targets: new Set(targets),
    inWindow: (c: number) => windows.some((w) => c >= w.start - 50 && c <= w.end + 50),
  });
  test("a file that only another chat's file tool named is not this turn's: counted apart, not as the user's", () => {
    const a = long();
    const t = gitTally([raw("M", "a.ts", 1, 0), raw("M", "b.ts", 1, 0)], facts(a, { "a.ts": 1500, "b.ts": 2000 }, { elsewhere: other(["b.ts"]) }));
    expect(t.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect([t.total, t.others, t.elsewhere]).toEqual([1, 0, 1]);
  });
  test("a file this turn's own file tool named stays the turn's, whoever else named it", () => {
    const b = new TurnActivity(50);
    b.note(call("e1", "Edit", { file_path: "/srv/app/b.ts" }), 8000);
    b.note(result("e1"), 8100);
    b.close(9000);
    const t = gitTally([raw("M", "b.ts", 1, 0)], facts(b, { "b.ts": 8050 }, { elsewhere: other(["b.ts"]) }));
    expect(t.files.map((f) => f.path)).toEqual(["b.ts"]);
    expect(t.elsewhere).toBe(0);
  });
  test("a change in another chat's command window: the turn's while its own command ran (both), else apart", () => {
    const a = long();
    const t = gitTally(
      [raw("M", "both.ts", 1, 0), raw("M", "theirs.ts", 1, 0), raw("M", "mine.md", 1, 0)],
      // both.ts: inside this turn's Bash and the other chat's `!` command. theirs.ts: inside this turn's Read only, and
      // inside the other chat's command. mine.md: the user's, outside every window.
      facts(a, { "both.ts": 2000, "theirs.ts": 7200, "mine.md": 8500 }, { elsewhere: other([], [{ start: 1900, end: 2100 }, { start: 7100, end: 7300 }]) }),
    );
    expect(t.files.map((f) => f.path)).toEqual(["both.ts"]);
    expect([t.others, t.elsewhere]).toEqual([1, 1]);
  });
});
