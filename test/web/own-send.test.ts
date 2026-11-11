// FIX-Q1 3: your own send goes to the end. A send from this page's message box (Send, or Run for a `!` command) is
// the reader going on with the chat: the conversation drops a linked row's pin and a kept place and follows the end at
// the press, as a send at the end always did, and a route that only names a row (a /m/ link: a search hit, a rail
// jump; a changes route on the phone, which is the chat at the turn's card line; a card route whose card no longer
// waits) becomes the chat's own URL once the send went out. Q1 review: by going back when the entry before is the
// chat's own URL in this page (a rail's jump), so no dead entry stays (5.1 rule 4, 5.5 step 3); else by replace, so
// Back returns to where the link came from; and a refused send leaves the link as it was. The scroll itself is
// ui-check's (the send-follow flow); here the rules, the page's own signal and where the box and the conversation use
// them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { leaveAfter, leaveBy, onOwnSend, ownSend, sendLeaves } from "../../web/chat/ownSend";
import { parse, pushedState, type EntryState } from "../../web/router";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const route = (path: string) => parse(new URL(path, "http://127.0.0.1"));
const src = (rel: string) => readFileSync(join(import.meta.dir, "..", "..", "web", rel), "utf8");
const DONE = Promise.resolve(true);

describe("your own send goes to the end (FIX-Q1)", () => {
  test("a route that only names a row becomes the chat's own: a /m/ link everywhere, a changes route on the phone", () => {
    expect(sendLeaves(route(`/c/${CHAT}/m/msg_01abc?mark=upload`), false)).toBe(true);
    expect(sendLeaves(route(`/c/${CHAT}/m/msg_01abc`), true)).toBe(true);
    expect(sendLeaves(route(`/c/${CHAT}/changes/m7q2x4abk3`), true)).toBe(true);
    expect(sendLeaves(route(`/c/${CHAT}/changes/m7q2x4abk3/src/upload.ts`), true)).toBe(true);
    // On the laptop and the tablet a changes route is the side panel's view: it stays, and only the scroll follows.
    expect(sendLeaves(route(`/c/${CHAT}/changes/m7q2x4abk3`), false)).toBe(false);
    // The chat itself, a block that the URL opens, a card, a picker: as before.
    for (const p of [`/c/${CHAT}`, `/c/${CHAT}/tool/toolu_01AbCdEf`, `/c/${CHAT}/thinking/msg_01abc`, `/c/${CHAT}/details`, `/c/${CHAT}/permission/toolu_01AbCdEf`])
      for (const phone of [false, true]) expect(sendLeaves(route(p), phone)).toBe(false);
  });

  test("Q1 review: a card route whose card no longer waits (its record, or 5.4's line) becomes the chat's own too", () => {
    for (const kind of ["permission", "question", "plan", "elicitation"])
      for (const phone of [false, true]) expect(sendLeaves(route(`/c/${CHAT}/${kind}/toolu_01BashRerun5`), phone, true)).toBe(true);
  });

  test("Q1 review: back when the entry before is the chat's own URL in this page (a rail's jump), else a replace", () => {
    const chat = `/c/${CHAT}`;
    const at = `${chat}/m/f5538617-0000-4000-8000-000000000000`;
    // Home, then the chat, then the rail's jump pushed the /m/ entry: the entry before is the chat's own.
    const jumped: EntryState = pushedState(pushedState(null, "/"), chat);
    expect(leaveBy(jumped, at, chat)).toBe("back");
    // A search hit opened from Home (or the chat list), and a link opened as a new document: the entry before is not.
    expect(leaveBy(pushedState(null, "/"), at, chat)).toBe("replace");
    expect(leaveBy(pushedState(null, "/chats"), at, chat)).toBe("replace");
    expect(leaveBy(null, at, chat)).toBe("replace");
    expect(leaveBy({ from: chat, back: [chat] }, at, chat)).toBe("replace");
  });

  test("Q1 review: the URL waits for the send's result: a refused send leaves the link, and so does a page that moved on", async () => {
    const left: string[] = [];
    await leaveAfter(Promise.resolve(true), "/a", () => "/a", () => left.push("sent"));
    await leaveAfter(Promise.resolve(false), "/a", () => "/a", () => left.push("refused"));
    await leaveAfter(Promise.resolve(true), "/a", () => "/b", () => left.push("moved"));
    expect(left).toEqual(["sent"]);
  });

  test("the page's own send reaches the conversation of that chat only, while it listens, with its result", () => {
    const heard: string[] = [];
    const stopA = onOwnSend("chat-a", (done) => heard.push(done === DONE ? "a" : "a?"));
    const stopB = onOwnSend("chat-b", () => heard.push("b"));
    ownSend("chat-a", DONE);
    ownSend("chat-c", DONE);
    stopA();
    ownSend("chat-a", DONE);
    ownSend("chat-b", DONE);
    stopB();
    ownSend("chat-b", DONE);
    expect(heard).toEqual(["a", "b"]);
  });

  test("the message box signals the send with its result (Send and Run alike), never for a side question", () => {
    const box = src("composer/Composer.tsx");
    const body = box.slice(box.indexOf("const send = (now = false) => {"), box.indexOf("// R124: a side question from the message box."));
    expect(body.length).toBeGreaterThan(100);
    const side = body.indexOf("if (sideAsk) return sendSide(");
    const goes = body.indexOf('const done = d.mode === "bash" ? act.bash(');
    const own = body.indexOf("ownSend(chat.id, done);");
    expect(side).toBeGreaterThan(-1);
    expect(goes).toBeGreaterThan(side);
    expect(own).toBeGreaterThan(goes);
  });

  test("the conversation follows the end at the press, and the route leaves after the send went out, by back or replace", () => {
    const view = src("chat/ChatView.tsx");
    const at = view.indexOf("onOwnSend(chat.id, (done) => {");
    expect(at).toBeGreaterThan(-1);
    const body = view.slice(at, view.indexOf("}), [chat.id]);", at));
    for (const part of ["pinned.current = null;", "pendingPlace.current = null;", "dropPlace();", "follow.stick = true;", "toEnd(el);", "setJump(false);", "leaveAfter(done, from, currentUrl, () => {", "history.back();", "navigate(chatUrlNow.current, { replace: true })", "sentBack.current = true;"])
      expect(body).toContain(part);
    expect(body.indexOf("if (!leavesNow.current) return;")).toBeLessThan(body.indexOf("leaveAfter("));
    expect(body.indexOf('leaveBy(history.state as EntryState | null, from, chatUrlNow.current) === "back"')).toBeLessThan(body.indexOf("history.back();"));
    // The route leaves for the chat's own on a stale card route too (its record, or 5.4's line).
    expect(view).toContain("leavesNow.current = sendLeaves(route, phone, !!requestId && !routedCard);");
    // The arrival that a send's Back makes follows the end: the entry's kept place (a rail's) is dropped, not put back.
    const pin = view.slice(view.indexOf("const firstScroll = useRef(true);"), view.indexOf("}, [scrollId, route.name, view]);"));
    expect(pin).toContain("sentBack.current");
    expect(pin.indexOf("sentBack.current")).toBeLessThan(pin.indexOf("cameByHistory() ? entryPlace() : null"));
  });
});
