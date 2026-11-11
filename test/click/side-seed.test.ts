// R124's click-through seed on the real server, with no browser: the side scene boots bin/kitespan with the fake
// claude, and the example chat's side thread holds the two kept exchanges (seed/side.ts). Over two pages' sockets: `get
// side` reads it; a side question answers and both pages get its events; a follow-up reads the one before it; a
// question on a sleeping chat starts its Claude Code with no turn; Stop cancels one in Claude Code; `/btw` sent as a
// message is refused; nothing of it reaches either chat's transcript; and the thread is kept over a restart (SIGTERM,
// then a new start on the same seed). scripts/ui-check.ts's side-chat flows open the same scene in a browser. A stub
// page stands in for the built one; the port is KITESPAN_TEST_PORT or a free test port.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type SideExchange, type SideRead } from "../../shared/protocol";
import { ROUTE_BY_NAME, parsePath } from "../../shared/route";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { SIDE, SIDE_ANSWERS } from "./seed/fixture";
import { EX, IDS } from "./seed/ids";
import { SIDE_KEPT } from "./seed/side";
import { SIDE_SCENE } from "./seed/scenes";
import { projectDirName } from "./seed/write";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
let h: Booted | null = null;
afterAll(async () => {
  if (h) await h.stop().catch(() => {});
  rmSync(DIST, { recursive: true, force: true });
});

type Frame = Record<string, any>;
const rid = () => crypto.randomUUID();

async function page(port: number, tab: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
  const frames: Frame[] = [];
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  const until = async (ok: () => boolean, what: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  };
  const send = (f: Frame) => ws.send(JSON.stringify(f));
  /** One request and its ack. */
  const request = async (f: Frame, ms = 15_000): Promise<Frame> => {
    const r = f.rid as string;
    send(f);
    await until(() => frames.some((x) => x.t === "ack" && x.rid === r), `the ack of ${f.t}`, ms);
    return frames.find((x) => x.t === "ack" && x.rid === r)!;
  };
  const attach = async (chat: string) => {
    send({ t: "attach", chat, since: 0, epoch: null });
    await until(() => frames.some((f) => f.t === "attached" && f.chat === chat), `the attach of ${chat}`);
  };
  /** The side events of `chat` since frame `from`. */
  const side = (chat: string, from = 0) => frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat && ["side", "side_gone", "side_clear"].includes(f.e?.k)).map((f) => f.e);
  send({ t: "hello", v: PROTOCOL_VERSION, tab });
  await until(() => frames.some((f) => f.t === "chats" && "list" in f), "the chat list");
  return { frames, until, send, request, attach, side, close: () => ws.close() };
}

test("the side chat route's example link fills the box with the seed's link question (its Send is the action check)", () => {
  const r = parsePath(ROUTE_BY_NAME.sideChat!.example);
  expect([r.name, r.params.chat, r.query.text]).toEqual(["sideChat", EX.chat, SIDE.link]);
});

const transcript = (b: Booted, session: string) => join(b.seed.claudeConfig, "projects", projectDirName(b.seed.folders.kitespan), `${session}.jsonl`);
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()) : []);

