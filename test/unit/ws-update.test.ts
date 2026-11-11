// Origin's update line on the chat socket (DESIGN.md 4.10; build checklist S4): `welcome.update` carries the last
// check's line, and a change of it is one notice with an id, which a later notice with `gone` takes away.

import { afterAll, expect, test } from "bun:test";
import { PROTOCOL_VERSION, WIRE, type UpdateKind } from "../../shared/protocol";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore } from "../../server/chats/testing";
import type { SocketData } from "../../server/http/app";
import { CHAT_SOCKET_OPTIONS, wsHandlers } from "../../server/ws/handlers";

let kind: UpdateKind = "none";
const reg = new ChatRegistry({ driver: new FakeDriver(), store: new MemoryStore() });
await reg.boot();
const hub = wsHandlers(reg, { update: () => ({ available: kind === "available", kind }) });
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

async function page(): Promise<{ frames: Record<string, unknown>[]; ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${WIRE.path}`);
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener("message", (ev) => frames.push(JSON.parse(String(ev.data))));
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
  ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, tab: `tab_${crypto.randomUUID().slice(0, 8)}` }));
  const end = Date.now() + 2_000;
  while (!frames.some((f) => f.t === "welcome") && Date.now() < end) await Bun.sleep(10);
  return { frames, ws };
}

const until = async (pred: () => boolean) => {
  const end = Date.now() + 2_000;
  while (!pred() && Date.now() < end) await Bun.sleep(10);
};

test("welcome carries origin's line as the last check found it", async () => {
  kind = "none";
  const a = await page();
  expect(a.frames.find((f) => f.t === "welcome")!.update).toEqual({ available: false, kind: "none" });
  kind = "available";
  const b = await page();
  expect(b.frames.find((f) => f.t === "welcome")!.update).toEqual({ available: true, kind: "available" });
  a.ws.close();
  b.ws.close();
});

test("a change is one notice with its id; gone takes it away", async () => {
  const p = await page();
  // Row 108: the notice of an update that origin has carries the Update action.
  hub.notice("Update available.", undefined, { id: "update", actions: ["update"] });
  await until(() => p.frames.some((f) => f.t === "notice"));
  expect(p.frames.filter((f) => f.t === "notice")).toEqual([{ t: "notice", text: "Update available.", id: "update", actions: ["update"] }]);
  hub.notice("", undefined, { id: "update", gone: true });
  await until(() => p.frames.filter((f) => f.t === "notice").length === 2);
  expect(p.frames.filter((f) => f.t === "notice").at(-1)).toEqual({ t: "notice", text: "", id: "update", gone: true });
  // A chat's own line keeps its form.
  hub.notice("A line.", "k3m7q2x4abk3m7q2x4ab");
  await until(() => p.frames.filter((f) => f.t === "notice").length === 3);
  expect(p.frames.filter((f) => f.t === "notice").at(-1)).toEqual({ t: "notice", text: "A line.", chat: "k3m7q2x4abk3m7q2x4ab" });
  p.ws.close();
});
