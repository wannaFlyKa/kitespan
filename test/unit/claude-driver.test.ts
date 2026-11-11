// The Claude driver end to end: the real Agent SDK runs the fake CLI (test/fake-claude/) from a mkdtemp PATH, so
// every test goes through query(), the stream-json protocol and the SDK's own callbacks. No model, no real claude.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DENY_TEXTS, DriverError, leftSessionFolder } from "../../server/agents/claude/driver";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateError, SDK_CHILD_ENV } from "../../server/agents/claude/options";
import { CARD_ABORT, MARK_PHRASES, markOf } from "../../server/agents/types";
import type { Card, ChatEvent } from "../../shared/protocol";
import { SHELL_OWN_ENV_NAMES, type TraceLine } from "../fake-claude/install";
import { rig, type Rig } from "../fake-claude/harness";

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});
const use = (r: Rig) => (rigs.push(r), r);
const kinds = (ev: ChatEvent[]) => ev.map((e) => e.k);
const now = () => new Date();
const answers = (r: Rig) => r.fake.trace().filter((l) => l.t === "answer");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a text turn with thinking", () => {
  test("streams thinking and text once, starts by the user, ends with the message's uuid", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events, sessionId } = r.open();
    const uuid = randomUUID();
    await chat.send({ uuid, text: "Hello" });
    const ev = await events.turnEnds(1);
    const session = events.of("session")[0]!;
    expect(session.sessionId).toBe(sessionId);
    expect(session.bypass).toBe(false);
    expect(events.of("turn_start")[0]).toEqual({ k: "turn_start", by: "user" });
    const starts = events.of("block_start");
    expect(starts.map((s) => s.kind)).toEqual(["thinking", "text"]);
    const text = events
      .of("block_delta")
      .filter((d) => d.key === starts[1]!.key)
      .map((d) => d.text)
      .join("");
    expect(text).toBe("Hello! How can I help you today?");
    expect(events.of("block_end").map((e) => e.key)).toEqual(starts.map((s) => s.key));
    // The whole records repeat both blocks: neither shows again (D-LIVE-42).
    expect(events.of("block")).toEqual([]);
    expect(events.of("turn_end")[0]).toMatchObject({ ok: true, subtype: "success", uuids: [uuid] });
    expect(kinds(ev)).toContain("thinking_estimate");
    expect(events.of("status")[0]).toEqual({ k: "status", status: "requesting", compact: null, error: null });
    expect(events.of("hook").map((h) => h.phase)).toEqual(["started", "response"]);
  });

  test("each message is one SDKUserMessage with the host's uuid and origin human; two messages run as two turns", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events } = r.open();
    const [u1, u2] = [randomUUID(), randomUUID()];
    await chat.send({ uuid: u1, text: "Hello" });
    await chat.send({ uuid: u2, text: "Again" });
    await events.turnEnds(2);
    const users = r.fake.trace().filter((l) => l.t === "user");
    expect(users.map((u) => u.uuid)).toEqual([u1, u2]);
    for (const u of users) expect(u.origin).toEqual({ kind: "human" });
    expect(users[0]!.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(events.of("turn_end").map((e) => e.uuids)).toEqual([[u1], [u2]]);
  });

  test("the start passes sessionId on a first start and resume on a later one, never both (D41)", async () => {
    const r = use(rig("text-thinking"));
    const first = r.open();
    await first.chat.send({ uuid: randomUUID(), text: "Hi" });
    await first.events.turnEnds(1);
    const start1 = r.fake.trace().find((l) => l.t === "start")!;
    expect(start1.args as string[]).toContain(`--session-id=${first.sessionId}`);
    expect((start1.args as string[]).some((a) => a.startsWith("--resume"))).toBe(false);
    await first.chat.close();
    // The transcript now exists: a second start with sessionId fails the gate; resume works.
    expect(() => r.open({ sessionId: { value: first.sessionId, mark: markOf(MARK_PHRASES.newSession, now()) } })).toThrow(GateError);
    const second = r.open({ sessionId: null, resume: { value: first.sessionId, mark: markOf(MARK_PHRASES.resume, now()) } });
    await second.chat.send({ uuid: randomUUID(), text: "Hi again" });
    await second.events.turnEnds(1);
    const starts = r.fake.trace().filter((l) => l.t === "start");
    expect(starts[1]!.args as string[]).toContain(`--resume=${first.sessionId}`);
    expect((starts[1]!.args as string[]).some((a) => a.startsWith("--session-id"))).toBe(false);
  });

  test("a resume adds no --await-initialize: SDK 0.3.322 adds it only without pathToClaudeCodeExecutable, which kitespan always passes", async () => {
    const r = use(rig("text-thinking"));
    const first = r.open();
    await first.chat.send({ uuid: randomUUID(), text: "Hi" });
    await first.events.turnEnds(1);
    await first.chat.close();
    const second = r.open({ sessionId: null, resume: { value: first.sessionId, mark: markOf(MARK_PHRASES.resume, now()) } });
    await second.chat.send({ uuid: randomUUID(), text: "Hi again" });
    await second.events.turnEnds(1);
    const starts = r.fake.trace().filter((l) => l.t === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.args as string[]).toContain(`--resume=${first.sessionId}`);
    for (const s of starts) expect((s.args as string[]).filter((a) => a.startsWith("--await-"))).toEqual([]);
  });

  test("the options of each start are written before query() runs, callbacks as [function]", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events, sessionId } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const rec = r.lastOptions[0] as { v: number; sdk: string; chat: string; options: Record<string, unknown>; marks: Record<string, string> };
    expect(rec.v).toBe(1);
    expect(rec.sdk).toBe("0.3.322");
    expect(rec.options.canUseTool).toBe("[function]");
    expect(rec.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(rec.options.sessionId).toBe(sessionId);
    expect(rec.marks.sessionId).toMatch(/^the user started this new chat on /);
    expect(rec.options.pathToClaudeCodeExecutable).toBe(r.fake.bin);
    expect(Object.keys(rec.options).sort()).toEqual(
      ["canUseTool", "cwd", "forwardSubagentText", "includeHookEvents", "includePartialMessages", "onElicitation", "onUserDialog", "pathToClaudeCodeExecutable", "sessionId", "stderr", "systemPrompt"].sort(),
    );
  });

  test("the initialize request carries no prompt, agents, hooks or MCP servers of kitespan's own", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const init = r.fake.trace().find((l) => l.t === "control" && l.subtype === "initialize")!.request as Record<string, unknown>;
    for (const k of ["appendSystemPrompt", "agents", "sdkMcpServers", "jsonSchema", "planModeInstructions", "toolAliases", "skills", "promptSuggestions"]) expect(init[k]).toBeUndefined();
    expect(init.hooks === undefined || Object.keys(init.hooks as object).length === 0).toBe(true);
    const start = r.fake.trace().find((l) => l.t === "start")!.args as string[];
    for (const f of ["--model", "--effort", "--permission-mode", "--allowedTools", "--disallowedTools", "--mcp-config", "--setting-sources", "--settings", "--agent"])
      expect(start.some((a) => a === f || a.startsWith(`${f}=`))).toBe(false);
    expect(start).toContain("--include-partial-messages");
    expect(start).toContain("--include-hook-events");
  });
});

