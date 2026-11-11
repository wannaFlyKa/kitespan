// R127's click-through seed on the real server, with no browser: the trust scene boots bin/kitespan with the fake claude,
// and the example chat's last turn holds two refused `claude --bg` rows (seed/demo.ts TRUST_FOLDERS). Over two pages'
// sockets: the rows carry their folders (and the repository root of the one inside the project's repository); Trust this
// folder's one request starts the fake claude in that folder with the attestation and no message, and answers trusted;
// both pages get the folder's states; a second press answers already with no second start; a page that attaches later
// gets the state in `attached`; the server's log holds one line with the path and the answer. scripts/ui-check.ts's
// trust-folder flow opens the same scene in a browser. A stub page stands in for the built one; the port is
// KITESPAN_TEST_PORT or a free test port.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../shared/protocol";
import { ROUTE_BY_NAME, parsePath } from "../../shared/route";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { TRUST_FOLDERS, TRUST_IN_REPO_CALL } from "./seed/demo";
import { EX } from "./seed/ids";
import { SCENE } from "./seed/scenes";

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
  /** Attach: `attached` and the snapshot's history. */
  const attach = async (chat: string) => {
    const from = frames.length;
    send({ t: "attach", chat, since: 0, epoch: null });
    await until(() => frames.slice(from).some((f) => f.t === "snapshot" && f.chat === chat), `the snapshot of ${chat}`);
    const at = frames.slice(from);
    return { attached: at.find((f) => f.t === "attached")!, history: at.find((f) => f.t === "snapshot")!.history as Frame[] };
  };
  const trustEvents = (chat: string, from = 0) => frames.slice(from).filter((f) => f.t === "ev" && f.chat === chat && f.e?.k === "trust").map((f) => `${f.e.path} ${f.e.state}`);
  send({ t: "hello", v: PROTOCOL_VERSION, tab });
  await until(() => frames.some((f) => f.t === "chats" && "list" in f), "the chat list");
  return { frames, until, send, request, attach, trustEvents, close: () => ws.close() };
}

test("the confirm's route example names the example chat and the refused row's tool id (its press is the action check)", () => {
  const r = parsePath(ROUTE_BY_NAME.trust!.example);
  expect([r.name, r.params.chat, r.params.toolUse]).toEqual(["trust", EX.chat, EX.toolUse]);
});

test.skipIf(!PROCFS)(
  `${SCENE.trust.name}: ${SCENE.trust.about}; Trust this folder on two pages, already, and the log line ${LINUX_ONLY}`,
  async () => {
    h = await boot({ scene: "trust", port: PORT, dist: DIST });
    const nested = join(h.seed.folders.kitespan, TRUST_FOLDERS.nested);
    const inRepo = join(h.seed.folders.kitespan, TRUST_FOLDERS.inRepo);
    const laptop = await page(h.port, "trust-laptop");
    expect(laptop.frames.find((f) => f.t === "welcome")?.capabilities).toEqual({ sideQuestions: true, trustFolder: true });
    const seen = await laptop.attach(EX.chat);
    const refused = seen.history.filter((e) => e.k === "tool_result" && e.trust).map((e) => [e.id, e.trust]);
    expect(refused).toEqual([
      [EX.toolUse, { path: nested, root: null }],
      [TRUST_IN_REPO_CALL, { path: inRepo, root: h.seed.folders.kitespan }],
    ]);
    expect(seen.attached.trust).toBeUndefined();

    const phone = await page(h.port, "trust-phone");
    await phone.attach(EX.chat);
    const starts = () => h!.trace().filter((l) => l.t === "start");
    const before = starts().length;
    const from = { laptop: laptop.frames.length, phone: phone.frames.length };
    const ack = await phone.request({ t: "trust_folder", rid: rid(), chat: EX.chat, toolUse: EX.toolUse, path: nested });
    expect(ack).toMatchObject({ ok: true, result: { trust: "trusted" } });
    for (const [p, at] of [
      [laptop, from.laptop],
      [phone, from.phone],
    ] as const) {
      await p.until(() => p.trustEvents(EX.chat, at).length >= 2, "the trust events");
      expect(p.trustEvents(EX.chat, at)).toEqual([`${nested} trusting`, `${nested} trusted`]);
    }
    // One start, in the folder, with the attestation for it in initialize, and no message (so no turn).
    const mine = starts().slice(before);
    expect(mine.length).toBe(1);
    expect(mine[0]!.cwd).toBe(nested);
    const inits = h.trace().filter((l) => l.t === "control" && l.subtype === "initialize" && (l.request as Frame).workspaceTrust);
    expect(inits.map((l) => (l.request as Frame).workspaceTrust)).toEqual([{ accepted: true, directory: nested }]);
    expect(h.trace().filter((l) => l.t === "trust_recorded").map((l) => l.directory)).toEqual([nested]);
    expect(h.trace().filter((l) => l.t === "user" || l.t === "turn_start")).toEqual([]);

    // The second press of this boot: already, with no second start.
    const again = await laptop.request({ t: "trust_folder", rid: rid(), chat: EX.chat, toolUse: EX.toolUse, path: nested });
    expect(again).toMatchObject({ ok: true, result: { trust: "already" } });
    expect(starts().length).toBe(before + 1);
    // A path that is not the row's (here the home folder) is stale, and starts nothing.
    expect((await laptop.request({ t: "trust_folder", rid: rid(), chat: EX.chat, toolUse: EX.toolUse, path: h.seed.home })).error?.code).toBe("stale");

    // The folder inside the project's repository: trusted too (the fake records it as the session's own folder).
    expect(await laptop.request({ t: "trust_folder", rid: rid(), chat: EX.chat, toolUse: TRUST_IN_REPO_CALL, path: inRepo })).toMatchObject({ ok: true, result: { trust: "trusted" } });

    // A page that comes later gets the states in `attached`.
    const later = await page(h.port, "trust-later");
    expect((await later.attach(EX.chat)).attached.trust).toEqual({ [nested]: "already", [inRepo]: "trusted" });

    // The log: one line per answer, with the path and the answer only.
    const logs = join(h.seed.state, "logs");
    const lines = readdirSync(logs)
      .flatMap((n) => readFileSync(join(logs, n), "utf8").split("\n"))
      .filter((l) => l.includes('"ev":"trust"'))
      .map((l) => JSON.parse(l) as Frame);
    expect(lines.map((l) => [l.path, l.answer, l.chat])).toEqual([
      [nested, "trusted", null],
      [nested, "already", null],
      [inRepo, "trusted", null],
    ]);
    laptop.close();
    phone.close();
    later.close();
    const r = await h.stop();
    h = null;
    expect(r.code).toBe(0);
    expect(r.leftovers).toEqual([]);
  },
  90_000,
);
