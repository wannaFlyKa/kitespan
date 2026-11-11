// T-26 (DESIGN-T1 2.1, G-43): a tool result that the page holds cut (6,000 characters, LIMITS.toolResult) has its whole
// text one GET away: GET /api/chats/:chat/tools/:toolUse/output reads the result from the session's transcript through
// the agent seam, before any cap, and answers it as a text/plain attachment, under the files route's guards. Here: the
// transcript read itself (the pure part and the real SDK reader, in a child process whose HOME and CLAUDE_CONFIG_DIR
// are a mkdtemp folder with a transcript in Claude Code's record shape), and the route with a stand-in driver. The
// user's own Claude Code folders are never touched; no claude runs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import { historyEvents, toolResultOf } from "../../server/agents/claude/events";
import type { AgentDriver, BinaryProbe } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { API_ROUTE_PATTERNS, createApi } from "../../server/http/api";
import { createApp, logRouteOf, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS, type ChatLedger } from "../../server/store/types";
import { LIMITS, toolOutputPath, type ChatEvent } from "../../shared/protocol";

const PROBE_SCRIPT = join(import.meta.dir, "tool-output-probe.ts");
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "tool-output-")));
const CONFIG = join(HOME, ".claude");
const PROJECT = join(HOME, "work", "demo");
const SESSION = "4e3a8f4b-4a5d-4f6e-8a7b-8c9d0e1f2a3b";
const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER_CHAT = "m7q2x4abk3m7q2x4abk3";

