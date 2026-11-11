// The demo content of the click-through seed: the chats of the approved prototype (web/state/mock.ts, iteration 1's
// prototype/src/state/mock.ts) written as Claude Code transcripts, the project folders they work in, and the uploads.
// Pure data and small builders; write.ts puts them on disk.
//
// The example chat holds the prototype's c_demo01 tour: a table and code in one reply, a thinking block, Read, Grep
// and Bash rows, a subagent, an Edit with its diff, a to-do list, a workflow, a /context output and a ! command. Its
// ids that the route examples name come in through `UploadSlots`, because each scene gives the example tool-use id to
// a different row (the Edit for /tool/, the live card for /permission/, and so on): one chat cannot have two rows with
// one id.

import { deflateSync } from "node:zlib";
import { EX, IDS } from "./ids";

// ---------------------------------------------------------------------------------------------------------------
// Transcripts, as Claude Code writes them: one JSON line per user message, per tool result and per block of an
// assistant message (one record per block, all with the API message's id), chained by parentUuid.

type Json = Record<string, unknown>;

export interface TranscriptFile {
  sessionId: string;
  /** The folder the session ran in (the project's real path). */
  cwd: string;
  /** `sdk-ts` for a kitespan chat; `cli` for a session started in a terminal (From the terminal lists only those). */
  entrypoint: "sdk-ts" | "cli";
  lines: string[];
}

const CLI_VERSION = "2.1.322";
const MODEL = "claude-opus-5-5";

export class Transcript {
  private readonly lines: string[] = [];
  private parent: string | null = null;
  private n = 0;
  private at: number;

  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    readonly entrypoint: "sdk-ts" | "cli",
    startMs: number,
  ) {
    this.at = startMs;
  }

  /** A record uuid of this session: the session's first group, then a counter (unique across the seed). */
  private nextUuid(): string {
    this.n++;
    return `${this.sessionId.slice(0, 8)}-0000-4000-8000-${this.n.toString(16).padStart(12, "0")}`;
  }

  private push(type: "user" | "assistant" | "system", uuid: string, body: Json): void {
    this.at += 20_000;
    this.lines.push(
      JSON.stringify({
        parentUuid: this.parent,
        isSidechain: false,
        userType: "external",
        cwd: this.cwd,
        sessionId: this.sessionId,
        version: CLI_VERSION,
        gitBranch: "main",
        entrypoint: this.entrypoint,
        type,
        ...body,
        uuid,
        timestamp: new Date(this.at).toISOString(),
      }),
    );
    this.parent = uuid;
  }

  user(text: string, uuid: string = this.nextUuid()): string {
    this.push("user", uuid, { message: { role: "user", content: text } });
    return uuid;
  }

  /** The tool results of the last assistant message, in one user record. */
  results(items: { id: string; content: string | Json[]; isError?: boolean }[], toolUseResult?: unknown): string {
    const uuid = this.nextUuid();
    this.push("user", uuid, {
      message: { role: "user", content: items.map((r) => ({ tool_use_id: r.id, type: "tool_result", content: r.content, is_error: r.isError === true })) },
      ...(toolUseResult === undefined ? {} : { toolUseResult }),
    });
    return uuid;
  }

  /**
   * One API message: one record per block. `uuids` names the records' uuids (the thinking example uses the message
   * id the route names); the rest are made.
   */
  assistant(apiId: string, blocks: Json[], uuids: (string | undefined)[] = []): void {
    blocks.forEach((b, i) => {
      const last = i === blocks.length - 1;
      this.push("assistant", uuids[i] ?? this.nextUuid(), {
        message: {
          id: apiId,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [b],
          stop_reason: last ? (b.type === "tool_use" ? "tool_use" : "end_turn") : null,
          stop_sequence: null,
          usage: { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 4200, output_tokens: 80 },
        },
        requestId: `req_${apiId.replace(/[^A-Za-z0-9]/g, "").slice(-16)}`,
      });
    });
  }

  file(): TranscriptFile {
    return { sessionId: this.sessionId, cwd: this.cwd, entrypoint: this.entrypoint, lines: [...this.lines] };
  }
}

const text = (t: string): Json => ({ type: "text", text: t });
const thinking = (t: string): Json => ({ type: "thinking", thinking: t, signature: "c2VlZA==" });
const tool = (id: string, name: string, input: Json): Json => ({ type: "tool_use", id, name, input });

// ---------------------------------------------------------------------------------------------------------------
// The project folders

export interface Folders {
  kitespan: string;
  notes: string;
  scratch: string;
}

