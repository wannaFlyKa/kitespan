// R130 (FIX-R130 2; DESIGN-R130 5): Bring back, the server's side. The page quotes a side answer into the message
// box's draft, after the box's text, and saves it at once with one `draft` frame, as typing does (D49). The server
// keeps it as the chat's draft and gives every page of the chat that one draft, and nothing else happens: no message, no
// turn, no side question, nothing to Claude Code, and the side thread stays as it was. The draft's cap holds (the page
// refuses a quote over it first). The scripted driver and MemoryStore stand in for Claude Code and the disk.
import { describe, expect, test } from "bun:test";
import { LIMITS, parseClientFrame, type DraftEditFrame, type SideRead } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeBash, FakeDriver, MemoryStore, RecordingViewer, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";

const PROJECT = "k3m7q2x4ab";
const rid = () => crypto.randomUUID();

async function setup() {
  const driver = new FakeDriver();
  const store = new MemoryStore();
  store.projects = [projectRecord(PROJECT)];
  const reg = new ChatRegistry({ driver, store, bash: new FakeBash() }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500, openCheckMs: 15, openFastMs: 15 });
  await reg.boot();
  autoReply(driver);
  const o = await apply(reg, { t: "new_chat", rid: rid(), project: PROJECT, uuid: rid(), text: "Fix the flaky upload test", picks: { model: null, effort: null, mode: null }, uploads: [] });
  if (!o.ok) throw new Error(`new_chat refused: ${o.code}`);
  await settle(20);
  return { driver, store, reg, chat: (o.result as { chat: string }).chat };
}

/** DESIGN-R130 5's form: each line of the answer after "> " (an empty line ">"), one blank line after the box's text. */
const quoted = (box: string, answer: string) => `${box ? `${box}\n\n` : ""}${answer.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
const sideRead = async (reg: ChatRegistry, chat: string) => ((await apply(reg, { t: "get", rid: rid(), chat, what: "side" })) as { ok: true; result: SideRead }).result;
const draftFrame = (chat: string, text: string): DraftEditFrame => ({ t: "draft", chat, text, mode: "chat", command: null, link: false, uploads: [] });

describe("Bring back's one draft frame", () => {
  test("every page gets the one draft with the quote; no message, turn or side question, and the side thread is as it was", async () => {
    const { driver, store, reg, chat } = await setup();
    const c = driver.last;
    const a = new RecordingViewer("tab_a");
    const b = new RecordingViewer("tab_b");
    await reg.attach(chat, a);
    await reg.attach(chat, b);
    expect((await apply(reg, { t: "side_question", rid: rid(), chat, id: rid(), text: "Why did the second try fail?" })).ok).toBe(true);
    await settle(20);
    const side = await sideRead(reg, chat);
    const answer = side.exchanges.at(-1)!.answer!;
    const before = { sent: c.sent.length, asks: c.sideAsks.length, events: a.items.length, drafts: a.drafts.length, side: JSON.stringify(side) };
    const text = quoted("Fix it so that the test waits for the event.", `${answer}\n\nTwo ways out.`);
    await reg.draftEdit(draftFrame(chat, text), "tab_a");
    expect(a.drafts.length - before.drafts).toBe(1);
    expect(b.drafts.at(-1)).toMatchObject({ text, mode: "chat", command: null, by: "tab_a" });
    expect(a.drafts.at(-1)!.text).toBe(text);
    expect(reg.draftOf(chat)!.text).toBe(text);
    expect(store.drafts.get(chat)?.text).toBe(text);
    expect(c.sent.length).toBe(before.sent);
    expect(c.sideAsks.length).toBe(before.asks);
    expect(a.items.length).toBe(before.events);
    expect(reg.stateOf(chat)).toBe("idle");
    expect(JSON.stringify(await sideRead(reg, chat))).toBe(before.side);
    await reg.shutdown();
  });

  test("the draft's cap: a text over 20,000 characters keeps the first 20,000 and sends nothing", async () => {
    const { driver, reg, chat } = await setup();
    const a = new RecordingViewer("tab_a");
    await reg.attach(chat, a);
    await reg.draftEdit(draftFrame(chat, quoted("", "a".repeat(LIMITS.draftText))), "tab_a");
    expect(reg.draftOf(chat)!.text.length).toBe(LIMITS.draftText);
    expect(driver.last.sent.length).toBe(1);
    await reg.shutdown();
  });

  test("the frame as the page sends it: quote marks, blank lines and the box's text pass the socket's check as they are", () => {
    const text = quoted("Look at this:", "The fake server sends `uploaded` first.\n\nAdd the listener before `start()`.");
    const f = parseClientFrame(JSON.stringify(draftFrame("k3m7q2x4abk3m7q2x4ab", text)));
    expect(f).toMatchObject({ ok: true, frame: { t: "draft", text, mode: "chat" } });
    expect(text).toBe("Look at this:\n\n> The fake server sends `uploaded` first.\n>\n> Add the listener before `start()`.\n\n");
  });
});