/** 7,000 characters, each line numbered, so a cut and a whole text differ in a way a test can see. */
const LONG = Array.from({ length: 700 }, (_, i) => `line ${String(i).padStart(4, "0")}`).join("\n").padEnd(7_000, ".");
const u = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assistant = (msgId: string, block: unknown) => ({ id: msgId, type: "message", role: "assistant", model: "claude-fake-1", content: [block], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

type Messages = Parameters<typeof toolResultOf>[0];
/** The records of a short session: a Bash call with a 7,000-character result, a Read with a list result, a hidden tool. */
const ROWS: { type: "user" | "assistant"; uuid: string; message: unknown }[] = [
  { type: "user", uuid: u(1), message: { role: "user", content: "Run the long test" } },
  { type: "assistant", uuid: u(2), message: assistant("msg_01A", { type: "tool_use", id: "toolu_01Long", name: "Bash", input: { command: "bun test" } }) },
  { type: "user", uuid: u(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Long", content: LONG }] } },
  { type: "assistant", uuid: u(4), message: assistant("msg_01B", { type: "tool_use", id: "toolu_01List", name: "Read", input: { file_path: "src/a.ts" } }) },
  {
    type: "user",
    uuid: u(5),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01List", content: [{ type: "text", text: "first" }, { type: "image", source: {} }, { type: "text", text: "last" }] }] },
  },
  { type: "assistant", uuid: u(6), message: assistant("msg_01C", { type: "tool_use", id: "toolu_01Hand", name: "SubagentHandback", input: {} }) },
  { type: "user", uuid: u(7), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01Hand", content: "hidden" }] } },
  { type: "assistant", uuid: u(8), message: assistant("msg_01D", { type: "text", text: "Done." }) },
];
const MESSAGES = ROWS.map((r) => ({ ...r, session_id: SESSION, parent_tool_use_id: null })) as unknown as Messages;

/** A subagent's own records, in its transcript apart from the session's: a Bash call with a 7,000-character result. */
const AGENT = "a1b2c3d4e5f60718";
const SUB_LONG = LONG.replace(/line/g, "step");
const SUB_ROWS: typeof ROWS = [
  { type: "user", uuid: u(21), message: { role: "user", content: "Check the upload log" } },
  { type: "assistant", uuid: u(22), message: assistant("msg_02A", { type: "tool_use", id: "toolu_02Sub", name: "Bash", input: { command: "cat upload.log" } }) },
  { type: "user", uuid: u(23), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02Sub", content: SUB_LONG }] } },
  { type: "assistant", uuid: u(24), message: assistant("msg_02B", { type: "text", text: "Read it." }) },
];

function lines(id: string, rows: typeof ROWS, agent?: string): string {
  let parent: string | null = null;
  let out = "";
  rows.forEach((r, i) => {
    out += `${JSON.stringify({ type: r.type, message: r.message, uuid: r.uuid, parentUuid: parent, sessionId: id, timestamp: new Date(Date.UTC(2026, 10, 6, 9, 0, i)).toISOString(), cwd: PROJECT, isSidechain: !!agent, ...(agent ? { agentId: agent } : {}), userType: "external", entrypoint: "sdk-ts", version: "2.1.318" })}\n`;
    parent = r.uuid;
  });
  return out;
}

function transcript(id: string, rows: typeof ROWS): void {
  const dir = join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines(id, rows));
}

/** A subagent's transcript where Claude Code keeps it: <session>/subagents/agent-<id>.jsonl beside the session's. */
function subagentTranscript(id: string, agent: string, rows: typeof ROWS): void {
  const dir = join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"), id, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agent}.jsonl`), lines(id, rows, agent));
}

async function probe(args: { id: string; tool: string }): Promise<{ ok: boolean; value?: unknown; code?: string | null }> {
  const proc = Bun.spawn([process.execPath, "--no-env-file", PROBE_SCRIPT, JSON.stringify({ cwd: PROJECT, ...args })], {
    cwd: HOME,
    env: { HOME, CLAUDE_CONFIG_DIR: CONFIG, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return JSON.parse(out);
}

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true });
  transcript(SESSION, ROWS);
  subagentTranscript(SESSION, AGENT, SUB_ROWS);
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("the whole result in a transcript (toolResultOf)", () => {
  test("a long result comes whole; the page's event holds its first 6,000 characters and says the whole length", () => {
    expect(toolResultOf(MESSAGES, "toolu_01Long")).toBe(LONG);
    const event = historyEvents(MESSAGES).find((e) => e.k === "tool_result" && e.id === "toolu_01Long") as Extract<ChatEvent, { k: "tool_result" }>;
    expect(event.text).toBe(LONG.slice(0, LIMITS.toolResult));
    expect(event.cut).toBe(7_000);
  });
  test("a list result is the text history shows: its texts joined, other blocks by their type", () => {
    expect(toolResultOf(MESSAGES, "toolu_01List")).toBe("first\n[image]\nlast");
    const event = historyEvents(MESSAGES).find((e) => e.k === "tool_result" && e.id === "toolu_01List") as Extract<ChatEvent, { k: "tool_result" }>;
    expect(event.text).toBe("first\n[image]\nlast");
    expect("cut" in event).toBe(false);
  });
  test("an id with no result, and a tool that is never shown, give null", () => {
    expect(toolResultOf(MESSAGES, "toolu_01None")).toBeNull();
    expect(toolResultOf(MESSAGES, "toolu_01Hand")).toBeNull();
    expect(toolResultOf([] as unknown as Messages, "toolu_01Long")).toBeNull();
  });
});

describe("the driver's toolOutput, through the real SDK reader", () => {
  test("the whole text from the transcript file", async () => {
    expect(await probe({ id: SESSION, tool: "toolu_01Long" })).toEqual({ ok: true, value: LONG });
  });
  test("a subagent's own result (a row with a parent) comes whole from the subagent's transcript", async () => {
    expect(await probe({ id: SESSION, tool: "toolu_02Sub" })).toEqual({ ok: true, value: SUB_LONG });
    // The session's own results are still read first.
    expect(await probe({ id: SESSION, tool: "toolu_01Long" })).toEqual({ ok: true, value: LONG });
  });
  test("no such result, no such transcript and a bad session id give null", async () => {
    expect(await probe({ id: SESSION, tool: "toolu_01None" })).toEqual({ ok: true, value: null });
    expect(await probe({ id: "5f4b9a5c-5b6e-4a7f-9b8c-9d0e1f2a3b4c", tool: "toolu_01Long" })).toEqual({ ok: true, value: null });
    expect(await probe({ id: "not-a-session", tool: "toolu_01Long" })).toEqual({ ok: true, value: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The route

const PORT = 7941;
const OWN = `http://127.0.0.1:${PORT}`;
const FORWARD = "https://forward.example.com";
const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.318", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };
const ledger = (over: Partial<ChatLedger> = {}) => ({ id: CHAT, cwd: PROJECT, sessionId: SESSION, archivedAt: null, project: "k3m7q2x4ab", ...over }) as unknown as ChatLedger;
const asked: { session: string; cwd: string; tool: string }[] = [];

function makeApp(opts: { chat?: ChatLedger | null; toolOutput?: boolean } = {}) {
  const chat = opts.chat === undefined ? ledger() : opts.chat;
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo" | "toolOutput"> = {
    probe: async () => PROBE,
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
    listSessions: async () => [],
    sessionInfo: async () => null,
    history: async () => ({ events: [], more: null }),
    ...(opts.toolOutput === false
      ? {}
      : {
          toolOutput: async (session: string, cwd: string, tool: string) => {
            asked.push({ session, cwd, tool });
            return tool === "toolu_01Long" ? LONG : tool === "toolu_01Word" ? "café" : null;
          },
        }),
  };
  const gate = createGate(PORT, [FORWARD]);
  const site = loadSite(join(HOME, "no-dist"), gate.origins);
  const lines: { event: string; route?: unknown }[] = [];
  const api = createApi({
    gate,
    safe: site.safe,
    store: { listProjects: async () => [], putProject: async () => {}, readSettings: async () => ({ ...SETTINGS_DEFAULTS }), readChat: async (id) => (id === CHAT ? chat : null), listUploads: async () => [], putUpload: async () => {}, removeUpload: async () => null },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: { ...PUBLIC_ADAPTERS, origins: [FORWARD] } },
    logger: { log: (event: string, f?: Record<string, unknown>) => void lines.push({ event, ...(f ?? {}) }) } as never,
  });
  return { app: createApp({ gate, site, api, sockets: {} }), lines };
}

const noServer: Upgrader = { upgrade: () => false };
async function get(path: string, opts: { method?: string; headers?: Record<string, string>; app?: ReturnType<typeof makeApp> } = {}) {
  const { app } = opts.app ?? makeApp();
  const res = (await app.fetch(new Request(`${OWN}${path}`, { method: opts.method ?? "GET", headers: { host: `127.0.0.1:${PORT}`, ...(opts.headers ?? {}) } }), noServer))!;
  return { res, status: res.status, text: await res.text() };
}

describe("GET /api/chats/:chat/tools/:toolUse/output", () => {
  test("an API pattern: a log line names the pattern, never the ids", () => {
    expect(API_ROUTE_PATTERNS).toContain("/api/chats/:chat/tools/:tool/output");
    expect(logRouteOf(toolOutputPath(CHAT, "toolu_01Long"))).toBe("/api/chats/:chat/tools/:tool/output");
  });

  test("the whole text as a text/plain attachment, read through the seam from the chat's own session and folder", async () => {
    asked.length = 0;
    const { res, status, text } = await get(toolOutputPath(CHAT, "toolu_01Long"));
    expect(status).toBe(200);
    expect(text).toBe(LONG);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="toolu_01Long-output.txt"; filename*=UTF-8''toolu_01Long-output.txt`);
    expect(res.headers.get("content-length")).toBe("7000");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(asked).toEqual([{ session: SESSION, cwd: PROJECT, tool: "toolu_01Long" }]);
    // Its length in bytes, not in characters.
    expect((await get(toolOutputPath(CHAT, "toolu_01Word"))).res.headers.get("content-length")).toBe("5");
  });

  test("a chat whose session ran in another folder is read there (Continue in the project folder)", async () => {
    asked.length = 0;
    const app = makeApp({ chat: ledger({ sessionDir: "/srv/old-worktree" } as Partial<ChatLedger>) });
    expect((await get(toolOutputPath(CHAT, "toolu_01Long"), { app })).status).toBe(200);
    expect(asked).toEqual([{ session: SESSION, cwd: "/srv/old-worktree", tool: "toolu_01Long" }]);
  });

  test("HEAD answers the headers with no body", async () => {
    const { res, status, text } = await get(toolOutputPath(CHAT, "toolu_01Long"), { method: "HEAD" });
    expect(status).toBe(200);
    expect(text).toBe("");
    expect(res.headers.get("content-length")).toBe("7000");
  });

  test("a result it cannot find is 404 with the 5.4 line; so is a chat with no session yet, or a driver that cannot read one", async () => {
    const line = "That message is not in this chat.";
    for (const [path, app] of [
      [toolOutputPath(CHAT, "toolu_01None"), makeApp()],
      [toolOutputPath(CHAT, "toolu_01Long"), makeApp({ chat: ledger({ sessionId: null }) })],
      [toolOutputPath(CHAT, "toolu_01Long"), makeApp({ toolOutput: false })],
    ] as const) {
      const { status, text } = await get(path, { app });
      expect([path, status]).toEqual([path, 404]);
      expect(JSON.parse(text)).toEqual({ error: { code: "not_found", message: line } });
    }
  });

  test("its existence probe, always a 200 read: the name and the size in bytes, or why there is none", async () => {
    const there = await get(`${toolOutputPath(CHAT, "toolu_01Word")}/exists`);
    expect(there.status).toBe(200);
    expect(JSON.parse(there.text)).toEqual({ exists: true, kind: "file", name: "toolu_01Word-output.txt", size: 5 });
    for (const [path, app, reason] of [
      [`${toolOutputPath(CHAT, "toolu_01None")}/exists`, makeApp(), "missing"],
      [`${toolOutputPath(CHAT, "toolu_01Long")}/exists`, makeApp({ chat: ledger({ sessionId: null }) }), "missing"],
      [`${toolOutputPath(OTHER_CHAT, "toolu_01Long")}/exists`, makeApp(), "no_chat"],
    ] as const) {
      const r = await get(path, { app });
      expect([path, r.status, JSON.parse(r.text)]).toEqual([path, 200, { exists: false, reason }]);
    }
    expect(logRouteOf(`${toolOutputPath(CHAT, "toolu_01Long")}/exists`)).toBe("/api/chats/:chat/tools/:tool/output/exists");
  });

  test("an unknown chat is the chat's 5.4 line; a malformed id is no route", async () => {
    const chat = await get(toolOutputPath(OTHER_CHAT, "toolu_01Long"));
    expect(chat.status).toBe(404);
    expect(JSON.parse(chat.text).error.message).toBe("That chat is not here. It may have been deleted.");
    for (const path of [`/api/chats/${CHAT}/tools/toolu_01%2F..%2Fx/output`, `/api/chats/${CHAT}/tools/${"t".repeat(300)}/output`, `/api/chats/nope/tools/toolu_01Long/output`, `/api/chats/${CHAT}/tools/toolu_01Long`]) {
      const r = await get(path);
      expect([path, r.status]).toEqual([path, 404]);
      expect(JSON.parse(r.text).error.message).toBe("There is no such kitespan API route.");
    }
  });

  test("the files route's guards: another site's Origin is refused, an allowed one reads, and it is a read only", async () => {
    expect((await get(toolOutputPath(CHAT, "toolu_01Long"), { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await get(toolOutputPath(CHAT, "toolu_01Long"), { headers: { origin: FORWARD } })).status).toBe(200);
    expect((await get(toolOutputPath(CHAT, "toolu_01Long"), { headers: { origin: OWN } })).status).toBe(200);
    expect((await get(toolOutputPath(CHAT, "toolu_01Long"), { headers: { host: "evil.example" } })).status).toBe(403);
    const post = await get(toolOutputPath(CHAT, "toolu_01Long"), { method: "POST", headers: { origin: OWN, "x-kitespan": "1", "content-type": "application/json" } });
    expect(post.status).toBe(405);
  });
});
