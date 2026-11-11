// U1 review (DESIGN-U1 4.2 rules 1 and 2): a tool's run window opens when the call runs, not when it is announced.
// The stream's first word of a call (no input yet) opens nothing; a permission card that holds the call shuts its
// window until the Allow; AskUserQuestion and ExitPlanMode have no window at all. A file tool's target is the turn's
// only when its result was not an error: a denied or failed Edit changed nothing, so the user's own later edit of that
// file is the user's. And what another chat in the folder may read of this turn: its targets and its command windows.
import { describe, expect, test } from "bun:test";
import { TurnActivity } from "../../server/changes/activity";
import type { Card, ChatEvent } from "../../shared/protocol";

const call = (id: string, name: string, input: unknown = {}, parent: string | null = null): ChatEvent => ({ k: "tool_call", id, name, input, parent });
const result = (id: string, isError = false): ChatEvent => ({ k: "tool_result", id, text: "", isError, parent: null, report: null });
const permission = (id: string, toolName: string, input: unknown = {}): ChatEvent => ({
  k: "card_open",
  card: { kind: "permission", id, toolUseId: id, toolName, title: null, displayName: null, description: null, reason: null, blockedPath: null, input, defaultToNo: false, suppressAlwaysAllowRule: false, sessionRule: false, parent: null } as Card,
});
const question = (id: string): ChatEvent => ({ k: "card_open", card: { kind: "question", id, toolUseId: id, questions: [] } as unknown as Card });
const plan = (id: string): ChatEvent => ({ k: "card_open", card: { kind: "plan", id, toolUseId: id, plan: "x" } as unknown as Card });
const closed = (id: string, answer: "once" | "session" | "denied" | "answered" | "cancelled"): ChatEvent => ({ k: "card_close", id, why: answer === "cancelled" ? "cancelled" : "answered", answer });

describe("a call's window opens when it runs", () => {
  test("the stream's first word of a call opens nothing: a long Write's input streams with no window", () => {
    const a = new TurnActivity(0);
    a.note(call("w1", "Write", null), 0);
    a.note(call("w1", "Write", { file_path: "/srv/app/big.md", content: "x" }), 5_000);
    a.note(result("w1"), 5_100);
    a.close(9_000);
    expect(a.inWindow(2_500)).toBe(false);
    expect(a.inWindow(5_050)).toBe(true);
    expect(a.firstCall).toBe(0);
  });
  test("a permission card shuts the call's window until the Allow", () => {
    const a = new TurnActivity(0);
    a.note(call("b1", "Bash", null), 0);
    a.note(call("b1", "Bash", { command: "bun test" }), 100);
    a.note(permission("b1", "Bash", { command: "bun test" }), 110);
    // The user edits while the card waits.
    a.note(closed("b1", "once"), 2_000);
    a.note(result("b1"), 2_500);
    a.close(9_000);
    expect(a.inWindow(1_000)).toBe(false);
    expect(a.inWindow(2_200)).toBe(true);
    expect(a.inWindow(3_000)).toBe(false);
    expect(a.inCommandWindow(2_200)).toBe(true);
  });
  test("a card that opens before the call's whole input came holds it too; Allow for this session opens it", () => {
    const a = new TurnActivity(0);
    a.note(call("e1", "Edit", null), 0);
    a.note(permission("e1", "Edit", { file_path: "/srv/app/a.ts" }), 50);
    a.note(call("e1", "Edit", { file_path: "/srv/app/a.ts" }), 60);
    a.note(closed("e1", "session"), 1_000);
    a.note(result("e1"), 1_100);
    a.close(2_000);
    expect(a.inWindow(500)).toBe(false);
    expect(a.inWindow(1_050)).toBe(true);
    expect([...a.targets]).toEqual(["/srv/app/a.ts"]);
  });
  test("a card that comes before any event of its call: the window opens when the call comes after the Allow", () => {
    const a = new TurnActivity(0);
    a.note(permission("b1", "Bash", { command: "make" }), 100);
    a.note(closed("b1", "once"), 500);
    a.note(call("b1", "Bash", { command: "make" }), 510);
    a.note(result("b1"), 600);
    // A card whose call never comes opens nothing.
    a.note(permission("x1", "Workflow"), 700);
    a.note(closed("x1", "once"), 800);
    a.close(2_000);
    expect(a.inWindow(300)).toBe(false);
    expect(a.inWindow(550)).toBe(true);
    expect(a.inWindow(1_500)).toBe(false);
  });
  test("a denied permission opens no window again, and its file is not a target", () => {
    const a = new TurnActivity(0);
    a.note(call("e1", "Edit", { file_path: "/srv/app/denied.ts" }), 100);
    a.note(permission("e1", "Edit", { file_path: "/srv/app/denied.ts" }), 105);
    a.note(closed("e1", "denied"), 300);
    a.note({ k: "denied", id: "e1", tool: "Edit", reasonType: null, reason: null, parent: null }, 301);
    a.close(2_000);
    expect(a.inWindow(1_000)).toBe(false);
    expect(a.targets.size).toBe(0);
  });
  test("AskUserQuestion and ExitPlanMode have no window: the user's edits while they wait are the user's", () => {
    const a = new TurnActivity(0);
    a.note(call("q1", "AskUserQuestion", null), 0);
    a.note(call("q1", "AskUserQuestion", { questions: [] }), 10);
    a.note(question("q1"), 12);
    a.note(closed("q1", "answered"), 600);
    a.note(result("q1"), 610);
    a.note(call("p1", "ExitPlanMode", { plan: "x" }), 1_000);
    a.note(plan("p1"), 1_002);
    a.note(closed("p1", "answered"), 1_800);
    a.note(result("p1"), 1_810);
    a.close(3_000);
    for (const at of [5, 300, 605, 1_400, 1_805]) expect(a.inWindow(at)).toBe(false);
  });
});

