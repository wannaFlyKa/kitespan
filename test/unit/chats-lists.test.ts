// The list rules (D48 E3; DESIGN.md 6.2, 6.9): archived chats leave every list but the Archived view; "From the
// terminal" leaves out the sessions that kitespan chats hold.
import { describe, expect, test } from "bun:test";
import type { ChatRow } from "../../shared/protocol";
import { filterChats, fromTerminal, projectChats, recentChats } from "../../server/chats/lists";

const row = (chat: string, over: Partial<ChatRow> = {}): ChatRow => ({
  chat,
  title: chat,
  project: "k3m7q2x4ab",
  state: "sleeping",
  needsYou: false,
  lastActivity: "2026-10-31T10:00:00.000Z",
  archived: false,
  ...over,
});

const rows: ChatRow[] = [
  row("a", { lastActivity: "2026-10-31T09:00:00.000Z" }),
  row("b", { state: "running", lastActivity: "2026-10-31T11:00:00.000Z" }),
  row("c", { state: "waiting", needsYou: true, lastActivity: "2026-10-31T10:30:00.000Z" }),
  row("d", { archived: true, state: "sleeping", lastActivity: "2026-10-31T12:00:00.000Z" }),
  row("e", { project: "q2x4abk3m7", lastActivity: "2026-10-31T08:00:00.000Z" }),
];

describe("the chat list filters", () => {
  test("All leaves archived chats out, newest first", () => {
    expect(filterChats(rows, "all").map((r) => r.chat)).toEqual(["b", "c", "a", "e"]);
  });
  test("Working is a running turn; Needs input is an open card", () => {
    expect(filterChats(rows, "working").map((r) => r.chat)).toEqual(["b"]);
    expect(filterChats(rows, "needs-input").map((r) => r.chat)).toEqual(["c"]);
  });
  test("Archived lists only the archived chats", () => {
    expect(filterChats(rows, "archived").map((r) => r.chat)).toEqual(["d"]);
  });
  test("a running archived chat is not Working (it cannot be: archive ends the process)", () => {
    expect(filterChats([row("x", { archived: true, state: "running" })], "working")).toEqual([]);
  });
});

describe("Recent and the project page", () => {
  test("Recent: every project, newest first, archived left out, 10 on Home", () => {
    expect(recentChats(rows).map((r) => r.chat)).toEqual(["b", "c", "a", "e"]);
    expect(recentChats(rows, 2).map((r) => r.chat)).toEqual(["b", "c"]);
  });
  test("a project page holds its own chats only, archived left out", () => {
    expect(projectChats(rows, "k3m7q2x4ab").map((r) => r.chat)).toEqual(["b", "c", "a"]);
    expect(projectChats(rows, "q2x4abk3m7").map((r) => r.chat)).toEqual(["e"]);
  });
});

describe("From the terminal", () => {
  test("leaves out the sessions that a kitespan chat holds, newest first", () => {
    const sessions = [
      { sessionId: "s1", title: "one", customTitle: null, lastModified: 1, cwd: null },
      { sessionId: "s2", title: "two", customTitle: null, lastModified: 3, cwd: null },
      { sessionId: "s3", title: "three", customTitle: null, lastModified: 2, cwd: null },
    ];
    expect(fromTerminal(sessions, new Set(["s1"])).map((s) => s.sessionId)).toEqual(["s2", "s3"]);
  });
});
