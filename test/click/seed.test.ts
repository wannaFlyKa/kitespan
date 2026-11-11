// The click-through seed on the real server, with no browser: every scene boots bin/kitespan with the fake claude, and
// what each route example names is there (the chat and its history rows, the open card, the running turn, the queued
// message, the session that kitespan has not opened, the project, the file, the uploads, the draft that the server
// holds, the archived chat), and every example path gets the page. scripts/ui-check.ts then opens the same examples
// in a browser. Port 7942 when it is free, else another free test port (pickTestPort); a stub page stands in for the
// built one.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "../../shared/protocol";
import { ROUTES } from "../../shared/route";
import { LINUX_ONLY, PROCFS } from "../linux";
import { boot, checkPort, pickTestPort, type Booted } from "./harness";
import { HELD_DRAFT } from "./seed/demo";
import { QUESTIONS } from "./seed/fixture";
import { EX, IDS } from "./seed/ids";
import { SEED_DEVICE } from "./seed/push";
import { ACTIONS, SCENE, SCENES, SIDE_SCENES, sceneOfRoute, type SceneName } from "./seed/scenes";

const PORT = pickTestPort(7942);
const T = 30_000;
const DIST = mkdtempSync(join(tmpdir(), "kitespan-click-stub-"));
writeFileSync(join(DIST, "index.html"), "<!doctype html><html><body>stub page</body></html>");
afterAll(() => rmSync(DIST, { recursive: true, force: true }));

type Frame = Record<string, any>;

