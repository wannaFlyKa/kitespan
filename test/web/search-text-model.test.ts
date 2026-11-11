// U5 (FIX-U5 1 and 2, DESIGN-U5 7 and 8): the Messages group in the search pane's model. It is drawn last (after
// Commands, also for a "/" query), with its own 20 rows outside the 120 that the other groups share; while it is asked,
// Files keeps at most its floor, so nothing above it moves when its rows land; the Chats scope keeps it, the Files and
// Commands scopes do not; a chat's rows stay together, the first carries the chat (its title and time come from the
// page's own list, archived chats included), and a hit of a chat the page does not hold is dropped; an answer for
// another query is not drawn; the list's true count is the other groups' (data-count), the group has its own. A pick
// goes to /c/<chat>/m/<message> with the query as `mark`.
import { describe, expect, test } from "bun:test";
import type { FileRows } from "../../web/search/engine";
import { MESSAGE_ROWS, SECTION_FLOOR, SECTION_ORDER, SECTION_TITLE, enterPick, flatRows, kindsOf, searchSections, type SearchInput } from "../../web/search/sections";
import { markOf, pickHref } from "../../web/search/nav";
import type { MessageHit } from "../../web/search/messages";
import type { MenuRow } from "../../web/composer/draft";
import type { Chat } from "../../web/state/types";
import { CHATS, COMMANDS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const IDLE = "idleo6xxxxxxxxxxxxxx";
const FAILED = "failloxxxxxxxxxxxxxx";
const files = (q: string, n: number): FileRows => ({ q, count: n, rows: Array.from({ length: n }, (_, i) => ({ path: `src/cache/file${i}.ts`, nameStart: 10, nameRanges: [] })) });
const input = (over: Partial<SearchInput>): SearchInput => ({ q: "", scope: null, chats: [], files: null, uploads: [], commands: null, ...over });
const hit = (chat: string, message: string, snippet = "the cache keeps it", ranges: [number, number][] = [[4, 9]], by: MessageHit["by"] = "agent"): MessageHit => ({ chat, message, by, snippet, ranges });
const answer = (q: string, hits: MessageHit[]) => ({ q, hits });
const titles = (r: ReturnType<typeof searchSections>, kind: string) => flatRows(r).filter((h) => h.kind === kind);

describe("the Messages group (DESIGN-U5 8)", () => {
  test("its title is Messages, and it is drawn last: after Commands, also when a / puts Commands first", () => {
    expect(SECTION_TITLE.messages).toBe("Messages");
    expect(SECTION_ORDER[SECTION_ORDER.length - 1]).toBe("messages");
    const commands: MenuRow[] = [{ name: "cache-clear", hint: "x", source: "user" }];
    const base = input({ q: "cache", chats: [], allChats: CHATS, files: files("cache", 3), commands, messages: answer("cache", [hit(CHAT, "m_1")]), messagesAsked: true });
    expect(searchSections(base).sections.map((s) => s.kind)).toEqual(["files", "commands", "messages"]);
    const slash = searchSections({ ...base, q: "/cache", files: files("/cache", 3), messages: answer("/cache", [hit(CHAT, "m_1")]) });
    expect(slash.sections.map((s) => s.kind)).toEqual(["commands", "files", "messages"]);
  });

  test("its own 20 rows outside the 120; the list's true count stays the other groups' and the group has its own", () => {
    const many: Chat[] = Array.from({ length: 30 }, (_, i) => ({ ...CHATS[0]!, id: `cache${String(i).padStart(15, "x")}`, title: `Cache item ${i}`, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
    const hits = many.map((c) => hit(c.id, `m_${c.id}`));
    const r = searchSections(input({ q: "cache", chats: many, allChats: many, files: files("cache", 500), commands: null, messages: answer("cache", hits), messagesAsked: true }));
    const by = Object.fromEntries(r.sections.map((s) => [s.kind, [s.count, s.rows.length]]));
    expect(by.messages).toEqual([MESSAGE_ROWS, MESSAGE_ROWS]);
    expect(MESSAGE_ROWS).toBe(20);
    // Chats and Files share the 120 as before, with Files held to its floor while Messages is asked.
    expect(by.chats).toEqual([30, 30]);
    expect(by.files).toEqual([500, SECTION_FLOOR]);
    expect(r.count).toBe(30 + 500);
    expect(r.rows).toBe(30 + SECTION_FLOOR + MESSAGE_ROWS);
  });

  test("while Messages is asked, Files keeps at most its floor; not asked (a short query), Files takes the room as before", () => {
    const asked = searchSections(input({ q: "cache", files: files("cache", 300), messagesAsked: true }));
    expect(asked.sections.map((s) => [s.kind, s.rows.length])).toEqual([["files", SECTION_FLOOR]]);
    // The rule follows the query alone: no answer yet, the same rows.
    const landed = searchSections(input({ q: "cache", chats: CHATS, allChats: CHATS, files: files("cache", 300), messages: answer("cache", [hit(CHAT, "m_1")]), messagesAsked: true }));
    expect(flatRows(landed).filter((h) => h.kind === "files") as unknown[]).toEqual(flatRows(asked));
    const short = searchSections(input({ q: "c", files: files("c", 300), messagesAsked: false }));
    expect(short.sections.map((s) => [s.kind, s.rows.length])).toEqual([["files", 120]]);
  });

  test("the Chats scope keeps Chats and Messages; the Files and Commands scopes have no Messages", () => {
    expect(kindsOf("chats")).toEqual(["chats", "messages"]);
    expect(kindsOf("files")).toEqual(["files"]);
    expect(kindsOf("commands")).toEqual(["commands"]);
    const all = input({ q: "fix", chats: CHATS, allChats: CHATS, files: files("fix", 2), commands: COMMANDS as MenuRow[], messages: answer("fix", [hit(IDLE, "m_1")]), messagesAsked: true });
    expect(searchSections({ ...all, scope: "chats" }).sections.map((s) => s.kind)).toEqual(["chats", "messages"]);
    expect(searchSections({ ...all, scope: "files" }).sections.map((s) => s.kind)).toEqual(["files"]);
    expect(searchSections({ ...all, scope: "commands" }).sections.map((s) => s.kind)).not.toContain("messages");
  });

  test("a chat's rows stay together, in the server's rank order; the first carries the chat, the others their line", () => {
    const hits = [hit(IDLE, "m_a"), hit(CHAT, "m_b"), hit(IDLE, "m_c"), hit(IDLE, "m_d"), hit(CHAT, "m_e")];
    const rows = titles(searchSections(input({ q: "cache", allChats: CHATS, messages: answer("cache", hits), messagesAsked: true })), "messages");
    expect(rows.map((h) => (h.kind === "messages" ? [h.chat.id, h.message, h.first] : null))).toEqual([
      [IDLE, "m_a", true],
      [IDLE, "m_c", false],
      [IDLE, "m_d", false],
      [CHAT, "m_b", true],
      [CHAT, "m_e", false],
    ]);
    // Each row is its own link: keys differ, and they name the chat and the message.
    expect(new Set(rows.map((h) => h.key)).size).toBe(5);
  });

  test("the title and the time come from the page's list (a rename shows at once); an archived chat's hits stay; a chat the page does not hold is dropped", () => {
    const renamed = CHATS.map((c) => (c.id === IDLE ? { ...c, title: "Renamed here" } : c.id === FAILED ? { ...c, archived: true } : c));
    const hits = [hit(IDLE, "m_a"), hit("goneoxxxxxxxxxxxxxxx", "m_b"), hit(FAILED, "m_c")];
    const rows = titles(searchSections(input({ q: "cache", chats: renamed.filter((c) => !c.archived), allChats: renamed, messages: answer("cache", hits), messagesAsked: true })), "messages");
    expect(rows.map((h) => (h.kind === "messages" ? [h.chat.title, h.chat.archived ?? false] : null))).toEqual([
      ["Renamed here", false],
      ["Update the date library", true],
    ]);
  });

  test("an answer for another query is not drawn, and with no answer the group is not there", () => {
    const base = input({ q: "cache", allChats: CHATS, messagesAsked: true });
    expect(searchSections({ ...base, messages: answer("cach", [hit(CHAT, "m_1")]) }).sections).toEqual([]);
    expect(searchSections({ ...base, messages: null }).sections).toEqual([]);
    expect(searchSections({ ...base, messages: answer("cache", []) }).sections).toEqual([]);
    // Messages is not asked for this scope: an answer that lingers is not drawn either.
    expect(searchSections({ ...base, scope: "files", messages: answer("cache", [hit(CHAT, "m_1")]) }).sections).toEqual([]);
  });

  test("Enter never waits for Messages: the list of the field's query picks its active row before the answer came", () => {
    const r = searchSections(input({ q: "summarize", chats: CHATS, allChats: CHATS, messages: null, messagesAsked: true }));
    const hit = enterPick(flatRows(r), 0, r.q, "summarize", true);
    expect(hit).toMatchObject({ kind: "chats", chat: { id: IDLE } });
  });

  test("the snippet and its ranges pass through as the server sent them; a bad range is the highlight's to clamp", () => {
    const rows = titles(searchSections(input({ q: "cache", allChats: CHATS, messages: answer("cache", [hit(CHAT, "m_1", "…a <b>cache</b> line", [[5, 10]])]), messagesAsked: true })), "messages");
    expect(rows[0]).toMatchObject({ kind: "messages", snippet: "…a <b>cache</b> line", ranges: [[5, 10]] });
  });

  test("who said it passes through too: the user's own message, or Claude's reply", () => {
    const hits = [hit(CHAT, "m_1", "the cache keeps it", [[4, 9]], "agent"), hit(CHAT, "m_2", "the cache again", [[4, 9]], "user")];
    const rows = titles(searchSections(input({ q: "cache", allChats: CHATS, messages: answer("cache", hits), messagesAsked: true })), "messages");
    expect(rows.map((r) => (r.kind === "messages" ? [r.message, r.by, r.first] : null))).toEqual([
      ["m_1", "agent", true],
      ["m_2", "user", false],
    ]);
  });
});

describe("a pick: the chat at that message, with the query to mark (DESIGN-U5 9)", () => {
  const chat = CHATS.find((c) => c.id === IDLE)!;
  const row = { kind: "messages" as const, key: "m", chat, message: "msg_01AbC-0", by: "agent" as const, snippet: "x", ranges: [] as [number, number][], first: true };
  test("/c/<chat>/m/<message>?mark=<q>; the view only inside the pane's own chat", () => {
    expect(pickHref(row, CHAT, "verbose", "memory cap")).toBe(`/c/${IDLE}/m/msg_01AbC-0?mark=memory%20cap`);
    expect(pickHref(row, IDLE, "verbose", "memory cap")).toBe(`/c/${IDLE}/m/msg_01AbC-0?mark=memory%20cap&view=verbose`);
    expect(pickHref(row, null, undefined, "cache")).toBe(`/c/${IDLE}/m/msg_01AbC-0?mark=cache`);
  });
  test("the mark: white space collapsed, and never over the route's 120 characters (words up to the cap)", () => {
    expect(markOf("  memory\n  cap ")).toBe("memory cap");
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const m = markOf(long);
    expect(m.length).toBeLessThanOrEqual(120);
    expect(long.startsWith(m)).toBe(true);
    expect(m.endsWith(" ")).toBe(false);
    expect(markOf("x".repeat(300))).toBe("");
  });
});
