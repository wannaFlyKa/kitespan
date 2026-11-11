// The fake claude's fixture for the click-through (test/fake-claude/fake-claude.ts replays it; no model runs). One
// fixture serves every scene: a scene's warm-up message picks its turn by its text (turnsByText), and so does each
// message that an action check sends (Send, the / command, Start on the new-chat form). The live parts of the seed
// are here: the main turn's to-do list (Claude Code 2.1's task tools), the permission, question, plan and elicitation
// cards that wait, the running subagent, the running workflow and the running Bash call.

import type { Fixture, SideWay, Step, Turn } from "../../fake-claude/install";
import { EX, IDS, LONG_COMMAND } from "./ids";
import { changesTurns } from "./changes";
import { PROJECT_FILES } from "./demo";

type Json = Record<string, unknown>;

const T = EX.toolUse;
const result = (text: string, extra: Json = {}): Step => ({ emit: { type: "result", subtype: "success", result: text, ...extra } });
const toolResult = (id: string, content: string, isError = false, side?: Json, parent: string | null = null): Step => ({
  emit: {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    parent_tool_use_id: parent,
    ...(side ? { tool_use_result: side } : {}),
  },
});
/**
 * A reply's API message id for a turn that may run more than once in one server life (an action pressed at three
 * sizes): the fake fills in the user message's uuid, so each run's blocks get keys of their own.
 */
const EACH = "$USER_UUID";
/** Long enough for any click-through; an interrupt (Stop) ends it at once. */
const HOLD: Step = { sleep: 15 * 60_000 };

/**
 * Row 116: the two ends of a turn that fail with no Stop, for the seen flag's Failed dot (server/chats/seen.ts): a turn
 * that Claude Code ends with an error result (agent view's Failed: turn_end with ok false), and a turn whose Claude
 * Code exits by itself (the exit line). Any chat takes them; dots-seed.test.ts and ui-check's unseen-dot send them.
 */
export const FAILS = {
  turn: "This turn fails on purpose (row 116).",
  exit: "Claude Code exits on purpose (row 116).",
} as const;

/** The texts of the warm-up messages: the harness sends one to put the example chat in its scene's state. */
export const WARM = {
  main: "Run the upload test 20 times.",
  permission: "Clean the build folder and rebuild, then run the test once more.",
  question: "Add tests for the retry fix. Ask me which layers first.",
  plan: "Plan the retry tests before you change anything.",
  elicitation: "Search the docs server for the sync API and summarize it.",
  agent: "Find every caller of uploadFile again, now with the new signature.",
  workflow: "Review the fix from three angles, then check each finding.",
  running: "Run the full upload suite with coverage.",
  /** Sent while the running scene's turn runs, under the example message id: it shows Queued, with Take back. */
  queued: "Keep the old uploadFile signature as a wrapper until the callers move.",
  /** The not-sent scene's message: it waited in the queue file when kitespan stopped, so it shows Not sent (RD-8). */
  notSent: "Rerun the upload test once the retry fix lands.",
} as const;

export const QUESTIONS = [
  {
    question: "Which tests should the fix add?",
    header: "Test layers",
    multiSelect: true,
    options: [
      { label: "Unit tests", description: "uploadFile with a fake fetch that fails twice" },
      { label: "Click-through", description: "Drop a file in the page and watch it arrive" },
      { label: "Live smoke test", description: "One real upload to the scratch server" },
    ],
  },
  {
    question: "How many reruns should the flaky check use?",
    header: "Reruns",
    multiSelect: false,
    options: [
      { label: "5", description: "Fast; catches a one-in-five failure most of the time" },
      { label: "20", description: "Slower; the number used before the fix" },
    ],
  },
];

export const PLAN_MD =
  "## Plan: tests for the upload retry\n\n1. Add a fake fetch to `test/helpers/fake-fetch.ts` that fails a set number of times.\n2. Unit-test `uploadFile`: two failures, then success; the same bytes on every try.\n3. Rerun the flaky check 20 times in CI.\n4. Note the retry timing in `docs/UPLOAD-RETRIES.md`.";

const RERUN20 = " 20 pass\n 0 fail\nRan 20 tests across 1 file. [2.31s]";

