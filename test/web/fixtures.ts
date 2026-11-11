// The iteration 1 prototype's scripted data, kept as fixtures for the page's unit tests (the page itself reads the
// server). Chats get the fields that iteration 2 added (state/types.ts) with their empty values.
import { COMMANDS as CATALOG_COMMANDS, MODELS as CATALOG_MODELS } from "../../web/state/catalog";
import { resetState } from "../../web/state/store";
import type { Chat, CommandRow, Connector, ContextInfo, ModelRow, PreviewSession, Project, Toast, Upload } from "../../web/state/types";

/** A chat as the prototype scripted it: the fields that the server adds get their empty values in CHATS. */
type ScriptedChat = Omit<Chat, "archived" | "needsYou" | "picks" | "serverState" | "loaded" | "more" | "turn" | "liveModel" | "version" | "commands" | "models" | "connectorInfo" | "tasks" | "suggestion">;

export function scripted(c: ScriptedChat): Chat {
  return {
    archived: false,
    needsYou: c.pending.length > 0,
    picks: { model: c.model === "default" ? null : c.model, effort: null, mode: null },
    // A failed or unread chat is idle on the server, with its last end not seen yet (row 116).
    serverState: c.state === "failed" || c.state === "unread" ? "idle" : c.state,
    unseen: c.state === "failed" ? "failed" : c.state === "unread" ? "done" : null,
    loaded: true,
    more: null,
    turn: null,
    liveModel: null,
    version: null,
    commands: null,
    models: null,
    connectorInfo: null,
    tasks: [],
    suggestion: null,
    ...c,
  };
}

export const PROJECTS: Project[] = [
  { id: "kitespanxx", name: "kitespan", folder: "~/src/kitespan", branch: "main", picks: { model: "opus-5.5", effort: "xhigh" } },
  { id: "notesxxxxx", name: "notes-api", folder: "~/src/notes-api", branch: "feat/search-index", picks: { mode: "acceptEdits" } },
  { id: "scratchxxx", name: "scratch", folder: "~/scratch/demo", branch: "main", picks: {} },
];

