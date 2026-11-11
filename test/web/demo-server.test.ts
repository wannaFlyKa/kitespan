// The landing page's demo server (site/demo/server.ts, DESIGN-W1 2 and 4), driven as the page drives it: the app's
// own socket (web/net/socket.ts Connection) and Terminal link (web/terminal/link.ts ShellLink) over the frame's
// stand-in WebSocket and fetch (site/demo/port.ts), through a real MessageChannel. Every frame the server sends must
// pass the protocol's own checks (shared/protocol.ts and its readers: the ids, the enumerations, capEvent's caps,
// changesCardOf, messageSearchReplyOf), and every frame the page sends is read by parseClientFrame (a frame it would
// refuse is a console error, which no flow here may cause). The scenes: the welcome and the list, the example chat's
// attach with its waiting card, a draft on two devices, the scripted turn in both languages, a send while a turn
// runs, Stop, S1's three answers on the phone and their record on the laptop, a `!` command, the Terminal pane's
// refusal, a replay after a reattach, and every API route that the demo answers.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { version as PACKAGE_VERSION } from "../../package.json";
import { changesCardOf } from "../../shared/changes";
import { CHAT_ID, EPOCH, PROJECT_ID, TAB_ID, UPLOAD_ID, UUID } from "../../shared/ids";
import { messageSearchReplyOf } from "../../shared/message-search";
import {
  CHAT_STATES,
  DRAFT_MODES,
  EFFORT_IDS,
  ERROR_CODES,
  ERROR_MESSAGES,
  LIMITS,
  MODE_IDS,
  PROTOCOL_VERSION,
  SHELL_ERROR_CODES,
  TURN_INTERRUPTED,
  UNSEEN_KINDS,
  UPDATE_KINDS,
  capEvent,
  type AckFrame,
  type ChatEvent,
  type ChatRow,
  type DraftState,
  type ServerFrame,
} from "../../shared/protocol";
import { newTabId, newUuid } from "../../web/net/frames";
import { Connection, type SocketLike } from "../../web/net/socket";
import { ShellLink, type LinkStatus, type ShellSocketLike } from "../../web/terminal/link";
import { DEMO_CHATS } from "../../site/demo/data/chats";
import { EXAMPLE_PERMISSION, WAITING_TURN_USER } from "../../site/demo/data/example";
import { DEMO_CHECK_REFUSAL, DEMO_HOST, DEMO_LINES, DEMO_REPLIES, EXAMPLE_CARD, EXAMPLE_CHANGES, EXAMPLE_CHAT, type DemoLang } from "../../site/demo/lines";
import { FrameLink, demoFetch, demoWebSocketClass, demoXhrClass, type PortLike } from "../../site/demo/port";
import { DemoServer, pieces, startDemo, type DemoMessageEvent } from "../../site/demo/server";

const ORIGIN = "https://wannaflyka.github.io";
const LAYERS = "pickthetestlayers2ab";
const LOGS = "summarizetheserverlo";
const isIso = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s)) && new Date(s as string).toISOString() === s;

// ---------------------------------------------------------------------------------------------------------------
// The protocol's checks of a server frame

function draftProblems(d: DraftState, where: string): string[] {
  const out: string[] = [];
  if (!Number.isSafeInteger(d.rev) || d.rev < 0) out.push(`${where}: rev`);
  if (typeof d.text !== "string" || d.text.length > LIMITS.draftText) out.push(`${where}: text`);
  if (!DRAFT_MODES.includes(d.mode)) out.push(`${where}: mode`);
  if (d.command !== null && (typeof d.command !== "string" || d.mode !== "slash")) out.push(`${where}: command`);
  if (typeof d.link !== "boolean") out.push(`${where}: link`);
  if (!Array.isArray(d.uploads) || !d.uploads.every((u) => UPLOAD_ID.test(u))) out.push(`${where}: uploads`);
  if (d.by !== null && !TAB_ID.test(d.by)) out.push(`${where}: by`);
  if (!isIso(d.at)) out.push(`${where}: at`);
  return out;
}

function rowProblems(r: Partial<ChatRow>, where: string, whole: boolean): string[] {
  const out: string[] = [];
  const has = (k: keyof ChatRow) => whole || k in r;
  if (!CHAT_ID.test(r.chat ?? "")) out.push(`${where}: chat id`);
  if (has("title") && r.title !== null && (typeof r.title !== "string" || r.title.length > LIMITS.title)) out.push(`${where}: title`);
  if (has("project") && !PROJECT_ID.test(r.project ?? "")) out.push(`${where}: project`);
  if (has("state") && !CHAT_STATES.includes(r.state!)) out.push(`${where}: state`);
  if (has("needsYou") && typeof r.needsYou !== "boolean") out.push(`${where}: needsYou`);
  if (has("lastActivity") && !isIso(r.lastActivity)) out.push(`${where}: lastActivity`);
  if (has("archived") && typeof r.archived !== "boolean") out.push(`${where}: archived`);
  if ("busy" in r && typeof r.busy !== "boolean") out.push(`${where}: busy`);
  if ("session" in r && r.session !== null && !UUID.test(r.session ?? "")) out.push(`${where}: session`);
  if ("unseen" in r && r.unseen !== null && !UNSEEN_KINDS.includes(r.unseen!)) out.push(`${where}: unseen`);
  return out;
}