/** A TaskCreate call of the main turn, and its result in the CLI's words (Claude Code 2.1 has no TodoWrite). */
const TASKS = [
  { id: "toolu_01TaskRerun20", subject: "Run the upload test 20 times", description: "Rerun test/upload.test.ts 20 times with the fix", activeForm: "Running the upload test 20 times" },
  { id: "toolu_01TaskRebuild", subject: "Clean the build folder and rebuild", description: "Remove build/ and run bun run build", activeForm: "Rebuilding" },
  { id: "toolu_01TaskLastRun", subject: "Run the upload test once more", description: "One last run on the fresh build", activeForm: "Running the upload test once more" },
];
const taskUpdate = (msg: string, id: string, status: string): Step[] => [
  { say: { id: msg, tools: [{ id, name: "TaskUpdate", input: { taskId: "1", status } }] } },
  toolResult(id, "Updated task #1 status", false, { success: true, taskId: "1", updatedFields: ["status"] }),
];

/**
 * The resume flows of the click-through (scripts/ui-check.ts resume-drop, resume-reload, resume-slow, resume-blackhole
 * and resume-tail, and restart-now; build checklist R19, S10, done checks 3, 4, 5 and 9): one turn per run, picked by
 * its tag, with ids of its own, since the runs share a server life. A paced reply (A), then a Bash call (B) whose
 * permission card waits, and after Allow a second paced reply (C). A flow knows each block's whole text, so a block
 * that a replay drew twice shows. The tail runs' reply A is long and slow (RESUME_LONG, about 15 s), so a page that
 * opens while it streams gets a snapshot with a tail of its pieces.
 */
export const RESUME_TAGS = [
  "drop-laptop",
  "drop-phone",
  "reload-phone",
  "reload-medium",
  "slow-laptop",
  "slow-phone",
  "blackhole-laptop",
  "blackhole-phone",
  "tail-laptop",
  "tail-phone",
  "now-laptop",
  "now-phone",
  // U1's changes-card: its Bash call runs 1.5 s after the Allow (the flow writes the command's files then).
  "changes-laptop",
  // v0.6 touch: resume-drop and resume-reload at 626x890 and the large tablet (DESIGN-T1 3.1), each a turn of its own.
  "drop-m626",
  "drop-large",
  "reload-m626",
  "reload-large",
] as const;
export type ResumeTag = (typeof RESUME_TAGS)[number];
export const RESUME_A =
  "First I read the resume path from the top. The page keeps its cursor for each chat and sends it with every attach, the server replays what the page missed from the chat's ring, and a waiting card comes back with the attached frame before any of it. Now I run the resume test once.";
export const RESUME_C = "The resume test passes. Every event came back once, in order, and the card was the first thing drawn after the link came back.";
/** The tail runs' reply A: RESUME_A and three more sentences, in 100 pieces. */
export const RESUME_LONG = `${RESUME_A} The snapshot is the history the server read, and its tail is every event of the ring after it, counted, so the page knows when the tail ends. A cut in the middle of the tail leaves the page with a cursor that names the last event it drew. The next attach replays from there, and no piece of this reply is drawn twice.`;
/** The pieces of each paced reply and the wait after each (about 3.6 s for A, 15 s for a tail run's A, 2.4 s for C). */
const RESUME_PACE = { a: 24, long: 100, c: 16, ms: 150 } as const;

/** The whole text of reply A of a run. */
export const resumeReply = (tag: ResumeTag): string => (tag.startsWith("tail-") ? RESUME_LONG : RESUME_A);

export interface ResumeTurn {
  /** The message that starts the turn. */
  text: string;
  /** The API message ids of the two replies (their blocks are `<id>-0`), and the Bash call's id, which is the card's. */
  ids: { a: string; c: string; b: string; tool: string };
}

export function resumeTurn(tag: ResumeTag): ResumeTurn {
  const name = tag.replace(/(^|-)([a-z])/g, (_m, _d, c: string) => c.toUpperCase());
  return { text: `Walk the resume check ${tag} now.`, ids: { a: `msg_01Resume${name}A`, b: `msg_01Resume${name}B`, c: `msg_01Resume${name}C`, tool: `toolu_01Resume${name}` } };
}

