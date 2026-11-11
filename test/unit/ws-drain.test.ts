// The restart's drain on the chat socket (DESIGN.md 4.10 step 3; build checklist S9, S16): every page gets the drain
// notice with Cancel restart and Restart now, a page that says hello while the drain waits gets it after `welcome` and
// the list, Cancel takes it back, and `end_here` gets its one ack. The real registry over the scripted driver, the
// real handlers on a Bun server of this test (port 0).

import { afterAll, expect, test } from "bun:test";
import { PROTOCOL_VERSION, WIRE } from "../../shared/protocol";
import { DRAIN_LINE, DRAIN_NOTICE_ID, Restart } from "../../server/chats/drain";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, projectRecord, settle } from "../../server/chats/testing";
import type { SocketData } from "../../server/http/app";
import { CHAT_SOCKET_OPTIONS, wsHandlers } from "../../server/ws/handlers";

const PROJECT = "k3m7q2x4ab";
const driver = new FakeDriver();
const store = new MemoryStore();
store.projects = [projectRecord(PROJECT)];
const reg = new ChatRegistry({ driver, store }, { closeGraceMs: 20, shutdownMs: 300 });
await reg.boot();
let restart!: Restart;
const hub = wsHandlers(reg, { notices: () => restart.standing() });
restart = new Restart({
  registry: reg,
  notice: (text, chat, more) => hub.notice(text, chat, more),
  bye: () => {},
  closeShells: async () => {},
  spawn: () => {
    throw new Error("no successor in this test");
  },
  release: async () => {},
  relisten: async () => {},
  health: async () => null,
  done: () => {},
  failed: () => {},
});
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    if (new URL(req.url).pathname === WIRE.path && srv.upgrade(req, { data: { route: "/ws", state: null } })) return undefined;
    return new Response("not here", { status: 404 });
  },
  websocket: { ...CHAT_SOCKET_OPTIONS, open: (ws) => hub.open(ws), message: (ws, m) => hub.message(ws, m), close: (ws, c, r) => hub.close(ws, c, r), drain: (ws) => hub.drain(ws) },
});
afterAll(async () => {
  hub.dispose();
  await reg.shutdown();
  void server.stop(true);
});

type Frame = Record<string, unknown>;
async function page(): Promise<{ frames: Frame[]; ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WIRE.path}`);
  const frames: Frame[] = [];
  ws.addEventListener("message", (ev) => frames.push(JSON.parse(String(ev.data))));
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
  ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, tab: `tab_${crypto.randomUUID().slice(0, 8)}` }));
  await until(() => frames.some((f) => f.t === "chats"));
  await Bun.sleep(30);
  return { frames, ws };
}
async function until(pred: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!pred() && Date.now() < end) await Bun.sleep(10);
}
const notices = (frames: Frame[]) => frames.filter((f) => f.t === "notice");
const DRAIN = { t: "notice", text: DRAIN_LINE, id: DRAIN_NOTICE_ID, actions: ["cancel_restart", "restart_now"] };

test("every page gets the drain notice; a page that says hello while it waits gets it after the list; Cancel takes it back", async () => {
  // A running turn, so the drain waits.
  const chat = (await apply(reg, { t: "new_chat", rid: crypto.randomUUID(), project: PROJECT, uuid: crypto.randomUUID(), text: "a long task", picks: { model: null, effort: null, mode: null }, uploads: [] })) as { ok: true; result: { chat: string } };
  driver.last.emit({ k: "session", sessionId: driver.last.input.sessionId!.value, model: "m", mode: "default", version: "2.1.317", bypass: false });
  await settle();
  const before = await page();
  expect(notices(before.frames)).toEqual([]);
  expect(restart.ask("finish")).toEqual({ ok: true });
  await until(() => notices(before.frames).length > 0);
  expect(notices(before.frames)).toEqual([DRAIN]);

  const later = await page();
  const kinds = later.frames.map((f) => f.t);
  expect(kinds.slice(0, 3)).toEqual(["welcome", "chats", "notice"]);
  expect(notices(later.frames)).toEqual([DRAIN]);

  // End it here is refused while the drain waits: one ack, `restarting`.
  const rid = crypto.randomUUID();
  later.ws.send(JSON.stringify({ t: "end_here", rid, chat: chat.result.chat }));
  await until(() => later.frames.some((f) => f.t === "ack" && f.rid === rid));
  expect(later.frames.filter((f) => f.t === "ack" && f.rid === rid)).toEqual([{ t: "ack", rid, ok: false, error: { code: "restarting", message: "kitespan is restarting." } }]);

  expect(restart.cancel()).toBe(true);
  await until(() => notices(before.frames).length > 1);
  expect(notices(before.frames).at(-1)).toEqual({ t: "notice", text: "", id: DRAIN_NOTICE_ID, gone: true });
  const after = await page();
  expect(notices(after.frames)).toEqual([]);

  // After Cancel, End it here works: the chat runs, so it answers `ending`.
  const rid2 = crypto.randomUUID();
  after.ws.send(JSON.stringify({ t: "end_here", rid: rid2, chat: chat.result.chat }));
  await until(() => after.frames.some((f) => f.t === "ack" && f.rid === rid2));
  expect(after.frames.find((f) => f.t === "ack" && f.rid === rid2)).toEqual({ t: "ack", rid: rid2, ok: true, result: { ending: true } });
  for (const p of [before, later, after]) p.ws.close();
});