function eventProblems(e: ChatEvent, where: string): string[] {
  const out: string[] = [];
  // capEvent is idempotent on an event that fits every cap: the server never sends one that it would cut.
  if (!Bun.deepEquals(capEvent(e), e)) out.push(`${where}: ${e.k} is not within the protocol's caps`);
  if (e.k === "user" && !UUID.test(e.uuid)) out.push(`${where}: user uuid`);
  if (e.k === "changes" && !changesCardOf(e)) out.push(`${where}: changes card`);
  if (e.k === "turn_end" && !e.uuids.every((u) => UUID.test(u))) out.push(`${where}: turn_end uuids`);
  if (e.k === "card_open" && e.card.kind === "permission" && Object.keys(e.card).sort().join() !== Object.keys(EXAMPLE_PERMISSION).sort().join()) out.push(`${where}: card keys`);
  return out;
}

/** What in one frame the protocol would not take (none for a good frame). */
function frameProblems(f: ServerFrame): string[] {
  switch (f.t) {
    case "welcome": {
      const out: string[] = [];
      if (!EPOCH.test(f.epoch)) out.push("welcome: epoch");
      if (f.v !== PROTOCOL_VERSION) out.push("welcome: v");
      if (typeof f.version !== "string" || typeof f.claude.ok !== "boolean" || (f.claude.version !== null && typeof f.claude.version !== "string")) out.push("welcome: version or claude");
      if (!UPDATE_KINDS.includes(f.update.kind ?? "none") || f.update.available !== (f.update.kind === "available")) out.push("welcome: update");
      if (f.auth !== "none" && f.auth !== "token") out.push("welcome: auth");
      if (f.host !== undefined && f.host !== null && (typeof f.host !== "string" || f.host.length > 63)) out.push("welcome: host");
      return out;
    }
    case "chats":
      if ("list" in f) return f.list.flatMap((r, i) => rowProblems(r, `chats ${i}`, true));
      return "gone" in f.delta ? (CHAT_ID.test(f.delta.chat) && f.delta.gone === true ? [] : ["chats: gone"]) : rowProblems(f.delta, "delta", false);
    case "pong":
      return Number.isSafeInteger(f.n) ? [] : ["pong: n"];
    case "attached": {
      const out = [...rowProblems({ chat: f.chat, state: f.state }, "attached", false), ...draftProblems(f.draft, "attached draft")];
      if (f.sideDraft) out.push(...draftProblems(f.sideDraft, "attached side draft"));
      if (!EPOCH.test(f.epoch) || !Number.isSafeInteger(f.seq) || f.seq < 0) out.push("attached: epoch or seq");
      if (f.picks.effort !== null && !EFFORT_IDS.includes(f.picks.effort)) out.push("attached: effort");
      if (f.picks.mode !== null && !MODE_IDS.includes(f.picks.mode)) out.push("attached: mode");
      if (!["events", "snapshot", "none"].includes(f.replay) || (f.replay !== "snapshot" && !Number.isSafeInteger(f.cursor))) out.push("attached: replay");
      return out;
    }
    case "ev":
      return [...(CHAT_ID.test(f.chat) && Number.isSafeInteger(f.seq) && f.seq > 0 ? [] : ["ev: chat or seq"]), ...eventProblems(f.e, `ev ${f.seq}`)];
    case "snapshot":
      return [...(f.more === null || typeof f.more === "string" ? [] : ["snapshot: more"]), ...(Number.isSafeInteger(f.tail) ? [] : ["snapshot: tail"]), ...f.history.flatMap((e, i) => eventProblems(e, `history ${i}`))];
    case "draft":
      return draftProblems(f, "draft");
    case "ack":
      if (!UUID.test(f.rid)) return ["ack: rid"];
      return f.ok || (ERROR_CODES.includes(f.error.code) && f.error.message === ERROR_MESSAGES[f.error.code]) ? [] : ["ack: error"];
    case "notice":
      return typeof f.text === "string" && (f.chat === undefined || CHAT_ID.test(f.chat)) ? [] : ["notice"];
    default:
      return [`a frame of type ${(f as { t: string }).t} that the demo never sends`];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A device: the app's own socket over the frame's stand-in, and its fetch

const ports: MessagePort[] = [];
const conns: Connection[] = [];
let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const c of conns.splice(0)) c.stop();
  for (const p of ports.splice(0)) p.close();
  errors.mockRestore();
});