test.skipIf(!PROCFS)(
  `${SIDE_SCENE.side.name}: ${SIDE_SCENE.side.about}; ask, follow up, a sleeping chat, Stop, and the thread kept over a restart ${LINUX_ONLY}`,
  async () => {
    h = await boot({ scene: "side", port: PORT, dist: DIST });
    const laptop = await page(h.port, "side-laptop");
    expect(laptop.frames.find((f) => f.t === "welcome")?.capabilities).toEqual({ sideQuestions: true, trustFolder: true });
    await laptop.attach(EX.chat);
    const kept = (await laptop.request({ t: "get", rid: rid(), chat: EX.chat, what: "side" })).result as SideRead;
    expect(kept.rev).toBe(4);
    expect(kept.exchanges.map((x) => [x.id, x.question, x.state, x.answer])).toEqual(SIDE_KEPT.map((x) => [x.id, x.question, "answered", x.answer]));
    const mainLines = lines(transcript(h, IDS.sessions.upload));
    expect(mainLines.length).toBeGreaterThan(0);

    // Ask from the phone; the laptop gets the same events.
    const phone = await page(h.port, "side-phone");
    await phone.attach(EX.chat);
    const from = { laptop: laptop.frames.length, phone: phone.frames.length };
    const id = rid();
    const ack = await phone.request({ t: "side_question", rid: rid(), chat: EX.chat, id, text: SIDE.ask });
    expect(ack.ok).toBe(true);
    const x = ack.result.answered as SideExchange;
    expect(x).toMatchObject({ id, question: SIDE.ask, state: "answered", answer: SIDE_ANSWERS.ask });
    for (const [p, at] of [
      [laptop, from.laptop],
      [phone, from.phone],
    ] as const)
      expect(p.side(EX.chat, at).map((e) => `${e.k} ${e.rev} ${e.x?.state ?? ""}`.trim())).toEqual(["side 5 asking", "side 6 answered"]);
    // A follow-up reads the question before it in its history.
    const f = await laptop.request({ t: "side_question", rid: rid(), chat: EX.chat, id: rid(), text: SIDE.followUp });
    expect(f.result.answered.answer).toBe(SIDE_ANSWERS.followUp.replace("$LAST_QUESTION", SIDE.ask));
    const asked = h.trace().filter((l) => l.t === "control" && l.subtype === "side_question").map((l) => (l.request as { history?: unknown[] }).history?.length ?? 0);
    expect(asked).toEqual([2, 3]);

    // Stop on one that never answers: it leaves the thread, and Claude Code is told.
    const slow = rid();
    const q = laptop.request({ t: "side_question", rid: rid(), chat: EX.chat, id: slow, text: SIDE.slow }, 30_000);
    await laptop.until(() => h!.trace().some((l) => l.t === "side_question" && l.question === SIDE.slow), "the slow question");
    expect((await phone.request({ t: "side_stop", rid: rid(), chat: EX.chat, id: slow })).result).toEqual({ stopped: true });
    expect((await q).result).toEqual({ stopped: true });
    await laptop.until(() => h!.trace().some((l) => l.t === "side_cancelled"), "the cancel in Claude Code");
    expect(laptop.side(EX.chat).at(-1)).toMatchObject({ k: "side_gone", id: slow });

    // /btw typed as a message is refused, and reaches no Claude Code.
    const btw = rid();
    expect((await laptop.request({ t: "send", rid: btw, chat: EX.chat, uuid: btw, text: "/btw what is the cap?", draftRev: null, uploads: [] })).error?.code).toBe("bad_request");
    expect(h.trace().some((l) => l.t === "user" && JSON.stringify(l.content).includes("/btw"))).toBe(false);

    // A sleeping chat: its Claude Code starts with no message, answers, and stays idle.
    const users = h.trace().filter((l) => l.t === "user").length;
    const starts = h.trace().filter((l) => l.t === "start").length;
    const layerLines = lines(transcript(h, IDS.sessions.layers));
    await phone.attach(IDS.chats.layers);
    const s = await phone.request({ t: "side_question", rid: rid(), chat: IDS.chats.layers, id: rid(), text: SIDE.link });
    expect(s.result.answered.answer).toBe(SIDE_ANSWERS.link);
    expect(h.trace().filter((l) => l.t === "start").length).toBe(starts + 1);
    expect((h.trace().filter((l) => l.t === "start").at(-1)!.args as string[]).some((a) => a === `--resume=${IDS.sessions.layers}` || a === IDS.sessions.layers)).toBe(true);
    expect(h.trace().filter((l) => l.t === "user").length).toBe(users);
    const rows = laptop.frames.filter((fr) => fr.t === "chats" && fr.delta?.chat === IDS.chats.layers).map((fr) => fr.delta.state).filter(Boolean);
    expect(rows).not.toContain("running");
    // An archived chat's thread is read with no start.
    expect((await laptop.request({ t: "get", rid: rid(), chat: IDS.chats.dates, what: "side" })).result).toEqual({ rev: 0, exchanges: [] });
    expect(h.trace().filter((l) => l.t === "start").length).toBe(starts + 1);

    // Nothing of the side questions is in either transcript.
    expect(lines(transcript(h, IDS.sessions.upload))).toEqual(mainLines);
    expect(lines(transcript(h, IDS.sessions.layers))).toEqual(layerLines);
    for (const text of [SIDE.ask, SIDE.followUp, SIDE.slow, SIDE.link]) {
      expect(readFileSync(transcript(h, IDS.sessions.upload), "utf8")).not.toContain(text);
      expect(readFileSync(transcript(h, IDS.sessions.layers), "utf8")).not.toContain(text);
    }
    // kitespan's own file holds it.
    const file = JSON.parse(readFileSync(join(h.seed.state, "side", `${EX.chat}.json`), "utf8")) as { rev: number; exchanges: SideExchange[] };
    expect(file.exchanges.map((e) => e.question)).toEqual([...SIDE_KEPT.map((k) => k.question), SIDE.ask, SIDE.followUp]);
    laptop.close();
    phone.close();

    // A restart: the thread is the same on the next server, its rev goes on.
    const r = await h.restart();
    expect(r.code).toBe(0);
    const next = await page(h.port, "side-after");
    const after = (await next.request({ t: "get", rid: rid(), chat: EX.chat, what: "side" })).result as SideRead;
    expect(after.exchanges.map((e) => e.question)).toEqual(file.exchanges.map((e) => e.question));
    expect(after.rev).toBe(file.rev);
    next.close();
  },
  120_000,
);
