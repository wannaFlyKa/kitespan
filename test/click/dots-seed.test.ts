// Row 116's click-through seed on the real server, with no browser: the dots scene boots bin/kitespan with the fake
// claude, and its chat list holds all four dots at once (the example chat's card waits, a second chat runs a Bash
// call, one chat has a finished turn that no page has seen, one a failed one). A page that opens the unread chat and
// says it is on screen clears its dot for the other page. Through the real driver and the fake claude, a turn that
// ends in an error result and a Claude Code that exits by itself, with no page on screen, each set Failed, which a
// page on screen clears. The flags are kept over a restart (SIGTERM, then a new start on the same seed), where the
// shutdown's cut turn and cut card count as failed. scripts/ui-check.ts's
// unseen-dot flow opens the same scene in a browser. A stub page stands in for the built one; the port is
// KITESPAN_TEST_PORT or a free test port.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, applyChatsFrame, type ChatRow, type ChatsFrame } from "../../shared/protocol";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { FAILS } from "./seed/fixture";
import { EX, IDS } from "./seed/ids";
import { DOT_SCENE } from "./seed/scenes";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
let h: Booted | null = null;
afterAll(async () => {
  if (h) await h.stop().catch(() => {});
  rmSync(DIST, { recursive: true, force: true });
});

type Frame = Record<string, any>;

/** One page's socket: its frames, and its chat list as every `chats` frame so far makes it. */
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
  const rows = (): Map<string, ChatRow> => new Map(frames.filter((f) => f.t === "chats").reduce<ChatRow[]>((list, f) => applyChatsFrame(list, f as ChatsFrame), []).map((r) => [r.chat, r]));
  const until = async (ok: () => boolean, what: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; rows: ${JSON.stringify([...rows().values()].map((r) => [r.title, r.state, r.unseen ?? null]))}`);
      await Bun.sleep(20);
    }
  };
  const send = (f: Frame) => ws.send(JSON.stringify(f));
  send({ t: "hello", v: PROTOCOL_VERSION, tab });
  await until(() => frames.some((f) => f.t === "chats" && "list" in f), "the chat list");
  return { frames, rows, until, send, close: () => ws.close() };
}

const dot = (r: ChatRow | undefined) => (!r ? "gone" : r.state === "waiting" ? "needs you" : r.state === "running" ? "working" : r.unseen === "failed" ? "failed" : r.unseen === "done" ? "unread" : "none");

test.skipIf(!PROCFS)(
  `${DOT_SCENE.dots.name}: ${DOT_SCENE.dots.about}; a page's on clears a dot on every page, and the flags are kept over a restart ${LINUX_ONLY}`,
  async () => {
    h = await boot({ scene: "dots", port: PORT, dist: DIST });
    const laptop = await page(h.port, "dots-laptop");
    const four = () => {
      const rows = laptop.rows();
      return {
        [EX.chat]: dot(rows.get(EX.chat)),
        [IDS.chats.docs]: dot(rows.get(IDS.chats.docs)),
        [IDS.chats.layers]: dot(rows.get(IDS.chats.layers)),
        [IDS.chats.parser]: dot(rows.get(IDS.chats.parser)),
      };
    };
    expect(four()).toEqual({ [EX.chat]: "needs you", [IDS.chats.docs]: "working", [IDS.chats.layers]: "unread", [IDS.chats.parser]: "failed" });
    // The warm-up's own chats are seen (the harness had them on screen), and no other chat has a dot.
    for (const r of laptop.rows().values()) if (r.chat !== IDS.chats.layers && r.chat !== IDS.chats.parser) expect([r.title, r.unseen ?? null]).toEqual([r.title, null]);

    // The phone opens Pick the test layers: once it is drawn at its end, the page says so, and the laptop's dot goes.
    const phone = await page(h.port, "dots-phone");
    phone.send({ t: "attach", chat: IDS.chats.layers, since: 0, epoch: null });
    await phone.until(() => phone.frames.some((f) => f.t === "snapshot" && f.chat === IDS.chats.layers), "the snapshot");
    // Attached, but not yet on screen: the dot stays.
    await Bun.sleep(200);
    expect(laptop.rows().get(IDS.chats.layers)?.unseen).toBe("done");
    phone.send({ t: "on_screen", chat: IDS.chats.layers, on: true });
    await laptop.until(() => laptop.rows().get(IDS.chats.layers)?.unseen == null, "the unread dot to go on the laptop");
    // No ack: on_screen is a state report, not a request.
    expect(phone.frames.filter((f) => f.t === "ack")).toEqual([]);
    expect(four()[IDS.chats.parser]).toBe("failed");

    // The two ends that fail with no Stop, on Plan the search index: a sender attaches it and never says on (no page
    // has it on screen), so each end sets Failed on the laptop; the phone that has it on screen clears it, then leaves.
    const chat = IDS.chats.search;
    const sender = await page(h.port, "dots-sender");
    sender.send({ t: "attach", chat, since: 0, epoch: null });
    await sender.until(() => sender.frames.some((f) => f.t === "attached" && f.chat === chat), "the sender's attach");
    for (const [text, end] of [
      [FAILS.turn, "turn_end"],
      [FAILS.exit, "exit"],
    ] as const) {
      const from = sender.frames.length;
      const uuid = crypto.randomUUID();
      sender.send({ t: "send", rid: uuid, chat, uuid, text, draftRev: null, uploads: [] });
      await sender.until(() => sender.frames.slice(from).some((f) => f.t === "ev" && f.chat === chat && f.e?.k === end), `the ${end} of "${text}"`);
      const e = sender.frames.slice(from).find((f) => f.t === "ev" && f.chat === chat && f.e?.k === end)!.e;
      if (end === "turn_end") expect([e.ok, e.subtype, e.error]).toEqual([false, "error_during_execution", "The index files could not be read."]);
      else expect(e.code).toBe(1);
      await laptop.until(() => dot(laptop.rows().get(chat)) === "failed", `the failed dot after "${text}"`);
      expect(sender.frames.filter((f) => f.t === "ack" && f.rid === uuid).map((f) => f.ok)).toEqual([true]);
      const seen = phone.frames.length;
      phone.send({ t: "attach", chat, since: 0, epoch: null });
      await phone.until(() => phone.frames.slice(seen).some((f) => f.t === "attached" && f.chat === chat), "the phone's attach");
      phone.send({ t: "on_screen", chat, on: true });
      await laptop.until(() => dot(laptop.rows().get(chat)) === "none", `the failed dot to go after "${text}"`);
      phone.send({ t: "on_screen", chat, on: false });
      phone.send({ t: "detach", chat });
    }
    sender.close();
    phone.close();
    laptop.close();

    // A restart: the flags are in the ledgers. The shutdown cut the running turn and the waiting card, so after the new
    // boot those two chats show failed (their stop lines say what happened); the seen chat stays seen.
    const r = await h.restart();
    expect(r.code).toBe(0);
    const next = await page(h.port, "dots-after");
    await next.until(() => dot(next.rows().get(IDS.chats.docs)) === "failed" && dot(next.rows().get(EX.chat)) === "failed", "the cut chats to show failed");
    const rows = next.rows();
    expect([dot(rows.get(IDS.chats.layers)), dot(rows.get(IDS.chats.parser)), dot(rows.get(IDS.chats.search))]).toEqual(["none", "failed", "none"]);
    next.close();
  },
  120_000,
);