describe("close() and the end of a chat", () => {
  test("close() resolves only when the claude process is gone, and the events end with exit", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const pid = (r.fake.trace().find((l) => l.t === "start")!.pid as number) ?? 0;
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    await chat.close();
    expect(alive(pid)).toBe(false);
    await events.done;
    expect(events.events.at(-1)!.k).toBe("exit");
    await expect(chat.send({ uuid: randomUUID(), text: "late" })).rejects.toBeInstanceOf(DriverError);
  });

  test("R16: the chat's pid is its claude process's while it runs, and null once the process is gone", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    // The driver finds the pid by a few tries while the SDK spawns (0, 50, 250, 1000 and 3000 ms); the fake turn can end
    // before the first one that sees the process on a loaded host, so wait for it as R16's hold does.
    for (let i = 0; chat.pid === null && i < 90; i++) await Bun.sleep(50);
    expect(chat.pid).toBe(r.fake.trace().find((l) => l.t === "start")!.pid as number);
    await chat.close();
    expect(chat.pid).toBeNull();
  });

  test("a CLI that ignores the end of stdin is ended by the SDK's SIGTERM, and close() waits for it", async () => {
    const r = use(rig({ ignoreStdinEnd: true }));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const pid = r.fake.trace().find((l) => l.t === "start")!.pid as number;
    const t0 = Date.now();
    await chat.close();
    expect(alive(pid)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThan(1_500);
    expect(r.fake.trace().some((l) => l.t === "sigterm")).toBe(true);
  }, 15_000);

  test("a CLI that exits by itself gives one exit event with its code and the last stderr lines", async () => {
    const r = use(rig({ turns: [{ steps: [{ exit: 3, stderr: ["line one", "line two", "line three", "line four", "line five"] }] }] }));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.done;
    const exit = events.of("exit");
    expect(exit).toHaveLength(1);
    expect(exit[0]!.code).toBe(3);
    expect(exit[0]!.stderr).toEqual(["line two", "line three", "line four", "line five"]);
  });

  test("a start the CLI refuses (an id already in use) ends at once with exit code 1", async () => {
    const id = randomUUID();
    const r = use(rig({ inUse: [id] }));
    const { chat, events } = r.open({ sessionId: { value: id, mark: markOf(MARK_PHRASES.newSession, now()) } });
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.done;
    expect(events.of("exit")[0]!.code).toBe(1);
    expect(events.of("exit")[0]!.stderr.join(" ")).toContain("already in use");
  });

  test("with no claude on PATH, open() refuses with no_claude and starts nothing", () => {
    const r = use(rig("text-thinking", { pathEnv: () => "/nonexistent-folder-for-test" }));
    let err: unknown;
    try {
      r.open();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe("no_claude");
    expect(r.fake.trace()).toEqual([]);
  });
});

