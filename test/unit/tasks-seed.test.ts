// The click-through seed's to-do list on the real server (CV-13): the main scene's warm-up turn tracks its steps with
// Claude Code 2.1's task tools (three TaskCreate and two TaskUpdate calls, test/click/seed/fixture.ts). A page that
// attaches after the turn gets them in the snapshot's history (the fake claude wrote them to the transcript, as the
// CLI does), and the page's reducer draws one to-do row at the turn's first task call, next to the history's older
// TodoWrite row. Port 7942 when it is free, else another free test port (pickTestPort); a stub page stands in for the
// built one. The harness stops its server only after a /proc/<pid>/cmdline check, so the test runs where /proc can be
// read (test/linux.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "../../shared/protocol";
import { applyHistory, type ChatPart } from "../../web/state/reduce";
import type { Item, TodoItem } from "../../web/state/types";
import { boot, pickTestPort, type Booted } from "../click/harness";
import { WARM } from "../click/seed/fixture";
import { EX } from "../click/seed/ids";
import { LINUX_ONLY, PROCFS } from "../linux";

const PORT = pickTestPort(7942);
const DIST = mkdtempSync(join(tmpdir(), "kitespan-tasks-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");

let h: Booted | null = null;
afterAll(async () => {
  if (h) await h.stop();
  rmSync(DIST, { recursive: true, force: true });
});

type Frame = Record<string, any>;

/** hello, attach, and the snapshot's history of the example chat. */
async function snapshotOf(port: number, chat: string): Promise<ChatEvent[]> {
  const frames: Frame[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
  ws.onmessage = (m) => {
    if (typeof m.data === "string") frames.push(JSON.parse(m.data) as Frame);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket did not open"));
  });
  const waitFor = async (pred: (f: Frame) => boolean): Promise<Frame> => {
    const end = Date.now() + 10_000;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; frames: ${frames.map((f) => f.t).join(", ")}`);
      await Bun.sleep(20);
    }
  };
  try {
    ws.send(JSON.stringify({ t: "hello", v: 1, tab: "tasks-seed-test" }));
    await waitFor((f) => f.t === "welcome");
    ws.send(JSON.stringify({ t: "attach", chat, since: 0, epoch: null }));
    const snapshot = await waitFor((f) => f.t === "snapshot" && f.chat === chat);
    return snapshot.history as ChatEvent[];
  } finally {
    ws.close();
  }
}

function blank(): ChatPart {
  return {
    items: [],
    pending: [],
    title: "",
    titleSource: "first-prompt",
    model: "default",
    effort: "default",
    mode: "default",
    picks: { model: null, effort: null, mode: null },
    sessionId: "",
    bypassFlag: false,
    lostRequests: [],
    turn: null,
    liveModel: null,
    version: null,
    commands: null,
    tasks: [],
    suggestion: null,
    outputs: [],
  };
}

describe.skipIf(!PROCFS)(`the main scene's to-do list, after a reload ${LINUX_ONLY}`, () => {
  test(
    "the snapshot draws one to-do row with the three tasks, at the turn's first task call",
    async () => {
      h = await boot({ scene: "main", port: PORT, dist: DIST, timeoutMs: 20_000 });
      const history = await snapshotOf(h.port, EX.chat);
      const items = applyHistory(blank(), history, { cwd: h.seed.folders.kitespan, now: Date.now(), ended: true }).items;
      // No task call has a tool row of its own.
      expect(items.filter((it) => it.kind === "tool" && /^Task(Create|Update|List|Get)$/.test(it.name))).toEqual([]);
      const rows = items.filter((it): it is TodoItem => it.kind === "todo");
      // The history's TodoWrite row (an older Claude Code), then the warm-up turn's task row.
      expect(rows.map((r) => (r.tasks ? "tasks" : "TodoWrite"))).toEqual(["TodoWrite", "tasks"]);
      const row = rows[1]!;
      expect(row.items).toEqual([
        { text: "Run the upload test 20 times", status: "completed", taskId: "1" },
        { text: "Clean the build folder and rebuild", status: "pending", taskId: "2" },
        { text: "Run the upload test once more", status: "pending", taskId: "3" },
      ]);
      expect(row.tasks!.calls.map((c) => c.name)).toEqual(["TaskCreate", "TaskCreate", "TaskCreate", "TaskUpdate", "TaskUpdate"]);
      // Its place: after the warm-up message and the reply's first words, before the Bash call that ran the test.
      const at = (pred: (it: Item) => boolean) => items.findIndex(pred);
      const sent = at((it) => it.kind === "user" && it.text === WARM.main);
      const bash = at((it) => it.kind === "tool" && it.id === "toolu_01Rerun20");
      expect(sent).toBeGreaterThanOrEqual(0);
      expect(items.indexOf(row)).toBeGreaterThan(sent);
      expect(items.indexOf(row)).toBeLessThan(bash);
      const r = await h.stop();
      h = null;
      expect(r.code).toBe(0);
      expect(r.leftovers).toEqual([]);
    },
    60_000,
  );
});