const UPLOAD_TS = `// Upload one file with up to three tries. The body is read once into memory, so every try sends the same bytes.
export async function uploadFile(url: string, body: ReadableStream<Uint8Array>): Promise<Response> {
  const bytes = await new Response(body).arrayBuffer();
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body: bytes.slice(0) });
      if (res.ok) return res;
      last = new Error(\`upload failed with HTTP \${res.status}\`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
  }
  throw last instanceof Error ? last : new Error("upload failed");
}
`;

const UPLOAD_TEST_TS = `import { expect, test } from "bun:test";
import { uploadFile } from "../src/upload";
import { fakeFetch } from "./helpers/fake-fetch";

test("upload > sends the file", async () => {
  const fetch = fakeFetch({ failFirst: 2 });
  const body = new Blob(["hello"]).stream();
  const res = await uploadFile("http://upload.test/file", body);
  expect(res.ok).toBe(true);
  expect(fetch.bodies).toEqual(["hello", "hello", "hello"]);
});
`;

const RETRIES_MD = `# Upload retries

\`uploadFile\` reads the body once and sends a fresh copy on each of its three tries, 200 ms, 400 ms and 800 ms apart.
A stream can be read only once, so the old loop sent an empty body on the second try.
`;

export const PROJECT_FILES: Record<keyof Folders, Record<string, string>> = {
  kitespan: {
    "README.md": "# kitespan demo project\n\nA small upload client and its tests.\n",
    "package.json": JSON.stringify({ name: "upload-demo", private: true, type: "module", scripts: { test: "bun test" } }, null, 2) + "\n",
    "src/upload.ts": UPLOAD_TS,
    "src/sync.ts": `import { uploadFile } from "./upload";\n\nexport const sync = (url: string, s: ReadableStream<Uint8Array>) => uploadFile(url, s);\n`,
    "src/cli/push.ts": `import { uploadFile } from "../upload";\n\nexport const push = (url: string, s: ReadableStream<Uint8Array>) => uploadFile(url, s);\n`,
    "test/upload.test.ts": UPLOAD_TEST_TS,
    "test/helpers/fake-fetch.ts": "export function fakeFetch(_o: { failFirst: number }) {\n  return { bodies: [] as string[] };\n}\n",
    "docs/UPLOAD-RETRIES.md": RETRIES_MD,
  },
  notes: {
    "src/query/parse.ts": `export type Query = { terms: string[]; phrases: string[] };\n\nexport function parse(input: string): Query {\n  const terms: string[] = [];\n  const phrases: string[] = [];\n  for (const part of input.match(/"[^"]*"|\\S+/g) ?? []) {\n    if (part.startsWith('"')) phrases.push(part.slice(1, -1));\n    else terms.push(part.toLowerCase());\n  }\n  return { terms, phrases };\n}\n`,
    "src/db/schema.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);\n",
  },
  scratch: {
    "notes/log-summary.md": "# Server log, yesterday\n\n41,208 requests, 0.3% errors.\n",
    "docs/RELEASE.md": "# Release checklist\n\n1. bun install --frozen-lockfile\n2. bun test\n3. bun run build\n",
  },
};

// ---------------------------------------------------------------------------------------------------------------
// The example chat: "Fix the flaky upload test"

/** Which row of the example chat gets which id in a scene; null leaves the row out of the history. */
export interface UploadSlots {
  /** The uuid of the chat's first user message (/c/<chat>/m/<message>), or null for a made one. */
  message: string | null;
  /**
   * The API message id of the first reply (its thinking block, its text and its Read call). The page's block ids are
   * `<API message id>-<index>`, so this names the thinking block of /c/<chat>/thinking/<message> once the page maps a
   * message id to its reply's blocks.
   */
  thinking: string;
  /** The Edit with a diff. */
  edit: string;
  /** The Explore subagent that found the callers. */
  agent: string;
  /** The review workflow launched from the history; null in the scene where a live one runs. */
  workflow: string | null;
  /**
   * R127: the Bash call whose `claude --bg` Claude Code refused in a folder that is not trusted, in a last turn of its
   * own at the history's end (TRUST_TURN); absent or null: no such turn.
   */
  trust?: string | null;
  /**
   * R131: the Bash call whose `claude --bg -n <name>` started a background session in a task folder of the project
   * and printed Claude Code's launch line, in a last turn of its own at the history's end (BG_TURN); absent or null: no
   * such turn.
   */
  background?: string | null;
}

/**
 * R131: the background session that the example chat started (the background scene): its short id (the route
 * example's), its `-n` name, its folder relative to the example chat's folder (a task folder inside the project, so its
 * view may show its transcript), its own session, and the session of another folder that Claude Code's list also holds
 * (the user's other worker, which kitespan never shows or logs).
 */