class Client {
  readonly frames: Frame[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      if (typeof m.data === "string") this.frames.push(JSON.parse(m.data) as Frame);
    };
  }
  static open(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
      const c = new Client(ws);
      ws.onopen = () => resolve(c);
      ws.onerror = () => reject(new Error("the socket did not open"));
    });
  }
  send(f: Frame): void {
    this.ws.send(JSON.stringify(f));
  }
  async waitFor(pred: (f: Frame) => boolean, ms = 10_000, from = 0): Promise<Frame> {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; frames: ${this.frames.slice(from).map((f) => (f.t === "ev" ? `ev:${f.e.k}` : f.t)).join(", ")}`);
      await Bun.sleep(20);
    }
  }
  async request(f: Frame): Promise<Frame> {
    const from = this.frames.length;
    this.send(f);
    return this.waitFor((x) => x.t === "ack" && x.rid === f.rid, 10_000, from);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

/** hello, then attach: the chat list, `attached`, and what the page draws (the snapshot's history, then the tail). */
async function look(h: Booted, chat: string): Promise<{ c: Client; list: Frame[]; attached: Frame; drawn: ChatEvent[] }> {
  const c = await Client.open(h.port);
  c.send({ t: "hello", v: 1, tab: "seed-test" });
  await c.waitFor((f) => f.t === "welcome");
  const list = (await c.waitFor((f) => f.t === "chats" && "list" in f)).list as Frame[];
  const from = c.frames.length;
  c.send({ t: "attach", chat, since: 0, epoch: null });
  const attached = await c.waitFor((f) => f.t === "attached" && f.chat === chat, 10_000, from);
  const snapshot = await c.waitFor((f) => f.t === "snapshot" && f.chat === chat, 10_000, from);
  await Bun.sleep(150);
  const at = c.frames.indexOf(snapshot);
  const drawn = [...(snapshot.history as ChatEvent[]), ...c.frames.slice(at + 1).filter((f) => f.t === "ev" && f.chat === chat).map((f) => f.e as ChatEvent)];
  return { c, list, attached, drawn };
}

const of = <K extends ChatEvent["k"]>(evs: ChatEvent[], k: K) => evs.filter((e): e is Extract<ChatEvent, { k: K }> => e.k === k);
const toolNamed = (evs: ChatEvent[], id: string) => of(evs, "tool_call").find((e) => e.id === id)?.name ?? null;
const rid = () => crypto.randomUUID();

const booted: Booted[] = [];
afterAll(async () => {
  for (const h of booted) await h.stop().catch(() => {});
});

async function bootScene(scene: SceneName): Promise<Booted> {
  const h = await boot({ scene, port: PORT, dist: DIST });
  booted.push(h);
  return h;
}

async function stopScene(h: Booted): Promise<void> {
  const r = await h.stop();
  expect(r.code).toBe(0);
  // The fake claude and any shell end with the server; stop() names what it had to end.
  expect(r.leftovers).toEqual([]);
}

describe("the route table and the seed agree", () => {
  test("every route has a scene, every scene is used, and the action checks cover every action route", () => {
    checkPort(PORT);
    const used = new Set<string>(ROUTES.map((r) => sceneOfRoute(r.name)));
    for (const a of ACTIONS) used.add(a.scene);
    // R130's link to one side exchange opens in the side scene (its kept thread); every other route in SCENES.
    expect([...used].sort()).toEqual([...SCENES, ...SIDE_SCENES].sort());
    for (const r of ROUTES.filter((x) => x.kind === "action")) expect(ACTIONS.some((a) => a.route === r.name)).toBe(true);
  });
});

describe.skipIf(!PROCFS)(`scene main: the example chat with its history, live and idle ${LINUX_ONLY}`, () => {
  let h: Booted;
  afterAll(async () => {
    if (h) await stopScene(h);
  });
  test(
    "boots, and every example path gets the page",
    async () => {
      h = await bootScene("main");
      for (const r of ROUTES) {
        const res = await fetch(h.base + r.example, { redirect: "manual" });
        expect({ route: r.name, status: res.status }).toEqual({ route: r.name, status: 200 });
        expect(await res.text()).toContain("stub page");
      }
    },
    T,
  );

  test(
    "the chat list, the history rows the examples name, and the live chat's pickers, / menu and connectors",
    async () => {
      const { c, list, attached, drawn } = await look(h, EX.chat);
      const rows = new Map(list.map((r) => [r.chat, r]));
      for (const id of Object.values(IDS.chats)) expect(rows.has(id)).toBe(true);
      expect(rows.get(IDS.chats.dates)!.archived).toBe(true);
      expect(rows.get(EX.chat)).toMatchObject({ archived: false, project: EX.project, title: "Fix the flaky upload test" });
      expect(attached).toMatchObject({ archived: false, cards: [], title: { text: "Fix the flaky upload test" } });
      expect(["idle", "sleeping"]).toContain(attached.state);
      // /c/<chat>/tool/<toolUse>: the Edit with its diff; /m/: the first user message; /thinking/: its reply's thinking.
      expect(toolNamed(drawn, EX.toolUse)).toBe("Edit");
      expect(of(drawn, "user").some((u) => u.uuid === EX.message && !u.queued)).toBe(true);
      expect(of(drawn, "block").some((b) => b.kind === "thinking" && b.key === `${EX.message}:0`)).toBe(true);
      expect(of(drawn, "block").some((b) => b.text.includes("| Run | Retries |") && b.text.includes("```ts"))).toBe(true);
      expect(toolNamed(drawn, "toolu_01ExploreCallers")).toBe("Agent");
      expect(toolNamed(drawn, "toolu_01ReviewWorkflow")).toBe("Workflow");
      expect(of(drawn, "bash").some((b) => b.input === "git status --short")).toBe(true);
      expect(of(drawn, "local_output").some((o) => o.text.includes("Context usage"))).toBe(true);
      // The warm-up turn ran: the chat's Claude Code is open, so the pickers and menus have rows.
      expect(of(drawn, "block").some((b) => b.text.includes("20 of 20 runs"))).toBe(true);
      const models = await c.request({ t: "get", rid: rid(), chat: EX.chat, what: "models" });
      expect(models.result.map((m: Frame) => m.value)).toContain(EX.model);
      const commands = await c.request({ t: "get", rid: rid(), chat: EX.chat, what: "commands" });
      expect(commands.result.map((m: Frame) => m.name)).toContain(EX.command);
      const connectors = await c.request({ t: "get", rid: rid(), chat: EX.chat, what: "connectors" });
      expect(connectors.result.map((m: Frame) => m.name)).toContain(EX.connector);
      expect(connectors.result.find((m: Frame) => m.name === "github")).toMatchObject({ status: "connected", hasView: true });
      const context = await c.request({ t: "get", rid: rid(), chat: EX.chat, what: "context" });
      expect(context.result).toMatchObject({ percent: 57 });
      c.close();
    },
    T,
  );

  test(
    "the project, the session that kitespan has not opened, the file, the uploads and the held draft",
    async () => {
      const projects = (await (await fetch(`${h.base}/api/projects`)).json()) as { projects: Frame[] };
      expect(projects.projects.map((p) => p.id).sort()).toEqual(Object.values(IDS.projects).sort());
      expect(projects.projects.find((p) => p.id === EX.project)!.picks).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
      const sessions = (await (await fetch(`${h.base}/api/projects/${EX.project}/sessions`)).json()) as { sessions: Frame[] };
      expect(sessions.sessions.map((s) => s.sessionId)).toEqual([EX.session]);
      const preview = (await (await fetch(`${h.base}/api/projects/${EX.project}/sessions/${EX.session}`)).json()) as Frame;
      expect(preview.chat).toBeNull();
      expect(preview.history.some((e: Frame) => e.k === "user" && String(e.text).includes("options gate"))).toBe(true);
      const file = await fetch(`${h.base}/api/chats/${EX.chat}/files/${EX.file}`, { method: "HEAD" });
      expect(file.status).toBe(200);
      const uploads = (await (await fetch(`${h.base}/api/chats/${EX.chat}/uploads`)).json()) as { uploads: Frame[] };
      expect(uploads.uploads.map((u) => u.name).sort()).toEqual(["flaky-run.log", "pasted.png"]);
      const { c, attached } = await look(h, HELD_DRAFT.chat);
      expect(attached.draft).toMatchObject({ text: HELD_DRAFT.text, rev: HELD_DRAFT.rev });
      c.close();
      // A chat with no message yet: no session, so no history (Open in terminal has nothing to type, 6.10).
      const empty = await look(h, IDS.chats.lint);
      expect(empty.drawn).toEqual([]);
      empty.c.close();
    },
    T,
  );

  test(
    "R130: the server's key and the one device that has notifications on, as the device route's example names it",
    async () => {
      const push = (await (await fetch(`${h.base}/api/push`)).json()) as { key: string | null; devices: Frame[] };
      expect(push.key).toMatch(/^B[A-Za-z0-9_-]{86}$/);
      expect(push.devices).toEqual([{ id: EX.device, name: SEED_DEVICE.name, titles: false, at: expect.any(String), failing: false }]);
      // Its endpoint is a capability: no answer holds it.
      expect(JSON.stringify(push)).not.toContain(SEED_DEVICE.endpoint);
    },
    T,
  );
});

