// The example chat, "Fix the flaky upload test", as the real server sends it on the click-through seed (test/click/seed/:
// the permission scene, over the main scene's first turn and its changes card): the first turn finds and fixes the
// flaky test, then the user asks for a clean build, and Claude's Bash call waits on its permission card (DESIGN-W1 2.1,
// S1). Its folder is the demo's own (/work/kitespan). Pure data.

import type { ChatEvent, ChatEventOf, PermissionCard } from "../../../shared/protocol";

/** The user message of the turn that waits on the card (its turn_end names it). */
export const WAITING_TURN_USER = "05eb318e-0471-45b3-a9b3-bc1071342453";

/** The Bash call's permission card, under the route examples' tool-use id. */
export const EXAMPLE_PERMISSION: PermissionCard = {
  kind: "permission",
  id: "toolu_01AbCdEf",
  toolUseId: "toolu_01AbCdEf",
  toolName: "Bash",
  title: null,
  displayName: null,
  description: "Clean the build folder and rebuild",
  reason: "Clean the build folder and rebuild before the last test run",
  blockedPath: null,
  input: { command: "rm -rf build && bun run build", description: "Clean the build folder and rebuild" },
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  sessionRule: true,
  parent: null,
};

/** What Claude Code's start said for this chat (its `session` event). */
export const EXAMPLE_SESSION: ChatEventOf<"session"> = {
  k: "session",
  sessionId: "4f6d2a90-1c3e-4b8f-9a51-7e2d0c6b8a13",
  model: "claude-opus-5-5",
  mode: "default",
  version: "2.1.322",
  bypass: false,
  fastMode: null,
  skills: [],
  plugins: [],
  outputStyle: "default",
  cwd: "/work/kitespan",
};