export const BG = {
  id: EX.bg,
  name: "investigate-negative-qty",
  folder: "worktrees/remove-negative-qty",
  session: IDS.sessions.worker,
  prompt: "Follow BRIEF-investigate.md for remove-negative-qty",
  other: { id: "9b8c7d6e", name: "nightly-dependency-audit", session: IDS.sessions.otherWorker },
} as const;
/** Claude Code's launch block for `id` (2.1.318 `Xtt`, colour off as in a Bash tool's result): the line and four hints. */
export const launchBlock = (id: string, name: string | null): string =>
  [
    `backgrounded · ${id}${name ? ` · ${name}` : ""}`,
    `  ${"claude agents".padEnd(26)}list sessions`,
    `  ${`claude attach ${id}`.padEnd(26)}open in this terminal`,
    `  ${`claude logs ${id}`.padEnd(26)}show recent output`,
    `  ${`claude stop ${id}`.padEnd(26)}stop this session`,
  ].join("\n");
export const BG_TURN = {
  ask: "Stage a task folder for the negative quantity fix and start an investigator in it in the background.",
  reply: `The investigator runs in the background as ${BG.name}. It follows BRIEF-investigate.md and reports what it finds.`,
} as const;

/**
 * R127's refused folders, relative to the example chat's folder: a new git repository nested in the project (the
 * owner's case: it keys on itself, so the confirm names no repository) and a plain folder of the project's own
 * repository (the confirm names the project folder as the repository whose trust it grants).
 */
export const TRUST_FOLDERS = { nested: "tasks/remove-negative-qty", inRepo: "tasks/search-index" } as const;
/** The second refused Bash call of the trust turn (the folder inside the project's repository). */
export const TRUST_IN_REPO_CALL = "toolu_01StartIndexer";
/** Claude Code's refusal line for `folder` (the CLI's own words, shared/trust.ts). */
export const trustRefusal = (folder: string): string => `Workspace not trusted. Run \`claude\` in ${folder} once and accept the trust prompt, then retry.`;
export const TRUST_TURN = {
  ask: "Stage a task folder for the negative quantity fix and start an investigator in it, and one for the search index.",
  reply: "The task folders are staged, but neither worker started: Claude Code refused to launch them because nobody has accepted its trust prompt there. That's your call to make, so I didn't change any trust settings.",
} as const;

export const UPLOAD_TABLE = `The test fails about one run in five. Here is what each run did:

| Run | Retries | Result | Time |
|---|---:|---|---:|
| 1 | 0 | pass | 1.2 s |
| 2 | 3 | **fail**: \`ECONNRESET\` | 9.8 s |
| 3 | 1 | pass | 2.4 s |

The retry loop reuses the same \`Request\` body after the stream was read, so the second try sends nothing:

\`\`\`ts
export async function uploadFile(url: string, body: ReadableStream) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: "PUT", body }); // body is spent after the first try
    if (res.ok) return res;
  }
  throw new Error("upload failed");
}
\`\`\`

I'll buffer the body once and send a fresh copy on each attempt.`;

const CONTEXT_OUT = `Context usage: 114k of 200k tokens (57%)
  System prompt   6.4k
  System tools   14.2k
  MCP tools      21.8k
  Memory files    3.1k
  Messages       68.5k
  Free space     86.0k`;

const AGENT_REPORT =
  "uploadFile has 3 callers: src/sync.ts (stream), src/cli/push.ts (stream) and test/upload.test.ts (string). Only the stream callers can hit the spent-body bug.";

export const UPLOAD_LAST_REPLY = "The fix is in and the review runs in the background. Next I will run the upload test 20 times.";

/** The history's Bash call that waited for a permission card, which the user answered with Allow once. */
export const ANSWERED_CARD = "toolu_01BashRerun5";

/**
 * kitespan's own notes of the example chat (server/store/types.ts NotesRecord, `notes/<chat id>.json`): the card that
 * let the five-run test command run, answered Allow once. Its record follows the call in history, as after a reload,
 * and the card's link reads "That request was already answered." (DESIGN.md 5.4).
 */
