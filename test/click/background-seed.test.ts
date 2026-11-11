// R131's click-through seed on the real server, with no browser: the background scene boots bin/kitespan with the fake
// claude, and the example chat's last turn holds a Bash row whose `claude --bg -n investigate-negative-qty` printed
// Claude Code's launch line (seed/demo.ts BG_TURN). A stand-in process's record says the session works; its transcript
// is under its folder's own slug; the fake's agents list holds it beside another folder's session. Over two pages'
// sockets: the row carries its launch and the line's state comes (Working); the view reads the worker's transcript
// with its stamp and its bypass mode, answers same until a new record is added, and then the new page; the record set
// to waiting gives Needs input and the row's field; Stop's one request runs one `claude stop <id>` in the fake (its
// exact argv) and answers stopped on both pages; the log holds the id and the answer, and the list runs' counts, and
// never the other folder's session. scripts/ui-check.ts's background-session flow opens the same scene in a browser. A
// stub page stands in for the built one; the port is KITESPAN_TEST_PORT or a free test port.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { ROUTE_BY_NAME, parsePath } from "../../shared/route";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { bgFolder, bgTranscript } from "./seed/background";
import { BG, workerMore } from "./seed/demo";
import { EX } from "./seed/ids";
import { BG_CALL, SCENE } from "./seed/scenes";

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
  const request = async (f: Frame, ms = 15_000): Promise<Frame> => {
    const r = f.rid as string;
    send(f);
    await until(() => frames.some((x) => x.t === "ack" && x.rid === r), `the ack of ${f.t}`, ms);
    return frames.find((x) => x.t === "ack" && x.rid === r)!;
  };
  const attach = async (chat: string) => {
    const from = frames.length;
    send({ t: "attach", chat, since: 0, epoch: null });
    await until(() => frames.slice(from).some((f) => f.t === "snapshot" && f.chat === chat), `the snapshot of ${chat}`);
    const at = frames.slice(from);
    return { attached: at.find((f) => f.t === "attached")!, history: at.find((f) => f.t === "snapshot")!.history as Frame[] };
  };
  /** The newest worker the page got for `id` (undefined: none yet; null: gone). */
  const worker = (chat: string, id: string) => frames.filter((f) => f.t === "ev" && f.chat === chat && f.e?.k === "background" && f.e.id === id).at(-1)?.e.worker as Frame | null | undefined;
  /** The chat row's background field as the deltas left it. */
  const row = (chat: string) => {
    let v: unknown = null;
    for (const f of frames) {
      if (f.t !== "chats") continue;
      if ("list" in f) v = (f.list as Frame[]).find((r) => r.chat === chat)?.background ?? null;
      else if (f.delta.chat === chat && "background" in f.delta) v = f.delta.background;
    }
    return v;
  };
  send({ t: "hello", v: PROTOCOL_VERSION, tab });
  await until(() => frames.some((f) => f.t === "chats" && "list" in f), "the chat list");
  return { frames, until, send, request, attach, worker, row, close: () => ws.close() };
}

const view = async (q = "") => (await fetch(`${h!.base}/api/chats/${EX.chat}/background/${EX.bg}${q}`)).json() as Promise<Frame>;

test("the view's and the Stop confirm's route examples name the example chat and the scene's short id (its press is the action check)", () => {
  for (const name of ["background", "backgroundStop"]) {
    const r = parsePath(ROUTE_BY_NAME[name]!.example);
    expect([r.name, r.params.chat, r.params.id]).toEqual([name, EX.chat, BG.id]);
  }
});

