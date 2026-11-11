// U1 (DESIGN-U1 5, D49): history gives each turn's changes card right after the turn's end (server/chats/turns.ts
// insertTurns): a noted turn's after its noted end; one whose turn no note holds (the notes' cap dropped it, a seed's
// turn) after the turn's own end, else before the next input, else at the page's end when no turn runs; one whose
// turn's first row is not on the page is left to the page that holds it. The card's `at` is the page's row ids.
import { describe, expect, test } from "bun:test";
import { cardKey, noteCardKey, pageRowId } from "../../server/changes/rows";
import { insertTurns } from "../../server/chats/turns";
import type { TurnNote } from "../../server/store/types";
import type { ChatEvent } from "../../shared/protocol";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const user = (uuid: string): ChatEvent => ({ k: "user", uuid, text: "go", queued: false });
const text = (key: string): ChatEvent => ({ k: "block", key, kind: "text", text: "Done.", parent: null });
const call = (id: string): ChatEvent => ({ k: "tool_call", id, name: "Bash", input: {}, parent: null });
const result = (id: string): ChatEvent => ({ k: "tool_result", id, text: "ok", isError: false, parent: null, report: null });
const card = (id: string, at: string[]): ChatEvent => ({ k: "changes", id, at, how: "git", total: 1, added: 1, removed: 0, files: [{ path: "a.ts", status: "M", added: 1, removed: 0 }] });
const note = (ids: string[], last: string[]): TurnNote => ({ ids, last, by: "user", ok: true, subtype: "success", durationMs: 1000, uuids: [ids[0]!], error: null });
const words = (events: readonly ChatEvent[]) => events.map((e) => (e.k === "changes" ? `changes ${e.id}` : e.k === "user" ? `user ${e.uuid.slice(0, 2)}` : e.k === "block" ? e.key : e.k));

describe("the card's place", () => {
  test("the page's row ids: a uuid as it is, a block's key by itemIdOf, a call's id without its kind", () => {
    expect(pageRowId(U1)).toBe(U1);
    expect(pageRowId("msg_01Plan:0")).toBe("msg_01Plan-0");
    expect(pageRowId("call:toolu_1")).toBe("toolu_1");
    expect(pageRowId("result:toolu_1")).toBe("toolu_1");
    expect(noteCardKey([U1, "call:toolu_1", "x"])).toBe(cardKey([U1, "toolu_1"]));
  });
  test("a noted turn's card follows its noted end, before the next turn", () => {
    const events = [user(U1), call("t1"), result("t1"), text("msg_a:0"), user(U2), text("msg_b:0")];
    const cards = new Map([[cardKey([U1, "t1"]), card("aaaaaaaaaa", [U1, "t1"])]]);
    const out = insertTurns(events, [note([U1, "call:t1"], ["msg_a:0"])], null, true, cards);
    expect(words(out)).toEqual(["turn_start", "user 11", "tool_call", "tool_result", "msg_a:0", "turn_end", "changes aaaaaaaaaa", "user 22", "msg_b:0"]);
  });
  test("a turn that no note holds: before the next input, or at the end once no turn runs; not on this page: left out", () => {
    const events = [user(U1), call("t1"), result("t1"), user(U2), text("msg_b:0")];
    const cards = new Map([
      [cardKey([U1]), card("bbbbbbbbbb", [U1])],
      [cardKey([U2]), card("cccccccccc", [U2])],
      [cardKey(["33333333-3333-4333-8333-333333333333"]), card("dddddddddd", ["33333333-3333-4333-8333-333333333333"])],
    ]);
    expect(words(insertTurns(events, [], null, true, cards))).toEqual(["user 11", "tool_call", "tool_result", "changes bbbbbbbbbb", "user 22", "msg_b:0", "changes cccccccccc"]);
    // While a turn runs, the last turn's card is not placed at the end.
    expect(words(insertTurns(events, [], null, false, cards))).toEqual(["user 11", "tool_call", "tool_result", "changes bbbbbbbbbb", "user 22", "msg_b:0"]);
  });
  test("no cards: history as before", () => {
    const events = [user(U1), text("msg_a:0")];
    expect(insertTurns(events, [], null, true, new Map())).toEqual(events);
    expect(insertTurns(events, [], null, true)).toEqual(events);
  });
});