/** The live part of each scene, as the page would see it on attach. */
const LIVE: Record<Exclude<SceneName, "main">, (a: { attached: Frame; drawn: ChatEvent[] }) => void> = {
  agent: ({ drawn }) => {
    expect(toolNamed(drawn, EX.toolUse)).toBe("Agent");
    expect(of(drawn, "task").some((t) => t.ev === "started" && t.toolUseId === EX.toolUse && t.taskId === IDS.tasks.agent)).toBe(true);
    expect(of(drawn, "turn_end")).toEqual([]);
  },
  workflow: ({ drawn }) => {
    expect(toolNamed(drawn, EX.toolUse)).toBe("Workflow");
    expect(of(drawn, "task").some((t) => t.ev === "progress" && t.toolUseId === EX.toolUse && (t.workflow?.length ?? 0) > 0)).toBe(true);
  },
  permission: ({ attached }) => {
    expect(attached.cards).toEqual([expect.objectContaining({ kind: "permission", id: EX.toolUse, toolName: "Bash", sessionRule: true })]);
  },
  question: ({ attached }) => {
    expect(attached.cards).toEqual([expect.objectContaining({ kind: "question", id: EX.toolUse })]);
    expect(attached.cards[0].questions.map((q: Frame) => q.question)).toEqual(QUESTIONS.map((q) => q.question));
  },
  plan: ({ attached }) => {
    expect(attached.cards).toEqual([expect.objectContaining({ kind: "plan", id: EX.toolUse })]);
    expect(attached.picks.mode).toBe("plan");
  },
  elicitation: ({ attached }) => {
    expect(attached.cards).toEqual([expect.objectContaining({ kind: "elicitation", id: EX.request, server: EX.connector, mode: "form" })]);
  },
  running: ({ attached, drawn }) => {
    expect(attached.state).toBe("running");
    expect(toolNamed(drawn, EX.toolUse)).toBe("Bash");
    // The message id is the queued message here, so no history row may claim it.
    expect(of(drawn, "user").filter((u) => u.uuid === EX.message).map((u) => u.queued)).toEqual([true]);
    expect(of(drawn, "block").some((b) => b.key.startsWith(`${EX.message}:`))).toBe(false);
  },
  archived: ({ attached, drawn }) => {
    expect(attached.archived).toBe(true);
    expect(toolNamed(drawn, EX.toolUse)).toBe("Edit");
  },
  // R127: the last turn's two refused claude --bg rows, each with its folder; the example tool id names the nested one.
  trust: ({ attached, drawn }) => {
    expect(attached.state).toBe("sleeping");
    expect(attached.trust).toBeUndefined();
    const refused = of(drawn, "tool_result").filter((e) => e.trust);
    expect(refused.map((e) => e.id)).toEqual([EX.toolUse, "toolu_01StartIndexer"]);
    expect(refused[0]!.trust!.path.endsWith("/tasks/remove-negative-qty")).toBe(true);
    expect(refused[0]!.trust!.root).toBeNull();
    expect(refused[1]!.trust!.root).toBe(refused[1]!.trust!.path.replace(/\/tasks\/search-index$/, ""));
    expect(toolNamed(drawn, EX.toolUse)).toBe("Bash");
  },
  // R131: the last turn's launch row carries its session; the server's book gives it a state once its list answered.
  background: ({ attached, drawn }) => {
    expect(attached.state).toBe("sleeping");
    const launched = of(drawn, "tool_result").filter((e) => e.background);
    expect(launched.map((e) => [e.id, e.background])).toEqual([["toolu_01StartInvestigator", [{ id: EX.bg, name: "investigate-negative-qty", idle: false }]]]);
    expect(toolNamed(drawn, "toolu_01StartInvestigator")).toBe("Bash");
  },
  // RD-8: the queue file's message is back, Queued and Not sent, and nothing started.
  "not-sent": ({ attached, drawn }) => {
    expect(attached.state).toBe("sleeping");
    expect(of(drawn, "user").filter((u) => u.uuid === EX.message).map((u) => ({ queued: u.queued, notSent: u.notSent }))).toEqual([{ queued: true, notSent: true }]);
    expect(of(drawn, "block").some((b) => b.key.startsWith(`${EX.message}:`))).toBe(false);
  },
};

describe.skipIf(!PROCFS)(`the scenes with live parts ${LINUX_ONLY}`, () => {
  for (const scene of SCENES.filter((s): s is Exclude<SceneName, "main"> => s !== "main")) {
    test(
      `${scene}: ${SCENE[scene].about}`,
      async () => {
        const h = await bootScene(scene);
        try {
          const view = await look(h, EX.chat);
          view.c.close();
          LIVE[scene](view);
        } finally {
          await stopScene(h);
        }
      },
      T,
    );
  }
});