// supportsAutoMode: the models whose rows Claude Code marks as able to run Auto (DESIGN.md 6.6); on the others the
// mode picker shows Auto off with "Auto needs a model that supports it." On Bedrock, Auto needs "Sonnet 5 or later,
// Opus 4.7 or later, Haiku 5.5, and Fable models only" (DESKTOP-PARITY CO-14), so Opus 4.6 is the one without it.
export const MODELS: ModelRow[] = [
  { id: "default", label: "Default", hint: "Use the default model (currently Opus 5.5)", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
  { id: "opus-4.6", label: "Opus 4.6", hint: "Earlier Opus", efforts: ["low", "medium", "high"], supportsAutoMode: false },
  { id: "opus-4.8", label: "Opus 4.8", hint: "Earlier Opus", efforts: ["low", "medium", "high", "xhigh"], supportsAutoMode: true },
  { id: "opus-5", label: "Opus 5", hint: "Earlier Opus", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
  { id: "opus-5.5", label: "Opus 5.5", hint: "Most capable for complex work", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
  { id: "sonnet-5.5", label: "Sonnet 5.5", hint: "Fast and capable for everyday work", efforts: ["low", "medium", "high", "xhigh"], supportsAutoMode: true },
  { id: "haiku-5.5", label: "Haiku 5.5", hint: "Fastest for quick answers", efforts: ["low", "medium", "high"], supportsAutoMode: true },
  { id: "fable-5.1", label: "Fable 5.1", hint: "From your settings", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
];

export const COMMANDS: CommandRow[] = [
  { name: "clear", hint: "Start a new conversation in this chat", source: "built-in" },
  { name: "compact", hint: "Summarize the conversation to free context", args: "[instructions]", source: "built-in" },
  { name: "context", hint: "Show what fills the context window", source: "built-in" },
  { name: "model", hint: "Switch the model", args: "[model]", source: "built-in" },
  { name: "effort", hint: "Set the effort level", args: "[level]", source: "built-in" },
  { name: "review", hint: "Review the changes on this branch", source: "built-in" },
  { name: "init", hint: "Write a CLAUDE.md for this folder", source: "built-in" },
  { name: "memory", hint: "Edit memory files", source: "built-in" },
  { name: "mcp", hint: "Manage MCP servers", source: "built-in" },
  { name: "agents", hint: "Manage subagents", source: "built-in" },
  { name: "cost", hint: "Show this session's usage", source: "built-in" },
  { name: "doctor", hint: "Check your Claude Code install", source: "built-in", terminalOnly: true },
  { name: "statusline", hint: "Set up the status line", source: "built-in", terminalOnly: true },
  { name: "security-review", hint: "Review pending changes for security issues", source: "built-in" },
  { name: "pr-comments", hint: "Get the comments of a pull request", args: "[number]", source: "built-in" },
  { name: "deploy-notes", hint: "Draft release notes from the last tag", args: "[tag]", source: "project" },
  { name: "tidy", hint: "Your command: tidy imports and run the formatter", source: "user" },
];

const connectors = (): Connector[] => [
  { name: "playwright", status: "connected", tools: 25, source: "user" },
  { name: "github", status: "connected", tools: 41, source: "user" },
  { name: "docs-search", status: "failed", tools: 0, source: "project" },
  { name: "tickets", status: "needs-auth", tools: 0, source: "user" },
];

const context = (usedPct: number): ContextInfo => {
  const windowTokens = 200000;
  const usedTokens = Math.round((windowTokens * usedPct) / 100);
  return {
    usedPct,
    usedTokens,
    windowTokens,
    parts: [
      { label: "System prompt", tokens: 6400 },
      { label: "System tools", tokens: 14200 },
      { label: "MCP tools", tokens: 21800 },
      { label: "Memory files", tokens: 3100 },
      { label: "Messages", tokens: Math.max(0, usedTokens - 45500) },
    ],
  };
};

const now = Date.parse("2026-10-30T09:00:00Z");
const ago = (min: number) => new Date(now - min * 60000).toISOString();

const RELEASE_MD = `# Release checklist

1. bun install --frozen-lockfile
2. bun test
3. bun run build
4. bun run changelog --check
5. git tag v0.4.0 && git push origin v0.4.0
6. npm publish
7. Announce the release in the changelog`;

const UPLOAD_TABLE = `The test fails about one run in five. Here is what each run did:

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

const PARSE_TS = `export type Query = { terms: string[]; phrases: string[] };

export function parse(input: string): Query {
  const terms: string[] = [];
  const phrases: string[] = [];
  for (const part of input.match(/"[^"]*"|\\S+/g) ?? []) {
    if (part.startsWith('"')) phrases.push(part.slice(1, -1));
    else terms.push(part.toLowerCase());
  }
  return { terms, phrases };
}`;

const SCRIPTED: ScriptedChat[] = [
  {
    id: "demoolxxxxxxxxxxxxxx",
    projectId: "kitespanxx",
    title: "Fix the flaky upload test",
    titleSource: "generated",
    state: "waiting",
    updatedAt: ago(2),
    sessionId: "4f6d2a90-1c3e-4b8f-9a51-7e2d0c6b8a13",
    model: "opus-5.5",
    effort: "xhigh",
    mode: "default",
    bypassFlag: false,
    context: context(57),
    connectors: connectors(),
    outputs: [
      { path: "src/upload.ts", kind: "file" },
      { path: "test/upload.test.ts", kind: "file" },
      { path: "docs/UPLOAD-RETRIES.md", kind: "doc" },
      { path: "src/http/retry.ts", kind: "file" },
      { path: "test/helpers/fake-fetch.ts", kind: "file" },
      { path: "test/fixtures/large-upload.bin", kind: "file" },
      { path: "CHANGELOG.md", kind: "doc" },
    ],
    items: [
      { kind: "compact", id: "m_compact1" },
      { kind: "user", id: "m_user1", text: "The upload test is flaky again. Find out why and fix it. Run the test a few times to be sure." },
      { kind: "thinking", id: "m_think1", seconds: 6, text: "The test name points at src/upload.ts. Read it first, then look for the retry loop, then run the test several times to see the failure mode." },
      { kind: "assistant", id: "m_a1", markdown: "I'll read the upload helper and its test, then run the test a few times." },
      { kind: "tool", id: "tu_read1", name: "Read", summary: "src/upload.ts", status: "ok", output: "48 lines" },
      { kind: "tool", id: "tu_grep1", name: "Grep", summary: "\"attempt\" in src", status: "ok", output: "src/upload.ts:4\nsrc/upload.ts:9" },
      { kind: "tool", id: "tu_bash1", name: "Bash", summary: "bun test test/upload.test.ts --rerun-each 5", status: "error", input: "bun test test/upload.test.ts --rerun-each 5", output: "test/upload.test.ts:\n(pass) upload > sends the file [1.21ms]\n(fail) upload > sends the file [9802.40ms]\n  error: ECONNRESET\n\n 4 pass\n 1 fail" },
      { kind: "assistant", id: "m_table", markdown: UPLOAD_TABLE },
      {
        kind: "agent",
        id: "tu_agent1",
        agentType: "Explore",
        description: "Find every caller of uploadFile",
        status: "done",
        toolUses: 6,
        seconds: 41,
        rows: [
          { kind: "tool", id: "tu_a1_g", name: "Grep", summary: "uploadFile in .", status: "ok", output: "3 files" },
          { kind: "tool", id: "tu_a1_r1", name: "Read", summary: "src/sync.ts", status: "ok" },
          { kind: "tool", id: "tu_a1_r2", name: "Read", summary: "src/cli/push.ts", status: "ok" },
        ],
        lastText: "Two callers pass a stream; one passes a string.",
        report: "uploadFile has 3 callers: src/sync.ts (stream), src/cli/push.ts (stream) and test/upload.test.ts (string). Only the stream callers can hit the spent-body bug.",
      },
      {
        kind: "tool",
        id: "tu_edit1",
        name: "Edit",
        summary: "src/upload.ts",
        status: "ok",
        diff: {
          path: "src/upload.ts",
          removed: ["export async function uploadFile(url: string, body: ReadableStream) {", "    const res = await fetch(url, { method: \"PUT\", body });"],
          added: ["export async function uploadFile(url: string, body: ReadableStream) {", "  const bytes = await new Response(body).arrayBuffer();", "    const res = await fetch(url, { method: \"PUT\", body: bytes.slice(0) });"],
        },
      },
      {
        kind: "todo",
        id: "m_todo1",
        items: [
          { text: "Find why the upload test is flaky", status: "completed" },
          { text: "Buffer the body once and resend a fresh copy", status: "completed" },
          { text: "Run the test 20 times", status: "in_progress" },
          { text: "Write docs/UPLOAD-RETRIES.md", status: "pending" },
        ],
      },
      {
        kind: "workflow",
        id: "tu_wf1",
        name: "review-upload-fix",
        description: "Review the fix from three angles, then check each finding",
        status: "running",
        phases: [
          { title: "Review", agents: [{ label: "correctness", status: "done" }, { label: "retries and timeouts", status: "done" }, { label: "tests", status: "running" }] },
          { title: "Verify", agents: [{ label: "verify finding 1", status: "queued" }, { label: "verify finding 2", status: "queued" }] },
        ],
      },
      { kind: "slash", id: "m_slash1", command: "/context", output: "Context usage: 114k of 200k tokens (57%)\n  System prompt   6.4k\n  System tools   14.2k\n  MCP tools      21.8k\n  Memory files    3.1k\n  Messages       68.5k\n  Free space     86.0k" },
      { kind: "bash", id: "m_bash1", command: "git status --short", stdout: " M src/upload.ts\n M test/upload.test.ts\n?? docs/UPLOAD-RETRIES.md", stderr: "", code: 0, ms: 38 },
      { kind: "assistant", id: "m_a2", markdown: "The fix holds in 20 of 20 runs here. I want to clean the build folder and rebuild before the last run." },
    ],
    pending: [{ kind: "permission", id: "rq_bash1", tool: "Bash", title: "Allow Claude to use Bash?", reason: "Clean the build folder and rebuild before the last test run", detail: "rm -rf build && bun run build" }],
  },
  {
    id: "asko2xxxxxxxxxxxxxxx",
    projectId: "kitespanxx",
    title: "Pick the test layers",
    titleSource: "first-prompt",
    state: "waiting",
    updatedAt: ago(9),
    sessionId: "8b1e5f02-77aa-4d10-b3c9-2f4e6a9d0c55",
    model: "sonnet-5.5",
    effort: "high",
    mode: "auto",
    bypassFlag: false,
    context: context(18),
    connectors: connectors(),
    outputs: [],
    items: [
      { kind: "user", id: "m_ask_u1", text: "Add tests for the retry fix. Ask me which layers first." },
      { kind: "assistant", id: "m_ask_a1", markdown: "Before I write anything, two questions." },
    ],
    pending: [{
      kind: "question",
      id: "rq_ask1",
      questions: [
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
      ],
    }],
  },
  {
    id: "plano3xxxxxxxxxxxxxx",
    projectId: "notesxxxxx",
    title: "Plan the search index",
    titleSource: "generated",
    state: "waiting",
    updatedAt: ago(26),
    sessionId: "c2d93b17-0f5e-4e2a-8d6c-91b7a4e3f208",
    model: "opus-5.5",
    effort: "high",
    mode: "plan",
    bypassFlag: true,
    context: context(31),
    connectors: connectors(),
    outputs: [],
    items: [
      { kind: "user", id: "m_plan_u1", text: "Plan a full-text search index for notes. Do not change code yet." },
      { kind: "tool", id: "tu_plan_r1", name: "Read", summary: "src/db/schema.sql", status: "ok" },
      { kind: "tool", id: "tu_plan_g1", name: "Grep", summary: "\"LIKE\" in src", status: "ok", output: "7 matches in 3 files" },
    ],
    pending: [{
      kind: "plan",
      id: "rq_plan1",
      markdown: "## Plan: full-text search for notes\n\n1. Add an FTS5 table `notes_fts` with `title` and `body`, kept in sync by three triggers.\n2. Replace the seven `LIKE` queries with one `search(query, limit)` function.\n3. Rank by `bm25()` and return a snippet per hit.\n4. Backfill the index in one migration; it takes about 2 s for 50,000 notes.\n5. Add tests for prefixes, phrases and deleted notes.",
    }],
  },
  {
    id: "runo4xxxxxxxxxxxxxxx",
    projectId: "notesxxxxx",
    title: "Refactor the query parser",
    titleSource: "rename",
    state: "running",
    updatedAt: ago(0),
    sessionId: "1a7f3c88-5b2d-49e0-a6f1-0d8c2e9b7f46",
    model: "opus-5.5",
    effort: "max",
    mode: "acceptEdits",
    bypassFlag: false,
    context: context(64),
    connectors: connectors(),
    outputs: [{ path: "src/query/parse.ts", kind: "file" }],
    pending: [],
    items: [
      { kind: "user", id: "m_run_u1", text: "Split the query parser into a tokenizer and a parser, and keep every test green." },
      { kind: "tool", id: "tu_run_r1", name: "Read", summary: "src/query/parse.ts", status: "ok", input: "src/query/parse.ts", output: PARSE_TS },
      {
        kind: "tool",
        id: "tu_run_w1",
        name: "Write",
        summary: "src/query/tokenize.ts",
        status: "ok",
        input: "export type Token = { kind: \"word\" | \"phrase\"; text: string };\n\nexport function tokenize(query: string): Token[] {\n  const parts = query.match(/\"[^\"]*\"|\\S+/g) ?? [];\n  return parts.map((p) => (p.startsWith('\"') ? { kind: \"phrase\", text: p.slice(1, -1) } : { kind: \"word\", text: p }));\n}",
      },
      { kind: "tool", id: "tu_run_b1", name: "Bash", summary: "bun test test/query", status: "running", elapsedSeconds: 12 },
      // A subagent that runs in the foreground (DESIGN.md 5.2: /c/<chat>/agent/<toolUse> shows Run in background and Stop).
      {
        kind: "agent",
        id: "tu_run_ag1",
        agentType: "Explore",
        description: "Find every caller of parse()",
        prompt: "List every file that calls parse() from src/query/parse.ts, with the line, so the new tokenizer can be wired in.",
        status: "running",
        toolUses: 3,
        tokens: 7200,
        seconds: 18,
        rows: [
          { kind: "tool", id: "tu_run_ag1_g1", name: "Grep", summary: "\"parse(\" in src", status: "ok", output: "src/search.ts:12\nsrc/api/notes.ts:48" },
          { kind: "tool", id: "tu_run_ag1_r1", name: "Read", summary: "src/search.ts", status: "running" },
        ],
        lastText: "Two callers so far: src/search.ts and src/api/notes.ts.",
      },
      { kind: "assistant", id: "m_run_a1", markdown: "The tokenizer is in its own file now. While the tests run, here is how the parser changes:\n\n- `parse()` takes tokens instead of a string\n- quoted phrases become one token", streaming: true },
      // A message the user sent while Claude works: Queued, with Take back and Send now (/c/runo4xxxxxxxxxxxxxxx/m/m_run_q1).
      { kind: "user", id: "m_run_q1", text: "Keep the old parse() as a wrapper until the callers move.", queued: true },
    ],
  },
  {
    id: "oldo5xxxxxxxxxxxxxxx",
    projectId: "scratchxxx",
    title: "Try the markdown renderer",
    titleSource: "first-prompt",
    state: "sleeping",
    updatedAt: ago(60 * 26),
    sessionId: "e5c14d6a-2f80-4b93-8e7d-3a9f1c0b6d22",
    model: "haiku-5.5",
    effort: "medium",
    mode: "default",
    bypassFlag: false,
    context: context(9),
    connectors: connectors(),
    outputs: [],
    pending: [],
    // A card that ended unanswered when this chat's Claude Code restarted: /c/oldo5xxxxxxxxxxxxxxx/permission/rq_lost1.
    lostRequests: ["rq_lost1"],
    items: [
      { kind: "user", id: "m_old_u1", text: "Show me a table, a task list and a code block." },
      { kind: "assistant", id: "m_old_a1", markdown: "| Feature | Works |\n|---|---|\n| Tables | yes |\n| Task lists | yes |\n\n- [x] a done task\n- [ ] an open task\n\n```sh\necho hello\n```" },
    ],
  },
  {
    id: "idleo6xxxxxxxxxxxxxx",
    projectId: "scratchxxx",
    title: "Summarize the server logs",
    titleSource: "generated",
    state: "idle",
    updatedAt: ago(48),
    sessionId: "93b0e7f1-6c4a-4d58-b2e9-5f1a8c3d7e04",
    model: "sonnet-5.5",
    effort: "medium",
    mode: "auto",
    bypassFlag: false,
    context: context(22),
    connectors: connectors(),
    outputs: [{ path: "notes/log-summary.md", kind: "doc" }],
    pending: [],
    items: [
      { kind: "user", id: "m_idle_u1", text: "Summarize yesterday's server log in five lines." },
      { kind: "assistant", id: "m_idle_a1", markdown: "1. 41,208 requests, 0.3% errors.\n2. Most errors are timeouts on `/sync` between 14:00 and 14:20.\n3. One restart at 14:22.\n4. p95 latency 180 ms, p99 1.9 s.\n5. No failed logins." },
    ],
  },
  {
    id: "elico7xxxxxxxxxxxxxx",
    projectId: "notesxxxxx",
    title: "Connect the docs server",
    titleSource: "generated",
    state: "waiting",
    updatedAt: ago(4),
    sessionId: "5d2f8c41-9e3a-4b70-8c16-2a9e7d4f0b38",
    model: "sonnet-5.5",
    effort: "medium",
    mode: "default",
    bypassFlag: false,
    context: context(12),
    connectors: connectors(),
    outputs: [],
    items: [
      { kind: "user", id: "m_elic_u1", text: "Search the docs server for the sync API and summarize it." },
      { kind: "tool", id: "tu_elic_m1", name: "docs-search", summary: "search \"sync API\"", status: "running" },
    ],
    pending: [
      {
        kind: "elicitation",
        id: "rq_elic1",
        server: "docs-search",
        title: "Sign in to the docs server",
        message: "The docs server needs your workspace name and an access mode before it can search.",
        mode: "form",
        fields: [
          { name: "workspace", label: "Workspace", type: "string", required: true },
          { name: "readOnly", label: "Read only", type: "boolean" },
        ],
      },
      {
        kind: "dialog",
        id: "rq_dlg1",
        dialogKind: "refusal_fallback_prompt",
        title: "Try another model?",
        body: "The model declined part of this request. Claude Code can retry it on another model.",
        choices: [
          { id: "retry", label: "Retry on Sonnet 5.5", primary: true },
          { id: "end", label: "End the turn" },
        ],
      },
    ],
  },
  {
    // The tour of the message kinds that the spike dropped (DESIGN.md 6.3): plugin installs, a memory recall, a hook,
    // info lines, an auto-denied call, a retry, a refusal, a failed compaction, the sign-in error, the reconnect
    // dividers, a background subagent and a background command, a workflow with attempts, and a live thinking block.
    id: "tourobxxxxxxxxxxxxxx",
    projectId: "scratchxxx",
    title: "Dry run of the release checklist",
    titleSource: "generated",
    state: "running",
    updatedAt: ago(1),
    sessionId: "b8e4f1a2-6d3c-4e7b-9f05-1c2a3b4d5e6f",
    model: "opus-5.5",
    effort: "high",
    mode: "auto",
    bypassFlag: false,
    context: context(86),
    connectors: connectors(),
    outputs: [{ path: "docs/RELEASE-DRY-RUN.md", kind: "doc" }],
    pending: [],
    items: [
      { kind: "plugin", id: "m_t8_pl1", status: "started" },
      { kind: "plugin", id: "m_t8_pl2", status: "installed", name: "release-tools" },
      { kind: "plugin", id: "m_t8_pl3", status: "failed", name: "changelog-lint", error: "No marketplace you added has a plugin with that name." },
      { kind: "plugin", id: "m_t8_pl4", status: "completed" },
      {
        kind: "memory",
        id: "m_t8_mem1",
        items: [
          { scope: "personal", path: "~/.claude/CLAUDE.md", text: "Never push a tag or publish a package during a dry run." },
          { scope: "team", path: "CLAUDE.md", text: "Release notes go in docs/CHANGES.md, newest first." },
          { scope: "organization", path: "/etc/claude-code/CLAUDE.md" },
        ],
      },
      { kind: "user", id: "m_t8_u1", text: "Do a dry run of the release checklist in docs/RELEASE.md. Run every step that has a dry-run flag, and stop before anything publishes." },
      { kind: "thinking", id: "m_t8_th1", seconds: 5, text: "The checklist has seven steps. Steps 1 to 4 run locally. Step 5 pushes the tag and step 6 publishes, so both must stay dry: check each command for a dry-run flag before it runs." },
      { kind: "assistant", id: "m_t8_a1", markdown: "I'll read the checklist, run each local step, and note what the publishing steps would do." },
      { kind: "tool", id: "tu_t8_r1", name: "Read", summary: "docs/RELEASE.md", status: "ok", input: "docs/RELEASE.md", output: RELEASE_MD },
      { kind: "tool", id: "tu_t8_r2", name: "Read", summary: "docs/CHANGES.md", status: "ok", output: "2,000 lines" },
      { kind: "info", id: "m_t8_i1", level: "warning", text: "docs/CHANGES.md has 2,412 lines, so only the first 2,000 were read.", toolUseId: "tu_t8_r2" },
      { kind: "hook", id: "m_t8_h1", event: "PreToolUse", name: "block-publish", output: "Allowed: the command has --dry-run." },
      {
        kind: "tool",
        id: "tu_t8_b1",
        name: "Bash",
        summary: "bun run release --dry-run",
        status: "ok",
        input: "bun run release --dry-run",
        output: "release v0.4.0 (dry run)\n  install    ok\n  test       ok   212 pass, 0 fail\n  build      ok   4.1 s\n  tag        skipped (dry run)\n  publish    skipped (dry run)",
      },
      { kind: "info", id: "m_t8_i2", level: "notice", text: "The hook block-publish checked this command before it ran.", toolUseId: "tu_t8_b1" },
      { kind: "tool", id: "tu_t8_b2", name: "Bash", summary: "git push origin v0.4.0", status: "auto-denied", input: "git push origin v0.4.0" },
      { kind: "assistant", id: "m_t8_a2", markdown: "Auto mode stopped the tag push, which is right for a dry run: step 5 would push `v0.4.0` to `origin`. Next I'll check the changelog against the merged changes." },
      { kind: "retry", id: "m_t8_rt1", attempt: 2, max: 10, delayMs: 4000, error: "overloaded" },
      { kind: "refusal", id: "m_t8_rf1", text: "Opus 5.5 declined this request, so Claude Code retried it on Sonnet 5.5.", fallback: { model: "sonnet-5.5", scope: "local" }, retracted: [] },
      { kind: "status", id: "m_t8_st1", status: null, compact: "failed", error: "The summary request timed out." },
      { kind: "error", id: "m_t8_e1", text: "API error: the provider's credentials have expired.", signIn: true },
      { kind: "reconnect", id: "m_t8_rc1", phase: "loading" },
      { kind: "reconnect", id: "m_t8_rc2", phase: "missing" },
      { kind: "user", id: "m_t8_u2", text: "I signed in again. Carry on from step 4." },
      { kind: "assistant", id: "m_t8_a3", markdown: "Picking up at step 4. The docs build and the changelog check run in the background while the release gate runs." },
      { kind: "tool", id: "tu_t8_b3", name: "Bash", summary: "bun run docs:build", status: "running", input: "bun run docs:build", elapsedSeconds: 95, background: true },
      {
        kind: "agent",
        id: "tu_t8_ag1",
        agentType: "general-purpose",
        typeDescription: "General-purpose agent for researching complex questions, searching for code, and running tasks of several steps",
        description: "Check the changelog against the merged changes",
        prompt: "Compare docs/CHANGES.md with the merge commits since v0.3.0. List each merged change that the changelog does not mention, with its commit and a one-line entry to add.",
        status: "running",
        background: true,
        toolUses: 6,
        tokens: 18400,
        seconds: 52,
        rows: [
          { kind: "tool", id: "tu_t8_ag1_r1", name: "Read", summary: "docs/CHANGES.md", status: "ok" },
          { kind: "tool", id: "tu_t8_ag1_g1", name: "Grep", summary: "\"#2[0-9][0-9]\" in docs/CHANGES.md", status: "ok", output: "docs/CHANGES.md:3\ndocs/CHANGES.md:9\ndocs/CHANGES.md:14" },
          { kind: "tool", id: "tu_t8_ag1_b1", name: "Bash", summary: "git log --merges --oneline v0.3.0..HEAD", status: "running", input: "git log --merges --oneline v0.3.0..HEAD", elapsedSeconds: 3 },
        ],
        lastText: "Two merged changes are missing so far: the upload retry fix and the new search flag.",
      },
      {
        kind: "workflow",
        id: "tu_t8_wf1",
        name: "release-gate",
        description: "Check the build from four sides before the tag",
        status: "done",
        phases: [
          {
            title: "Checks",
            agents: [
              { label: "licence headers", status: "done", attempt: 1, task: "Check that every source file starts with the licence header.", result: "All 214 source files have the header." },
              { label: "bundle size", status: "done", attempt: 2, task: "Compare the built bundle with the size budget in package.json.", result: "dist/app.js is 182 kB gzipped, under the 200 kB budget. The first attempt timed out while the build ran." },
              { label: "smoke test", status: "failed", attempt: 3, task: "Start the built server and load the home page.", error: "Port 4173 is in use, so the server did not start. All three attempts failed the same way." },
            ],
          },
          {
            title: "Report",
            agents: [{ label: "dry-run report", status: "done", attempt: 1, task: "Write docs/RELEASE-DRY-RUN.md from the checks.", result: "Wrote docs/RELEASE-DRY-RUN.md: 2 checks passed, 1 failed." }],
          },
        ],
      },
      {
        kind: "thinking",
        id: "m_t8_th2",
        seconds: 7,
        live: true,
        tokenEstimate: 1900,
        text: "The smoke test fails because port 4173 is taken, probably by the docs build's preview server. Wait for the background build to end, then run the smoke test again on a free port.",
      },
    ],
  },
  {
    // A chat whose Claude Code is starting (DESIGN.md 4.1 and 6.2): its first message waits for the process, so the
    // row says "Starting" and the chat "Starting Claude Code...".
    id: "startogxxxxxxxxxxxxx",
    projectId: "scratchxxx",
    title: "Add a lint rule for unused exports",
    titleSource: "first-prompt",
    state: "starting",
    updatedAt: ago(0),
    sessionId: "3f6a2c9e-8b14-4d7a-a5e2-9c0b1d4e7f63",
    model: "sonnet-5.5",
    effort: "medium",
    mode: "default",
    bypassFlag: false,
    context: context(0),
    connectors: [],
    outputs: [],
    pending: [],
    items: [{ kind: "user", id: "m_start_u1", text: "Add a lint rule for unused exports." }],
  },
  {
    // A chat whose last turn ended in an error (DESIGN.md 6.2): the row starts with "Failed", and the next message
    // starts a turn again.
    id: "failloxxxxxxxxxxxxxx",
    projectId: "scratchxxx",
    title: "Update the date library",
    titleSource: "generated",
    state: "failed",
    updatedAt: ago(14),
    sessionId: "c2d7e9a4-1f3b-4c86-b0e5-6a8d2f9c4b17",
    model: "sonnet-5.5",
    effort: "medium",
    mode: "acceptEdits",
    bypassFlag: false,
    context: context(18),
    connectors: connectors(),
    outputs: [],
    pending: [],
    items: [
      { kind: "user", id: "m_fail_u1", text: "Update the date library to the latest version and fix what breaks." },
      { kind: "assistant", id: "m_fail_a1", markdown: "I'll check which version the project uses, then update it and run the tests." },
      { kind: "tool", id: "tu_fail_r1", name: "Read", summary: "package.json", status: "ok" },
      { kind: "error", id: "m_fail_e1", text: "API error: the provider had an internal error (500)." },
    ],
  },
];

export const CHATS: Chat[] = SCRIPTED.map(scripted);

export const PREVIEW_SESSIONS: PreviewSession[] = [
  {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    projectId: "kitespanxx",
    title: "Bump the SDK and rerun the gate",
    startedIn: "terminal",
    updatedAt: ago(180),
    items: [
      { kind: "user", id: "m_pv_u1", text: "Bump the Agent SDK to the next patch and rerun the options gate." },
      { kind: "tool", id: "tu_pv_b1", name: "Bash", summary: "bun test test/options-gate.test.ts", status: "ok", output: "12 pass, 0 fail" },
      { kind: "assistant", id: "m_pv_a1", markdown: "The gate still passes with the new patch. I did not commit anything." },
    ],
  },
];

/** The scripted toasts (Claude Code's notifications, DESIGN.md 6.3): each shows while its chat is open. */
export const TOASTS: Toast[] = [
  { id: "t_tour08", chatId: "tourobxxxxxxxxxxxxxx", key: "context-left", text: "Context left until auto-compact: 9%", priority: "high", timeoutMs: null },
];

export const HOST_USER = "dev";

/** The scripted uploads, per chat: demoolxxxxxxxxxxxxxx has two from earlier (a log and a pasted screenshot). */
export const UPLOADS: Record<string, Upload[]> = {
  demoolxxxxxxxxxxxxxx: [
    {
      id: "up_demo1",
      chatId: "demoolxxxxxxxxxxxxxx",
      name: "flaky-run.log",
      size: 48_213,
      type: "text/plain",
      path: `/tmp/kitespan-uploads-${HOST_USER}/u-k3v9q2/flaky-run.log`,
      folder: "temp",
      dir: `/tmp/kitespan-uploads-${HOST_USER}/u-k3v9q2`,
      at: ago(24),
      state: "done",
      progress: 1,
    },
    {
      id: "up_demo2",
      chatId: "demoolxxxxxxxxxxxxxx",
      name: "pasted.png",
      size: 312_480,
      type: "image/png",
      path: `/tmp/kitespan-uploads-${HOST_USER}/u-7hx2md/pasted.png`,
      folder: "temp",
      dir: `/tmp/kitespan-uploads-${HOST_USER}/u-7hx2md`,
      at: ago(21),
      state: "done",
      progress: 1,
    },
  ],
};

export { DEFAULT_SETTINGS, DEFAULT_VIEW, EFFORTS, KEEP_DAYS, LOOK_IDS, LOOKS, MODES, TEXT_SIZES, UPLOAD_FOLDERS, UPLOAD_LIMITS_MB } from "../../web/state/catalog";

/**
 * The tests of the composer, the cards and the Terminal pane read the prototype's `/` menu and model rows: put them in
 * the page's catalog, which stands in for a chat's lists until the areas read the store's (state/catalog.ts).
 */
export function useScriptedCatalog(): void {
  CATALOG_COMMANDS.splice(0, CATALOG_COMMANDS.length, ...COMMANDS);
  CATALOG_MODELS.splice(0, CATALOG_MODELS.length, ...MODELS);
}

/** The store as the prototype's scripted data left it (no socket): the projects, the chats, the uploads, the toasts. */
export function useScriptedState(): void {
  resetState({ projects: structuredClone(PROJECTS), chats: structuredClone(CHATS), uploads: structuredClone(UPLOADS), toasts: structuredClone(TOASTS), ready: true });
}

/** Row 105: the product names that no look's name, hint, tooltip, label or preview may carry. */
export const LOOK_BRANDS = /\b(apple|mac|macos|iphone|ipad|ios|claude)\b/i;
