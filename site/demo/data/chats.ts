// The demo's chats: the click-through seed's chats (test/click/seed/demo.ts, ids.ts), each with its title, its picks,
// its last activity in minutes before the page's load, and its history as the real server sends it. The example chat's
// history is its own file (example.ts). Pure data.

import type { ChatEvent, ChatTitle, Picks } from "../../../shared/protocol";
import { EXAMPLE_HISTORY } from "./example";

export interface DemoChat {
  chat: string;
  project: string;
  title: ChatTitle;
  picks: Picks;
  /** Minutes before the page's load. */
  agoMin: number;
  archived: boolean;
  /** Its Claude Code session id, once it has a transcript. */
  session?: string;
  /** The draft the server holds (D49). */
  draft?: string;
  history: ChatEvent[];
}

export const DEMO_CHATS: DemoChat[] = [
  {
    chat: "k3m7q2x4abk3m7q2x4ab",
    project: "k3m7q2x4ab",
    title: { text: "Fix the flaky upload test", from: "generated" },
    picks: { model: "claude-opus-5-5", effort: "xhigh", mode: null },
    agoMin: 0,
    archived: false,
    session: "4f6d2a90-1c3e-4b8f-9a51-7e2d0c6b8a13",
    history: EXAMPLE_HISTORY,
  },
  {
    chat: "addalintruleforunuse",
    project: "scr4tch2de",
    title: { text: "Add a lint rule for unused exports", from: "first-prompt" },
    picks: { model: null, effort: null, mode: null },
    agoMin: 1,
    archived: false,
    history: [],
  },
  {
    chat: "connectthedocsserver",
    project: "n4tes2api7",
    title: { text: "Connect the docs server", from: "generated" },
    picks: { model: null, effort: null, mode: null },
    agoMin: 4,
    archived: false,
    session: "5d2f8c41-9e3a-4b70-8c16-2a9e7d4f0b38",
    history: [
      { k: "user", uuid: "5d2f8c41-0000-4000-8000-000000000001", text: "Search the docs server for the sync API and summarize it.", queued: false },
      {
        k: "block",
        key: "msg_07Docs:0",
        kind: "text",
        text: "The docs server is not connected yet: it needs a sign-in first. Reconnect it from Connectors, then ask again.",
        parent: null,
      },
    ],
  },
  {
    chat: "pickthetestlayers2ab",
    project: "k3m7q2x4ab",
    title: { text: "Pick the test layers", from: "first-prompt" },
    picks: { model: "claude-sonnet-5-5", effort: "high", mode: "auto" },
    agoMin: 9,
    archived: false,
    session: "8b1e5f02-77aa-4d10-b3c9-2f4e6a9d0c55",
    history: [
      { k: "user", uuid: "8b1e5f02-0000-4000-8000-000000000001", text: "Add tests for the upload retry. Ask me which layers first.", queued: false },
      {
        k: "block",
        key: "msg_02AskLayers:0",
        kind: "text",
        text: "I would add unit tests for uploadFile with a fake fetch that fails twice, and one click-through that drops a file in the page. Say which you want.",
        parent: null,
      },
    ],
  },
  {
    chat: "planthesearchindex2a",
    project: "n4tes2api7",
    title: { text: "Plan the search index", from: "generated" },
    picks: { model: "claude-opus-5-5", effort: "high", mode: null },
    agoMin: 26,
    archived: false,
    session: "c2d93b17-0f5e-4e2a-8d6c-91b7a4e3f208",
    history: [
      { k: "user", uuid: "c2d93b17-0000-4000-8000-000000000001", text: "Plan a full-text search index for notes. Do not change code yet.", queued: false },
      { k: "tool_call", id: "toolu_03ReadSchema", name: "Read", input: { file_path: "/work/notes-api/src/db/schema.sql" }, parent: null },
      {
        k: "tool_result",
        id: "toolu_03ReadSchema",
        text: "     1\tCREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);",
        isError: false,
        parent: null,
        report: null,
      },
      {
        k: "block",
        key: "msg_03Plan:0",
        kind: "text",
        text: "## Plan: full-text search for notes\n\n1. Add an FTS5 table `notes_fts` with `title` and `body`, kept in sync by three triggers.\n2. Replace the seven `LIKE` queries with one `search(query, limit)` function.\n3. Rank by `bm25()` and return a snippet per hit.",
        parent: null,
      },
    ],
  },
  {
    chat: "refactorthequery2abc",
    project: "n4tes2api7",
    title: { text: "Refactor the query parser", from: "renamed" },
    picks: { model: null, effort: "max", mode: "acceptEdits" },
    agoMin: 35,
    archived: false,
    session: "1a7f3c88-5b2d-49e0-a6f1-0d8c2e9b7f46",
    history: [
      {
        k: "user",
        uuid: "1a7f3c88-0000-4000-8000-000000000001",
        text: "Split the query parser into a tokenizer and a parser, and keep every test green.",
        queued: false,
      },
      {
        k: "block",
        key: "msg_04Tokenizer:0",
        kind: "text",
        text: "The tokenizer is in its own file now. Here is how the parser changes:\n\n- `parse()` takes tokens instead of a string\n- quoted phrases become one token",
        parent: null,
      },
    ],
  },
  {
    chat: "summarizetheserverlo",
    project: "scr4tch2de",
    title: { text: "Summarize the server logs", from: "generated" },
    picks: { model: "claude-sonnet-5-5", effort: null, mode: null },
    agoMin: 48,
    archived: false,
    session: "93b0e7f1-6c4a-4d58-b2e9-5f1a8c3d7e04",
    draft: "Also list the five slowest endpoints.",
    history: [
      { k: "user", uuid: "93b0e7f1-0000-4000-8000-000000000001", text: "Summarize yesterday's server log in five lines.", queued: false },
      {
        k: "block",
        key: "msg_06Summary:0",
        kind: "text",
        text: "1. 41,208 requests, 0.3% errors.\n2. Most errors are timeouts on `/sync` between 14:00 and 14:20.\n3. One restart at 14:22.\n4. p95 latency 180 ms, p99 1.9 s.\n5. No failed logins.",
        parent: null,
      },
    ],
  },
  {
    chat: "trythemarkdown2abcde",
    project: "scr4tch2de",
    title: { text: "Try the markdown renderer", from: "first-prompt" },
    picks: { model: "claude-haiku-5-5", effort: "medium", mode: null },
    agoMin: 1560,
    archived: false,
    session: "e5c14d6a-2f80-4b93-8e7d-3a9f1c0b6d22",
    history: [
      { k: "user", uuid: "e5c14d6a-0000-4000-8000-000000000001", text: "Show me a table, a task list and a code block.", queued: false },
      {
        k: "block",
        key: "msg_05Markdown:0",
        kind: "text",
        text: "| Feature | Works |\n|---|---|\n| Tables | yes |\n| Task lists | yes |\n\n- [x] a done task\n- [ ] an open task\n\n```sh\necho hello\n```",
        parent: null,
      },
    ],
  },
  {
    chat: "updatethedatelibrar2",
    project: "scr4tch2de",
    title: { text: "Update the date library", from: "generated" },
    picks: { model: null, effort: null, mode: "acceptEdits" },
    agoMin: 4320,
    archived: true,
    session: "c2d7e9a4-1f3b-4c86-b0e5-6a8d2f9c4b17",
    history: [
      { k: "user", uuid: "c2d7e9a4-0000-4000-8000-000000000001", text: "Update the date library to the latest version and fix what breaks.", queued: false },
      {
        k: "block",
        key: "msg_10Dates:0",
        kind: "text",
        text: "Updated the date library from 3.6 to 4.1. Two call sites used the removed `format` alias; both use `formatDate` now, and the tests pass.",
        parent: null,
      },
    ],
  },
];
