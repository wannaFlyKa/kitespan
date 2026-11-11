// The demo's stand-in server against the real one (DESIGN-W1 4.5): the real server boots on the click-through seed
// with the fake claude (the main scene, then the permission scene; KITESPAN_TEST_PORT or a free test port), and the
// stand-in (site/demo/server.ts) runs here, both asked the same things. Their frames and replies must have the same
// keys: the welcome, a chat row, an attach, a snapshot, each kind of event that both send, the permission card, what
// a `get` answers, and each API reply that the stand-in answers. A field that the real server adds fails this test
// until the stand-in has it too. The real claude never runs (the harness puts the fake first on PATH).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { EXAMPLE_CARD, EXAMPLE_CHANGES, EXAMPLE_CHAT } from "../../site/demo/lines";
import { DemoServer } from "../../site/demo/server";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-demo-parity-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
const LAYERS = "pickthetestlayers2ab";
const LINT = "addalintruleforunuse";

type Frame = Record<string, any>;

/** One side's socket: the real server's over a WebSocket, or the stand-in's over its port. */
interface Side {
  frames: Frame[];
  send(f: Frame): void;
  close(): void;
}

async function until(s: Side, pred: (f: Frame) => boolean, what: string, from = 0, ms = 30_000): Promise<Frame> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = s.frames.slice(from).find(pred);
    if (hit) return hit;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; got ${s.frames.slice(from).map((f) => (f.t === "ev" ? `ev:${f.e?.k}` : f.t)).join(", ")}`);
    await Bun.sleep(10);
  }
}

async function realSide(b: Booted): Promise<Side> {
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`, { headers: { origin: b.base } });
  const frames: Frame[] = [];
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  return { frames, send: (f) => ws.send(JSON.stringify(f)), close: () => ws.close() };
}

function demoSide(server: DemoServer): Side {
  const frames: Frame[] = [];
  const port = server.connect((m) => {
    if (m.k === "ws-message" && typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  });
  port.receive({ k: "ws", id: 1, path: "/ws" });
  return { frames, send: (f) => port.receive({ k: "ws-send", id: 1, data: JSON.stringify(f) }), close: () => port.close() };
}

/** What both sides are asked, in order; the frames each gave. */
async function hello(s: Side, tab: string) {
  s.send({ t: "hello", v: PROTOCOL_VERSION, tab });
  await until(s, (f) => f.t === "chats" && "list" in f, "the list");
}

async function attach(s: Side, chat: string) {
  const from = s.frames.length;
  s.send({ t: "attach", chat, since: 0, epoch: null });
  const snap = await until(s, (f) => f.t === "snapshot" && f.chat === chat, `the snapshot of ${chat}`, from);
  // The tail follows its snapshot at once.
  const end = Date.now() + 5_000;
  while (s.frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat).length < snap.tail && Date.now() < end) await Bun.sleep(10);
  return from;
}

async function ask(s: Side, f: Frame): Promise<Frame> {
  const rid = crypto.randomUUID();
  const from = s.frames.length;
  s.send({ ...f, rid, ...(f.t === "send" ? { uuid: rid } : {}) });
  return until(s, (x) => x.t === "ack" && x.rid === rid, `the ack of ${f.t}`, from);
}

const keys = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : []);

/** Every event in a side's frames (histories and live), by kind. */
function eventsOf(s: Side): Map<string, Frame[]> {
  const out = new Map<string, Frame[]>();
  const add = (e: Frame) => out.set(e.k, [...(out.get(e.k) ?? []), e]);
  for (const f of s.frames) {
    if (f.t === "ev") add(f.e);
    if (f.t === "snapshot") for (const e of f.history) add(e);
  }
  return out;
}

const real: { main?: Side; perm?: Side; api: Map<string, unknown> } = { api: new Map() };
const demo = { server: new DemoServer({ lang: "en", pace: 0 }), api: new Map<string, unknown>() };
let side: Side;

/** The API reads both sides answer (the stand-in's own search, corpus and file reads included). */
const READS = [
  "/api/projects",
  "/api/settings",
  "/api/settings?project=k3m7q2x4ab",
  "/api/update",
  "/api/restart",
  "/api/push",
  `/api/chats/${EXAMPLE_CHAT}/uploads`,
  `/api/chats/${EXAMPLE_CHAT}/changes/${EXAMPLE_CHANGES}`,
  `/api/chats/${EXAMPLE_CHAT}/changes/${EXAMPLE_CHANGES}/files/src/upload.ts`,
  "/api/search?q=upload&tab=parityTab01",
  "/api/projects/k3m7q2x4ab/sessions",
  "/api/projects/k3m7q2x4ab/models",
  "/api/projects/k3m7q2x4ab/commands",
  "/api/folders/suggested",
  `/api/chats/${EXAMPLE_CHAT}/corpus?max=100000`,
  "/api/projects/n4tes2api7/corpus?max=20000&chars=1400000",
  "/api/upload-folder?chat=k3m7q2x4abk3m7q2x4ab",
] as const;