/**
 * Row 111, the send-now flows of the click-through (scripts/ui-check.ts send-now and send-now-key): two turns picked by
 * their text, with ids of their own on every run, since the runs share a server life. `bash`: a Bash call that runs in
 * the foreground (its task starts 0.6 s after the call, as Claude Code's does a few seconds late, and runs 30 s), so
 * Send now on a message queued behind it moves it to the background: the call returns at once with Claude Code's
 * background line, the message goes into the same turn at that tool boundary, and the reply follows; the command's end
 * then starts a short turn of its own ("The background task finished."). With no press the call ends by itself at 30 s,
 * and a queued message goes into the turn at that boundary.
 * `write`: a reply that streams for about 30 s, so Send now stops the turn (Stop's end) and the queued message runs
 * next as a turn of its own, whose reply is the fixture's default ("Done.").
 */
export const SEND_NOW = {
  bash: "Run the send-now check's long command.",
  write: "Write the send-now check's long story.",
} as const;
export const SEND_NOW_REPLIES = {
  /** Before the call. */
  bashStart: "Running the long command now.",
  /** After the call returned (moved to the background, or ended): Claude read the queued message. */
  bashRead: "I read your new message, and I'll do that next.",
  write: "The send-now story: ".concat("A kite rose over the river and the city watched it climb. ".repeat(30)).trim(),
} as const;

/**
 * R124, the side chat's questions in the click-through (scripts/ui-check.ts side-chat and side-chat-running, and
 * side-seed.test.ts): each one picks its own way of answering by its text (Fixture.sideByText); any other question
 * gets SIDE_ANSWERS.other after 1.5 s. Nothing of a side question goes into the chat's transcript.
 */
export const SIDE = {
  /** Answered after 1.5 s, with a list and code spans. */
  ask: "Why did the second test time out?",
  /** A follow-up: its answer names the question asked just before it, which it read in the history. */
  followUp: "Where should the listener go, then?",
  /** The text of the route example's link (/c/<chat>/btw?text=...): answered after 1.5 s. */
  link: "Which file holds the cap?",
  /** Never answers by itself (15 minutes): Stop is the way out. */
  slow: "Walk me through every retry, one at a time.",
  /** Two retries (the second: "Retrying (2 of 10) in 4 s"), then the answer after 8 s. */
  retry: "Is the upload server up again?",
  /** Fails after 1 s with Claude Code's error. */
  fail: "Which branch has the fix?",
  /** A fallback model answers, with Claude Code's notice. */
  fallback: "Could the fix break the push command?",
  /** Claude Code's own answer, marked synthetic. */
  synthetic: "What did the subagent find?",
  /** An empty answer. */
  empty: "Answer with nothing at all.",
} as const;

export const SIDE_ANSWERS = {
  ask: "The second test waits for the `uploaded` event, but the fake server sends it before the listener is attached, so the wait never ends.\n\n- Attach the listener before the first `PUT`.\n- Or await `server.ready` first, as the first test does.",
  /** `$LAST_QUESTION`: the fake claude puts the history's last question there. */
  followUp: "Right after `const server = await fakeServer()`, before `uploadFile(...)` runs, in `test/upload.test.ts`. That is from your question before this one: “$LAST_QUESTION”",
  link: "`src/upload.ts` holds it: `MAX_UPLOAD_BYTES`, 25 MiB, checked before the first try.",
  retry: "Yes. The last three uploads in the log went through.",
  fail: "Failed to get response",
  fallback: "Not likely: `src/cli/push.ts` passes a stream, which the fix reads the same way. Run `bun test test/cli` to be sure.",
  /** Claude Code's notice for the fallback (its `content`). */
  fallbackNotice: "Opus 5.5 declined to answer, so Sonnet 5.5 answered this question.",
  synthetic: "(No answer available for this side question. Try again, or ask in the main conversation.)",
  other: "From what is in the chat so far: the fix retries the `PUT` with the same body, and all 20 runs passed.",
} as const;

/**
 * R127: merged over the fixture for a boot whose fake claude answers the trust start's attestation with
 * `workspace_trust_recorded: false` (Claude Code recorded nothing). scripts/ui-check.ts trust-folder boots seeds of the
 * trust scene with it for the fallback: the answer not recorded, the line's Open in terminal, then the pane.
 */
export const TRUST_NOT_RECORDED: Partial<Fixture> = { workspaceTrust: { recorded: false } };