test.skipIf(!PROCFS)(
  `${SCENE.background.name}: ${SCENE.background.about}; the line, the view, Needs input, Stop on two pages, and the log ${LINUX_ONLY}`,
  async () => {
    h = await boot({ scene: "background", port: PORT, dist: DIST });
    if (!h.background) throw new Error("no /proc here: the stand-in's record cannot be written");
    const laptop = await page(h.port, "bg-laptop");
    const seen = await laptop.attach(EX.chat);
    expect(seen.history.filter((e) => e.k === "tool_result" && e.background).map((e) => [e.id, e.background])).toEqual([[BG_CALL, [{ id: BG.id, name: BG.name, idle: false }]]]);
    await laptop.until(() => laptop.worker(EX.chat, BG.id)?.state === "working", "Working");
    const working = laptop.worker(EX.chat, BG.id)!;
    expect(working).toMatchObject({ state: "working", name: BG.name, folder: bgFolder(h.seed), view: true });
    expect(typeof working.startedAt).toBe("number");

    // The view: the worker's own transcript, its stamp and its mode; the same stamp answers same.
    const first = await view();
    expect(first.mode).toBe("bypassPermissions");
    expect(first.history.some((e: Frame) => e.k === "user" && e.text === BG.prompt)).toBe(true);
    expect(first.history.some((e: Frame) => e.k === "tool_call" && e.name === "Bash" && e.id === "toolu_31RunTest")).toBe(true);
    expect(await view(`?since=${encodeURIComponent(first.stamp)}`)).toEqual({ same: true });
    h.background.say("The fix belongs in check(): reject qty < 1.");
    const next = await view(`?since=${encodeURIComponent(first.stamp)}`);
    expect(next.stamp).not.toBe(first.stamp);
    expect(next.history.some((e: Frame) => e.k === "block" && e.text === "The fix belongs in check(): reject qty < 1.")).toBe(true);
    // A record that Claude Code is still writing: the SDK's reader skips the half line, and shows it once it is whole.
    const half = workerMore(bgFolder(h.seed), Date.now(), "Writing the test for qty < 1 now.", null)[0]!;
    appendFileSync(bgTranscript(h.seed), half.slice(0, 80));
    const partial = await view(`?since=${encodeURIComponent(next.stamp)}`);
    expect(partial.history.some((e: Frame) => e.k === "block" && e.text === "Writing the test for qty < 1 now.")).toBe(false);
    expect(partial.history.some((e: Frame) => e.k === "block" && e.text === "The fix belongs in check(): reject qty < 1.")).toBe(true);
    appendFileSync(bgTranscript(h.seed), `${half.slice(80)}\n`);
    const whole = await view(`?since=${encodeURIComponent(partial.stamp)}`);
    expect(whole.history.some((e: Frame) => e.k === "block" && e.text === "Writing the test for qty < 1 now.")).toBe(true);

    // Waiting: Needs input with its reason, and the row's own field, on every page.
    const phone = await page(h.port, "bg-phone");
    await phone.attach(EX.chat);
    h.background.record({ status: "waiting", waitingFor: "permission prompt" });
    for (const p of [laptop, phone]) await p.until(() => p.worker(EX.chat, BG.id)?.state === "needs_input", "Needs input");
    expect(laptop.worker(EX.chat, BG.id)).toMatchObject({ state: "needs_input", waitingFor: "permission prompt" });
    await laptop.until(() => laptop.row(EX.chat) === "needs_input", "the row's field");
    expect(laptop.frames.find((f) => f.t === "chats" && "list" in f)!.list.find((r: Frame) => r.chat === EX.chat).needsYou).toBe(false);

    // Stop: one request, one `claude stop <id>` in the fake with its exact argv, stopped on both pages.
    h.background.record({ status: "busy" });
    await laptop.until(() => laptop.worker(EX.chat, BG.id)?.state === "working", "Working again");
    const stops = () => h!.trace().filter((l) => l.t === "stop");
    const ack = await phone.request({ t: "background_stop", rid: rid(), chat: EX.chat, id: BG.id });
    expect(ack).toMatchObject({ ok: true, result: { background: "stopped" } });
    expect(stops().map((l) => l.args)).toEqual([["stop", BG.id]]);
    for (const p of [laptop, phone]) await p.until(() => p.worker(EX.chat, BG.id)?.state === "stopped", "Stopped");
    // The record of that very process changes nothing; its end, then the list's stopped, keep it so.
    await Bun.sleep(2_500);
    expect(laptop.worker(EX.chat, BG.id)?.state).toBe("stopped");
    const standIn = h.background.pid;
    h.background.stop();
    await laptop.until(() => {
      try {
        process.kill(standIn, 0);
        return false;
      } catch {
        return true;
      }
    }, "the stand-in's end");
    const stale = await laptop.request({ t: "background_stop", rid: rid(), chat: EX.chat, id: BG.other.id });
    expect(stale.error?.code).toBe("stale");
    expect(stops().length).toBe(1);

    // A page that comes later gets the state in `attached`.
    const later = await page(h.port, "bg-later");
    const att = (await later.attach(EX.chat)).attached;
    expect(att.background?.[BG.id]).toMatchObject({ state: "stopped", name: BG.name });

    // The log: the stop's id and answer; the list runs' counts; never the other folder's session, a name or a path.
    const logs = join(h.seed.state, "logs");
    const lines = readdirSync(logs)
      .flatMap((n) => readFileSync(join(logs, n), "utf8").split("\n"))
      .filter((l) => l.includes('"ev":"bg_'))
      .map((l) => JSON.parse(l) as Frame);
    expect(lines.filter((l) => l.ev === "bg_stop").map((l) => [l.id, l.answer])).toEqual([[BG.id, "stopped"]]);
    const lists = lines.filter((l) => l.ev === "bg_list");
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) expect(l.count).toBe(1);
    const all = [...laptop.frames, ...phone.frames, ...later.frames].map((f) => JSON.stringify(f)).join("\n") + JSON.stringify(lines);
    for (const word of [BG.other.id, BG.other.name, BG.other.session, "website-fix"]) expect(all).not.toContain(word);
    laptop.close();
    phone.close();
    later.close();
    const r = await h.stop();
    h = null;
    expect(r.code).toBe(0);
    expect(r.leftovers).toEqual([]);
  },
  120_000,
);