/** The chat's history, oldest first, up to the Bash call that waits. */
export const EXAMPLE_HISTORY: ChatEvent[] = [
  {
    k: "user",
    uuid: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    text: "The upload test is flaky again. Find out why and fix it. Run the test a few times to be sure.",
    queued: false,
  },
  {
    k: "block",
    key: "7c9e6679-7425-40de-944b-e07fc1f90ae7:0",
    kind: "thinking",
    text: "The test name points at src/upload.ts. Read it first, then look for the retry loop, then run the test several times to see the failure mode.",
    parent: null,
  },
  {
    k: "block",
    key: "7c9e6679-7425-40de-944b-e07fc1f90ae7:1",
    kind: "text",
    text: "I'll read the upload helper and its test, then run the test a few times.",
    parent: null,
  },
  { k: "tool_call", id: "toolu_01ReadUpload", name: "Read", input: { file_path: "/work/kitespan/src/upload.ts" }, parent: null },
  {
    k: "tool_result",
    id: "toolu_01ReadUpload",
    text: "     1\texport async function uploadFile(url: string, body: ReadableStream) {\n     2\t  for (let attempt = 0; attempt < 3; attempt++) {\n     3\t    const res = await fetch(url, { method: \"PUT\", body });\n     4\t    if (res.ok) return res;\n     5\t  }\n     6\t  throw new Error(\"upload failed\");\n     7\t}",
    isError: false,
    parent: null,
    report: null,
  },
  { k: "tool_call", id: "toolu_01GrepAttempt", name: "Grep", input: { pattern: "attempt", path: "src", output_mode: "content", "-n": true }, parent: null },
  {
    k: "tool_result",
    id: "toolu_01GrepAttempt",
    text: "src/upload.ts:2:  for (let attempt = 0; attempt < 3; attempt++) {\nsrc/upload.ts:3:    const res = await fetch(url, { method: \"PUT\", body });",
    isError: false,
    parent: null,
    report: null,
  },
  {
    k: "tool_call",
    id: "toolu_01BashRerun5",
    name: "Bash",
    input: { command: "bun test test/upload.test.ts --rerun-each 5", description: "Run the upload test five times" },
    parent: null,
  },
  {
    k: "card_open",
    card: {
      kind: "permission",
      id: "toolu_01BashRerun5",
      toolUseId: "toolu_01BashRerun5",
      toolName: "Bash",
      title: "Claude wants to run bun test test/upload.test.ts --rerun-each 5",
      displayName: "Run a command",
      description: "Run the upload test five times",
      reason: null,
      blockedPath: null,
      input: { command: "bun test test/upload.test.ts --rerun-each 5", description: "Run the upload test five times" },
      defaultToNo: false,
      suppressAlwaysAllowRule: false,
      sessionRule: true,
      parent: null,
    },
  },
  { k: "card_close", id: "toolu_01BashRerun5", why: "answered", answer: "once" },
  {
    k: "tool_result",
    id: "toolu_01BashRerun5",
    text: "test/upload.test.ts:\n(pass) upload > sends the file [1.21ms]\n(fail) upload > sends the file [9802.40ms]\n  error: ECONNRESET\n\n 4 pass\n 1 fail",
    isError: true,
    parent: null,
    report: null,
  },
  {
    k: "block",
    key: "msg_01UploadTable:0",
    kind: "text",
    text: "The test fails about one run in five. Here is what each run did:\n\n| Run | Retries | Result | Time |\n|---|---:|---|---:|\n| 1 | 0 | pass | 1.2 s |\n| 2 | 3 | **fail**: `ECONNRESET` | 9.8 s |\n| 3 | 1 | pass | 2.4 s |\n\nThe retry loop reuses the same `Request` body after the stream was read, so the second try sends nothing:\n\n```ts\nexport async function uploadFile(url: string, body: ReadableStream) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const res = await fetch(url, { method: \"PUT\", body }); // body is spent after the first try\n    if (res.ok) return res;\n  }\n  throw new Error(\"upload failed\");\n}\n```\n\nI'll buffer the body once and send a fresh copy on each attempt.",
    parent: null,
  },
  {
    k: "tool_call",
    id: "toolu_01ExploreCallers",
    name: "Agent",
    input: {
      description: "Find every caller of uploadFile",
      subagent_type: "Explore",
      prompt: "List every caller of uploadFile in this repository, with the file and line, and say which callers pass a stream.",
    },
    parent: null,
  },
  {
    k: "tool_result",
    id: "toolu_01ExploreCallers",
    text: "uploadFile has 3 callers: src/sync.ts (stream), src/cli/push.ts (stream) and test/upload.test.ts (string). Only the stream callers can hit the spent-body bug.",
    isError: false,
    parent: null,
    report: null,
  },
  { k: "block", key: "msg_01EditUpload:0", kind: "text", text: "Only the stream callers can hit it. Here is the fix:", parent: null },
  {
    k: "tool_call",
    id: "toolu_01EditUpload",
    name: "Edit",
    input: {
      file_path: "/work/kitespan/src/upload.ts",
      old_string: "export async function uploadFile(url: string, body: ReadableStream) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const res = await fetch(url, { method: \"PUT\", body });",
      new_string: "export async function uploadFile(url: string, body: ReadableStream) {\n  const bytes = await new Response(body).arrayBuffer();\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const res = await fetch(url, { method: \"PUT\", body: bytes.slice(0) });",
    },
    parent: null,
  },
  { k: "tool_result", id: "toolu_01EditUpload", text: "The file /work/kitespan/src/upload.ts has been updated.", isError: false, parent: null, report: null },
  {
    k: "tool_call",
    id: "toolu_01EditTest",
    name: "Edit",
    input: {
      file_path: "/work/kitespan/test/upload.test.ts",
      old_string: "expect(res.ok).toBe(true);",
      new_string: "expect(res.ok).toBe(true);\n  expect(fetch.bodies).toEqual([\"hello\", \"hello\", \"hello\"]);",
    },
    parent: null,
  },
  {
    k: "tool_call",
    id: "toolu_01WriteDoc",
    name: "Write",
    input: {
      file_path: "/work/kitespan/docs/UPLOAD-RETRIES.md",
      content: "# Upload retries\n\n`uploadFile` reads the body once and sends a fresh copy on each of its three tries, 200 ms, 400 ms and 800 ms apart.\nA stream can be read only once, so the old loop sent an empty body on the second try.\n",
    },
    parent: null,
  },
  {
    k: "tool_result",
    id: "toolu_01EditTest",
    text: "The file /work/kitespan/test/upload.test.ts has been updated.",
    isError: false,
    parent: null,
    report: null,
  },
  {
    k: "tool_result",
    id: "toolu_01WriteDoc",
    text: "File created successfully at: /work/kitespan/docs/UPLOAD-RETRIES.md",
    isError: false,
    parent: null,
    report: null,
  },
  {
    k: "tool_call",
    id: "toolu_01TodoWrite",
    name: "TodoWrite",
    input: {
      todos: [
        { content: "Find why the upload test is flaky", status: "completed", activeForm: "Finding why the upload test is flaky" },
        { content: "Buffer the body once and resend a fresh copy", status: "completed", activeForm: "Buffering the body" },
        { content: "Run the test 20 times", status: "in_progress", activeForm: "Running the test 20 times" },
        { content: "Write docs/UPLOAD-RETRIES.md", status: "pending", activeForm: "Writing docs/UPLOAD-RETRIES.md" },
      ],
    },
    parent: null,
  },
  { k: "tool_result", id: "toolu_01TodoWrite", text: "Todos have been modified successfully.", isError: false, parent: null, report: null },
  { k: "block", key: "msg_01ReviewWorkflow:0", kind: "text", text: "A review workflow checks the fix from three angles while the tests run.", parent: null },
  {
    k: "tool_call",
    id: "toolu_01ReviewWorkflow",
    name: "Workflow",
    input: { script: "export const meta = { name: 'review-upload-fix', description: 'Review the fix from three angles, then check each finding' };" },
    parent: null,
  },
  {
    k: "tool_result",
    id: "toolu_01ReviewWorkflow",
    text: "Workflow launched in background. Task ID: w0history0review",
    isError: false,
    parent: null,
    report: null,
  },
  {
    k: "changes",
    id: "m7q2x4abk3",
    at: ["7c9e6679-7425-40de-944b-e07fc1f90ae7"],
    how: "git",
    total: 3,
    added: 18,
    removed: 4,
    files: [
      { path: "docs/UPLOAD-RETRIES.md", status: "A", added: 4, removed: 0 },
      { path: "src/upload.ts", status: "M", added: 13, removed: 4 },
      { path: "test/upload.test.ts", status: "M", added: 1, removed: 0 },
    ],
  },
  { k: "user", uuid: "4f6d2a90-0000-4000-8000-000000000017", text: "/context", queued: false },
  {
    k: "local_output",
    stream: "stdout",
    text: "Context usage: 114k of 200k tokens (57%)\n  System prompt   6.4k\n  System tools   14.2k\n  MCP tools      21.8k\n  Memory files    3.1k\n  Messages       68.5k\n  Free space     86.0k",
  },
  {
    k: "bash",
    uuid: "4f6d2a90-0000-4000-8000-000000000019",
    input: "git status --short",
    state: "done",
    stdout: " M src/upload.ts\n M test/upload.test.ts\n?? docs/UPLOAD-RETRIES.md",
    stderr: "",
    code: null,
    ms: null,
    timedOut: false,
    capped: false,
  },
  {
    k: "block",
    key: "msg_01LastReply:0",
    kind: "text",
    text: "The fix is in and the review runs in the background. Next I will run the upload test 20 times.",
    parent: null,
  },
  { k: "turn_start", by: "user" },
  {
    k: "user",
    uuid: "05eb318e-0471-45b3-a9b3-bc1071342453",
    text: "Clean the build folder and rebuild, then run the test once more.",
    queued: false,
    mentions: [],
  },
  { k: "block", key: "msg_01Clean:0", kind: "text", text: "I'll clean the build folder and rebuild first.", parent: null },
  {
    k: "tool_call",
    id: "toolu_01AbCdEf",
    name: "Bash",
    input: { command: "rm -rf build && bun run build", description: "Clean the build folder and rebuild" },
    parent: null,
  },
];

/** How the waiting call goes on: allowed (once or for this session), or denied. */
export const ALLOWED = { result: "Built in 1.4 s.", key: "msg_01Built:0", reply: "Built. The last run passes too." } as const;
export const DENIED = { result: "The user denied this tool use.", key: "msg_01NotBuilt:0", reply: "I left the build folder as it is." } as const;
