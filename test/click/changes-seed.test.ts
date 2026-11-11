// U1's click-through seed on the real server, with no browser: the changes scene boots bin/kitespan with the fake
// claude (seed/changes.ts). The route examples' summary is the example chat's first turn (three files, from two real
// marks of the kitespan repository) and its file's diff reads; the warm-up's two-file turn left its card in the tidy
// chat's history (the user's own line between the tools counted apart, never in the card); a turn that edits, adds,
// renames and deletes files and writes a binary, a large and a long file gets its card live (five of its seven files)
// and each file's diff in its own form; a chat in a folder that is not a repository gets Claude's own edits, with the
// reason; and nothing of a diff is in the log. scripts/ui-check.ts's changes-card flow opens the same scene in a
// browser. A stub page stands in for the built one; the port is KITESPAN_TEST_PORT or a free test port.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeFileApiPath, changesApiPath } from "../../shared/changes";
import { PROTOCOL_VERSION, type ChatEvent } from "../../shared/protocol";
import { ROUTE_BY_NAME, parsePath } from "../../shared/route";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, pickTestPort, type Booted } from "./harness";
import { CHANGES, CHANGES_FILES } from "./seed/changes";
import { EX } from "./seed/ids";
import { CHANGES_SCENE } from "./seed/scenes";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
let h: Booted | null = null;
beforeAll(async () => {
  if (PROCFS) h = await boot({ scene: "changes", port: PORT, dist: DIST });
}, 120_000);
afterAll(async () => {
  if (h) await h.stop().catch(() => {});
  rmSync(DIST, { recursive: true, force: true });
});

type Frame = Record<string, any>;
type Card = Extract<ChatEvent, { k: "changes" }>;
const rid = () => crypto.randomUUID();

async function read(path: string): Promise<{ status: number; body: any }> {
  const b = h!;
  const res = await fetch(`${b.base}${path}`, { headers: { origin: b.base } });
  return { status: res.status, body: await res.json() };
}