function device(server: DemoServer, at = `${ORIGIN}/c/${EXAMPLE_CHAT}`) {
  const ch = new MessageChannel();
  ports.push(ch.port1, ch.port2);
  server.connectPort(ch.port2 as unknown as PortLike);
  const link = new FrameLink(ch.port1 as unknown as PortLike);
  const base = () => at;
  const WS = demoWebSocketClass(link, base);
  const tab = newTabId();
  const conn = new Connection({
    url: "wss://wannaflyka.github.io/ws",
    tab,
    open: (url) => new WS(url) as unknown as SocketLike,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    random: Math.random,
    reload: () => {
      throw new Error("the page would reload");
    },
  });
  conns.push(conn);
  const frames: ServerFrame[] = [];
  conn.on((f) => frames.push(f));
  const until = async <T extends ServerFrame>(pred: (f: ServerFrame) => f is T, what: string, from = 0, ms = 4_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no ${what}; got ${frames.slice(from).map((f) => (f.t === "ev" ? `ev:${f.e.k}` : f.t)).join(", ")}`);
      await Bun.sleep(5);
    }
  };
  const evs = (chat: string, from = 0) => frames.slice(from).flatMap((f) => (f.t === "ev" && f.chat === chat ? [f.e] : []));
  return { conn, frames, until, evs, link, tab, fetch: demoFetch(link, base), WS, XHR: demoXhrClass(link, base) };
}

const isT =
  <T extends ServerFrame["t"]>(t: T, chat?: string) =>
  (f: ServerFrame): f is Extract<ServerFrame, { t: T }> =>
    f.t === t && (chat === undefined || (f as { chat?: string }).chat === chat);
const isEv =
  (k: ChatEvent["k"], chat = EXAMPLE_CHAT) =>
  (f: ServerFrame): f is Extract<ServerFrame, { t: "ev" }> =>
    f.t === "ev" && f.chat === chat && f.e.k === k;
const isAck = (rid: string) => (f: ServerFrame): f is AckFrame => f.t === "ack" && f.rid === rid;

async function opened(d: ReturnType<typeof device>, chat = EXAMPLE_CHAT) {
  d.conn.start();
  await d.until(isT("chats"), "the chat list");
  const from = d.frames.length;
  d.conn.attach(chat);
  await d.until(isT("snapshot", chat), `the snapshot of ${chat}`, from);
  await Bun.sleep(20);
  return from;
}

function allGood(...ds: ReturnType<typeof device>[]) {
  for (const d of ds) expect(d.frames.flatMap(frameProblems)).toEqual([]);
  expect(errors).not.toHaveBeenCalled();
}

const textOf = (es: ChatEvent[], key: string) => es.flatMap((e) => (e.k === "block_delta" && e.key === key ? [e.text] : [])).join("");

// ---------------------------------------------------------------------------------------------------------------

describe("the welcome, the list and the example chat", () => {
  test("welcome: the demo's machine, one epoch for the page's life, the protocol's version, no side chat or trust", async () => {
    const server = new DemoServer({ lang: "en", pace: 0 });
    const d = device(server);
    d.conn.start();
    const w = await d.until(isT("welcome"), "the welcome");
    expect(w).toMatchObject({ v: PROTOCOL_VERSION, version: PACKAGE_VERSION, host: DEMO_HOST, auth: "none", update: { available: false, kind: "none" }, capabilities: { sideQuestions: false, trustFolder: false } });
    expect(w.claude).toEqual({ ok: true, version: "2.1.312 (Claude Code)", drift: null });
    expect(w.epoch).toBe(server.epoch);
    expect(w.epoch).toMatch(/^demo-[a-z2-7]{12}$/);
    const list = await d.until(isT("chats"), "the list");
    expect("list" in list && list.list.map((r) => r.chat).sort()).toEqual(DEMO_CHATS.map((c) => c.chat).sort());
    const ex = "list" in list ? list.list.find((r) => r.chat === EXAMPLE_CHAT) : null;
    expect(ex).toMatchObject({ title: "Fix the flaky upload test", state: "waiting", needsYou: true, busy: true });
    // The list is newest first, the example chat at the top.
    expect("list" in list && list.list[0]!.chat).toBe(EXAMPLE_CHAT);
    allGood(d);
  });

  test("attach: the history, then the tail with the turn's start, the chat's facts and the card that waits", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    const from = await opened(d);
    const att = d.frames.slice(from).find(isT("attached", EXAMPLE_CHAT))!;
    expect(att).toMatchObject({ state: "waiting", replay: "snapshot", cards: [EXAMPLE_PERMISSION], title: { text: "Fix the flaky upload test", from: "generated" } });
    const snap = d.frames.slice(from).find(isT("snapshot", EXAMPLE_CHAT))!;
    expect(snap.history.some((e) => e.k === "changes" && e.id === EXAMPLE_CHANGES)).toBe(true);
    expect(snap.history.at(-1)).toMatchObject({ k: "tool_call", id: EXAMPLE_CARD, name: "Bash" });
    const tail = d.evs(EXAMPLE_CHAT, from);
    expect(tail.map((e) => e.k)).toEqual(["turn_start", "session", "commands", "card_open"]);
    expect(snap.tail).toBe(4);
    // Claude Code's built-in commands only: no plugin's and no user's own.
    const cmds = tail.find((e) => e.k === "commands");
    expect(cmds?.k === "commands" && cmds.list.every((c) => c.builtin)).toBe(true);
    // The page's cursor is the chat's seq once the tail is in.
    expect(d.frames.slice(from).filter(isT("ev", EXAMPLE_CHAT)).at(-1)?.seq).toBe(att.seq);
    allGood(d);
  });

  test("a reattach under the same epoch replays only what it missed", async () => {
    const server = new DemoServer({ lang: "en", pace: 0 });
    const d = device(server);
    await opened(d);
    const att = d.frames.find(isT("attached", EXAMPLE_CHAT))!;
    // The store says that the snapshot's tail is in (R1), so the chat's cursor counts.
    d.conn.replayIn(EXAMPLE_CHAT, att.seq, server.epoch);
    d.conn.detach(EXAMPLE_CHAT);
    const from = d.frames.length;
    d.conn.attach(EXAMPLE_CHAT, att.seq, server.epoch);
    const again = await d.until(isT("attached", EXAMPLE_CHAT), "the attach again", from);
    expect(again).toMatchObject({ replay: "none", cursor: att.seq });
    expect(d.frames.slice(from).some(isT("snapshot"))).toBe(false);
    allGood(d);
  });
});

describe("one chat on every device (D49)", () => {
  test("a draft typed on the phone goes to the laptop, and a send there clears it on both", async () => {
    const server = new DemoServer({ lang: "en", pace: 0 });
    const phone = device(server);
    const laptop = device(server);
    await opened(phone, LAYERS);
    await opened(laptop, LAYERS);
    const from = laptop.frames.length;
    phone.conn.draft({ t: "draft", chat: LAYERS, text: "Unit tests first", mode: "chat", command: null, link: false, uploads: [] });
    const got = await laptop.until(isT("draft", LAYERS), "the draft on the laptop", from);
    expect(got).toMatchObject({ text: "Unit tests first", by: phone.tab, rev: 1 });
    const rid = newUuid();
    void laptop.conn.request({ t: "send", rid, chat: LAYERS, uuid: rid, text: "Unit tests first", draftRev: 1, uploads: [] });
    await laptop.until(isAck(rid), "the send's ack", from);
    const cleared = await phone.until((f): f is Extract<ServerFrame, { t: "draft" }> => f.t === "draft" && f.chat === LAYERS && f.text === "", "the cleared draft on the phone");
    expect(cleared.rev).toBe(2);
    allGood(phone, laptop);
  });

  test("the logs chat's draft is the server's, on every device", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    await opened(d, LOGS);
    expect(d.frames.find(isT("attached", LOGS))?.draft.text).toBe("Also list the five slowest endpoints.");
  });
});

describe("what a `get` answers, as the real server does", () => {
  test("a sleeping chat: its transcript's estimate, no commands and no connectors; once it runs, the live answers", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    await opened(d, LAYERS);
    const get = async (chat: string, what: "context" | "commands" | "connectors" | "models" | "side") => {
      const a = await d.conn.request({ t: "get", rid: newUuid(), chat, what });
      return a.ok ? a.result : a.error;
    };
    expect(await get(LAYERS, "commands")).toEqual([]);
    expect(await get(LAYERS, "connectors")).toEqual([]);
    expect(await get(LAYERS, "context")).toMatchObject({ percent: 2.2, model: "claude-sonnet-5-5" });
    expect(await get("addalintruleforunuse", "context")).toBe(null);
    expect(await get(LAYERS, "side")).toEqual({ rev: 0, exchanges: [] });
    expect((await get(LAYERS, "models")) as unknown[]).toHaveLength(5);
    const from = d.frames.length;
    const rid = newUuid();
    void d.conn.request({ t: "send", rid, chat: LAYERS, uuid: rid, text: "Go", draftRev: null, uploads: [] });
    await d.until(isEv("turn_end", LAYERS), "the turn's end", from);
    expect(((await get(LAYERS, "commands")) as unknown[]).length).toBeGreaterThan(5);
    expect(((await get(LAYERS, "connectors")) as unknown[]).length).toBe(3);
    expect(await get(LAYERS, "context")).toMatchObject({ model: "claude-sonnet-5-5", maxTokens: 200_000 });
    // The example chat is live from the page's load.
    expect(await get(EXAMPLE_CHAT, "context")).toMatchObject({ percent: 57 });
    allGood(d);
  });
});

describe("the scripted turn", () => {
  for (const lang of ["en", "zh-CN"] as DemoLang[]) {
    test(`a send to a sleeping chat starts it and gets the reply that streams (${lang})`, async () => {
      const d = device(new DemoServer({ lang, pace: 0 }));
      await opened(d, LAYERS);
      const from = d.frames.length;
      const rid = newUuid();
      void d.conn.request({ t: "send", rid, chat: LAYERS, uuid: rid, text: "Unit tests first, then the click-through.", draftRev: null, uploads: [] });
      await d.until(isEv("turn_end", LAYERS), "the turn's end", from);
      await Bun.sleep(10);
      const seq = d.frames.slice(from).flatMap((f) => (f.t === "chats" && "delta" in f && f.delta.chat === LAYERS ? [`delta:${"state" in f.delta ? f.delta.state : "lastActivity" in f.delta ? "activity" : "?"}`] : f.t === "ev" && f.chat === LAYERS ? [f.e.k === "block_delta" ? "delta" : f.e.k] : f.t === "ack" && f.rid === rid ? ["ack"] : []));
      const squeezed = seq.filter((x, i) => !(x === "delta" && seq[i - 1] === "delta"));
      expect(squeezed).toEqual(["delta:starting", "turn_start", "user", "delta:activity", "ack", "commands", "delta:running", "session", "block_start", "delta", "block_end", "turn_end", "delta:idle"]);
      const ack = d.frames.find(isAck(rid));
      expect(ack?.ok && ack.result).toEqual({ queued: false });
      const es = d.evs(LAYERS, from);
      expect(textOf(es, `${rid}:0`)).toBe(DEMO_REPLIES[lang]);
      expect(es.filter((e) => e.k === "block_delta").length).toBeGreaterThanOrEqual(10);
      expect(es.find((e) => e.k === "user")).toMatchObject({ uuid: rid, queued: false, mentions: [] });
      expect(es.find((e) => e.k === "turn_end")).toMatchObject({ ok: true, subtype: "success", uuids: [rid] });
      expect(es.find((e) => e.k === "session")).toMatchObject({ cwd: "/work/kitespan", model: "claude-sonnet-5-5", mode: "auto" });
      allGood(d);
    });
  }

  test("the reply streams over about 2 s at the page's pace", () => {
    for (const text of Object.values(DEMO_REPLIES)) {
      const p = pieces(text);
      expect(p.join("")).toBe(text);
      expect(p.length).toBeGreaterThanOrEqual(25);
      expect(p.length * 60).toBeLessThanOrEqual(2_500);
    }
  });

  test("a message sent while a turn runs waits as Queued, then runs once the card is answered", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    const from = await opened(d);
    const rid = newUuid();
    void d.conn.request({ t: "send", rid, chat: EXAMPLE_CHAT, uuid: rid, text: "Also note the retry timing in the docs.", draftRev: null, uploads: [] });
    const queued = await d.until(isEv("user"), "the queued message", from);
    expect(queued.e).toMatchObject({ uuid: rid, queued: true });
    const a = newUuid();
    void d.conn.request({ t: "answer", rid: a, chat: EXAMPLE_CHAT, card: EXAMPLE_CARD, answer: { kind: "permission", allow: true, scope: "once" } });
    await d.until((f): f is Extract<ServerFrame, { t: "ev" }> => f.t === "ev" && f.e.k === "turn_end" && f.e.uuids[0] === rid, "the queued message's turn", from, 6_000);
    const users = d.evs(EXAMPLE_CHAT, from).filter((e) => e.k === "user");
    expect(users.map((e) => e.k === "user" && e.queued)).toEqual([true, false]);
    allGood(d);
  });

  test("a new chat in a seeded project gets its row, its title and the reply", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    await opened(d);
    const from = d.frames.length;
    const rid = newUuid();
    const ack = await d.conn.request({ t: "new_chat", rid, project: "n4tes2api7", uuid: newUuid(), text: "Add a search box\nto the notes page", picks: { model: null, effort: null, mode: null }, uploads: [] });
    expect(ack.ok).toBe(true);
    const chat = ack.ok ? (ack.result as { chat: string }).chat : "";
    expect(chat).toMatch(CHAT_ID);
    const row = await d.until((f): f is Extract<ServerFrame, { t: "chats" }> => f.t === "chats" && "delta" in f && f.delta.chat === chat, "the new chat's row", from);
    expect("delta" in row && row.delta).toMatchObject({ project: "n4tes2api7", title: "Add a search box", state: "starting", busy: true });
    const f2 = d.frames.length;
    d.conn.attach(chat);
    await d.until(isEv("turn_end", chat), "the new chat's reply", f2);
    allGood(d);
  });

  test("Stop ends the reply where it is: interrupted, with nothing queued left", async () => {
    const server = new DemoServer({ lang: "en", pace: 1 });
    const d = device(server);
    await opened(d, LAYERS);
    const from = d.frames.length;
    const rid = newUuid();
    void d.conn.request({ t: "send", rid, chat: LAYERS, uuid: rid, text: "Go", draftRev: null, uploads: [] });
    const start = await d.until(isEv("turn_start", LAYERS), "the turn's start", from);
    await d.until(isEv("block_delta", LAYERS), "the reply streaming", from);
    const stop = await d.conn.request({ t: "interrupt", rid: newUuid(), chat: LAYERS, turn: start.seq });
    expect(stop.ok && stop.result).toEqual({ stillQueued: [] });
    const end = await d.until(isEv("turn_end", LAYERS), "the turn's end", from);
    expect(end.e).toMatchObject({ ok: false, subtype: TURN_INTERRUPTED, error: null });
    const es = d.evs(LAYERS, from);
    expect(es.findIndex((e) => e.k === "block_end")).toBeLessThan(es.findIndex((e) => e.k === "turn_end"));
    expect(textOf(es, `${rid}:0`).length).toBeLessThan(DEMO_REPLIES.en.length);
    allGood(d);
  });
});

describe("S1: the card answered on the phone, and on the laptop too", () => {
  const cases = [
    { answer: { kind: "permission", allow: true, scope: "once" } as const, close: { answer: "once" } as const, result: "Built in 1.4 s.", reply: "Built. The last run passes too.", isError: false },
    { answer: { kind: "permission", allow: true, scope: "session" } as const, close: { answer: "session" } as const, result: "Built in 1.4 s.", reply: "Built. The last run passes too.", isError: false },
    { answer: { kind: "permission", allow: false, message: "Run only the test, not the build." } as const, close: { answer: "denied", note: "Run only the test, not the build." } as const, result: "The user denied this tool use.", reply: "I left the build folder as it is.", isError: true },
  ];
  for (const c of cases) {
    test(`${c.close.answer}: the card closes, the call goes on and the turn ends, on both devices`, async () => {
      const server = new DemoServer({ lang: "en", pace: 0 });
      const phone = device(server);
      const laptop = device(server, `${ORIGIN}/c/${EXAMPLE_CHAT}/changes/${EXAMPLE_CHANGES}/src/upload.ts?below=details`);
      const pf = await opened(phone);
      const lf = await opened(laptop);
      const rid = newUuid();
      const ack = await phone.conn.request({ t: "answer", rid, chat: EXAMPLE_CHAT, card: EXAMPLE_CARD, answer: c.answer });
      expect(ack.ok && ack.result).toBe(null);
      for (const [d, from] of [
        [phone, pf],
        [laptop, lf],
      ] as const) {
        await d.until(isEv("turn_end"), "the turn's end", from);
        const es = d.evs(EXAMPLE_CHAT, from).slice(4);
        expect(es[0]).toEqual({ k: "card_close", id: EXAMPLE_CARD, why: "answered", ...c.close });
        expect(es[1]).toEqual({ k: "tool_result", id: EXAMPLE_CARD, text: c.result, isError: c.isError, parent: null, report: null });
        expect(textOf(es, c.isError ? "msg_01NotBuilt:0" : "msg_01Built:0")).toBe(c.reply);
        expect(es.at(-1)).toMatchObject({ k: "turn_end", ok: true, uuids: [WAITING_TURN_USER] });
      }
      await Bun.sleep(10);
      const deltas = laptop.frames.flatMap((f) => (f.t === "chats" && "delta" in f && f.delta.chat === EXAMPLE_CHAT ? [f.delta] : []));
      expect(deltas[0]).toMatchObject({ state: "running", needsYou: false });
      expect(deltas.at(-1)).toMatchObject({ state: "idle", busy: false });
      // A second answer to the same card is stale; a page opened now draws the record from history, with no card.
      expect((await phone.conn.request({ t: "answer", rid: newUuid(), chat: EXAMPLE_CHAT, card: EXAMPLE_CARD, answer: c.answer })).ok).toBe(false);
      const late = device(server);
      const from = await opened(late);
      const snap = late.frames.slice(from).find(isT("snapshot", EXAMPLE_CHAT))!;
      expect(late.frames.slice(from).find(isT("attached", EXAMPLE_CHAT))?.cards).toEqual([]);
      expect(snap.history.slice(-5).map((e) => e.k)).toEqual(["card_open", "card_close", "tool_result", "block", "turn_end"]);
      expect(late.evs(EXAMPLE_CHAT, from).map((e) => e.k)).toEqual(["session", "commands"]);
      allGood(phone, laptop, late);
    });
  }
});

describe("what does not run answers in place with its line", () => {
  test("a `!` command: its row ends with the line as its stderr, and no turn follows", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    await opened(d, LAYERS);
    const from = d.frames.length;
    const rid = newUuid();
    const ack = await d.conn.request({ t: "bash", rid, chat: LAYERS, input: "ls", draftRev: null, uploads: [] });
    expect(ack.ok).toBe(true);
    const done = await d.until((f): f is Extract<ServerFrame, { t: "ev" }> => f.t === "ev" && f.e.k === "bash" && f.e.state === "done", "the command's record", from);
    expect(done.e).toMatchObject({ input: "ls", stderr: DEMO_LINES.commands, code: 1, stdout: "" });
    await Bun.sleep(30);
    expect(d.evs(LAYERS, from).some((e) => e.k === "turn_start")).toBe(false);
    allGood(d);
  });

  test("the Terminal pane: the shell socket refuses with the line, and the pane stops dialling", async () => {
    const server = new DemoServer({ lang: "en", pace: 0 });
    const d = device(server);
    const statuses: LinkStatus[] = [];
    const shell = new ShellLink(EXAMPLE_CHAT, { url: "wss://wannaflyka.github.io/ws/shell", open: (u) => new d.WS(u) as unknown as ShellSocketLike, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>), random: Math.random }, {
      output() {},
      opened() {},
      size() {},
      reset() {},
      exit() {},
      typed() {},
      status: (s) => statuses.push(s),
    });
    shell.start(80, 24);
    const end = Date.now() + 2_000;
    while (shell.status !== "refused" && Date.now() < end) await Bun.sleep(5);
    expect(shell.status).toBe("refused");
    expect(shell.refusal).toEqual({ code: "no_shell", message: DEMO_LINES.terminal });
    expect(SHELL_ERROR_CODES).toContain("no_shell");
    shell.stop();
    expect(errors).not.toHaveBeenCalled();
  });

  test("the controls with no line of their own: their plain result, and the demo's line as the notice", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    await opened(d);
    for (const f of [
      { t: "reconnect_mcp", server: "docs-search" },
      { t: "set_connector", server: "github", enabled: false },
      { t: "end_here" },
      { t: "send_now", uuid: newUuid() },
    ] as const) {
      const from = d.frames.length;
      const rid = newUuid();
      const ack = await d.conn.request({ ...f, rid, chat: EXAMPLE_CHAT } as never);
      expect(ack.ok).toBe(true);
      const n = await d.until(isT("notice"), `the notice of ${f.t}`, from);
      expect(n).toEqual({ t: "notice", text: DEMO_LINES.other, chat: EXAMPLE_CHAT });
    }
    allGood(d);
  });

  test("a frame that kitespan would refuse gets bad_request, and says so on the console", async () => {
    const server = new DemoServer({ lang: "en", pace: 0 });
    const sent: unknown[] = [];
    const port = server.connect((m) => sent.push(m));
    port.receive({ k: "ws", id: 1, path: "/ws" });
    const rid = newUuid();
    port.receive({ k: "ws-send", id: 1, data: JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, tab: "tab_x" }) });
    port.receive({ k: "ws-send", id: 1, data: JSON.stringify({ t: "send", rid, chat: EXAMPLE_CHAT, uuid: newUuid(), text: "uuid differs", uploads: [] }) });
    const frames = sent.flatMap((m) => ((m as { k: string }).k === "ws-message" ? [JSON.parse((m as { data: string }).data) as ServerFrame] : []));
    expect(frames.at(-1)).toEqual({ t: "ack", rid, ok: false, error: { code: "bad_request", message: ERROR_MESSAGES.bad_request } });
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe("the API", () => {
  const json = async (r: Response) => (r.status === 204 ? null : await r.json());

  test("the reads the page makes, as the real server shapes them", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    const get = async (p: string) => {
      const r = await d.fetch(p);
      expect(r.status).toBe(200);
      return json(r);
    };
    const projects = await get("/api/projects");
    expect(projects.projects.map((p: { name: string }) => p.name)).toEqual(["kitespan", "scratch", "notes-api"]);
    expect(projects.projects.every((p: { cwd: string }) => p.cwd.startsWith("/work/"))).toBe(true);
    const settings = await get("/api/settings?project=k3m7q2x4ab");
    expect(Object.keys(settings).sort()).toEqual(["access", "account", "adaptersProblem", "agent", "claude", "facts", "phoneNotes", "server", "settings", "uploads"]);
    expect(settings.claude).toMatchObject({ ok: true, path: "/usr/local/bin/claude", version: "2.1.312 (Claude Code)" });
    expect(await get("/api/update")).toMatchObject({ kind: "release", update: "none", build: "none", latest: null, next: null, can: true, job: { state: "idle" } });
    expect(await get("/api/restart")).toEqual({ update: "none", build: "none", panes: [] });
    expect(await get("/api/push")).toEqual({ key: null, devices: [] });
    expect(await get(`/api/chats/${EXAMPLE_CHAT}/uploads`)).toEqual({ uploads: [] });
    const summary = await get(`/api/chats/${EXAMPLE_CHAT}/changes/${EXAMPLE_CHANGES}`);
    expect(changesCardOf(summary)).not.toBeNull();
    for (const f of summary.files as { path: string }[]) expect((await get(`/api/chats/${EXAMPLE_CHAT}/changes/${EXAMPLE_CHANGES}/files/${f.path}`)).path).toBe(f.path);
    expect((await d.fetch(`/api/chats/${EXAMPLE_CHAT}/changes/${EXAMPLE_CHANGES}/files/src/nope.ts`)).status).toBe(404);
    for (const p of ["k3m7q2x4ab", "n4tes2api7", "scr4tch2de"]) {
      expect(await get(`/api/projects/${p}/sessions`)).toEqual({ sessions: [] });
      expect((await get(`/api/projects/${p}/models`)).models.length).toBe(5);
      expect((await get(`/api/projects/${p}/commands`)).commands.every((c: { builtin: boolean }) => c.builtin)).toBe(true);
    }
    expect((await get("/api/folders/suggested")).folders.map((f: { path: string }) => f.path)).toEqual(["/work/kitespan", "/work/notes-api", "/work/scratch"]);
    const corpus = await get(`/api/chats/${EXAMPLE_CHAT}/corpus?max=100000`);
    expect(corpus).toMatchObject({ v: "demo", source: "git", complete: true });
    expect(corpus.paths).toContain("src/upload.ts");
    expect(await get(`/api/chats/${EXAMPLE_CHAT}/corpus?max=100000&v=demo`)).toEqual({ v: "demo", same: true });
    expect((await get("/api/projects/n4tes2api7/corpus?max=20000&chars=1400000")).paths).toEqual(["src/db/schema.sql", "src/query/parse.ts"]);
  });

  test("a download, its existence probe and an upload's file: the demo's downloads line (the frame's build answers so itself)", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    for (const p of [`/api/chats/${EXAMPLE_CHAT}/exists/src/upload.ts`, `/api/chats/${EXAMPLE_CHAT}/files/src/upload.ts`, `/api/chats/${EXAMPLE_CHAT}/uploads/u1/exists`, `/api/chats/${EXAMPLE_CHAT}/uploads/u1/file`]) {
      const r = await d.fetch(p);
      expect({ p, status: r.status, body: await r.json() }).toEqual({ p, status: 501, body: { error: { code: "failed", message: DEMO_LINES.downloads } } });
    }
  });

  test("Check now: a check that could not look, with the demo's refusal, which About's next read keeps", async () => {
    let now = Date.parse("2026-11-08T10:00:00.000Z");
    const d = device(new DemoServer({ lang: "en", pace: 0, now: () => now }));
    const before = await (await d.fetch("/api/update")).json();
    expect(before.check).toMatchObject({ ok: true, why: null, running: false });
    now += 60_000;
    const r = await d.fetch("/api/update/check", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    const after = await r.json();
    expect(after.check).toEqual({ at: new Date(now).toISOString(), ok: false, why: DEMO_CHECK_REFUSAL, running: false });
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect((await (await d.fetch("/api/update")).json()).check).toEqual(after.check);
  });

  test("message search over the demo's own chats: the reply's form, user and agent hits, at most 3 per chat", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    const r = await json(await d.fetch(`/api/search?q=upload&tab=${newTabId()}`));
    const reply = messageSearchReplyOf(r);
    expect(reply).not.toBeNull();
    expect(reply!.complete).toBe(true);
    expect(reply!.hits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(reply!.hits.map((h) => h.by))).toEqual(new Set(["user", "agent"]));
    const per = new Map<string, number>();
    for (const h of reply!.hits) per.set(h.chat, (per.get(h.chat) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(3);
    expect(reply!.hits.some((h) => h.chat === LAYERS)).toBe(true);
    for (const h of reply!.hits) for (const [a, b] of h.ranges) expect(h.snippet.slice(a, b).toLowerCase()).toBe("upload");
    expect((await json(await d.fetch("/api/search?q=u"))).hits).toEqual([]);
  });

  test("what does not run here: a 501 with the demo's line, in the form web/net/api.ts reads", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    const line = async (method: string, p: string, key: keyof typeof DEMO_LINES) => {
      const r = await d.fetch(p, { method, body: "{}" });
      expect(r.status).toBe(501);
      expect(await r.json()).toEqual({ error: { code: "failed", message: DEMO_LINES[key] } });
    };
    await line("POST", "/api/update", "update");
    await line("POST", "/api/restart", "restart");
    await line("POST", "/api/restart/cancel", "restart");
    await line("POST", "/api/push/key", "notifications");
    await line("POST", "/api/push/devices", "notifications");
    await line("GET", "/api/folders?path=%2Fwork", "folders");
    await line("GET", "/api/folders/worktree?path=%2Fwork%2Fkitespan", "folders");
    await line("POST", "/api/projects", "folders");
    await line("POST", "/api/projects/k3m7q2x4ab/rename", "folders");
    await line("GET", "/api/projects/k3m7q2x4ab/env", "folders");
    await line("POST", "/api/uploads?chat=k3m7q2x4abk3m7q2x4ab", "files");
    await line("GET", "/api/nothing", "other");
  });

  test("a POST of settings is kept in memory for the page's life", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    const r = await d.fetch("/api/settings", { method: "POST", body: JSON.stringify({ "appearance.look": "paper", "nope.key": 1 }) });
    const s = await r.json();
    expect(s.settings["appearance.look"]).toBe("paper");
    expect("nope.key" in s.settings).toBe(false);
  });

  test("the upload's XHR: its progress, then the line as the server's refusal", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    const xhr = new d.XHR();
    const progress: number[] = [];
    const done = new Promise<void>((resolve) => (xhr.onload = () => resolve()));
    xhr.open("POST", "/api/uploads?chat=k3m7q2x4abk3m7q2x4ab&name=a.txt");
    xhr.upload.onprogress = (e) => progress.push(e.loaded);
    xhr.send(new Blob(["hello"]));
    await done;
    expect(progress.length).toBe(1);
    expect(xhr.status).toBe(501);
    expect(JSON.parse(xhr.responseText)).toEqual({ error: { code: "failed", message: DEMO_LINES.files } });
  });

  test("the frame's fetch reaches nothing but the stand-in: another origin or path fails, `/` is a 404", async () => {
    const d = device(new DemoServer({ lang: "en", pace: 0 }));
    expect((await d.fetch("/")).status).toBe(404);
    for (const u of ["https://example.com/api/projects", "/c/k3m7q2x4abk3m7q2x4ab", "/kitespan/demo/"]) await expect(d.fetch(u)).rejects.toThrow("Failed to fetch");
  });
});

describe("the landing page's side", () => {
  test("startDemo takes a port only from one of its own frames, on its own origin, with the tag", () => {
    const listeners: ((e: DemoMessageEvent) => void)[] = [];
    const frame = { contentWindow: { name: "frame" } };
    const win = {
      addEventListener: (_t: "message", fn: (e: DemoMessageEvent) => void) => void listeners.push(fn),
      location: { origin: ORIGIN },
      document: { querySelectorAll: () => [frame] },
    };
    const demo = startDemo({ lang: "en", win, pace: 0 });
    const got: unknown[] = [];
    const port = (): PortLike & { got: unknown[] } => ({ got, postMessage: (m: unknown) => void got.push(m), onmessage: null });
    const send = (e: Partial<DemoMessageEvent>) => listeners[0]!({ data: { kitespanDemo: 1, device: "phone" }, origin: ORIGIN, source: frame.contentWindow, ports: [port()], ...e });
    send({ origin: "https://example.com" });
    send({ source: { name: "another window" } });
    send({ data: { device: "phone" } });
    send({ ports: [] });
    expect(got).toEqual([]);
    send({});
    expect(got).toEqual([{ k: "theme", theme: "system" }]);
    demo.setTheme("dark");
    expect(got.at(-1)).toEqual({ k: "theme", theme: "dark" });
  });
});