describe("the permission card (canUseTool)", () => {
  const perm = (r: Rig) => r.cards.asked.find((c): c is Extract<Card, { kind: "permission" }> => c.kind === "permission")!;

  test("Allow once returns the tool's own input; the card carries the request's fields", async () => {
    const r = use(rig("tool-permission"));
    r.cards.answer = () => ({ kind: "permission", allow: true, scope: "once" });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "List the files" });
    await events.turnEnds(1);
    const card = perm(r);
    expect(card).toMatchObject({
      kind: "permission",
      id: "toolu_fake_bash_1",
      toolUseId: "toolu_fake_bash_1",
      toolName: "Bash",
      title: "Claude wants to run ls",
      displayName: "Run a command",
      reason: "This command needs your approval",
      defaultToNo: true,
      suppressAlwaysAllowRule: false,
      sessionRule: true,
      parent: null,
    });
    const a = answers(r)[0]!;
    expect(a.response).toMatchObject({ behavior: "allow", updatedInput: { command: "ls", description: "List the files" } });
    expect((a.response as Record<string, unknown>).updatedPermissions).toBeUndefined();
    const ev = events.events;
    expect(events.of("tool_call").map((t) => t.input)).toEqual([null, { command: "ls", description: "List the files" }]);
    expect(events.of("tool_progress")[0]).toEqual({ k: "tool_progress", id: "toolu_fake_bash_1", seconds: 1, parent: null });
    expect(events.of("tool_result")[0]).toMatchObject({ id: "toolu_fake_bash_1", text: "notes.txt\nplan.md", isError: false, report: null });
    expect(kinds(ev).filter((k) => k === "turn_start")).toHaveLength(1);
  });

  test("Allow for this session returns Claude Code's suggested rules with the session destination", async () => {
    const r = use(rig("tool-permission"));
    r.cards.answer = () => ({ kind: "permission", allow: true, scope: "session" });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "List the files" });
    await events.turnEnds(1);
    expect(answers(r)[0]!.response).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "session" }],
    });
  });

  test("suppressAlwaysAllowRule hides the session choice, and a session answer then counts as once", async () => {
    const fx = (await import("../fake-claude/install")).loadFixture("tool-permission");
    const step = fx.turns![0]!.steps[1] as { ask: Record<string, unknown> };
    step.ask.suppress_always_allow_rule = true;
    const r = use(rig(fx));
    r.cards.answer = () => ({ kind: "permission", allow: true, scope: "session" });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "List the files" });
    await events.turnEnds(1);
    expect(perm(r)).toMatchObject({ suppressAlwaysAllowRule: true, sessionRule: false });
    const res = answers(r)[0]!.response as Record<string, unknown>;
    expect(res.behavior).toBe("allow");
    expect(res.updatedPermissions).toBeUndefined();
  });

  test("Deny sends the user's text; an empty note sends the default deny text", async () => {
    const r = use(rig("tool-permission"));
    r.cards.answer = () => ({ kind: "permission", allow: false, message: "  Use find instead.  " });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "List the files" });
    await events.turnEnds(1);
    expect(answers(r)[0]!.response).toMatchObject({ behavior: "deny", message: "Use find instead." });
    expect(events.of("tool_result")[0]).toMatchObject({ isError: true });

    const r2 = use(rig("tool-permission"));
    r2.cards.answer = () => ({ kind: "permission", allow: false, message: "" });
    const o2 = r2.open();
    await o2.chat.send({ uuid: randomUUID(), text: "List the files" });
    await o2.events.turnEnds(1);
    expect(answers(r2)[0]!.response).toMatchObject({ behavior: "deny", message: DENY_TEXTS.permission });
  });

  test("a deny note is cut at 2,000 characters (A10)", async () => {
    const r = use(rig("tool-permission"));
    r.cards.answer = () => ({ kind: "permission", allow: false, message: "x".repeat(5_000) });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "List the files" });
    await events.turnEnds(1);
    expect(((answers(r)[0]!.response as Record<string, unknown>).message as string).length).toBe(2_000);
  });

  test("a card closed with no answer (null) is a denial", async () => {
    const r = use(rig("tool-permission"));
    r.cards.answer = () => null;
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "List the files" });
    await events.turnEnds(1);
    expect(answers(r)[0]!.response).toMatchObject({ behavior: "deny", message: DENY_TEXTS.permission });
  });

  test("a card that waits when its process ends, by itself or by close(), aborts with the driver's own reason (lost)", async () => {
    for (const how of ["exit", "close"] as const) {
      const r = use(
        rig({
          turns: [
            {
              steps: [
                { say: { id: "msg_lost", tools: [{ id: "toolu_lost", name: "Bash", input: { command: "ls" } }] } },
                { ask: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_lost" }, wait: false },
                { sleep: 300 },
                ...(how === "exit" ? [{ exit: 1 }] : [{ sleep: 10_000 }]),
              ],
            },
          ],
        }),
      );
      const { chat, events } = r.open();
      await chat.send({ uuid: randomUUID(), text: "Hi" });
      await events.until(() => r.cards.asked.length === 1);
      if (how === "close") await chat.close();
      await events.done;
      expect(r.cards.aborted).toEqual(["toolu_lost"]);
      expect(r.cards.reasons.get("toolu_lost")).toBe(CARD_ABORT.ended);
    }
  }, 20_000);

  test("an interrupt while the card waits: the CLI cancels the request and the card's signal aborts", async () => {
    const r = use(rig("tool-permission"));
    r.cards.answer = () => undefined; // nobody answers
    const { chat, events } = r.open();
    const u = randomUUID();
    await chat.send({ uuid: u, text: "List the files" });
    await events.until(() => r.cards.asked.length === 1);
    const receipt = await chat.interrupt();
    expect(receipt).toEqual({ stillQueued: [] });
    await events.turnEnds(1);
    await r.fake.waitFor((l) => l.t === "ask_cancelled");
    await events.until(() => r.cards.aborted.includes("toolu_fake_bash_1"));
    expect(events.of("turn_end")[0]).toMatchObject({ ok: false, subtype: "error_during_execution" });
  });

  test("Denied by auto mode: permission_denied becomes a denied tag on the tool row", async () => {
    const r = use(rig("tool-permission"));
    r.cards.answer = () => ({ kind: "permission", allow: true, scope: "once" });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "one" });
    await chat.send({ uuid: randomUUID(), text: "two" });
    await events.turnEnds(2);
    expect(events.of("denied")).toEqual([{ k: "denied", id: "toolu_fake_read_1", tool: "Read", reasonType: "classifier", reason: "Denied by auto mode", parent: null }]);
  });
});