function sideWays(): { side: SideWay; sideByText: Record<string, SideWay> } {
  return {
    side: { delayMs: 1_500, response: SIDE_ANSWERS.other },
    sideByText: {
      [SIDE.ask]: { delayMs: 1_500, response: SIDE_ANSWERS.ask },
      [SIDE.followUp]: { delayMs: 1_500, response: SIDE_ANSWERS.followUp },
      [SIDE.link]: { delayMs: 1_500, response: SIDE_ANSWERS.link },
      [SIDE.slow]: { delayMs: 15 * 60_000 },
      [SIDE.retry]: {
        delayMs: 8_000,
        retries: [
          { attempt: 1, max_retries: 10, retry_delay_ms: 2_000, error_status: 529 },
          { attempt: 2, max_retries: 10, retry_delay_ms: 4_000, error_status: 529 },
        ],
        response: SIDE_ANSWERS.retry,
      },
      [SIDE.fail]: { delayMs: 1_000, error: SIDE_ANSWERS.fail },
      [SIDE.fallback]: { delayMs: 1_500, response: SIDE_ANSWERS.fallback, refusal: { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", content: SIDE_ANSWERS.fallbackNotice } },
      [SIDE.synthetic]: { delayMs: 800, response: SIDE_ANSWERS.synthetic, synthetic: true },
      [SIDE.empty]: { delayMs: 800, response: "" },
    },
  };
}

/**
 * v0.6 touch (T-26, the cut-output flow): a Bash call whose result is 7,000 characters, more than the 6,000 the server
 * sends, so its row says the output was cut and Download output serves the whole text from the transcript.
 */
export const CUT_OUTPUT = {
  prompt: "Print the long upload log",
  reply: "Here is the whole upload log.",
  tool: "toolu_01CutLog$USER_UUID",
  command: "cat logs/upload-retries.log",
  text: Array.from({ length: 100 }, (_, i) => `${String(i + 1).padStart(3, "0")} upload retry ${String(i % 7).padStart(2, "0")}: waited 250 ms, then sent the same 4096 bytes`.padEnd(69, ".")).join("\n") + ".",
} as const;

function cutTurns(): Record<string, Turn> {
  const call = CUT_OUTPUT.tool;
  return {
    [CUT_OUTPUT.prompt]: {
      steps: [
        { say: { id: "msg_01CutLog$USER_UUID", text: "Reading the log.", tools: [{ id: call, name: "Bash", input: { command: CUT_OUTPUT.command, description: "Print the upload log" } }] } },
        toolResult(call, CUT_OUTPUT.text, false, { stdout: CUT_OUTPUT.text, stderr: "", interrupted: false }),
        { say: { id: "msg_01CutDone$USER_UUID", text: CUT_OUTPUT.reply } },
        result(CUT_OUTPUT.reply),
      ],
    },
  };
}

/**
 * v0.6 touch (the stream-hold flow): a Bash call with a short result, then a long reply that streams slowly, so its row
 * stays in view while the view follows the end and a finger can hold it then.
 */
export const STREAM_HOLD = {
  prompt: "Stream the retry notes",
  tool: "toolu_01StreamHold$USER_UUID",
  command: "ls logs",
  output: "upload-retries.log",
  reply: Array.from({ length: 160 }, (_, i) => `Retry note ${i + 1}: the client waited, then sent the same bytes again.`).join("\n\n"),
  chunks: 400,
  paceMs: 60,
} as const;

function streamHoldTurns(): Record<string, Turn> {
  const call = STREAM_HOLD.tool;
  return {
    [STREAM_HOLD.prompt]: {
      steps: [
        { say: { id: "msg_01StreamHoldA$USER_UUID", text: "Listing the logs.", tools: [{ id: call, name: "Bash", input: { command: STREAM_HOLD.command, description: "List the logs" } }] } },
        toolResult(call, STREAM_HOLD.output, false, { stdout: STREAM_HOLD.output, stderr: "", interrupted: false }),
        { say: { id: "msg_01StreamHoldB$USER_UUID", text: STREAM_HOLD.reply, chunks: STREAM_HOLD.chunks, paceMs: STREAM_HOLD.paceMs } },
        result("The notes are above."),
      ],
    },
  };
}

function sendNowTurns(): Record<string, Turn> {
  const call = "toolu_01SendNow$USER_UUID";
  const input = { command: "sleep 30", description: "Run the long command" };
  return {
    [SEND_NOW.bash]: {
      fold: true,
      steps: [
        { say: { id: "msg_01SendNowA$USER_UUID", text: SEND_NOW_REPLIES.bashStart, tools: [{ id: call, name: "Bash", input }] } },
        { task: { toolUseId: call, description: input.description, startMs: 600, runMs: 30_000, output: "" } },
        { say: { id: "msg_01SendNowB$USER_UUID", text: SEND_NOW_REPLIES.bashRead } },
        result(SEND_NOW_REPLIES.bashRead),
      ],
    },
    [SEND_NOW.write]: { steps: [{ say: { id: "msg_01SendNowC$USER_UUID", text: SEND_NOW_REPLIES.write, chunks: 300, paceMs: 100 } }, result(SEND_NOW_REPLIES.write)] },
  };
}

function resumeTurns(): Record<string, Turn> {
  const out: Record<string, Turn> = {};
  for (const tag of RESUME_TAGS) {
    const { text, ids } = resumeTurn(tag);
    const input = { command: "bun test test/resume.test.ts", description: "Run the resume test once" };
    out[text] = {
      steps: [
        { say: { id: ids.a, text: resumeReply(tag), chunks: tag.startsWith("tail-") ? RESUME_PACE.long : RESUME_PACE.a, paceMs: RESUME_PACE.ms } },
        { say: { id: ids.b, tools: [{ id: ids.tool, name: "Bash", input }] } },
        {
          ask: { subtype: "can_use_tool", tool_name: "Bash", input, tool_use_id: ids.tool, description: input.description, decision_reason: "Run the resume test once" },
          then: {
            allow: [...(tag === "changes-laptop" ? [{ sleep: 1500 }] : []), toolResult(ids.tool, " 1 pass\n 0 fail"), { say: { id: ids.c, text: RESUME_C, chunks: RESUME_PACE.c, paceMs: RESUME_PACE.ms } }, result(RESUME_C)],
            deny: [toolResult(ids.tool, "The user denied this tool use.", true), result("")],
          },
        },
      ],
    };
  }
  return out;
}

const turns: Record<string, Turn> = {
  // U1: the turns that change files (seed/changes.ts).
  ...changesTurns(PROJECT_FILES.kitespan),
  // main: the chat answers and goes idle, so its Claude Code is live for the pickers, the / menu and Connectors. It
  // tracks its steps with the task tools: three TaskCreate calls and two TaskUpdate calls make the turn's to-do row.
  "upload test 20 times": {
    steps: [
      { say: { id: "msg_01TaskPlan", text: "I'll track the last steps as tasks.", tools: TASKS.map(({ id, ...input }) => ({ id, name: "TaskCreate", input })) } },
      ...TASKS.map((t, i) => toolResult(t.id, `Task #${i + 1} created successfully: ${t.subject}`, false, { task: { id: String(i + 1), subject: t.subject } })),
      ...taskUpdate("msg_01TaskStart", "toolu_01TaskStart", "in_progress"),
      { say: { id: "msg_01Rerun20", text: "Running it 20 times now.", tools: [{ id: "toolu_01Rerun20", name: "Bash", input: { command: "bun test test/upload.test.ts --rerun-each 20", description: "Run the upload test 20 times" } }] } },
      toolResult("toolu_01Rerun20", RERUN20, false, { stdout: RERUN20, stderr: "", interrupted: false }),
      ...taskUpdate("msg_01TaskDone", "toolu_01TaskDone", "completed"),
      { say: { id: "msg_01Holds", text: "The fix holds in 20 of 20 runs. I want to clean the build folder and rebuild before the last run." } },
      result("The fix holds in 20 of 20 runs."),
    ],
  },
  "Clean the build folder": {
    steps: [
      { say: { id: "msg_01Clean", text: "I'll clean the build folder and rebuild first.", tools: [{ id: T, name: "Bash", input: { command: "rm -rf build && bun run build", description: "Clean the build folder and rebuild" } }] } },
      {
        ask: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf build && bun run build", description: "Clean the build folder and rebuild" },
          tool_use_id: T,
          description: "Clean the build folder and rebuild",
          decision_reason: "Clean the build folder and rebuild before the last test run",
          permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun run build" }], behavior: "allow", destination: "localSettings" }],
        },
        then: {
          allow: [toolResult(T, "Built in 1.4 s."), { say: { id: "msg_01Built", text: "Built. The last run passes too." } }, result("Built. The last run passes too.")],
          deny: [toolResult(T, "The user denied this tool use.", true), { say: { id: "msg_01NotBuilt", text: "I left the build folder as it is." } }, result("I left the build folder as it is.")],
        },
      },
    ],
  },
  "Ask me which layers": {
    steps: [
      { say: { id: "msg_01AskLayers", text: "Before I write anything, two questions.", tools: [{ id: T, name: "AskUserQuestion", input: { questions: QUESTIONS } }] } },
      {
        ask: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: QUESTIONS }, tool_use_id: T },
        then: {
          allow: [toolResult(T, "User has answered your questions."), { say: { id: "msg_01Layers", text: "I'll write those tests next." } }, result("I'll write those tests next.")],
          deny: [toolResult(T, "The user dismissed the question.", true), result("")],
        },
      },
    ],
  },
  "Plan the retry tests": {
    steps: [
      { say: { id: "msg_01PlanTests", text: "Here is my plan.", tools: [{ id: T, name: "ExitPlanMode", input: { plan: PLAN_MD } }] } },
      {
        ask: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: PLAN_MD }, tool_use_id: T },
        then: {
          allow: [toolResult(T, "User has approved your plan."), { say: { id: "msg_01PlanGo", text: "Starting on the plan." } }, result("Starting on the plan.")],
          deny: [toolResult(T, "The user doesn't want to proceed with this plan.", true), { say: { id: "msg_01PlanMore", text: "I will keep planning." } }, result("I will keep planning.")],
        },
      },
    ],
  },
  // The elicitation card's id is the control request's id, so the request goes out as it is, under the example id.
  "Search the docs server": {
    steps: [
      { say: { id: "msg_01Docs", text: "I'll search the docs server.", tools: [{ id: "toolu_01DocsSearch", name: "mcp__docs-search__search", input: { query: "sync API" } }] } },
      {
        emit: {
          type: "control_request",
          request_id: EX.request,
          request: {
            subtype: "elicitation",
            mcp_server_name: EX.connector,
            message: "The docs server needs your workspace name and an access mode before it can search.",
            mode: "form",
            title: "Sign in to the docs server",
            display_name: "Docs search",
            requested_schema: {
              type: "object",
              properties: { workspace: { type: "string", title: "Workspace" }, readOnly: { type: "boolean", title: "Read only" } },
              required: ["workspace"],
            },
          },
        },
      },
      HOLD,
    ],
  },
  // A foreground subagent that keeps running (Run in background and Stop act on it).
  "Find every caller of uploadFile again": {
    steps: [
      { emit: { type: "system", subtype: "status", status: "requesting" } },
      {
        say: {
          id: "msg_01AgentCallers",
          text: "I'll have an Explore agent find every caller.",
          tools: [{ id: T, name: "Agent", input: { description: "Find every caller of uploadFile", subagent_type: "Explore", run_in_background: false, prompt: "List every file that calls uploadFile, with the line, so the new signature can be wired in." } }],
        },
      },
      {
        emit: {
          type: "system",
          subtype: "task_started",
          task_id: IDS.tasks.agent,
          run_id: "run-click-agent",
          tool_use_id: T,
          description: "Find every caller of uploadFile",
          subagent_type: "Explore",
          is_backgrounded: false,
          spawn_depth: 1,
          task_type: "local_agent",
          prompt: "List every file that calls uploadFile, with the line, so the new signature can be wired in.",
        },
      },
      { emit: { type: "user", message: { role: "user", content: [{ type: "text", text: "List every file that calls uploadFile, with the line." }] }, parent_tool_use_id: T } },
      { say: { id: "msg_01AgentGrep", parent: T, tools: [{ id: "toolu_01AgentGrep", name: "Grep", input: { pattern: "uploadFile\\(", path: "." } }] } },
      toolResult("toolu_01AgentGrep", "src/sync.ts:3\nsrc/cli/push.ts:3\ntest/upload.test.ts:7", false, undefined, T),
      { say: { id: "msg_01AgentRead", parent: T, tools: [{ id: "toolu_01AgentRead", name: "Read", input: { file_path: "src/sync.ts" } }] } },
      { say: { id: "msg_01AgentText", parent: T, text: "Two callers pass a stream so far: src/sync.ts and src/cli/push.ts." } },
      {
        emit: {
          type: "system",
          subtype: "task_progress",
          task_id: IDS.tasks.agent,
          run_id: "run-click-agent",
          tool_use_id: T,
          description: "Reading src/sync.ts",
          subagent_type: "Explore",
          usage: { total_tokens: 7_200, tool_uses: 3, duration_ms: 18_000 },
          last_tool_name: "Read",
        },
      },
      HOLD,
    ],
  },
  // A workflow that runs while Claude waits on it (Stop acts on it). The turn stays open: a page that attaches after
  // the turn ended would get no task events of the workflow (the server replays only the newest `tasks` set).
  "Review the fix from three angles": {
    steps: [
      { say: { id: "msg_01Workflow", text: "I'll run a review workflow.", tools: [{ id: T, name: "Workflow", input: { script: "export const meta = { name: 'review-upload-fix', description: 'Review the fix from three angles, then check each finding' };" } }] } },
      { emit: { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: IDS.tasks.workflow, run_id: "run-click-wf", task_type: "local_workflow", description: "Review the fix from three angles, then check each finding" }] } },
      {
        emit: {
          type: "system",
          subtype: "task_started",
          task_id: IDS.tasks.workflow,
          run_id: "run-click-wf",
          tool_use_id: T,
          description: "Review the fix from three angles, then check each finding",
          task_type: "local_workflow",
          workflow_name: "review-upload-fix",
          prompt: "export const meta = { name: 'review-upload-fix' };",
        },
      },
      toolResult(T, `Workflow launched in background. Task ID: ${IDS.tasks.workflow}`, false, { status: "async_launched", taskId: IDS.tasks.workflow, workflowName: "review-upload-fix" }),
      {
        emit: {
          type: "system",
          subtype: "task_progress",
          task_id: IDS.tasks.workflow,
          run_id: "run-click-wf",
          tool_use_id: T,
          description: "Review: tests",
          usage: { total_tokens: 21_000, tool_uses: 14, duration_ms: 64_000 },
          last_tool_name: "tests",
          summary: "Review the fix from three angles, then check each finding",
          workflow_progress: [
            { type: "workflow_phase", index: 1, title: "Review" },
            { type: "workflow_agent", index: 1, label: "correctness", phaseIndex: 1, phaseTitle: "Review", state: "done", attempt: 1, promptPreview: "Check that every try sends the same bytes.", resultPreview: "No problem found." },
            { type: "workflow_agent", index: 2, label: "retries and timeouts", phaseIndex: 1, phaseTitle: "Review", state: "done", attempt: 1, promptPreview: "Check the backoff and the last error.", resultPreview: "The last error is kept and thrown." },
            { type: "workflow_agent", index: 3, label: "tests", phaseIndex: 1, phaseTitle: "Review", state: "start", attempt: 1, promptPreview: "Check that the test covers two failures." },
            { type: "workflow_phase", index: 2, title: "Verify" },
            { type: "workflow_agent", index: 4, label: "verify finding 1", phaseIndex: 2, phaseTitle: "Verify", state: "queued", attempt: 1 },
            { type: "workflow_agent", index: 5, label: "verify finding 2", phaseIndex: 2, phaseTitle: "Verify", state: "queued", attempt: 1 },
          ],
        },
      },
      HOLD,
    ],
  },
  // A Bash call that keeps running (Stop stops the turn; Run in background backgrounds the call).
  "full upload suite": {
    steps: [
      { say: { id: "msg_01Suite", text: "Running the whole upload suite with coverage.", tools: [{ id: T, name: "Bash", input: { command: "bun test test/upload --coverage", description: "Run the upload suite with coverage" } }] } },
      { emit: { type: "tool_progress", tool_use_id: T, tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 3 } },
      { sleep: 1_000 },
      { emit: { type: "tool_progress", tool_use_id: T, tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 4 } },
      HOLD,
    ],
  },
  // The messages that action checks send.
  "Run the tests again": { steps: [{ say: { id: EACH, text: "All 21 upload tests pass." } }, result("All 21 upload tests pass.")] },
  "/compact": {
    steps: [
      { emit: { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 114_000 } } },
      { say: { id: EACH, text: "Compacted. The test plan is kept." } },
      result("Compacted."),
    ],
  },
  "Plan the upload feature": { steps: [{ say: { id: EACH, text: "Here is a first plan for the upload feature: a drop target, a progress row and a retry." } }, result("Here is a first plan.")] },
  [FAILS.turn]: {
    steps: [
      { say: { id: EACH, text: "Reading the index files." } },
      { emit: { type: "result", subtype: "error_during_execution", is_error: true, result: "", errors: ["The index files could not be read."] } },
    ],
  },
  [FAILS.exit]: { steps: [{ say: { id: EACH, text: "Reading the index files." } }, { exit: 1, stderr: ["The fake Claude Code exits on purpose (row 116)."] }] },
  ...resumeTurns(),
  ...sendNowTurns(),
  ...cutTurns(),
  ...streamHoldTurns(),
};

