// The ids of the click-through seed. The route examples of shared/route.ts name one chat, one project, one session,
// one tool-use id and one request id; the seed puts the demo scenarios of the approved prototype under exactly those
// ids, so every example opens on the real server. They are read from the route table, never copied, so a change of
// an example moves the seed with it. Everything else (the other chats, projects and sessions) has ids of its own, of
// the right shapes (shared/ids.ts).

import { CHAT_ID, PROJECT_ID, UPLOAD_ID, UUID } from "../../../shared/ids";
import { ROUTE_BY_NAME, parsePath } from "../../../shared/route";

function exampleOf(route: string): { params: Record<string, string>; query: Record<string, unknown> } {
  const def = ROUTE_BY_NAME[route];
  if (!def) throw new Error(`shared/route.ts has no route called ${route}`);
  const r = parsePath(def.example);
  if (r.name !== route || r.fallbackFrom || r.dropped) throw new Error(`the ${route} example does not parse as its own route`);
  return { params: r.params, query: r.query };
}

function param(route: string, key: string): string {
  const v = exampleOf(route).params[key];
  if (!v) throw new Error(`the ${route} example has no ${key}`);
  return v;
}

function query(route: string, key: string): string {
  const v = exampleOf(route).query[key];
  if (typeof v !== "string") throw new Error(`the ${route} example has no ${key} value`);
  return v;
}

/** The ids the route examples name. */
export const EX = {
  /** The chat of every /c/<chat> example: the prototype's "Fix the flaky upload test". */
  chat: param("chat", "chat"),
  /** The project of /p/<project>, its session path and /new: the prototype's kitespan project. */
  project: param("project", "project"),
  /** A Claude Code session that kitespan has not opened (started in a terminal). */
  session: param("session", "session"),
  /** The message of /c/<chat>/m/<message> and /c/<chat>/thinking/<message>. */
  message: param("message", "message"),
  /** The tool-use id of the tool, agent and workflow blocks and of the permission, question and plan cards. */
  toolUse: param("tool", "toolUse"),
  /** The control request id of the elicitation and dialog cards. */
  request: param("elicitation", "request"),
  /** The / command of /c/<chat>/slash/<command>. */
  command: param("slash", "command"),
  /** The file of /c/<chat>/files/<path>. */
  file: param("files", "path"),
  /** The model row that /c/<chat>/model and /new pick. */
  model: query("model", "pick"),
  /** The MCP server that /c/<chat>/connectors marks. */
  connector: query("connectors", "server"),
  /** R131: the short id of the background session that /c/<chat>/background/<id> names (the background scene's). */
  bg: param("background", "id"),
  /** R130: the device of /settings/notifications/device/<device> (the main scene's, seed/push.ts). */
  device: param("settingsDevice", "device"),
  /** R130: the side exchange of /c/<chat>/btw/<exchange> (the side scene's first kept one, seed/side.ts). */
  exchange: param("sideExchange", "exchange"),
} as const;

// The examples that share an id must agree, or one seed could not open them all.
const AGREE: [string, string, string][] = [
  [param("thinking", "message"), EX.message, "the thinking and message examples"],
  [param("agent", "toolUse"), EX.toolUse, "the agent and tool examples"],
  [param("workflow", "toolUse"), EX.toolUse, "the workflow and tool examples"],
  [param("permission", "request"), EX.toolUse, "the permission and tool examples"],
  [param("question", "request"), EX.toolUse, "the question and tool examples"],
  [param("plan", "request"), EX.toolUse, "the plan and tool examples"],
  [param("dialog", "request"), EX.request, "the dialog and elicitation examples"],
  [param("session", "project"), EX.project, "the session and project examples"],
  [query("new", "project"), EX.project, "the new and project examples"],
  [query("new", "model"), EX.model, "the new and model examples"],
  [param("backgroundStop", "id"), EX.bg, "the background view and Stop examples"],
];
for (const [a, b, what] of AGREE) if (a !== b) throw new Error(`${what} name different ids; the seed needs one`);