describe("the question and plan cards", () => {
  test("AskUserQuestion: the answers go back in updatedInput, keyed by the question, cut at 2,000", async () => {
    const r = use(rig("question"));
    r.cards.answer = (c) =>
      c.kind === "question"
        ? { kind: "question", answers: { "Which colour should the button be?": "Blue", "Which sizes should ship?": "Small, Large", "Not a question": "dropped" } }
        : null;
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Ask me" });
    await events.turnEnds(1);
    const card = r.cards.asked[0]!;
    expect(card.kind).toBe("question");
    if (card.kind !== "question") throw new Error("not a question card");
    expect(card.questions.map((q) => [q.header, q.multiSelect, q.options.map((o) => o.label)])).toEqual([
      ["Colour", false, ["Red", "Blue"]],
      ["Sizes", true, ["Small", "Medium", "Large"]],
    ]);
    const res = answers(r)[0]!.response as { behavior: string; updatedInput: { answers: Record<string, string>; questions: unknown[] } };
    expect(res.behavior).toBe("allow");
    expect(res.updatedInput.answers).toEqual({ "Which colour should the button be?": "Blue", "Which sizes should ship?": "Small, Large" });
    expect(res.updatedInput.questions).toHaveLength(2);
  });

  test("a dismissed question is a denial with the spike's text", async () => {
    const r = use(rig("question"));
    r.cards.answer = () => null;
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Ask me" });
    await events.turnEnds(1);
    expect(answers(r)[0]!.response).toMatchObject({ behavior: "deny", message: DENY_TEXTS.question });
  });

  test("ExitPlanMode: an approval switches the mode it names; a refusal sends the feedback", async () => {
    const r = use(rig("plan"));
    r.cards.answer = () => ({ kind: "plan", approve: true, mode: "acceptEdits" });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Plan it" });
    await events.turnEnds(1);
    const card = r.cards.asked[0]!;
    expect(card).toMatchObject({ kind: "plan", id: "toolu_fake_plan_1", plan: "## Plan\n\n1. Add the button.\n2. Write its test." });
    expect(answers(r)[0]!.response).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    await r.fake.waitFor((l) => l.t === "control" && l.subtype === "set_permission_mode");
    expect(events.of("session")[0]!.mode).toBe("plan");

    const r2 = use(rig("plan"));
    r2.cards.answer = () => ({ kind: "plan", approve: false, feedback: "Add a step for the docs." });
    const o2 = r2.open();
    await o2.chat.send({ uuid: randomUUID(), text: "Plan it" });
    await o2.events.turnEnds(1);
    expect(answers(r2)[0]!.response).toMatchObject({ behavior: "deny", message: "Add a step for the docs." });
  });

  test("the bypass variant of a plan approval needs a chat started with the bypass flag", async () => {
    const r = use(rig("plan"));
    r.cards.answer = () => ({ kind: "plan", approve: true, mode: "bypassPermissions" });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Plan it" });
    await events.turnEnds(1);
    expect(answers(r)[0]!.response).toMatchObject({ updatedPermissions: [{ type: "setMode", mode: "default" }] });
  });
});

describe("the elicitation card (onElicitation)", () => {
  test("a form answer goes back with its values; a URL card closes when the server completes it", async () => {
    const r = use(rig("elicitation"));
    r.cards.answer = (c) => (c.kind === "elicitation" && c.mode === "form" ? { kind: "elicitation", action: "accept", content: { project: "web" } } : undefined);
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "File a ticket" });
    await events.turnEnds(1);
    const form = r.cards.asked[0]!;
    expect(form).toMatchObject({ kind: "elicitation", server: "tickets", displayName: "Tickets", title: "New ticket", mode: "form", url: null, schema: { type: "object" } });
    expect(answers(r)[0]!.response).toEqual({ action: "accept", content: { project: "web" } });

    await chat.send({ uuid: randomUUID(), text: "Sign in" });
    await events.turnEnds(2);
    const url = r.cards.asked[1]!;
    expect(url).toMatchObject({ kind: "elicitation", mode: "url", url: "https://tickets.example.com/sign-in", elicitationId: "elicit-fake-1" });
    expect(r.cards.aborted).toContain(url.id);
    // The driver's own reason: the user finished it elsewhere, so the record says answered, not withdrawn (5.4).
    expect(r.cards.reasons.get(url.id)).toBe(CARD_ABORT.completed);
    await r.fake.waitFor((l) => l.t === "answer" && (l.response as Record<string, unknown> | null)?.action === "accept" && answers(r).length === 2);
  });
});

describe("subagents and workflows", () => {
  test("a subagent's rows carry its tool-use id; its hand-back row is hidden; the report is on the Agent result", async () => {
    const r = use(rig("subagent"));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Summarise" });
    await events.turnEnds(1);
    const calls = events.of("tool_call");
    expect(calls.filter((c) => c.input !== null).map((c) => [c.id, c.parent])).toEqual([
      ["toolu_fake_agent_1", null],
      ["toolu_fake_inner_bash", "toolu_fake_agent_1"],
    ]);
    expect(calls.some((c) => c.name === "SubagentHandback")).toBe(false);
    const results = events.of("tool_result");
    expect(results.map((t) => [t.id, t.parent])).toEqual([
      ["toolu_fake_inner_bash", "toolu_fake_agent_1"],
      ["toolu_fake_agent_1", null],
    ]);
    expect(results[1]!.report).toBe("A small project: a README and a src folder.");
    const sub = events.of("block").filter((b) => b.parent === "toolu_fake_agent_1");
    expect(sub.map((b) => b.text)).toEqual(["The folder holds a README and a src folder."]);
    const tasks = events.of("task");
    expect(tasks.map((t) => t.ev)).toEqual(["started", "progress", "updated", "done"]);
    expect(tasks[0]).toMatchObject({ taskId: "afake0subagent01", toolUseId: "toolu_fake_agent_1", subagentType: "general-purpose", background: false });
    expect(tasks[1]).toMatchObject({ usage: { totalTokens: 1200, toolUses: 1, durationMs: 900 }, lastTool: "Bash" });
    expect(tasks[3]).toMatchObject({ status: "completed", usage: { toolUses: 2 } });
  });

  test("a workflow: the launch card is a permission card for Workflow; phases and agents come in task progress", async () => {
    const r = use(rig("workflow"));
    r.cards.answer = () => ({ kind: "permission", allow: true, scope: "once" });
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Run it" });
    // The workflow settles after the turn: its done event, then the empty task set.
    await events.until((ev) => ev.some((e) => e.k === "task" && e.ev === "done") && ev.filter((e) => e.k === "tasks").length === 2);
    expect(r.cards.asked[0]).toMatchObject({ kind: "permission", toolName: "Workflow", title: "Claude wants to run the workflow greet-demo" });
    const started = events.of("task").find((t) => t.ev === "started")!;
    expect(started).toMatchObject({ workflowName: "greet-demo", taskType: "local_workflow", prompt: null });
    const progress = events.of("task").filter((t): t is Extract<ChatEvent, { k: "task"; ev: "progress" }> => t.ev === "progress");
    expect(progress[0]!.workflow).toEqual([
      { kind: "phase", index: 1, title: "greet" },
      { kind: "agent", index: 1, label: "agent-one", phaseIndex: 1, phaseTitle: "greet", state: "start", attempt: 1, prompt: "Reply with the word alpha.", result: null, error: null, model: "claude-fake-1" },
      { kind: "agent", index: 2, label: "agent-two", phaseIndex: 1, phaseTitle: "greet", state: "queued", attempt: 1, prompt: "Reply with the word beta.", result: null, error: null, model: "claude-fake-1" },
    ]);
    expect(events.of("tasks").map((t) => t.running.map((x) => x.taskId))).toEqual([["wfake0wf1"], []]);
    // The task ran after the turn's result: no new turn starts for task events.
    expect(events.of("turn_start")).toHaveLength(1);
  });

  test("stopTask takes only task ids this chat has seen", async () => {
    const r = use(rig("subagent"));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Summarise" });
    await events.turnEnds(1);
    await expect(chat.stopTask("never-seen")).rejects.toMatchObject({ code: "stale" });
    await chat.stopTask("afake0subagent01");
    await r.fake.waitFor((l) => l.t === "control" && l.subtype === "stop_task" && (l.request as Record<string, unknown>).task_id === "afake0subagent01");
  });
});

