// U5's click-through seed on the real server, with no browser: the search-text scene boots bin/kitespan with the fake
// claude, and GET /api/search finds each of the flow's words once (seed/search-text.ts): the word in a reply inside a
// finished turn's work names that reply's row, the word only in a tool's output finds nothing, the archived chat's word
// finds the archived chat, and the long chat's word names its first message, which its newest history page does not
// hold. Without the sender header nothing is read; the log's search lines hold no word. scripts/ui-check.ts's
// search-text flow opens the same scene in a browser. A stub page stands in for the built one; the port is
// KITESPAN_TEST_PORT or a free test port.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageSearchPath, type MessageSearchReply } from "../../shared/message-search";
import { PROTOCOL_VERSION, WIRE, type ChatEvent } from "../../shared/protocol";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { SEARCH_TEXT, SEARCH_TEXT_ROWS } from "./seed/search-text";
import { SEARCH_TEXT_SCENE } from "./seed/scenes";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
let h: Booted | null = null;
beforeAll(async () => {
  if (PROCFS) h = await boot({ scene: "search-text", port: PORT, dist: DIST });
}, 120_000);
afterAll(async () => {
  if (h) await h.stop().catch(() => {});
  rmSync(DIST, { recursive: true, force: true });
});

async function ask(q: string, page = true): Promise<MessageSearchReply> {
  const b = h!;
  const res = await fetch(`${b.base}${messageSearchPath(q, "seedTab1")}`, { headers: page ? { "x-kitespan": "1", origin: b.base } : { origin: b.base } });
  expect(res.status).toBe(200);
  return (await res.json()) as MessageSearchReply;
}

/** The newest history page of a chat, as an attach's snapshot carries it. */
async function newestPage(chat: string): Promise<{ history: ChatEvent[]; more: string | null }> {
  const b = h!;
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`, { headers: { origin: b.base } });
  const frames: Record<string, any>[] = [];
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, tab: "seedTab2" }));
  ws.send(JSON.stringify({ t: "attach", chat, since: 0, epoch: null }));
  const end = Date.now() + 20_000;
  while (!frames.some((f) => f.t === "snapshot" && f.chat === chat)) {
    if (Date.now() > end) throw new Error("no snapshot");
    await Bun.sleep(20);
  }
  ws.close();
  const s = frames.find((f) => f.t === "snapshot" && f.chat === chat)!;
  return { history: s.history as ChatEvent[], more: s.more as string | null };
}

describe.skipIf(!PROCFS)(`${SEARCH_TEXT_SCENE["search-text"].name}: ${SEARCH_TEXT_SCENE["search-text"].about} ${LINUX_ONLY}`, () => {
  test("without the sender header nothing is read yet: no hits, not complete", async () => {
    expect(await ask(SEARCH_TEXT.words.reply, false)).toEqual({ q: SEARCH_TEXT.words.reply, hits: [], complete: false });
  });

  test("the word in a reply inside the finished turn's work names that reply's row", async () => {
    const r = await ask(SEARCH_TEXT.words.reply);
    expect(r.complete).toBe(true);
    expect(r.hits.map((x) => [x.chat, x.message])).toEqual([[SEARCH_TEXT.chats.cap, SEARCH_TEXT_ROWS.reply]]);
    const hit = r.hits[0]!;
    expect(hit.ranges.map(([s, e]) => hit.snippet.slice(s, e))).toEqual([SEARCH_TEXT.words.reply]);
  });

  test("the word only in a tool's output finds nothing", async () => {
    expect(await ask(SEARCH_TEXT.words.tool)).toEqual({ q: SEARCH_TEXT.words.tool, hits: [], complete: true });
  });

  test("the archived chat's word finds the archived chat", async () => {
    const r = await ask(SEARCH_TEXT.words.archived);
    expect(r.hits.map((x) => [x.chat, x.message])).toEqual([[SEARCH_TEXT.chats.tiles, SEARCH_TEXT_ROWS.archived]]);
  });

  test("the long chat's word names its first message, which the newest history page does not hold", async () => {
    const r = await ask(SEARCH_TEXT.words.old);
    expect(r.hits.map((x) => [x.chat, x.message])).toEqual([[SEARCH_TEXT.chats.long, SEARCH_TEXT_ROWS.old]]);
    const page = await newestPage(SEARCH_TEXT.chats.long);
    expect(page.more).not.toBeNull();
    expect(page.history.some((e) => e.k === "user" && e.uuid === SEARCH_TEXT_ROWS.old)).toBe(false);
    expect(JSON.stringify(page.history).length).toBeLessThanOrEqual(WIRE.pageBytes);
  });

  test("the shared phrase: the newer chat's two messages first (its answer, then its question), then the archived chat; each says who said it", async () => {
    const r = await ask(SEARCH_TEXT.words.shared);
    expect(r.hits.map((x) => [x.chat, x.message, x.by])).toEqual([
      [SEARCH_TEXT.chats.cap, SEARCH_TEXT_ROWS.answer, "agent"],
      [SEARCH_TEXT.chats.cap, SEARCH_TEXT.uuids.capQuestion, "user"],
      [SEARCH_TEXT.chats.tiles, SEARCH_TEXT_ROWS.archived, "agent"],
    ]);
  });

  test("the log's search lines hold lengths and counts, never a word", () => {
    const logs = h!.seed.state + "/logs";
    const text = readdirSync(logs)
      .filter((f) => f.startsWith("kitespan-"))
      .map((f) => readFileSync(join(logs, f), "utf8"))
      .join("");
    const lines = text.split("\n").filter((l) => l.includes('"ev":"search"'));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const w of Object.values(SEARCH_TEXT.words)) expect(text).not.toContain(w);
  });
});
