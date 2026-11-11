// R124: the Claude driver's side question end to end: the real Agent SDK's undocumented Query.askSideQuestion runs
// against the fake CLI (test/fake-claude/), which answers `side_question` as Claude Code 2.1.317 does in the lead's
// probe (it5-ui/live/LIVE-NOTES.md): a `control_request_progress` first, then the answer, while a turn runs (which goes
// on) and while none does; history read as `{question, response}` pairs; a cancel answered "Side question cancelled";
// a refusal fallback's notice, never its model names; a null answer; an error. No model, no real claude.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DriverError, type ClaudeChat } from "../../server/agents/claude/driver";
import { SIDE_MISSING, sideAnswerOf, sideProgressOf, sideQuestionOf } from "../../server/agents/claude/side";
import type { SideProgress } from "../../server/agents/types";
import { SIDE_FALLBACK_ARN } from "../../shared/protocol";
import type { Fixture } from "../fake-claude/install";
import { rig, type Rig } from "../fake-claude/harness";

let rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.map((r) => r.cleanup()));
  rigs = [];
});
const use = (r: Rig) => (rigs.push(r), r);
const ask = (chat: ClaudeChat, question: string, opts: { history?: { question: string; response: string }[]; signal?: AbortSignal; onProgress?: (p: SideProgress) => void } = {}) =>
  chat.sideQuestion(question, { history: opts.history ?? [], signal: opts.signal ?? new AbortController().signal, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) });

/** A provider's resource name, put together at run time (no account id in the source; context-arn.test.ts). */
const ARN = ["arn", "aws", "bedrock", "us-east-1", "4321".repeat(3), "application-inference-profile/abc"].join(":");