export function uploadNotes(chat: string): Record<string, unknown> {
  const command = "bun test test/upload.test.ts --rerun-each 5";
  return {
    v: 1,
    id: chat,
    cards: [
      {
        card: {
          kind: "permission",
          id: ANSWERED_CARD,
          toolUseId: ANSWERED_CARD,
          toolName: "Bash",
          title: `Claude wants to run ${command}`,
          displayName: "Run a command",
          description: "Run the upload test five times",
          reason: null,
          blockedPath: null,
          input: { command, description: "Run the upload test five times" },
          defaultToNo: false,
          suppressAlwaysAllowRule: false,
          sessionRule: true,
          parent: null,
        },
        close: { k: "card_close", id: ANSWERED_CARD, why: "answered", answer: "once" },
        after: ANSWERED_CARD,
      },
    ],
    bash: [],
  };
}

export function uploadTranscript(cwd: string, startMs: number, slots: UploadSlots): TranscriptFile {
  const t = new Transcript(IDS.sessions.upload, cwd, "sdk-ts", startMs);
  t.user("The upload test is flaky again. Find out why and fix it. Run the test a few times to be sure.", slots.message ?? undefined);
  t.assistant(slots.thinking, [
    thinking("The test name points at src/upload.ts. Read it first, then look for the retry loop, then run the test several times to see the failure mode."),
    text("I'll read the upload helper and its test, then run the test a few times."),
    tool("toolu_01ReadUpload", "Read", { file_path: `${cwd}/src/upload.ts` }),
  ]);
  t.results([{ id: "toolu_01ReadUpload", content: OLD_UPLOAD.split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n") }]);
  t.assistant("msg_01GrepAttempt", [tool("toolu_01GrepAttempt", "Grep", { pattern: "attempt", path: "src", output_mode: "content", "-n": true })]);
  t.results([{ id: "toolu_01GrepAttempt", content: "src/upload.ts:2:  for (let attempt = 0; attempt < 3; attempt++) {\nsrc/upload.ts:3:    const res = await fetch(url, { method: \"PUT\", body });" }]);
  const run5 = "test/upload.test.ts:\n(pass) upload > sends the file [1.21ms]\n(fail) upload > sends the file [9802.40ms]\n  error: ECONNRESET\n\n 4 pass\n 1 fail";
  t.assistant("msg_01BashRerun5", [tool("toolu_01BashRerun5", "Bash", { command: "bun test test/upload.test.ts --rerun-each 5", description: "Run the upload test five times" })]);
  t.results([{ id: "toolu_01BashRerun5", content: run5, isError: true }], { stdout: run5, stderr: "", interrupted: false });
  t.assistant("msg_01UploadTable", [text(UPLOAD_TABLE)]);
  t.assistant("msg_01ExploreCallers", [
    tool(slots.agent, "Agent", {
      description: "Find every caller of uploadFile",
      subagent_type: "Explore",
      prompt: "List every caller of uploadFile in this repository, with the file and line, and say which callers pass a stream.",
    }),
  ]);
  t.results([{ id: slots.agent, content: [{ type: "text", text: AGENT_REPORT }] }], {
    status: "completed",
    agentType: "Explore",
    content: [{ type: "text", text: AGENT_REPORT }],
    totalToolUseCount: 6,
    totalDurationMs: 41_000,
    totalTokens: 9_100,
  });
  const oldString = 'export async function uploadFile(url: string, body: ReadableStream) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const res = await fetch(url, { method: "PUT", body });';
  const newString =
    'export async function uploadFile(url: string, body: ReadableStream) {\n  const bytes = await new Response(body).arrayBuffer();\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const res = await fetch(url, { method: "PUT", body: bytes.slice(0) });';
  t.assistant("msg_01EditUpload", [text("Only the stream callers can hit it. Here is the fix:"), tool(slots.edit, "Edit", { file_path: `${cwd}/src/upload.ts`, old_string: oldString, new_string: newString })]);
  t.results([{ id: slots.edit, content: `The file ${cwd}/src/upload.ts has been updated.` }], {
    filePath: `${cwd}/src/upload.ts`,
    oldString,
    newString,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
        lines: [
          " export async function uploadFile(url: string, body: ReadableStream) {",
          "+  const bytes = await new Response(body).arrayBuffer();",
          "   for (let attempt = 0; attempt < 3; attempt++) {",
          '-    const res = await fetch(url, { method: "PUT", body });',
          '+    const res = await fetch(url, { method: "PUT", body: bytes.slice(0) });',
        ],
      },
    ],
  });
  t.assistant("msg_01EditTest", [
    tool("toolu_01EditTest", "Edit", { file_path: `${cwd}/test/upload.test.ts`, old_string: 'expect(res.ok).toBe(true);', new_string: 'expect(res.ok).toBe(true);\n  expect(fetch.bodies).toEqual(["hello", "hello", "hello"]);' }),
    tool("toolu_01WriteDoc", "Write", { file_path: `${cwd}/docs/UPLOAD-RETRIES.md`, content: RETRIES_MD }),
  ]);
  t.results([
    { id: "toolu_01EditTest", content: `The file ${cwd}/test/upload.test.ts has been updated.` },
    { id: "toolu_01WriteDoc", content: `File created successfully at: ${cwd}/docs/UPLOAD-RETRIES.md` },
  ]);
  t.assistant("msg_01Todos", [
    tool("toolu_01TodoWrite", "TodoWrite", {
      todos: [
        { content: "Find why the upload test is flaky", status: "completed", activeForm: "Finding why the upload test is flaky" },
        { content: "Buffer the body once and resend a fresh copy", status: "completed", activeForm: "Buffering the body" },
        { content: "Run the test 20 times", status: "in_progress", activeForm: "Running the test 20 times" },
        { content: "Write docs/UPLOAD-RETRIES.md", status: "pending", activeForm: "Writing docs/UPLOAD-RETRIES.md" },
      ],
    }),
  ]);
  t.results([{ id: "toolu_01TodoWrite", content: "Todos have been modified successfully." }]);
  if (slots.workflow) {
    t.assistant("msg_01ReviewWorkflow", [
      text("A review workflow checks the fix from three angles while the tests run."),
      tool(slots.workflow, "Workflow", { script: "export const meta = { name: 'review-upload-fix', description: 'Review the fix from three angles, then check each finding' };" }),
    ]);
    t.results([{ id: slots.workflow, content: "Workflow launched in background. Task ID: w0history0review" }], { status: "async_launched", taskId: "w0history0review", workflowName: "review-upload-fix" });
  }
  t.user("<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>");
  t.user(`<local-command-stdout>${CONTEXT_OUT}</local-command-stdout>`);
  t.user("<bash-input>git status --short</bash-input><bash-stdout> M src/upload.ts\n M test/upload.test.ts\n?? docs/UPLOAD-RETRIES.md</bash-stdout><bash-stderr></bash-stderr>");
  t.assistant("msg_01LastReply", [text(UPLOAD_LAST_REPLY)]);
  if (slots.trust) trustTurn(t, cwd, slots.trust);
  if (slots.background) backgroundTurn(t, slots.background);
  return t.file();
}

/**
 * R131: the turn that started the investigator (owner row 131's case): stage a task folder, make it a repository of its
 * own, then `claude --bg -n <name>` there, whose result is Claude Code's launch block; Claude's reply says so.
 */
function backgroundTurn(t: Transcript, call: string): void {
  t.user(BG_TURN.ask);
  t.assistant("msg_01StageWorker", [
    text("I'll stage the folder, then start a background session there with the brief."),
    tool("toolu_01StageWorker", "Bash", { command: `mkdir -p worktrees && cp -R src ${BG.folder}`, description: "Stage the task folder" }),
  ]);
  t.results([{ id: "toolu_01StageWorker", content: "" }], { stdout: "", stderr: "", interrupted: false });
  t.assistant("msg_01InitWorker", [tool("toolu_01InitWorker", "Bash", { command: `git -C ${BG.folder} init -q`, description: "Make it a repository" })]);
  t.results([{ id: "toolu_01InitWorker", content: "" }], { stdout: "", stderr: "", interrupted: false });
  t.assistant(`msg_${call.slice(5)}`, [tool(call, "Bash", { command: `cd ${BG.folder} && claude --bg -n ${BG.name} "${BG.prompt}"`, description: "Start the investigator in the background" })]);
  const out = launchBlock(BG.id, BG.name);
  t.results([{ id: call, content: out }], { stdout: out, stderr: "", interrupted: false });
  t.assistant("msg_01WorkerRuns", [text(BG_TURN.reply)]);
}

/**
 * R131: the background session's own transcript, filed under its folder's own slug (not the project's): a bypass
 * session (its `permission-mode` record) that read the brief and the cart check, and whose last call (a Bash run of the
 * test) has no result yet, as a session that waits on a permission prompt leaves it. `more` adds later turns' records.
 */
export function workerTranscript(cwd: string, startMs: number): TranscriptFile {
  const t = new Transcript(BG.session, cwd, "sdk-ts", startMs);
  t.user(BG.prompt);
  t.assistant("msg_31ReadBrief", [text("I'll read the brief first, then the cart check."), tool("toolu_31ReadBrief", "Read", { file_path: `${cwd}/BRIEF-investigate.md` })]);
  t.results([{ id: "toolu_31ReadBrief", content: `     1\t# Investigate: negative quantity\n     2\t\n     3\tFind why a negative quantity gets through the cart, and say where to fix it.` }]);
  t.assistant("msg_31GrepQty", [tool("toolu_31GrepQty", "Grep", { pattern: "quantity", path: "src/cart", output_mode: "files_with_matches" })]);
  t.results([{ id: "toolu_31GrepQty", content: "src/cart/check.ts\nsrc/cart/add.ts\nsrc/cart/types.ts\nsrc/cart/check.test.ts" }]);
  t.assistant("msg_31Finding", [text("The check compares qty > max but never qty < 1, so a negative quantity passes."), tool("toolu_31RunTest", "Bash", { command: "bun test src/cart/check.test.ts", description: "Run the cart check's test" })]);
  const file = t.file();
  // Claude Code writes the session's mode with its metadata, again and again; the view's head reads the last one.
  return { ...file, lines: [JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: BG.session }), ...file.lines] };
}