async function page(tab: string) {
  const b = h!;
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`, { headers: { origin: b.base } });
  const frames: Frame[] = [];
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  const until = async (ok: () => boolean, what: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(20);
    }
  };
  ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, tab }));
  await until(() => frames.some((f) => f.t === "chats" && "list" in f), "the chat list");
  const attach = async (chat: string): Promise<Frame> => {
    ws.send(JSON.stringify({ t: "attach", chat, since: 0, epoch: null }));
    await until(() => frames.some((f) => f.t === "snapshot" && f.chat === chat), `the snapshot of ${chat}`);
    return frames.find((f) => f.t === "snapshot" && f.chat === chat)!;
  };
  const send = async (chat: string, text: string): Promise<void> => {
    const uuid = rid();
    ws.send(JSON.stringify({ t: "send", rid: uuid, chat, uuid, text, draftRev: null, uploads: [] }));
    await until(() => frames.some((f) => f.t === "ack" && f.rid === uuid), `the ack of "${text}"`);
  };
  const card = async (chat: string, from: number): Promise<Card> => {
    await until(() => frames.slice(from).some((f) => f.t === "ev" && f.chat === chat && f.e?.k === "changes"), `the changes card of ${chat}`);
    return frames.slice(from).find((f) => f.t === "ev" && f.chat === chat && f.e?.k === "changes")!.e as Card;
  };
  return { frames, attach, send, card, close: () => ws.close() };
}

test("the route examples name the example chat and the seed's summary", () => {
  const r = parsePath(ROUTE_BY_NAME.changesFile!.example);
  expect([r.params.chat, r.params.turn, r.params.path]).toEqual([EX.chat, CHANGES.example, CHANGES.exampleFile]);
});

describe.skipIf(!PROCFS)(`${CHANGES_SCENE.changes.name}: ${CHANGES_SCENE.changes.about} ${LINUX_ONLY}`, () => {
  test("the example chat's first turn: its summary and its file's diff, from the real marks", async () => {
    const s = await read(changesApiPath(EX.chat, CHANGES.example));
    expect(s.status).toBe(200);
    expect(s.body.files.map((f: { path: string }) => f.path)).toEqual([...CHANGES_FILES.example]);
    expect(s.body.files.find((f: { path: string }) => f.path === "docs/UPLOAD-RETRIES.md").status).toBe("A");
    const d = await read(changeFileApiPath(EX.chat, CHANGES.example, CHANGES.exampleFile));
    expect(d.status).toBe(200);
    expect(d.body.hunks.length).toBeGreaterThan(0);
    expect(d.body.hunks.flatMap((x: { lines: string[] }) => x.lines).some((l: string) => l.startsWith("+") && l.includes("arrayBuffer"))).toBe(true);
    // The example chat's history holds the card, after its first turn.
    const p = await page("seedTabC1");
    const snap = await p.attach(EX.chat);
    const cards = (snap.history as ChatEvent[]).filter((e) => e.k === "changes") as Card[];
    expect(cards.map((c) => c.id)).toEqual([CHANGES.example]);
    p.close();
  });

  test("the warm-up's turn: two files in the card; the user's own line counted apart", async () => {
    const p = await page("seedTabC2");
    const snap = await p.attach(CHANGES.chats.tidy);
    const card = (snap.history as ChatEvent[]).find((e) => e.k === "changes") as Card | undefined;
    const tail = p.frames.filter((f) => f.t === "ev" && f.chat === CHANGES.chats.tidy && f.e?.k === "changes").map((f) => f.e as Card);
    const got = card ?? tail[0] ?? (await p.card(CHANGES.chats.tidy, 0));
    expect(got).toMatchObject({ how: "git", total: 2 });
    expect(got.files.map((f) => f.path)).toEqual([...CHANGES_FILES.two]);
    expect((await read(changesApiPath(CHANGES.chats.tidy, got.id))).body.others).toBe(1);
    p.close();
  });

  test("a turn that edits, adds, renames and deletes files, and writes a binary, a large and a long one", async () => {
    const p = await page("seedTabC3");
    await p.attach(CHANGES.chats.tidy);
    const from = p.frames.length;
    await p.send(CHANGES.chats.tidy, CHANGES.texts.every);
    const card = await p.card(CHANGES.chats.tidy, from);
    expect([card.how, card.total]).toEqual(["git", 7]);
    expect(card.files.map((f) => f.path)).toEqual(CHANGES_FILES.every.slice(0, 5));
    const all = (await read(changesApiPath(CHANGES.chats.tidy, card.id))).body;
    const by = (path: string) => all.files.find((f: { path: string }) => f.path === path);
    expect(all.files.map((f: { path: string }) => f.path)).toEqual([...CHANGES_FILES.every]);
    expect(by("src/cli/send.ts")).toMatchObject({ status: "R", from: "src/cli/push.ts" });
    expect(by("docs/UPLOAD-RETRIES.md")).toMatchObject({ status: "D" });
    expect(by("assets/upload-icon.bin")).toMatchObject({ status: "A", binary: true });
    expect(by("logs/trace.log")).toMatchObject({ status: "A", large: true });
    const file = (path: string) => read(changeFileApiPath(CHANGES.chats.tidy, card.id, path));
    expect((await file("src/generated/codes.ts")).body.cut).toEqual({ shown: 3000, more: 500 });
    expect((await file("logs/trace.log")).body.large).toEqual({ bytes: 9 * 1024 * 1024 });
    expect((await file("assets/upload-icon.bin")).body).toMatchObject({ binary: true, hunks: [] });
    expect((await file("src/sync.ts")).body.hunks[0].lines.some((l: string) => l.startsWith("+export const syncAll"))).toBe(true);
    expect((await file("README.md")).status).toBe(404);
    p.close();
  }, 60_000);

  test("a folder that is not a repository: Claude's own edits, with the reason", async () => {
    const p = await page("seedTabC4");
    await p.attach(CHANGES.chats.release);
    const from = p.frames.length;
    await p.send(CHANGES.chats.release, CHANGES.texts.edits);
    const card = await p.card(CHANGES.chats.release, from);
    expect(card).toMatchObject({ how: "edits", total: 2, added: 5, removed: 0 });
    expect(card.files.map((f) => f.path)).toEqual([...CHANGES_FILES.edits]);
    const all = (await read(changesApiPath(CHANGES.chats.release, card.id))).body;
    expect(all.why).toBe("not_git");
    const d = (await read(changeFileApiPath(CHANGES.chats.release, card.id, "docs/RELEASE.md"))).body;
    expect(d).toMatchObject({ edits: true, hunks: [{ oldStart: 3, newStart: 3, lines: [" 1. bun install --frozen-lockfile", " 2. bun test", " 3. bun run build", "+4. bun run ui-check"] }] });
    p.close();
  }, 60_000);

  test("the log holds the changes lines' counts, never a path or a line", () => {
    const logs = join(h!.seed.state, "logs");
    const text = readdirSync(logs)
      .filter((n) => n.startsWith("kitespan-"))
      .map((n) => readFileSync(join(logs, n), "utf8"))
      .join("");
    const lines = text.split("\n").filter((l) => l.includes('"ev":"changes"'));
    expect(lines.length).toBeGreaterThan(0);
    for (const word of ["upload.ts", "trace.log", "RELEASE", "syncAll", h!.seed.folders.kitespan]) expect(text.includes(word)).toBe(false);
  });
});