async function readReal(b: Booted, path: string): Promise<unknown> {
  const res = await fetch(`${b.base}${path}`, { headers: { origin: b.base, "x-kitespan": "1" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

beforeAll(async () => {
  if (!PROCFS) return;
  // The main scene: the example chat with its history and changes, every API read, a `!` command, a draft.
  let b = await boot({ scene: "main", port: PORT, dist: DIST });
  try {
    for (const p of READS) real.api.set(p, await readReal(b, p));
    const s = await realSide(b);
    await hello(s, "parityTab01");
    await attach(s, EXAMPLE_CHAT);
    for (const what of ["context", "commands", "models", "connectors"]) await ask(s, { t: "get", chat: EXAMPLE_CHAT, what });
    await attach(s, LINT);
    s.send({ t: "draft", chat: LINT, text: "Lint", mode: "chat", command: null, link: false, uploads: [] });
    await until(s, (f) => f.t === "draft" && f.chat === LINT, "the draft");
    const from = s.frames.length;
    await ask(s, { t: "bash", chat: EXAMPLE_CHAT, input: "true", draftRev: null, uploads: [] });
    await until(s, (f) => f.t === "ev" && f.e?.k === "bash" && f.e.state === "done", "the command's record", from);
    real.main = s;
    s.close();
  } finally {
    await b.stop();
  }
  // The permission scene: the card that waits, its answer, and a send to a sleeping chat.
  b = await boot({ scene: "permission", port: PORT, dist: DIST });
  try {
    const s = await realSide(b);
    await hello(s, "parityTab02");
    await attach(s, EXAMPLE_CHAT);
    await attach(s, LAYERS);
    let from = s.frames.length;
    await ask(s, { t: "answer", chat: EXAMPLE_CHAT, card: EXAMPLE_CARD, answer: { kind: "permission", allow: true, scope: "once" } });
    await until(s, (f) => f.t === "ev" && f.chat === EXAMPLE_CHAT && f.e?.k === "turn_end", "the answered turn's end", from);
    from = s.frames.length;
    await ask(s, { t: "send", chat: LAYERS, text: "Unit tests first.", draftRev: null, uploads: [] });
    await until(s, (f) => f.t === "ev" && f.chat === LAYERS && f.e?.k === "turn_end", "the sent turn's end", from);
    real.perm = s;
    s.close();
  } finally {
    await b.stop();
  }
}, 240_000);

beforeAll(async () => {
  // The stand-in, asked the same.
  side = demoSide(demo.server);
  for (const p of READS) {
    const r = demo.server.http("GET", p, null);
    demo.api.set(p, JSON.parse(r.body));
  }
  await hello(side, "parityTab03");
  await attach(side, EXAMPLE_CHAT);
  for (const what of ["context", "commands", "models", "connectors"]) await ask(side, { t: "get", chat: EXAMPLE_CHAT, what });
  await attach(side, LINT);
  side.send({ t: "draft", chat: LINT, text: "Lint", mode: "chat", command: null, link: false, uploads: [] });
  await until(side, (f) => f.t === "draft" && f.chat === LINT, "the draft");
  await attach(side, LAYERS);
  let from = side.frames.length;
  await ask(side, { t: "bash", chat: EXAMPLE_CHAT, input: "true", draftRev: null, uploads: [] });
  await until(side, (f) => f.t === "ev" && f.e?.k === "bash" && f.e.state === "done", "the command's record", from);
  from = side.frames.length;
  await ask(side, { t: "answer", chat: EXAMPLE_CHAT, card: EXAMPLE_CARD, answer: { kind: "permission", allow: true, scope: "once" } });
  await until(side, (f) => f.t === "ev" && f.chat === EXAMPLE_CHAT && f.e?.k === "turn_end", "the answered turn's end", from);
  from = side.frames.length;
  await ask(side, { t: "send", chat: LAYERS, text: "Unit tests first.", draftRev: null, uploads: [] });
  await until(side, (f) => f.t === "ev" && f.chat === LAYERS && f.e?.k === "turn_end", "the sent turn's end", from);
});

afterAll(() => {
  side?.close();
  rmSync(DIST, { recursive: true, force: true });
});

const realFrames = () => [...(real.main?.frames ?? []), ...(real.perm?.frames ?? [])];
const first = (frames: Frame[], pred: (f: Frame) => boolean, what: string): Frame => {
  const f = frames.find(pred);
  if (!f) throw new Error(`no ${what}`);
  return f;
};

describe.skipIf(!PROCFS)(`the stand-in has the real server's keys ${LINUX_ONLY}`, () => {
  test("the welcome, its Claude Code status, its update and its capabilities", () => {
    const r = first(realFrames(), (f) => f.t === "welcome", "real welcome");
    const d = first(side.frames, (f) => f.t === "welcome", "demo welcome");
    expect(keys(d)).toEqual(keys(r));
    for (const k of ["claude", "update", "capabilities"]) expect({ k, keys: keys(d[k]) }).toEqual({ k, keys: keys(r[k]) });
  });

  test("a chat row: the example chat's (it has a session) and one with no message yet", () => {
    const rows = (frames: Frame[]) => (frames.find((f) => f.t === "chats" && "list" in f)?.list ?? []) as Frame[];
    for (const chat of [EXAMPLE_CHAT, LINT]) {
      const r = rows(real.perm!.frames).find((x) => x.chat === chat);
      const d = rows(side.frames).find((x) => x.chat === chat);
      expect({ chat, keys: keys(d) }).toEqual({ chat, keys: keys(r) });
    }
  });

  test("the attach of a chat whose card waits, the card itself, and the snapshot", () => {
    const att = (frames: Frame[]) => first(frames, (f) => f.t === "attached" && f.chat === EXAMPLE_CHAT, "attached");
    const r = att(real.perm!.frames);
    const d = att(side.frames);
    expect(keys(d)).toEqual(keys(r));
    for (const k of ["picks", "title", "draft", "sideDraft"]) expect({ k, keys: keys(d[k]) }).toEqual({ k, keys: keys(r[k]) });
    expect(keys(d.cards[0])).toEqual(keys(r.cards[0]));
    expect(keys(d.cards[0].input)).toEqual(keys(r.cards[0].input));
    const snap = (frames: Frame[]) => first(frames, (f) => f.t === "snapshot" && f.chat === EXAMPLE_CHAT, "snapshot");
    expect(keys(snap(side.frames))).toEqual(keys(snap(real.perm!.frames)));
    // The waiting turn's tail: its start, the chat's facts and the card, in the real server's kinds.
    const tail = (frames: Frame[]) => [...new Set(frames.filter((f) => f.t === "ev" && f.chat === EXAMPLE_CHAT && f.seq <= att(frames).seq).map((f) => f.e.k))].sort();
    expect(tail(side.frames)).toEqual(tail(real.perm!.frames));
  });

  test("each kind of event that both send has the real server's fields", () => {
    const r = eventsOf({ frames: realFrames() } as Side);
    const d = eventsOf(side);
    const both = [...d.keys()].filter((k) => r.has(k));
    expect(both.length).toBeGreaterThan(15);
    for (const k of both) {
      const realAll = new Set(r.get(k)!.flatMap(keys));
      const realAlways = keys(r.get(k)![0]).filter((x) => r.get(k)!.every((e) => x in e));
      for (const e of d.get(k)!) {
        // Every field the stand-in sends is one the real server sends; every field the real server always sends, it sends.
        expect({ k, extra: keys(e).filter((x) => !realAll.has(x)) }).toEqual({ k, extra: [] });
        expect({ k, missing: realAlways.filter((x) => !(x in e)) }).toEqual({ k, missing: [] });
      }
    }
    // The kinds of a scripted turn, of S1's answer and of a `!` command are all among them.
    for (const k of ["turn_start", "user", "block_start", "block_delta", "block_end", "turn_end", "card_close", "tool_result", "session", "commands", "bash"]) expect(both).toContain(k);
  });

  test("the draft frame, and what a `get` answers", () => {
    const draft = (frames: Frame[]) => first(frames, (f) => f.t === "draft" && f.chat === LINT, "draft");
    expect(keys(draft(side.frames))).toEqual(keys(draft(real.main!.frames)));
    const acks = (frames: Frame[]) => frames.filter((f) => f.t === "ack" && f.ok && f.result !== null);
    const r = acks(real.main!.frames);
    const d = acks(side.frames);
    // context, commands, models, connectors: in that order on both sides.
    for (let i = 0; i < 4; i++) {
      const rr = r[i]!.result;
      const dr = d[i]!.result;
      expect(Array.isArray(dr)).toBe(Array.isArray(rr));
      expect(keys(Array.isArray(dr) ? dr[0] : dr)).toEqual(keys(Array.isArray(rr) ? rr[0] : rr));
    }
  });

  for (const path of READS) {
    test(`GET ${path.split("?")[0]}`, () => {
      const r = real.api.get(path) as Frame;
      const d = demo.api.get(path) as Frame;
      expect(keys(d)).toEqual(keys(r));
      // The rows of a list reply too.
      for (const k of keys(r)) {
        const rv = r[k];
        const dv = d[k];
        if (Array.isArray(rv) && rv.length && Array.isArray(dv) && dv.length && typeof rv[0] === "object") expect({ k, keys: keys(dv[0]) }).toEqual({ k, keys: keys(rv[0]) });
      }
    });
  }
});