describe("a file tool's target is the turn's only when its result was not an error", () => {
  test("a failed Edit, a denied Write and a stopped call that never ran name nothing; a done Edit does", () => {
    const a = new TurnActivity(0);
    a.note(call("e1", "Edit", { file_path: "/srv/app/missing.ts" }), 100);
    a.note(result("e1", true), 110);
    a.note(call("w1", "Write", { file_path: "/srv/app/denied.md" }), 200);
    a.note({ k: "denied", id: "w1", tool: "Write", reasonType: null, reason: null, parent: null }, 210);
    a.note(call("w2", "Write", { file_path: "/srv/app/held.md" }), 300);
    a.note(permission("w2", "Write"), 301);
    a.note({ k: "tool_stopped", id: "w2", parent: null }, 400);
    a.note(call("e2", "MultiEdit", { file_path: "/srv/app/ok.ts" }), 500);
    a.note(result("e2"), 510);
    a.note(call("w3", "Write", { file_path: "/srv/app/cut.md" }), 600);
    a.note({ k: "tool_stopped", id: "w3", parent: null }, 700);
    a.close(1_000);
    expect([...a.targets].sort()).toEqual(["/srv/app/cut.md", "/srv/app/ok.ts"]);
  });
});

describe("what another chat's summary reads of this turn", () => {
  test("the targets named in a span of time (running calls too, not failed ones) and the command windows", () => {
    const a = new TurnActivity(0);
    a.note(call("e1", "Edit", { file_path: "/srv/app/early.ts" }), 100);
    a.note(result("e1"), 120);
    a.note(call("e2", "Edit", { file_path: "/srv/app/bad.ts" }), 1_000);
    a.note(result("e2", true), 1_010);
    a.note(call("e3", "Write", { file_path: "/srv/app/now.ts" }), 1_100);
    a.note(call("b1", "Bash", { command: "make" }), 1_200);
    a.note(result("b1"), 1_900);
    expect(a.namedDuring(900, 2_000)).toEqual(["/srv/app/now.ts"]);
    expect(a.namedDuring(0, 2_000).sort()).toEqual(["/srv/app/early.ts", "/srv/app/now.ts"]);
    expect(a.commandSpans()).toEqual([{ start: 1_200, end: 1_900 }]);
  });
});