describe("the chat's other actions", () => {
  test("setModel(null) goes out with no model (the SDK's undefined); a row value goes as itself", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    await chat.setModel(null);
    await chat.setModel("claude-fake-1");
    const sets = r.fake.trace().filter((l) => l.t === "control" && l.subtype === "set_model").map((l) => l.request as Record<string, unknown>);
    expect(sets).toEqual([{ subtype: "set_model" }, { subtype: "set_model", model: "claude-fake-1" }]);
  });

  test("effort, mode, models, commands, context, account and the reload reach their control requests", async () => {
    const r = use(rig({ initMessage: { terminal_slash_commands: ["context"] } }));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    await chat.setEffort("high");
    await chat.setEffort(null);
    await chat.setMode("acceptEdits");
    await expect(chat.setMode("bypassPermissions")).rejects.toMatchObject({ code: "unsupported" });
    const t = r.fake.trace().filter((l) => l.t === "control").map((l) => l.request as Record<string, unknown>);
    expect(t.filter((x) => x.subtype === "apply_flag_settings").map((x) => x.settings)).toEqual([{ effortLevel: "high" }, { effortLevel: null }]);
    expect(t.filter((x) => x.subtype === "set_permission_mode").map((x) => x.mode)).toEqual(["acceptEdits"]);
    expect((await chat.models()).map((m) => [m.value, m.efforts.length, m.supportsAutoMode])).toEqual([
      ["default", 3, false],
      ["claude-fake-1", 5, true],
    ]);
    const cmds = await chat.commands();
    expect(cmds.map((c) => [c.name, c.builtin, c.terminalOnly])).toEqual([
      ["compact", true, false],
      ["context", true, true],
      ["review-notes", false, false],
    ]);
    expect(cmds[2]!.aliases).toEqual(["rn"]);
    expect(events.of("commands").length).toBeGreaterThan(0);
    expect(await chat.context()).toMatchObject({ usedTokens: 4000, maxTokens: 200000, percent: 2, parts: [{ name: "System prompt", tokens: 3000, kind: "used" }, { kind: "used" }, { kind: "free" }] });
    expect(await chat.account()).toEqual({ provider: "firstParty" });
    await chat.reload();
    const subs = r.fake.trace().filter((l) => l.t === "control").map((l) => l.subtype);
    expect(subs).toEqual(expect.arrayContaining(["reload_skills", "reload_plugins", "reload_output_styles"]));
    const plugins = t.find((x) => x.subtype === "reload_plugins");
    expect(plugins?.add_plugins).toBeUndefined();
    // Never a settings write or an MCP server set (13.1).
    expect(subs).not.toContain("update_settings");
    expect(subs).not.toContain("mcp_set_servers");
  });

  test("connectors and Reconnect: only a server that mcpServerStatus() knows", async () => {
    const r = use(
      rig({
        control: {
          mcp_status: { mcpServers: [{ name: "tickets", status: "connected", scope: "user", tools: [{ name: "file", _meta: { ui: { resourceUri: "ui://tickets/view" } } }, { name: "list" }] }, { name: "docs", status: "failed", error: "spawn failed" }] },
        },
      }),
    );
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    expect(await chat.connectors()).toEqual([
      { name: "tickets", status: "connected", error: null, tools: 2, scope: "user", hasView: true },
      { name: "docs", status: "failed", error: "spawn failed", tools: 0, scope: null, hasView: false },
    ]);
    await chat.reconnect("tickets");
    await expect(chat.reconnect("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(chat.setEnabled("tickets", false)).rejects.toMatchObject({ code: "unsupported" });
    expect(r.fake.trace().filter((l) => l.t === "control" && l.subtype === "mcp_reconnect")).toHaveLength(1);
  });

  test("Always ask waits for its throwaway-home check (DESIGN 6.7, 12 question 11): refused, and nothing reaches the CLI", async () => {
    const r = use(rig({ control: { mcp_status: { mcpServers: [{ name: "tickets", status: "connected", scope: "user", tools: [] }] } } }));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    for (const on of [true, false]) {
      const e = await chat.setAlwaysAsk("tickets", on).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(DriverError);
      expect((e as DriverError).code).toBe("unsupported");
    }
    expect(r.fake.trace().filter((l) => l.t === "control" && l.subtype === "set_mcp_permission_mode_override")).toEqual([]);
  });

  test("take back (cancelAsyncMessage, feature-detected): a queued message leaves the queue once", async () => {
    const r = use(rig({ turns: [{ steps: [{ sleep: 1_500 }, { say: { id: "msg_slow", text: "slow" } }, { emit: { type: "result", subtype: "success" } }] }] }));
    const { chat, events } = r.open();
    const [u1, u2] = [randomUUID(), randomUUID()];
    await chat.send({ uuid: u1, text: "first" });
    await chat.send({ uuid: u2, text: "second" });
    await r.fake.waitFor((l) => l.t === "user" && l.uuid === u2);
    expect(await chat.takeBack(u2)).toEqual({ cancelled: true });
    expect(await chat.takeBack(u2)).toEqual({ cancelled: false });
    await events.turnEnds(1);
    await Bun.sleep(100);
    expect(r.fake.trace().filter((l) => l.t === "turn_start")).toHaveLength(1);
  });

  test("SDK 0.3.322: a held message answers cancelled: false, and Claude Code's later command_lifecycle `cancelled` reaches the chat as `dropped`", async () => {
    const r = use(rig({ heldCancelMs: 50, turns: [{ steps: [{ sleep: 1_500 }, { say: { id: "msg_slow", text: "slow" } }, { emit: { type: "result", subtype: "success" } }] }] }));
    const { chat, events } = r.open();
    const [u1, u2] = [randomUUID(), randomUUID()];
    await chat.send({ uuid: u1, text: "first" });
    await chat.send({ uuid: u2, text: "second" });
    await r.fake.waitFor((l) => l.t === "user" && l.uuid === u2);
    expect(await chat.takeBack(u2)).toEqual({ cancelled: false });
    // The SDK hands the untyped frame on (sdk.mjs 0.3.322 readMessages), and the mapper names the message.
    await events.until((ev) => ev.some((e) => e.k === "dropped"));
    expect(events.of("dropped")).toEqual([{ k: "dropped", uuid: u2 }]);
    await events.turnEnds(1);
    await Bun.sleep(100);
    expect(r.fake.trace().filter((l) => l.t === "turn_start")).toHaveLength(1);
  });

  test("an interrupt's receipt lists the messages that will still run", async () => {
    const r = use(rig({ turns: [{ steps: [{ sleep: 3_000 }] }] }));
    const { chat, events } = r.open();
    const [u1, u2] = [randomUUID(), randomUUID()];
    await chat.send({ uuid: u1, text: "first" });
    await chat.send({ uuid: u2, text: "second" });
    await r.fake.waitFor((l) => l.t === "user" && l.uuid === u2);
    expect(await chat.interrupt()).toEqual({ stillQueued: [u2] });
    await events.turnEnds(2);
  });

  test("generateTitle (generateSessionTitle, feature-detected) asks once from the first message, persist false", async () => {
    const r = use(rig({ control: { generate_session_title: { title: "  Fix   the login\nbutton  " } } }));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "The login button does nothing" });
    await events.turnEnds(1);
    expect(await chat.generateTitle()).toBe("Fix the login button");
    const req = r.fake.trace().find((l) => l.t === "control" && l.subtype === "generate_session_title")!.request as Record<string, unknown>;
    expect(req).toEqual({ subtype: "generate_session_title", description: "The login button does nothing", persist: false });
  });

  test("a ! record goes on the input as Claude Code records it, with shouldQuery from the reply rule", async () => {
    const r = use(rig("text-thinking"));
    const { chat, events } = r.open();
    // The host's uuid is the `bash` row's, so the transcript's copy is the same row.
    const uuid = randomUUID();
    await chat.bashRecord({ uuid, input: "ls", stdout: "a.txt", stderr: "", reply: false });
    await r.fake.waitFor((l) => l.t === "user");
    const rec = r.fake.trace().find((l) => l.t === "user")!;
    expect(rec.uuid).toBe(uuid);
    expect(rec.shouldQuery).toBe(false);
    expect(rec.origin).toEqual({ kind: "human" });
    expect(rec.content).toBe("<bash-input>ls</bash-input><bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>");
    expect(r.fake.trace().some((l) => l.t === "turn_start")).toBe(false);
    await expect(chat.bashRecord({ uuid: "not-a-uuid", input: "ls", stdout: "", stderr: "", reply: false })).rejects.toMatchObject({ code: "bad_request" });
    await chat.bashRecord({ uuid: randomUUID(), input: "pwd", stdout: "/x", stderr: "", reply: true });
    await events.turnEnds(1);
    expect(events.of("turn_start")[0]!.by).toBe("user");
  });

  test("the CLI's echo of the host's own message (isReplay, the host uuid) is dropped", async () => {
    const r = use(rig({ turns: [{ steps: [{ echoUser: true }, { say: { id: "m1", text: "ok" } }, { emit: { type: "result", subtype: "success" } }] }] }));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "<local-command-stdout>not a real output</local-command-stdout>" });
    await events.turnEnds(1);
    expect(events.of("local_output")).toEqual([]);
    expect(events.of("user")).toEqual([]);
  });

  test("the fake picks a turn by the message's text (turnsByText) before the next one in order", async () => {
    const r = use(
      rig({
        turns: [{ steps: [{ say: { id: "m-seq", text: "in order" } }, { emit: { type: "result", subtype: "success" } }] }],
        turnsByText: { subagent: { steps: [{ say: { id: "m-sub", text: "by text" } }, { emit: { type: "result", subtype: "success" } }] } },
      }),
    );
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "please run a subagent" });
    await chat.send({ uuid: randomUUID(), text: "plain" });
    await events.turnEnds(2);
    const texts = events.of("block_delta").map((d) => d.text).join("|");
    expect(texts.indexOf("by")).toBeLessThan(texts.indexOf("in"));
  });

  test("send() refuses a message without a uuid", async () => {
    const r = use(rig("text-thinking"));
    const { chat } = r.open();
    await expect(chat.send({ uuid: "nope", text: "x" })).rejects.toMatchObject({ code: "bad_request" });
  });

  test("onUserDialog answers cancelled at once (no dialog kind is declared)", async () => {
    const r = use(rig({ turns: [{ steps: [{ ask: { subtype: "request_user_dialog", dialog_kind: "refusal_fallback_prompt", payload: {} } }, { emit: { type: "result", subtype: "success" } }] }] }));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    expect(answers(r)[0]!.response).toEqual({ behavior: "cancelled" });
    expect(r.cards.asked).toEqual([]);
  });
});