/** R131: the worker's next records (the flows add them while the view is open): a reply that names `marker`. */
export function workerMore(cwd: string, atMs: number, marker: string, parent: string | null): string[] {
  const uuid = crypto.randomUUID();
  return [
    JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      userType: "external",
      cwd,
      sessionId: BG.session,
      version: CLI_VERSION,
      gitBranch: "main",
      entrypoint: "sdk-ts",
      type: "assistant",
      message: { id: `msg_31More${atMs}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: marker }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      uuid,
      timestamp: new Date(atMs).toISOString(),
    }),
  ];
}

/**
 * R127: the turn whose background workers Claude Code refused (owner row 126's case): stage two task folders, then
 * `claude --bg` in each, each refused with Claude Code's line naming the folder's real path; Claude's reply says so.
 */
function trustTurn(t: Transcript, cwd: string, call: string): void {
  const nested = `${cwd}/${TRUST_FOLDERS.nested}`;
  const inRepo = `${cwd}/${TRUST_FOLDERS.inRepo}`;
  t.user(TRUST_TURN.ask);
  t.assistant("msg_01StageTasks", [
    text("I'll stage a task folder for each, with the negative quantity one as a repository of its own, and start a worker in each in the background."),
    tool("toolu_01StageTasks", "Bash", { command: `mkdir -p ${TRUST_FOLDERS.nested} ${TRUST_FOLDERS.inRepo} && git -C ${TRUST_FOLDERS.nested} init -q`, description: "Stage the task folders" }),
  ]);
  t.results([{ id: "toolu_01StageTasks", content: "" }], { stdout: "", stderr: "", interrupted: false });
  const refused = (id: string, folder: string, prompt: string, description: string) => {
    t.assistant(`msg_${id.slice(5)}`, [tool(id, "Bash", { command: `cd ${folder.slice(cwd.length + 1)} && claude --bg "${prompt}"`, description })]);
    const out = trustRefusal(folder);
    t.results([{ id, content: `Exit code 1\n${out}`, isError: true }], { stdout: "", stderr: out, interrupted: false });
  };
  refused(call, nested, "Find why a negative quantity gets through the cart", "Start the investigator in the background");
  refused(TRUST_IN_REPO_CALL, inRepo, "Rebuild the search index", "Start the indexer in the background");
  t.assistant("msg_01TasksRefused", [text(TRUST_TURN.reply)]);
}

const OLD_UPLOAD = `export async function uploadFile(url: string, body: ReadableStream) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: "PUT", body });
    if (res.ok) return res;
  }
  throw new Error("upload failed");
}`;

// ---------------------------------------------------------------------------------------------------------------
// The other chats and sessions (asleep; the prototype's other demo chats)

/**
 * New environment (D54): folders under the home folder to browse, two git repositories for the walk to find, and the
 * folder of a terminal session that is no project yet, so Suggested has one to add.
 */
export interface HomeFolders {
  website: string;
  infra: string;
  documents: string;
}

export function homeFolders(home: string): HomeFolders {
  return { website: `${home}/code/website`, infra: `${home}/code/infra`, documents: `${home}/Documents` };
}

export function homeTranscripts(h: HomeFolders, now: number): TranscriptFile[] {
  const t = new Transcript(IDS.sessions.terminalWebsite, h.website, "cli", now - 26 * 60 * 60_000);
  t.user("Why does the contact form send twice?");
  t.assistant("msg_12Twice", [text("The submit handler is bound twice, once in the page and once in main.js. Remove one of them.")]);
  return [t.file()];
}

/** The markdown chat's reply (a table, a task list and an sh block): v0.6 touch's copy-paste-touch copies it whole. */
export const MARKDOWN_REPLY = "| Feature | Works |\n|---|---|\n| Tables | yes |\n| Task lists | yes |\n\n- [x] a done task\n- [ ] an open task\n\n```sh\necho hello\n```";

export function otherTranscripts(f: Folders, now: number): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const min = 60_000;

  const layers = new Transcript(IDS.sessions.layers, f.kitespan, "sdk-ts", now - 15 * min);
  layers.user("Add tests for the upload retry. Ask me which layers first.");
  layers.assistant("msg_02AskLayers", [text("I would add unit tests for uploadFile with a fake fetch that fails twice, and one click-through that drops a file in the page. Say which you want.")]);
  out.push(layers.file());

  const search = new Transcript(IDS.sessions.search, f.notes, "sdk-ts", now - 40 * min);
  search.user("Plan a full-text search index for notes. Do not change code yet.");
  search.assistant("msg_03ReadSchema", [tool("toolu_03ReadSchema", "Read", { file_path: `${f.notes}/src/db/schema.sql` })]);
  search.results([{ id: "toolu_03ReadSchema", content: "     1\tCREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);" }]);
  search.assistant("msg_03Plan", [
    text(
      "## Plan: full-text search for notes\n\n1. Add an FTS5 table `notes_fts` with `title` and `body`, kept in sync by three triggers.\n2. Replace the seven `LIKE` queries with one `search(query, limit)` function.\n3. Rank by `bm25()` and return a snippet per hit.",
    ),
  ]);
  out.push(search.file());

  const parser = new Transcript(IDS.sessions.parser, f.notes, "sdk-ts", now - 50 * min);
  parser.user("Split the query parser into a tokenizer and a parser, and keep every test green.");
  parser.assistant("msg_04Tokenizer", [
    text("The tokenizer is in its own file now. Here is how the parser changes:\n\n- `parse()` takes tokens instead of a string\n- quoted phrases become one token"),
  ]);
  out.push(parser.file());

  const md = new Transcript(IDS.sessions.markdown, f.scratch, "sdk-ts", now - 27 * 60 * min);
  md.user("Show me a table, a task list and a code block.");
  md.assistant("msg_05Markdown", [text(MARKDOWN_REPLY)]);
  out.push(md.file());

  const logs = new Transcript(IDS.sessions.logs, f.scratch, "sdk-ts", now - 55 * min);
  logs.user("Summarize yesterday's server log in five lines.");
  logs.assistant("msg_06Summary", [
    text("1. 41,208 requests, 0.3% errors.\n2. Most errors are timeouts on `/sync` between 14:00 and 14:20.\n3. One restart at 14:22.\n4. p95 latency 180 ms, p99 1.9 s.\n5. No failed logins."),
  ]);
  out.push(logs.file());

  const docs = new Transcript(IDS.sessions.docs, f.notes, "sdk-ts", now - 6 * min);
  docs.user("Search the docs server for the sync API and summarize it.");
  docs.assistant("msg_07Docs", [text("The docs server is not connected yet: it needs a sign-in first. Reconnect it from Connectors, then ask again.")]);
  out.push(docs.file());

  const dates = new Transcript(IDS.sessions.dates, f.scratch, "sdk-ts", now - 3 * 24 * 60 * min);
  dates.user("Update the date library to the latest version and fix what breaks.");
  dates.assistant("msg_10Dates", [text("Updated the date library from 3.6 to 4.1. Two call sites used the removed `format` alias; both use `formatDate` now, and the tests pass.")]);
  out.push(dates.file());

  // Sessions that kitespan has not opened (started in a terminal): /p/<project>/session/<session> previews the first.
  const pv = new Transcript(EX.session, f.kitespan, "cli", now - 3 * 60 * min);
  pv.user("Bump the Agent SDK to the next patch and rerun the options gate.");
  pv.assistant("msg_09Gate", [tool("toolu_09Gate", "Bash", { command: "bun test test/options-gate.test.ts", description: "Run the options gate" })]);
  pv.results([{ id: "toolu_09Gate", content: "12 pass, 0 fail" }], { stdout: "12 pass, 0 fail", stderr: "", interrupted: false });
  pv.assistant("msg_09Done", [text("The gate still passes with the new patch. I did not commit anything.")]);
  out.push(pv.file());

  const pv2 = new Transcript(IDS.sessions.terminalNotes, f.notes, "cli", now - 5 * 60 * min);
  pv2.user("Why is the notes search slow?");
  pv2.assistant("msg_11Slow", [text("Each search runs seven LIKE queries over the whole table. A full-text index would make it one indexed query.")]);
  out.push(pv2.file());

  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The chat list (the ledger files) and the projects

export interface ChatSeed {
  id: string;
  project: keyof Folders;
  sessionId: string | null;
  title: string;
  from: "renamed" | "generated" | "first-prompt";
  picks: { model?: string; effort?: string; mode?: string };
  /** Minutes before now. */
  lastActivity: number;
  created: number;
  archived?: number;
}

export const CHATS: ChatSeed[] = [
  { id: IDS.chats.upload, project: "kitespan", sessionId: IDS.sessions.upload, title: "Fix the flaky upload test", from: "generated", picks: { model: "claude-opus-5-5", effort: "xhigh" }, lastActivity: 2, created: 200 },
  { id: IDS.chats.layers, project: "kitespan", sessionId: IDS.sessions.layers, title: "Pick the test layers", from: "first-prompt", picks: { model: "claude-sonnet-5-5", effort: "high", mode: "auto" }, lastActivity: 9, created: 20 },
  { id: IDS.chats.search, project: "notes", sessionId: IDS.sessions.search, title: "Plan the search index", from: "generated", picks: { model: "claude-opus-5-5", effort: "high" }, lastActivity: 26, created: 45 },
  { id: IDS.chats.parser, project: "notes", sessionId: IDS.sessions.parser, title: "Refactor the query parser", from: "renamed", picks: { effort: "max", mode: "acceptEdits" }, lastActivity: 35, created: 60 },
  { id: IDS.chats.markdown, project: "scratch", sessionId: IDS.sessions.markdown, title: "Try the markdown renderer", from: "first-prompt", picks: { model: "claude-haiku-5-5", effort: "medium" }, lastActivity: 26 * 60, created: 27 * 60 },
  { id: IDS.chats.logs, project: "scratch", sessionId: IDS.sessions.logs, title: "Summarize the server logs", from: "generated", picks: { model: "claude-sonnet-5-5" }, lastActivity: 48, created: 60 },
  { id: IDS.chats.docs, project: "notes", sessionId: IDS.sessions.docs, title: "Connect the docs server", from: "generated", picks: {}, lastActivity: 4, created: 8 },
  { id: IDS.chats.dates, project: "scratch", sessionId: IDS.sessions.dates, title: "Update the date library", from: "generated", picks: { mode: "acceptEdits" }, lastActivity: 3 * 24 * 60, created: 3 * 24 * 60 + 30, archived: 2 * 24 * 60 },
  { id: IDS.chats.lint, project: "scratch", sessionId: null, title: "Add a lint rule for unused exports", from: "first-prompt", picks: {}, lastActivity: 1, created: 1 },
];

export const PROJECTS: { key: keyof Folders; id: string; name: string; picks: { model?: string; effort?: string; mode?: string } }[] = [
  { key: "kitespan", id: IDS.projects.kitespan, name: "kitespan", picks: { model: "claude-opus-5-5", effort: "xhigh" } },
  { key: "notes", id: IDS.projects.notes, name: "notes-api", picks: { mode: "acceptEdits" } },
  { key: "scratch", id: IDS.projects.scratch, name: "scratch", picks: {} },
];

/** The draft that the server holds for "Summarize the server logs" (D49): another device typed it. */
export const HELD_DRAFT = { chat: IDS.chats.logs, text: "Also list the five slowest endpoints.", rev: 3, by: "seedPhoneTab" };

/** The example chat's uploads (D37): a log and a pasted screenshot, in kitespan's own upload folder. */
export const UPLOADS: { id: string; dir: string; name: string; type: string; body: () => Uint8Array; minutes: number }[] = [
  { id: IDS.uploads.log, dir: "u-k3v9q2", name: "flaky-run.log", type: "text/plain", body: () => new TextEncoder().encode(flakyLog()), minutes: 24 },
  { id: IDS.uploads.image, dir: "u-7hx2md", name: "pasted.png", type: "image/png", body: () => png(64, 40), minutes: 21 },
];

function flakyLog(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 40; i++) lines.push(`run ${String(i).padStart(2)}  upload > sends the file  ${i % 5 === 2 ? "FAIL ECONNRESET 9802 ms" : `pass ${(1 + (i % 3) * 0.6).toFixed(1)} ms`}`);
  return lines.join("\n") + "\n";
}

// A small PNG (an accent-blue screenshot stand-in), made here so the seed carries no binary file.
function png(w: number, h: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) raw.set(y < 8 ? [242, 242, 247] : [0, 113, 227], y * (1 + w * 3) + 1 + x * 3);
  }
  // PNG wants a zlib stream (node:zlib deflateSync), not the raw deflate of Bun.deflateSync.
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array())];
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