export function clickFixture(): Fixture {
  return {
    version: "2.1.312 (Claude Code)",
    model: "claude-opus-5-5",
    transcript: true,
    initialize: {
      commands: [
        { name: "clear", description: "Start a new conversation in this chat", argumentHint: "", builtin: true },
        { name: EX.command, description: "Clear conversation history but keep a summary in context", argumentHint: "[instructions]", builtin: true },
        { name: "context", description: "Show current context usage", argumentHint: "", builtin: true },
        { name: "review", description: "Review the changes on this branch", argumentHint: "", builtin: true },
        { name: "init", description: "Write a CLAUDE.md for this folder", argumentHint: "", builtin: true },
        { name: "memory", description: "Edit memory files", argumentHint: "", builtin: true },
        { name: "mcp", description: "Manage MCP servers", argumentHint: "", builtin: true },
        { name: "cost", description: "Show this session's usage", argumentHint: "", builtin: true },
        { name: "doctor", description: "Check your Claude Code install", argumentHint: "", builtin: true },
        { name: "deploy-notes", description: "Draft release notes from the last tag", argumentHint: "[tag]" },
        { name: "tidy", description: "Tidy imports and run the formatter", argumentHint: "" },
        { name: LONG_COMMAND, description: "Sync every package of the workspace (a plugin's command)", argumentHint: "[packages]" },
      ],
      models: [
        { value: "default", displayName: "Default (recommended)", description: "Use the default model (currently Opus 5.5)", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
        { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable for complex work", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
        { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Fast and capable for everyday work", supportedEffortLevels: ["low", "medium", "high", "xhigh"], supportsAutoMode: true },
        { value: EX.model, displayName: "Haiku 5.5", description: "Fastest for quick answers", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
        { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Earlier Opus", supportedEffortLevels: ["low", "medium", "high"], supportsAutoMode: false },
      ],
      account: { apiProvider: "firstParty" },
    },
    initMessage: {
      mcp_servers: [
        { name: "github", status: "connected" },
        { name: EX.connector, status: "failed" },
        { name: "tickets", status: "needs-auth" },
      ],
      terminal_slash_commands: ["doctor"],
    },
    control: {
      mcp_status: {
        mcpServers: [
          // get_file declares an MCP Apps view (a ui:// resource): the row says kitespan does not draw it (6.3, 8.4).
          { name: "github", status: "connected", scope: "user", tools: [{ name: "create_issue" }, { name: "list_pull_requests" }, { name: "get_file", _meta: { ui: { resourceUri: "ui://github/file-view" } } }] },
          { name: EX.connector, status: "failed", scope: "project", error: "The server closed the connection during start-up.", tools: [] },
          { name: "tickets", status: "needs-auth", scope: "user", tools: [] },
        ],
      },
      get_context_usage: {
        categories: [
          { name: "System prompt", tokens: 6_400, color: "c1", kind: "used" },
          { name: "System tools", tokens: 14_200, color: "c2", kind: "used" },
          { name: "MCP tools", tokens: 21_800, color: "c3", kind: "used" },
          { name: "Memory files", tokens: 3_100, color: "c4", kind: "used" },
          { name: "Messages", tokens: 68_500, color: "c5", kind: "used" },
          { name: "Free space", tokens: 86_000, color: "c6", kind: "free" },
        ],
        totalTokens: 114_000,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        percentage: 57,
        gridRows: [],
        model: "claude-opus-5-5",
        memoryFiles: [],
        mcpTools: [],
      },
      generate_session_title: { title: "Plan the upload feature" },
    },
    turnsByText: turns,
    defaultTurn: { steps: [{ say: { id: EACH, text: "Done." } }, result("Done.")] },
    ...sideWays(),
  };
}