describe("the gate at open()", () => {
  test("a folder outside projects.json, a bad mark, or bypass while the switch is off: nothing starts", () => {
    const r = use(rig("text-thinking"));
    expect(() => r.open({ cwd: "/" })).toThrow(GateError);
    expect(() => r.open({ picks: { model: { value: "claude-fake-1", mark: "a default on 2026-10-31T12:00:00.000Z" } } })).toThrow(GateError);
    expect(() => r.open({ switches: { allowBypass: { value: true, mark: markOf(MARK_PHRASES.bypass, now()) } } })).toThrow(GateError);
    expect(() => r.open({ picks: { permissionMode: { value: "plan", mark: markOf(MARK_PHRASES.remembered, now()) } } })).toThrow(GateError);
    expect(r.fake.trace()).toEqual([]);
  });

  test("a sessionId or resume that is not the id in the chat's ledger: nothing starts", async () => {
    const r = use(rig("text-thinking"));
    const [ledger, other] = [randomUUID(), randomUUID()];
    expect(() => r.open({ ledgerSessionId: ledger, sessionId: { value: other, mark: markOf(MARK_PHRASES.newSession, now()) } })).toThrow(GateError);
    expect(() => r.open({ ledgerSessionId: ledger, sessionId: null, resume: { value: other, mark: markOf(MARK_PHRASES.resume, now()) } })).toThrow(GateError);
    expect(() => r.open({ ledgerSessionId: null, sessionId: { value: other, mark: markOf(MARK_PHRASES.newSession, now()) } })).toThrow(GateError);
    expect(r.fake.trace()).toEqual([]);
    const { chat, events } = r.open({ ledgerSessionId: ledger, sessionId: { value: ledger, mark: markOf(MARK_PHRASES.newSession, now()) } });
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    expect(events.of("session")[0]!.sessionId).toBe(ledger);
  });

  test("SDK 0.3.322: deleteSession that removed the transcript but left the session folder keeps the chat; Delete again removes the folder", async () => {
    const config = mkdtempSync(join(tmpdir(), "ks-del-"));
    try {
      const sid = randomUUID();
      const project = join(config, "projects", "-srv-work-app");
      const folder = join(project, sid);
      mkdirSync(join(folder, "subagents"), { recursive: true });
      writeFileSync(join(folder, "subagents", "agent-a.jsonl"), "{}\n");
      const calls: string[] = [];
      // The SDK's KL: the transcript went, the folder stayed after three tries (sdk.mjs 0.3.322); a repeat: not found.
      const stub = async (id: string) => {
        calls.push(id);
        if (calls.length === 1) throw Object.assign(new Error(`'${folder}' is still on disk after three tries to delete it. A program may be writing to it.`), { code: "ENOTEMPTY" });
        throw new Error(`Session ${id} not found in project directory for /srv/work/app`);
      };
      const r = use(rig("text-thinking", { claudeConfigDir: config, sdk: { deleteSession: stub as never } }));
      const first = await r.driver.deleteSession(sid, "/srv/work/app").then(
        () => null,
        (x: unknown) => x,
      );
      expect(first).toBeInstanceOf(DriverError);
      expect(first).toMatchObject({ code: "failed", keepChat: true });
      expect(existsSync(folder)).toBe(true);
      // Delete again: the SDK says not found, and the folder that it named goes.
      await r.driver.deleteSession(sid, "/srv/work/app");
      expect(existsSync(folder)).toBe(false);
      expect(existsSync(project)).toBe(true);
      expect(calls).toEqual([sid, sid]);
      // A plain "not found" with no folder left is what Delete wants, as before.
      await r.driver.deleteSession(sid, "/srv/work/app");
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  });

  test("an ENOTEMPTY whose folder is not that session's, one level under the config's projects, is a plain failure", () => {
    const sid = randomUUID();
    const err = (path: string) => Object.assign(new Error(`'${path}' is still on disk after three tries to delete it.`), { code: "ENOTEMPTY" });
    expect(leftSessionFolder(err(`/c/projects/p/${sid}`), sid, "/c")).toBe(`/c/projects/p/${sid}`);
    expect(leftSessionFolder(err(`/c/projects/p/${randomUUID()}`), sid, "/c")).toBeNull();
    expect(leftSessionFolder(err(`/c/projects/${sid}`), sid, "/c")).toBeNull();
    expect(leftSessionFolder(err(`/c/projects/p/q/${sid}`), sid, "/c")).toBeNull();
    expect(leftSessionFolder(err(`/c/projects/p/../../${sid}`), sid, "/c")).toBeNull();
    expect(leftSessionFolder(err(`/other/projects/p/${sid}`), sid, "/c")).toBeNull();
    expect(leftSessionFolder(Object.assign(err(`/c/projects/p/${sid}`), { code: "EACCES" }), sid, "/c")).toBeNull();
    expect(leftSessionFolder(new Error("boom"), sid, "/c")).toBeNull();
  });

  test("promptSuggestions passes only after the user's own setting was read as true", async () => {
    const settings = { respondToBashCommands: false, promptSuggestionEnabled: true, cleanupPeriodDays: 14, permissions: { defaultMode: "acceptEdits" } };
    const r = use(
      rig("text-thinking", {
        sdk: {
          resolveSettings: (async () => ({ effective: settings, provenance: {}, sources: [] })) as never,
          filterEscalatingDefaultMode: ((x: { effective: unknown }) => x.effective) as never,
        },
      }),
    );
    const sw = { promptSuggestions: { value: true as const, mark: markOf(MARK_PHRASES.suggestions, now()) } };
    expect(() => r.open({ switches: sw })).toThrow(GateError);
    expect(await r.driver.settings(r.fake.project)).toEqual({ respondToBash: false, cleanupPeriodDays: 14, promptSuggestions: true, defaultMode: "acceptEdits" });
    const { chat, events } = r.open({ switches: sw });
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const init = r.fake.trace().find((l) => l.t === "control" && l.subtype === "initialize")!.request as Record<string, unknown>;
    expect(init.promptSuggestions).toBe(true);
  });

  test("the bypass switch with the Settings switch on starts Claude Code with the flag", async () => {
    const r = use(rig("text-thinking", { allowBypass: () => true }));
    const { chat, events } = r.open({
      switches: { allowBypass: { value: true, mark: markOf(MARK_PHRASES.bypass, now()) } },
      picks: { permissionMode: { value: "bypassPermissions", mark: markOf(MARK_PHRASES.pick, now()) } },
    });
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const args = r.fake.trace().find((l) => l.t === "start")!.args as string[];
    expect(args).toContain("--allow-dangerously-skip-permissions");
    expect(args).toContain("--permission-mode=bypassPermissions");
    expect(events.of("session")[0]!.bypass).toBe(true);
  });
});

describe("every display-only message kind reaches the page through the SDK (6.3, 11.2)", () => {
  test("one turn that emits each kind gives its event", async () => {
    const sys = (subtype: string, rest: Record<string, unknown> = {}) => ({ emit: { type: "system", subtype, ...rest } });
    const r = use(
      rig({
        turns: [
          {
            steps: [
              sys("status", { status: "compacting" }),
              sys("api_retry", { attempt: 1, max_retries: 3, retry_delay_ms: 500, error_status: 529, error: "overloaded" }),
              sys("model_refusal_no_fallback", { original_model: "m", request_id: null, content: "Refused." }),
              sys("informational", { content: "Note", level: "notice" }),
              sys("memory_recall", { mode: "select", memories: [{ path: "/m.md", scope: "personal" }] }),
              sys("plugin_install", { status: "started" }),
              sys("notification", { key: "k", text: "Hi", priority: "low" }),
              sys("compact_boundary", { compact_metadata: { trigger: "auto", pre_tokens: 10 } }),
              { emit: { type: "conversation_reset", new_conversation_id: "$SESSION", trigger: "clear" } },
              sys("local_command_output", { content: "<local-command-stdout>Context: 2%</local-command-stdout>" }),
              { emit: { type: "user", message: { role: "user", content: "<local-command-stderr>Unknown command</local-command-stderr>" }, parent_tool_use_id: null } },
              sys("commands_changed", { commands: [{ name: "compact", description: "c", argumentHint: "" }] }),
              { emit: { type: "prompt_suggestion", suggestion: "Run the tests" } },
              { emit: { type: "auth_status", isAuthenticating: false, output: [] } },
              { emit: { type: "result", subtype: "success", num_turns: 0 } },
            ],
          },
        ],
      }),
    );
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "/context" });
    await events.turnEnds(1);
    const ks: string[] = kinds(events.events);
    for (const k of ["status", "retry", "refusal", "info", "memory", "plugin_install", "toast", "compacted", "reset", "local_output", "commands", "suggestion"]) expect(ks).toContain(k);
    expect(events.of("local_output")).toEqual([
      { k: "local_output", stream: "stdout", text: "Context: 2%" },
      { k: "local_output", stream: "stderr", text: "Unknown command" },
    ]);
  });
});