const FIXTURE: Fixture = {
  sideByText: {
    "retry rule": { delayMs: 300, retries: [{ attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529 }], response: "The retry rule waits 4 s." },
    "slow one": { delayMs: 20_000 },
    refused: { refusal: { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", content: "Opus 5.5 could not answer this, so Sonnet 5.5 did." }, response: "The cap is in src/upload.ts." },
    "provider resource": { refusal: { original_model: ARN, fallback_model: "claude-sonnet-5-5", content: `Answered by ${ARN} instead.` }, response: "Yes." },
    "no answer": { response: null },
    synthetic: { response: "(No answer available for this side question. Try again, or ask in the main conversation.)", synthetic: true },
    empty: { response: "" },
    broken: { error: "Failed to get response" },
  },
  turnsByText: {
    "long bash": {
      steps: [
        { say: { id: "msg_side_1", tools: [{ id: "toolu_side_1", name: "Bash", input: { command: "sleep 2; echo SLEPT" } }] } },
        { sleep: 1_200 },
        { emit: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_side_1", content: "SLEPT" }] }, parent_tool_use_id: null } },
        { say: { id: "msg_side_2", text: "MAIN-DONE" } },
        { emit: { type: "result", subtype: "success", result: "MAIN-DONE" } },
      ],
    },
  },
};

describe("the side question through the SDK", () => {
  test("with no turn: one control request with the question and no history, its progress, the answer; no event of the chat", async () => {
    const r = use(rig(FIXTURE));
    const { chat, events } = r.open();
    const progress: SideProgress[] = [];
    const a = await ask(chat, "Which file holds the cap?", { onProgress: (p) => progress.push(p) });
    expect(a).toEqual({ response: 'Side answer to "Which file holds the cap?" (history 0).', synthetic: false, fallback: null });
    expect(progress).toEqual([{ status: "started" }]);
    const req = r.fake.trace().find((l) => l.t === "control" && l.subtype === "side_question")!.request as Record<string, unknown>;
    expect(req).toEqual({ subtype: "side_question", question: "Which file holds the cap?" });
    expect(r.fake.trace().find((l) => l.t === "side_question")).toMatchObject({ duringTurn: false });
    // Nothing of it is an event of the chat, and no message went to Claude Code.
    await Bun.sleep(50);
    expect(events.events.filter((e) => e.k !== "commands")).toEqual([]);
    expect(r.fake.trace().filter((l) => l.t === "user")).toEqual([]);
  });

  test("history goes as {question, response} pairs, and the answer reads it", async () => {
    const r = use(rig(FIXTURE));
    const { chat } = r.open();
    const history = [{ question: "What is the capital of France?", response: "Paris." }];
    const a = await ask(chat, "Which country is that city the capital of?", { history });
    expect(a?.response).toBe('Side answer to "Which country is that city the capital of?" (history 1: What is the capital of France? -> Paris.).');
    const req = r.fake.trace().find((l) => l.t === "control" && l.subtype === "side_question")!.request as Record<string, unknown>;
    expect(req.history).toEqual(history);
  });

  test("while a turn runs a Bash call: the answer comes, and the turn goes on to its end", async () => {
    const r = use(rig(FIXTURE));
    const { chat, events } = r.open();
    const uuid = randomUUID();
    await chat.send({ uuid, text: "long bash: run it" });
    await events.until((ev) => ev.some((e) => e.k === "tool_call" && e.id === "toolu_side_1" && e.input !== null));
    const a = await ask(chat, "What colour is a clear daytime sky?");
    expect(a?.response).toContain("What colour is a clear daytime sky?");
    expect(events.of("turn_end")).toEqual([]);
    expect(r.fake.trace().find((l) => l.t === "side_question")).toMatchObject({ duringTurn: true });
    await events.turnEnds(1, 8_000);
    expect(events.of("turn_end")[0]).toMatchObject({ ok: true, uuids: [uuid] });
    const text = events.of("block_delta").map((d) => d.text).join("");
    expect(text).toContain("MAIN-DONE");
  });

  test("a retry's progress comes before the answer", async () => {
    const r = use(rig(FIXTURE));
    const { chat } = r.open();
    const progress: SideProgress[] = [];
    const a = await ask(chat, "What does the retry rule do?", { onProgress: (p) => progress.push(p) });
    expect(a?.response).toBe("The retry rule waits 4 s.");
    expect(progress).toEqual([{ status: "started" }, { status: "api_retry", attempt: 2, max: 10, delayMs: 4000 }]);
  });

  test("an abort rejects at once, and Claude Code is told to cancel (its own error comes back)", async () => {
    const r = use(rig(FIXTURE));
    const { chat } = r.open();
    const ctl = new AbortController();
    const p = ask(chat, "the slow one, please", { signal: ctl.signal });
    await r.fake.waitFor((l) => l.t === "side_question");
    const t0 = performance.now();
    ctl.abort("stop");
    await expect(p).rejects.toBeDefined();
    expect(performance.now() - t0).toBeLessThan(1_000);
    const id = (r.fake.trace().find((l) => l.t === "side_question")!.id as string) ?? "";
    await r.fake.waitFor((l) => l.t === "side_cancelled" && l.id === id);
    expect(r.fake.trace().some((l) => l.t === "sdk_cancel" && l.id === id)).toBe(true);
    // The chat goes on: the next side question answers.
    expect((await ask(chat, "Still there?"))?.response).toContain("Still there?");
  });

  test("a refusal fallback keeps Claude Code's notice only; one that names a provider's resource reads as the fixed line", async () => {
    const r = use(rig(FIXTURE));
    const { chat } = r.open();
    expect(await ask(chat, "This one is refused.")).toEqual({ response: "The cap is in src/upload.ts.", synthetic: false, fallback: "Opus 5.5 could not answer this, so Sonnet 5.5 did." });
    const b = await ask(chat, "Names a provider resource?");
    expect(b).toEqual({ response: "Yes.", synthetic: false, fallback: SIDE_FALLBACK_ARN });
    expect(JSON.stringify(b)).not.toContain("arn:");
  });

  test("a null answer is null; a synthetic one and an empty one are as Claude Code gave them; an error throws", async () => {
    const r = use(rig(FIXTURE));
    const { chat } = r.open();
    expect(await ask(chat, "no answer please")).toBeNull();
    expect(await ask(chat, "synthetic please")).toEqual({ response: "(No answer available for this side question. Try again, or ask in the main conversation.)", synthetic: true, fallback: null });
    expect(await ask(chat, "empty please")).toEqual({ response: "", synthetic: false, fallback: null });
    await expect(ask(chat, "broken please")).rejects.toThrow("Failed to get response");
  });

  test("a query with no askSideQuestion is unsupported; a closed chat fails", async () => {
    const r = use(rig(FIXTURE));
    const { chat } = r.open();
    expect((await ask(chat, "warm up"))?.response).toContain("warm up");
    const q = (chat as unknown as { q: Record<string, unknown> }).q;
    const real = q.askSideQuestion;
    q.askSideQuestion = undefined;
    const e = await ask(chat, "unsupported?").catch((x) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect((e as DriverError).code).toBe("unsupported");
    expect((e as DriverError).message).toBe(SIDE_MISSING);
    q.askSideQuestion = real;
    await chat.close();
    await expect(ask(chat, "after the end?")).rejects.toBeDefined();
  });
});

describe("the typed wrapper", () => {
  test("the feature test, the answer's map and the progress's map", () => {
    expect(sideQuestionOf({})).toBeNull();
    expect(sideQuestionOf(null)).toBeNull();
    const o = { askSideQuestion(this: { tag: string }) {
      return Promise.resolve({ response: this.tag });
    }, tag: "bound" };
    expect(typeof sideQuestionOf(o)).toBe("function");
    expect(sideAnswerOf(null)).toBeNull();
    expect(sideAnswerOf({ response: null, synthetic: false })).toBeNull();
    expect(sideAnswerOf({ response: 3 })).toBeNull();
    expect(sideAnswerOf({ response: "x" })).toEqual({ response: "x", synthetic: false, fallback: null });
    expect(sideAnswerOf({ response: "x", synthetic: true, refusalFallback: { originalModel: "a", fallbackModel: "b", content: "  why  " } })).toEqual({ response: "x", synthetic: true, fallback: "why" });
    expect(sideProgressOf({ type: "system", subtype: "control_request_progress", status: "started" })).toEqual({ status: "started" });
    expect(sideProgressOf({ type: "system", subtype: "control_request_progress", status: "api_retry", attempt: 3, max_retries: 10, retry_delay_ms: 8000 })).toEqual({ status: "api_retry", attempt: 3, max: 10, delayMs: 8000 });
    expect(sideProgressOf({ type: "system", subtype: "control_request_progress", status: "api_retry" })).toEqual({ status: "api_retry", attempt: 0, max: 0, delayMs: 0 });
    expect(sideProgressOf({ type: "system", subtype: "control_request_progress", status: "later" })).toBeNull();
    expect(sideProgressOf({ type: "system", subtype: "init" })).toBeNull();
  });
});