/** The seed's own ids. */
export const IDS = {
  projects: {
    kitespan: EX.project,
    notes: "n4tes2api7",
    scratch: "scr4tch2de",
  },
  chats: {
    /** The example chat: "Fix the flaky upload test" (the prototype's c_demo01). */
    upload: EX.chat,
    /** "Pick the test layers" (c_ask02), asleep. */
    layers: "pickthetestlayers2ab",
    /** "Plan the search index" (c_plan03), asleep. */
    search: "planthesearchindex2a",
    /** "Refactor the query parser" (c_run04), renamed, asleep. */
    parser: "refactorthequery2abc",
    /** "Try the markdown renderer" (c_old05), asleep for a day. */
    markdown: "trythemarkdown2abcde",
    /** "Summarize the server logs" (c_idle06), asleep, with a draft the server holds (D49). */
    logs: "summarizetheserverlo",
    /** "Connect the docs server" (c_elic07), asleep. */
    docs: "connectthedocsserver",
    /** "Update the date library" (c_fail10), archived (D48). */
    dates: "updatethedatelibrar2",
    /** "Add a lint rule for unused exports" (c_start09): a chat with no message yet (no session, no transcript). */
    lint: "addalintruleforunuse",
  },
  /** Claude Code session ids of the chats (their transcripts are seeded). */
  sessions: {
    upload: "4f6d2a90-1c3e-4b8f-9a51-7e2d0c6b8a13",
    layers: "8b1e5f02-77aa-4d10-b3c9-2f4e6a9d0c55",
    search: "c2d93b17-0f5e-4e2a-8d6c-91b7a4e3f208",
    parser: "1a7f3c88-5b2d-49e0-a6f1-0d8c2e9b7f46",
    markdown: "e5c14d6a-2f80-4b93-8e7d-3a9f1c0b6d22",
    logs: "93b0e7f1-6c4a-4d58-b2e9-5f1a8c3d7e04",
    docs: "5d2f8c41-9e3a-4b70-8c16-2a9e7d4f0b38",
    dates: "c2d7e9a4-1f3b-4c86-b0e5-6a8d2f9c4b17",
    /** A second session that kitespan has not opened, in the notes-api folder. */
    terminalNotes: "6e8a1d3c-4b7f-4f20-9c5e-1d2b3a4c5e6f",
    /** A terminal session in a folder under the home folder that is no project yet (New environment's Suggested). */
    terminalWebsite: "7f9b2e4d-5c8a-4a31-8d6f-2e3c4b5d6f70",
    /** R131: the background session that the example chat started (the background scene): its own transcript. */
    worker: "3f9a1c2e-7d41-4c8a-9b6e-5a0f2c1d8e47",
    /** R131: a background session of another folder in Claude Code's list, which kitespan never shows. */
    otherWorker: "9b8c7d6e-1a2b-4c3d-8e5f-6a7b8c9d0e1f",
  },
  uploads: {
    log: "flakyrunlogupl2d",
    image: "pastedpngupld2ab",
  },
  /** The task id of the running subagent (agent scene) and of the running workflow (workflow scene). */
  tasks: { agent: "a7f3e2d1c0b9a8f7e", workflow: "w2e4f6a8b0c1d3e5f" },
} as const;

/**
 * A plugin's command in the seed's command list (Claude Code names one `<plugin>:<command>`): 40 characters with a
 * colon, longer than a phone's message box leaves beside the field (row 76; scripts/ui-check.ts chip-layout).
 */
export const LONG_COMMAND = "acme-dev-capabilities-plugin:ws-sync-all";

/**
 * Row 99 in part 2 (the worktree-env scene only): `~/code/shop` as an environment with Worktree on and one variable,
 * whose value the flow plants and then looks for on the page (never shown).
 */
export const PART2_IDS = {
  shop: "shopw2rktr",
  variable: { name: "SHOP_API_TOKEN", value: "shop-planted-7f3e2d1c0b9a" },
} as const;

/** The search gate's projects and their one chat each (the search scene only, seed/search.ts GATE). */
export const GATE_IDS = {
  projects: { big: "gatebig2ab", phone: "gatephone2" },
  chats: { big: "searchonehundredk2ab", phone: "searchtwentyk2abcdef" },
} as const;

// Fix the shapes once, at load: a wrong id would make a scene silently not open.
for (const id of [...Object.values(IDS.projects), ...Object.values(GATE_IDS.projects)]) if (!PROJECT_ID.test(id)) throw new Error(`not a project id: ${id}`);
for (const id of [...Object.values(IDS.chats), ...Object.values(GATE_IDS.chats)]) if (!CHAT_ID.test(id)) throw new Error(`not a chat id: ${id}`);
for (const id of Object.values(IDS.sessions)) if (!UUID.test(id)) throw new Error(`not a session id: ${id}`);
for (const id of Object.values(IDS.uploads)) if (!UPLOAD_ID.test(id)) throw new Error(`not an upload id: ${id}`);
for (const id of [EX.session, EX.message]) if (!UUID.test(id)) throw new Error(`not a uuid: ${id}`);