describe("the binary probe", () => {
  test("probe() finds the fake on its PATH and reads its version (no model call)", async () => {
    const r = use(rig({ version: "2.1.300 (Claude Code)" }));
    const p = await r.driver.probe();
    expect(p).toMatchObject({ ok: true, path: r.fake.bin, realpath: r.fake.bin, version: "2.1.300 (Claude Code)", source: "path", refused: [], platformPackages: [] });
    expect(p.drift).toBe("Claude Code 2.1.300 runs here; this SDK was built for 2.1.322.");
    // 2.1.300 is not below kitespan's minimum (2.1.296), so no line about it.
    expect(p.belowMinimum).toBeNull();
    expect(r.fake.trace().filter((l: TraceLine) => l.t === "start")).toEqual([]);
  });

  test("a claude below kitespan's minimum: the probe says so, as the CLI prints its version", async () => {
    const r = use(rig({ version: "2.1.250-acme.2 (Acme Claude Code)" }));
    const p = await r.driver.probe();
    expect(p).toMatchObject({ ok: true, version: "2.1.250-acme.2 (Acme Claude Code)", belowMinimum: { version: "2.1.250-acme.2", minimum: "2.1.296", stock: false } });
  });
});

describe("the environment the claude child gets (4.7 case 11)", () => {
  test("the SDK adds only its unconditional names, and kitespan's key set turns on none of the conditional ones", async () => {
    const r = use(rig("text-thinking"));
    const parent = new Set(Object.keys(process.env));
    const { chat, events } = r.open();
    await chat.send({ uuid: randomUUID(), text: "Hi" });
    await events.turnEnds(1);
    const names = r.fake.trace().find((l) => l.t === "start")!.envNames as string[];
    const added = names.filter((n) => !parent.has(n) && !SHELL_OWN_ENV_NAMES.includes(n));
    const sdkOwn: readonly string[] = [...SDK_CHILD_ENV.host, ...SDK_CHILD_ENV.added];
    expect(added.filter((n) => !sdkOwn.includes(n))).toEqual([]);
    for (const n of sdkOwn) expect(names).toContain(n);
    expect(added.filter((n) => (SDK_CHILD_ENV.conditional as readonly string[]).includes(n))).toEqual([]);
    expect([...parent].filter((n) => !names.includes(n) && !(SDK_CHILD_ENV.removed as readonly string[]).includes(n))).toEqual([]);
  });
});
