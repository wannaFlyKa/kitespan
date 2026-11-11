// The URL scheme (DESIGN.md section 5): the one route table, the strict decoder and the encoder, plus the app route
// families that the server answers with the page. Pure code: no DOM, no history; the page's router adds those.
// Ported from the approved prototype (prototype/src/routes.ts and router.ts) with kitespan's real id patterns, and
// with D48's /c/<chat>/archive, /c/<chat>/delete and the chat list's archived view in v0.1 core.

import { AGENT_REF, BG_ID, BROWSER_TAB_ID, CHANGES_ID, CHAT_ID, PROJECT_ID, UUID } from "./ids";
import { CONTROL_CHARS, EFFORT_IDS, MODE_IDS, isSafeRelativePath } from "./protocol";
import { PUSH_DEVICE_ID, PUSH_LIMITS } from "./push";

// The rule for a path relative to the chat's folder lives with the protocol, which checks the mentions with it too.
export { isSafeRelativePath };

export type RouteKind = "view" | "action";

export type QuerySpec =
  | { type: "text"; max: number }
  | { type: "enum"; values: readonly string[] }
  /** A repeated key: ?pick=A&pick=B, never joined with commas (5.1 rule 6). */
  | { type: "multi"; max: number; itemMax: number }
  | { type: "int"; min: number; max: number }
  /** A value that must match an id pattern. */
  | { type: "id"; re: RegExp }
  /** U4: the other view of the split side panel, as its path after /c/<chat>/ (paneRouteOf). */
  | { type: "pane" };

export interface RouteDef {
  name: string;
  /** Segments; ":x" is a param, "*x" takes the rest of the path. */
  path: string;
  /** "action": the URL may pre-fill, and a named button does the action (5.1 rule 3). */
  kind: RouteKind;
  shows: string;
  prefill: string;
  query: Record<string, QuerySpec>;
  milestone: string;
  /** A deep link that opens this state, with ids of the right shape. */
  example: string;
}

export const VIEW_IDS = ["normal", "thinking", "verbose"] as const;
/**
 * /c/<chat>/shell?type=: what a link may type at the Terminal pane's prompt (D38): the chat's resume command, or
 * (R127, with `tool`) `cd <folder> && claude` for the folder that the tool row's refusal names, or (R131, with `bg`)
 * `claude attach <id>` for a background session that a launch row of the chat printed. No free text ever.
 */
export const SHELL_TYPES = ["resume", "trust", "attach"] as const;
/** /chats?filter= (D48 adds the archived view, which the Archived row at the end of the list opens). */
export const CHAT_FILTERS = ["all", "working", "needs-input", "archived"] as const;
export const PERMISSION_ANSWERS = ["once", "session", "deny"] as const;
export const PLAN_ANSWERS = ["auto", "accept-edits", "bypass", "manual", "keep-planning"] as const;
/**
 * R130: Notifications comes after Chats (each device turns them on for itself, DESIGN-R130 4.5). Iteration 7: Browser
 * after Notifications (DESIGN-B1 4.14).
 */
export const SETTINGS_SECTIONS = ["general", "chats", "notifications", "browser", "models", "appearance", "claude-code", "account", "about"] as const;
/** /c/<chat>/search?scope=: the one kind of row the chat's search pane shows (9.3); absent: every kind. */
export const SEARCH_SCOPES = ["files", "chats", "commands"] as const;
/**
 * The key of each setting row in the URL (6.8). About's two of row 108: Check for updates (its value pre-fills, Save
 * saves), and Update, whose own view is the update's confirm (only its Update button acts, as at
 * /settings/about/restart). R130's two in Notifications: this device's switch (`value` on or off is a draft; its Save,
 * Turn on notifications or Turn off notifications, is the user's own tap that asks the browser) and Show chat titles.
 */
export const SETTING_KEYS = [
  "return-key", "shortcuts", "idle-minutes", "live-max", "new-chats", "allow-bypass", "auto-title", "bash-reply",
  "sessions-from-other-apps", "sessions-open-elsewhere",
  "prompt-suggestions", "upload-folder", "max-upload", "keep-days", "look", "theme", "text-size", "reduce-motion",
  "skills", "output-style", "check-for-updates", "update", "this-device", "show-titles",
] as const;

/**
 * /p/<project>/environment?name= (D60, L41): an environment variable's name, as the server takes one (at most 128
 * characters). It only marks that variable's row; no key of the route carries a value.
 */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** 5.1 rule 7: text, cmd, args, q and url hold at most 5,000 characters. */
const TEXT = { type: "text", max: 5000 } as const;
/** title and value hold at most 120. */
const SHORT = { type: "text", max: 120 } as const;
/** On every /c/<chat> path (6.3). */
const VIEW = { view: { type: "enum", values: VIEW_IDS } } as const;
/**
 * U4 (DESIGN-U4 6): on every view of the side panel and on the copy dialog over the Terminal, the other view of the
 * split panel and its place: above or below the URL's own view (the one used last). It only opens that view.
 */
const PAIR = { above: { type: "pane" }, below: { type: "pane" } } as const;

// Example ids of the right shape (4.4): a chat id is 20 characters of [a-z2-7], a project id 10.
const C = "k3m7q2x4abk3m7q2x4ab";
const P = "k3m7q2x4ab";
const S = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
/** R131: a background session's short id, as `claude --bg` prints it (8 lowercase hex). */
const B = "3f9a1c2e";
/** R130: a device that has notifications on (the hash of its endpoint, 16 of `[a-z2-7]`). */
const D = "k3m7q2x4abk3m7q2";
/** R130: a side question's exchange (the page-made uuid): the click-through's side scene keeps it (seed/side.ts). */
const X = "5e1d7a20-3b4c-4d5e-8f60-71829304a5b6";
/** U1: a turn's changes summary (10 of `[a-z2-7]`, shared/ids.ts CHANGES_ID): the click-through's seed keeps it. */
const H = "m7q2x4abk3";
/** Iteration 7: a tab of the shared browser (10 of `[a-z2-7]`, shared/ids.ts BROWSER_TAB_ID). */
const W = "q2x4abk3m7";

export const ROUTES: readonly RouteDef[] = [
  { name: "home", path: "/", kind: "view", shows: "Home: the new-chat form and Recent", prefill: "nothing", query: {}, milestone: "v0.1 core", example: "/" },
  { name: "new", path: "/new", kind: "action", shows: "The new-chat form", prefill: "project, model, effort, mode and text: the form holds them; Start sends", query: { project: { type: "id", re: PROJECT_ID }, model: SHORT, effort: { type: "enum", values: EFFORT_IDS }, mode: { type: "enum", values: MODE_IDS }, text: TEXT }, milestone: "v0.1 core", example: `/new?project=${P}&model=claude-haiku-5-5&effort=high&mode=plan&text=Plan%20the%20upload%20feature` },
  { name: "chats", path: "/chats", kind: "view", shows: "The chat list: a screen on the phone, a drawer on a medium touch device, the sidebar on a laptop", prefill: "filter (archived: the archived chats, each with Unarchive and Delete in its menu)", query: { filter: { type: "enum", values: CHAT_FILTERS } }, milestone: "v0.1 core", example: "/chats?filter=archived" },
  { name: "project", path: "/p/:project", kind: "action", shows: "One project: its chats, its remembered picks (with Forget) and its folder", prefill: "nothing; Forget forgets", query: {}, milestone: "v0.1 core", example: `/p/${P}` },
  { name: "projectRename", path: "/p/:project/rename", kind: "action", shows: "The project page with the environment's name as a field in its title's place", prefill: "name: shown, not saved; Save saves (the folder never changes)", query: { name: { type: "text", max: 80 } }, milestone: "v0.4 resume (row 99)", example: `/p/${P}/rename?name=kitespan%20app` },
  { name: "projectRemove", path: "/p/:project/remove", kind: "action", shows: "Remove the environment?: what leaves kitespan, with Cancel and Remove; while a chat there works or needs input, the line that says so", prefill: "nothing; Remove takes the environment and its chats out of kitespan (their Claude Code conversations and the folder stay)", query: {}, milestone: "v0.4 resume (row 99)", example: `/p/${P}/remove` },
  { name: "session", path: "/p/:project/session/:session", kind: "action", shows: "A Claude Code session that kitespan has not opened: a read-only preview", prefill: "nothing; Continue here continues it as a chat", query: {}, milestone: "v0.1 core", example: `/p/${P}/session/${S}` },
  // The project's environment (D60, row 73): its folder, the Worktree option and its variables. Its buttons act (the
  // Worktree switch, Edit, Remove, Add variables and Save); `name` only marks a row, so the route is a view (an action
  // route needs an action check in the click-through's seed).
  { name: "projectEnvironment", path: "/p/:project/environment", kind: "view", shows: "The project's environment: its folder, the Worktree option and its environment variables (each name with one fixed mask, never a value)", prefill: "name: that variable's row is marked; the Worktree switch, Edit, Remove and Add variables act only on their own click or tap", query: { name: { type: "id", re: ENV_NAME } }, milestone: "v0.4 resume", example: `/p/${P}/environment?name=API_TIMEOUT_MS` },
  { name: "chat", path: "/c/:chat", kind: "view", shows: "The chat at its end", prefill: "view", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}` },
  // U5: `mark` is the search's query (DESIGN-U5 9); it only marks its words in that message, and acts on nothing.
  { name: "message", path: "/c/:chat/m/:message", kind: "view", shows: "The chat scrolled to one message, highlighted", prefill: "mark: the query's words are marked in that message; on a queued message, Send now and Take back act, each on its own click or tap", query: { mark: SHORT, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/m/${S}` },
  { name: "tool", path: "/c/:chat/tool/:toolUse", kind: "view", shows: "A tool row opened in place (its input and output)", prefill: "nothing; on a running Bash call, Run in background backgrounds it", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/tool/toolu_01AbCdEf` },
  { name: "agent", path: "/c/:chat/agent/:toolUse", kind: "view", shows: "A subagent block opened: its rows, report, Run in background and Stop", prefill: "nothing; Run in background and Stop act", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/agent/toolu_01AbCdEf` },
  { name: "workflow", path: "/c/:chat/workflow/:toolUse", kind: "view", shows: "A workflow block opened: phases, agents, progress and Stop", prefill: "nothing; Stop stops", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/workflow/toolu_01AbCdEf` },
  { name: "thinking", path: "/c/:chat/thinking/:message", kind: "view", shows: "A thinking block unfolded, in any transcript view", prefill: "nothing", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/thinking/${S}` },
  { name: "permission", path: "/c/:chat/permission/:request", kind: "action", shows: "The waiting permission card, focused", prefill: "answer: that button is focused, not pressed", query: { answer: { type: "enum", values: PERMISSION_ANSWERS }, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/permission/toolu_01AbCdEf?answer=once` },
  { name: "question", path: "/c/:chat/question/:request", kind: "action", shows: "The waiting question card, focused", prefill: "pick: an option label, repeated for a multi-select: ticked, not sent", query: { pick: { type: "multi", max: 4, itemMax: 120 }, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/question/toolu_01AbCdEf?pick=Unit%20tests&pick=Click-through` },
  { name: "elicitation", path: "/c/:chat/elicitation/:request", kind: "action", shows: "The waiting MCP elicitation card, focused", prefill: "nothing; Submit, Decline and Cancel act", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/elicitation/req_01AbCd` },
  { name: "dialog", path: "/c/:chat/dialog/:request", kind: "action", shows: "The waiting Claude Code dialog card, focused", prefill: "nothing; the card's buttons act", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/dialog/req_01AbCd` },
  { name: "plan", path: "/c/:chat/plan/:request", kind: "action", shows: "The waiting plan card, focused", prefill: "answer: focused, not pressed", query: { answer: { type: "enum", values: PLAN_ANSWERS }, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/plan/toolu_01AbCdEf?answer=manual` },
  { name: "send", path: "/c/:chat/send", kind: "action", shows: "The composer", prefill: "text: the composer holds it; Send sends", query: { text: TEXT, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/send?text=Run%20the%20tests%20again` },
  { name: "bash", path: "/c/:chat/bash", kind: "action", shows: "The composer in Bash mode", prefill: "cmd: the composer holds it; Run runs", query: { cmd: TEXT, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/bash?cmd=git%20status` },
  { name: "slashMenu", path: "/c/:chat/slash", kind: "view", shows: "The / menu, at the top", prefill: "nothing", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/slash` },
  { name: "slash", path: "/c/:chat/slash/:command", kind: "action", shows: "The / menu on that command's row", prefill: "args: typed after the command chip; Send sends", query: { args: TEXT, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/slash/compact?args=keep%20the%20test%20plan` },
  { name: "add", path: "/c/:chat/add", kind: "view", shows: "The + menu", prefill: "nothing", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/add` },
  { name: "model", path: "/c/:chat/model", kind: "action", shows: "The model picker", prefill: "pick: a model row: marked; Switch switches", query: { pick: SHORT, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/model?pick=claude-haiku-5-5` },
  { name: "effort", path: "/c/:chat/effort", kind: "action", shows: "The model picker at its Effort section", prefill: "pick: a level: marked; Switch switches", query: { pick: { type: "enum", values: EFFORT_IDS }, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/effort?pick=high` },
  { name: "mode", path: "/c/:chat/mode", kind: "action", shows: "The permission-mode picker", prefill: "pick: a mode: marked; Switch switches", query: { pick: { type: "enum", values: MODE_IDS }, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/mode?pick=acceptEdits` },
  { name: "stop", path: "/c/:chat/stop", kind: "action", shows: "A Stop confirm for the running turn", prefill: "nothing; Stop stops", query: { ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/stop` },
  { name: "rename", path: "/c/:chat/rename", kind: "action", shows: "Rename: the title as a field", prefill: "title: shown, not saved; Save saves", query: { title: SHORT, ...VIEW }, milestone: "v0.1 core", example: `/c/${C}/rename?title=Flaky%20upload%20test` },
  { name: "archive", path: "/c/:chat/archive", kind: "action", shows: "Archive: Cancel and the action, Archive (Stop and archive while Claude Code is busy), or Unarchive for an archived chat (D53; on the phone's sheet, Cancel at the top right)", prefill: "nothing; Archive, Stop and archive or Unarchive acts", query: { ...VIEW }, milestone: "v0.1 core (D48)", example: `/c/${C}/archive` },
  { name: "delete", path: "/c/:chat/delete", kind: "action", shows: "Delete this chat? It cannot be undone", prefill: "nothing; Delete ends the chat's process and deletes the chat and its Claude Code transcript", query: { ...VIEW }, milestone: "v0.1 core (D48)", example: `/c/${C}/delete` },
  { name: "terminal", path: "/c/:chat/terminal", kind: "view", shows: "Copy the command: the fallback of Open in terminal", prefill: "nothing; Copy copies (while the chat's Claude Code is still open: Copy a fork command)", query: { ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/terminal` },
  // v0.6 touch (DESIGN 7.9, 9.6): a code of the page the dialog was opened over, on the remote address; no token and
  // no host path. The same URL is a dialog on a tablet and a laptop and a sheet on the phone.
  { name: "phone", path: "/c/:chat/phone", kind: "view", shows: "Open on phone: a code of this chat's page on the remote address", prefill: "nothing", query: { ...VIEW }, milestone: "v0.6 touch", example: `/c/${C}/phone` },
  { name: "shell", path: "/c/:chat/shell", kind: "view", shows: "The chat's Terminal pane: a login shell at a prompt in the chat's folder", prefill: "type=resume: the chat's command typed at the prompt, not run; Enter runs it. type=trust with tool (R127): cd <the folder that the tool row's refusal names> && claude typed, not run, so Claude Code asks its own trust question. type=attach with bg (R131): claude attach <the background session's short id> typed, not run, for a session that a launch row of the chat printed", query: { type: { type: "enum", values: SHELL_TYPES }, tool: { type: "id", re: AGENT_REF }, bg: { type: "id", re: BG_ID }, ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/shell?type=resume` },
  { name: "details", path: "/c/:chat/details", kind: "view", shows: "The side panel with its cards (the Details sheet on the phone)", prefill: "nothing", query: { ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/details` },
  { name: "environment", path: "/c/:chat/environment", kind: "view", shows: "Environment detail: host, folder, branch, Claude Code path and version, the session id", prefill: "nothing", query: { ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/environment` },
  { name: "context", path: "/c/:chat/context", kind: "view", shows: "Context detail", prefill: "nothing", query: { ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/context` },
  { name: "connectors", path: "/c/:chat/connectors", kind: "action", shows: "Connectors detail, with Reconnect per server", prefill: "server: that row is marked; Reconnect reconnects", query: { server: SHORT, ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/connectors?server=docs-search` },
  { name: "outputs", path: "/c/:chat/outputs", kind: "view", shows: "Outputs detail: every file Claude edited in this chat", prefill: "nothing", query: { ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/outputs` },
  // R127: the confirm names a row, never a path, so a link cannot name a folder that Claude Code did not refuse.
  { name: "trust", path: "/c/:chat/trust/:toolUse", kind: "action", shows: "The Trust this folder confirm for the folder that this tool row's refusal names: its real path and Claude Code's own trust question, with Cancel focused", prefill: "nothing; Trust this folder acts on its own click or tap", query: { ...VIEW }, milestone: "iteration 5 (R127)", example: `/c/${C}/trust/toolu_01AbCdEf` },
  // R131: both name the chat and the short id that the chat's own launch row printed, never a path or a session id, so
  // a link cannot open a session that the chat did not start.
  { name: "background", path: "/c/:chat/background/:id", kind: "view", shows: "A background session that this chat started: its transcript, read-only and live, with Open in terminal and Stop", prefill: "nothing", query: { ...VIEW }, milestone: "iteration 5 (R131)", example: `/c/${C}/background/${B}` },
  { name: "backgroundStop", path: "/c/:chat/background/:id/stop", kind: "action", shows: "The Stop confirm for a background session that this chat started, with Cancel focused", prefill: "nothing; Stop stops on its own click or tap", query: { ...VIEW }, milestone: "iteration 5 (R131)", example: `/c/${C}/background/${B}/stop` },
  { name: "sideChat", path: "/c/:chat/btw", kind: "action", shows: "The side chat: the chat's kept side thread and its box (the side panel's column or pane; a sheet over the chat on the phone)", prefill: "text: the side chat's box holds it; Send asks", query: { text: TEXT, ...VIEW, ...PAIR }, milestone: "iteration 5 (R124)", example: `/c/${C}/btw?text=Which%20file%20holds%20the%20cap%3F` },
  // R130: one exchange of the side thread, opened and marked; its Bring back quotes the answer into the message box's
  // draft only on its own press and never sends. An exchange that the thread no longer has shows the side chat and 5.4's line.
  { name: "sideExchange", path: "/c/:chat/btw/:exchange", kind: "view", shows: "The side chat with that exchange open and marked, scrolled into view (its Bring back focused on a laptop)", prefill: "nothing; Bring back puts the answer in the message box as a quote only on its own click or tap, and never sends", query: { ...VIEW, ...PAIR }, milestone: "iteration 5 (R130)", example: `/c/${C}/btw/${X}` },
  { name: "uploads", path: "/c/:chat/uploads", kind: "view", shows: "The chat's uploads: each with Download, Copy path and Remove", prefill: "nothing; Remove removes", query: { ...VIEW, ...PAIR }, milestone: "v0.1 core", example: `/c/${C}/uploads` },
  { name: "files", path: "/c/:chat/files/*path", kind: "view", shows: "A file in the chat's folder: its name, size and Download (a folder downloads as .tar.gz)", prefill: "line", query: { line: { type: "int", min: 1, max: 10000000 }, ...VIEW, ...PAIR }, milestone: "v0.1 core (download), v0.8 review (viewer)", example: `/c/${C}/files/src/upload.ts?line=42` },
  // U1 (DESIGN-U1 8): one turn's changed files, and one file's diff in that turn: a view of the side panel (its sixth
  // kind, changes), and on the phone the chat at that turn's card (row 115). `turn` is the summary's id, never a path.
  // `/c/<chat>/changes` and `/c/<chat>/changes/all/<path>` are kept for the whole chat's view (the next round): no
  // summary id is `all`, so this round both fall back to the chat.
  { name: "changesTurn", path: "/c/:chat/changes/:turn", kind: "view", shows: "The files one turn changed, each with its added and removed lines, in the side panel (on the phone: the chat at that turn's card)", prefill: "nothing", query: { ...VIEW, ...PAIR }, milestone: "iteration 5 (U1)", example: `/c/${C}/changes/${H}` },
  { name: "changesFile", path: "/c/:chat/changes/:turn/*path", kind: "view", shows: "One file's diff in that turn, unified with its old and new line numbers, in the side panel (on the phone: the chat at that turn's card)", prefill: "nothing", query: { ...VIEW, ...PAIR }, milestone: "iteration 5 (U1)", example: `/c/${C}/changes/${H}/src/upload.ts` },
  { name: "settings", path: "/settings", kind: "view", shows: "Settings at its first section", prefill: "nothing", query: {}, milestone: "v0.1 core", example: "/settings" },
  { name: "restart", path: "/settings/about/restart", kind: "action", shows: "The restart dialog", prefill: "nothing; Restart when they finish and Restart now act", query: {}, milestone: "v0.4 resume", example: "/settings/about/restart" },
  { name: "settingsSection", path: "/settings/:section", kind: "view", shows: "One Settings section", prefill: "nothing", query: {}, milestone: "v0.1 core", example: "/settings/about" },
  { name: "setting", path: "/settings/:section/:key", kind: "action", shows: "One setting, focused", prefill: "value: shown, not saved; Save saves", query: { value: SHORT }, milestone: "v0.1 core", example: "/settings/chats/live-max?value=12" },
  // R130: a device's row in Settings > Notifications, never its endpoint: the id is its hash.
  { name: "settingsDevice", path: "/settings/notifications/device/:device", kind: "action", shows: "Settings at Notifications with that device's row marked and its name as a field", prefill: "name: in the field, not saved; Save saves; Turn off acts only on its own click or tap", query: { name: { type: "text", max: PUSH_LIMITS.name } }, milestone: "iteration 5 (R130)", example: `/settings/notifications/device/${D}?name=My%20iPhone` },
  { name: "search", path: "/search", kind: "view", shows: "Search with no chat open: chats by title", prefill: "q: in the field; a pick opens the chat", query: { q: TEXT }, milestone: "v0.3 search", example: "/search?q=upload" },
  { name: "chatSearch", path: "/c/:chat/search", kind: "view", shows: "The chat's search pane, a side panel view: chats by title, the chat folder's files and the chat's uploads, and the chat's slash commands", prefill: "q in the field and scope selected; a pick is a navigation, and a command's pick only fills the composer", query: { q: TEXT, scope: { type: "enum", values: SEARCH_SCOPES }, ...VIEW, ...PAIR }, milestone: "v0.3 search", example: `/c/${C}/search?q=upl&scope=files` },
  { name: "mention", path: "/c/:chat/mention", kind: "view", shows: "The @ picker over the chat's folder, risen from the composer", prefill: "q: the picker's filter, shown as @<q> in the field and not saved as the draft until the user changes it; no chip until a pick", query: { q: TEXT, ...VIEW }, milestone: "v0.3 search", example: `/c/${C}/mention?q=upl` },
  // Iteration 7 (DESIGN-B1 4.1): the browser pane, a page of its own here and the side panel's seventh kind beside a
  // chat below. `url` only fills a new tab's address field, which opens only on Go or Enter (DESIGN 9.5).
  { name: "browser", path: "/browser", kind: "view", shows: "The browser pane", prefill: "url: in a new tab's address field, not opened; Go opens", query: { url: TEXT }, milestone: "iteration 7 (browser)", example: "/browser?url=http%3A%2F%2F127.0.0.1%3A3000" },
  { name: "browserTab", path: "/browser/:tab", kind: "view", shows: "The browser pane, one tab", prefill: "nothing", query: {}, milestone: "iteration 7 (browser)", example: `/browser/${W}` },
  { name: "chatBrowser", path: "/c/:chat/browser", kind: "view", shows: "The browser pane in the chat's side panel (its own page on the phone)", prefill: "url: in a new tab's address field, not opened; Go opens", query: { url: TEXT, ...VIEW, ...PAIR }, milestone: "iteration 7 (browser)", example: `/c/${C}/browser?url=http%3A%2F%2F127.0.0.1%3A3000` },
  { name: "chatBrowserTab", path: "/c/:chat/browser/:tab", kind: "view", shows: "The browser pane in the chat's side panel, one tab", prefill: "nothing", query: { ...VIEW, ...PAIR }, milestone: "iteration 7 (browser)", example: `/c/${C}/browser/${W}` },
];

export const ROUTE_BY_NAME: Readonly<Record<string, RouteDef>> = Object.fromEntries(ROUTES.map((r) => [r.name, r]));

/**
 * The views of a chat's side panel (6.7, 5.3): the cards, their detail views, the chat's uploads, a file's
 * download view (D37) and the chat's search pane (9.3). Closing the panel steps back over all of them. U1: a turn's
 * changes and one file's diff.
 */
export const PANEL_ROUTES: ReadonlySet<string> = new Set(["details", "environment", "context", "connectors", "outputs", "uploads", "files", "chatSearch", "sideChat", "sideExchange", "changesTurn", "changesFile", "chatBrowser", "chatBrowserTab"]);

/** The panes that take the side panel's place (7.3): the panel's own views and the Terminal pane. U4: two at a time. */
export const PANE_ROUTES: ReadonlySet<string> = new Set([...PANEL_ROUTES, "shell"]);

// ---------------------------------------------------------------------------------------------------------------
// U4: two views in the side panel (DESIGN-U4 4 and 6)

/** The keys that name the other view of the split panel: it sits above, or below, the URL's own view. */
export const PAIR_KEYS = ["above", "below"] as const;
export type PairKey = (typeof PAIR_KEYS)[number];

/**
 * The pane bar's five kinds (DESIGN-U4 4.1), and U1's sixth, a turn's changes (its list and one file's diff are one
 * kind, so a pair never shows two of them; the pane bar has no button for it this round). Two halves never show the
 * same kind. The copy dialog over the Terminal (`terminal`) is the Terminal's view in a pair. Iteration 7 (DESIGN-B1
 * 4.1): the seventh, the browser pane (all its tabs are one kind).
 */
export type PaneKind = "details" | "files" | "terminal" | "search" | "side" | "changes" | "browser";
const PANE_KIND: Readonly<Record<string, PaneKind>> = {
  details: "details",
  environment: "details",
  context: "details",
  connectors: "details",
  outputs: "details",
  uploads: "files",
  files: "files",
  shell: "terminal",
  terminal: "terminal",
  chatSearch: "search",
  sideChat: "side",
  sideExchange: "side",
  changesTurn: "changes",
  changesFile: "changes",
  chatBrowser: "browser",
  chatBrowserTab: "browser",
};

/** The kind of a route's view in the side panel, or null for a route that is no view of it. */
export function paneKindOf(name: string): PaneKind | null {
  return Object.hasOwn(PANE_KIND, name) ? PANE_KIND[name]! : null;
}

/**
 * A value holds at most this much: U1's `changes/`, a 10-symbol summary id, `/` and a 1,024-character path (a file's
 * `files/` and its path take 1,030).
 */
export const PANE_VALUE_MAX = 1043;

/** The prefix of every view of a chat's side panel in the route table. */
const CHAT_PREFIX = "/c/:chat/";

/**
 * A view's value: its path after /c/<chat>/ with its params as they are (`files/src/a.ts`, `btw/<exchange>`), and
 * `shell` for the copy dialog over the Terminal. Null for a route that is no view of the side panel.
 */
export function paneValueOf(route: Pick<Route, "name" | "def" | "params">): string | null {
  if (route.name === "terminal") return "shell";
  if (!PANE_ROUTES.has(route.name) || !route.def.path.startsWith(CHAT_PREFIX)) return null;
  return route.def.path
    .slice(CHAT_PREFIX.length)
    .split("/")
    .map((p) => (p.startsWith(":") || p.startsWith("*") ? (route.params[p.slice(1)] ?? "") : p))
    .join("/");
}

/**
 * The route a value names in chat `chat`: a view of the side panel matched by the route table's own patterns and param
 * rules, at most PANE_VALUE_MAX characters, with no query or hash part, no empty segment and no control character, and
 * in the one spelling paneValueOf writes. Null for anything else (the decoder drops the key, DESIGN-U4 6.3).
 */
export function paneRouteOf(chat: string, value: string): Route | null {
  if (!value || value.length > PANE_VALUE_MAX || /[?#]/.test(value) || CONTROL_CHARS.test(value)) return null;
  const segs = value.split("/");
  if (segs.some((s) => s === "")) return null;
  const r = parsePath(`/c/${encodeURIComponent(chat)}/${segs.map(encodeURIComponent).join("/")}`);
  if (r.fallbackFrom || r.dropped || !PANE_ROUTES.has(r.name)) return null;
  return paneValueOf(r) === value ? r : null;
}

/** A chat id that fits CHAT_ID: the decoder checks a value's pattern with it (the value names a view of the URL's chat). */
const PATTERN_CHAT = "k3m7q2x4abk3m7q2x4ab";

/**
 * Whether route `name` may show `value` at `key` (DESIGN-U4 6.3): another kind than its own, never the Terminal
 * above, and nothing below the Terminal (the Terminal always takes the lower half).
 */
export function pairAllowed(name: string, key: PairKey, value: string): boolean {
  const own = paneKindOf(name);
  const r = paneRouteOf(PATTERN_CHAT, value);
  const other = r ? paneKindOf(r.name) : null;
  if (!own || !other || own === other) return false;
  if (key === "above" && other === "terminal") return false;
  return !(key === "below" && own === "terminal");
}

/**
 * The pair's rules over a decoded query: both keys at once drop both, and a value that route `name` may not show at
 * its key drops that key. True when a key was dropped (the route is flagged, 5.4).
 */
function dropRefusedPair(name: string, query: Record<string, QueryValue>, search: URLSearchParams): boolean {
  const def = ROUTE_BY_NAME[name];
  if (!def || !PAIR_KEYS.every((k) => k in def.query)) return false;
  if (search.has("above") && search.has("below")) {
    delete query.above;
    delete query.below;
    return true;
  }
  let dropped = false;
  for (const key of PAIR_KEYS) {
    const v = query[key];
    if (typeof v === "string" && !pairAllowed(name, key, v)) {
      delete query[key];
      dropped = true;
    }
  }
  return dropped;
}

/**
 * The app route families (5.1 rule 1): the exact paths and the prefixes that the server answers with the page. A
 * prefix does not match its bare form (`/c`), and every path outside the families gets a 404, never the page.
 */
export const APP_EXACT_PATHS: readonly string[] = ["/", "/new", "/chats", "/search", "/settings", "/browser"];
export const APP_PATH_PREFIXES: readonly string[] = ["/c/", "/p/", "/settings/", "/browser/"];

/** True for a path that the server answers with the page (the pathname only, no query). */
export function isAppPath(pathname: string): boolean {
  return APP_EXACT_PATHS.includes(pathname) || APP_PATH_PREFIXES.some((p) => pathname.startsWith(p) && pathname.length > p.length);
}

// ---------------------------------------------------------------------------------------------------------------
// The strict decoder (5.1 rule 6)

export type QueryValue = string | string[] | number;

export interface Route {
  name: string;
  def: RouteDef;
  params: Record<string, string>;
  query: Record<string, QueryValue>;
  /** The URL that was asked for, when the decoder fell back to a parent because it was not valid. */
  fallbackFrom?: string;
  /** A query value was present but did not parse ("Part of that link could not be read."). */
  dropped?: boolean;
  /**
   * U4: the route draws one half of the split side panel (web/layout/split.ts): `url`, the whole pair's URL; `slot`,
   * the half's place; `path`, whether it is the URL's own view (the one used last, which alone takes the focus and a
   * pre-fill). A half's links and its close read it.
   */
  half?: { url: string; slot: "upper" | "lower"; path: boolean };
}

export const PARAM_RULES: Readonly<Record<string, (v: string) => boolean>> = {
  chat: (v) => CHAT_ID.test(v),
  project: (v) => PROJECT_ID.test(v),
  message: (v) => AGENT_REF.test(v),
  toolUse: (v) => AGENT_REF.test(v),
  request: (v) => AGENT_REF.test(v),
  /** Iteration 7: a tab of the shared browser (DESIGN-B1 4.1), never the page's own tab id. */
  tab: (v) => BROWSER_TAB_ID.test(v),
  session: (v) => UUID.test(v),
  command: (v) => /^[A-Za-z0-9:_-]{1,64}$/.test(v),
  section: (v) => (SETTINGS_SECTIONS as readonly string[]).includes(v),
  key: (v) => (SETTING_KEYS as readonly string[]).includes(v),
  path: isSafeRelativePath,
  /** R131: a background session's short id. */
  id: (v) => BG_ID.test(v),
  /** R130: a device's id (the hash of its endpoint). */
  device: (v) => PUSH_DEVICE_ID.test(v),
  /** R130: a side question's exchange (the page-made uuid). */
  exchange: (v) => UUID.test(v),
  /** U1: a turn's changes summary (never `all`, which the whole chat's view keeps). */
  turn: (v) => CHANGES_ID.test(v),
};

function decodeSegment(s: string): string | null {
  try {
    const d = decodeURIComponent(s);
    return CONTROL_CHARS.test(d) ? null : d;
  } catch {
    return null;
  }
}

function matchDef(def: RouteDef, segs: string[]): Record<string, string> | null {
  const pat = def.path === "/" ? [] : def.path.slice(1).split("/");
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p.startsWith("*")) {
      const rest = segs.slice(i);
      if (!rest.length) return null;
      const decoded = rest.map(decodeSegment);
      if (decoded.some((d) => d === null)) return null;
      const name = p.slice(1);
      params[name] = decoded.join("/");
      return PARAM_RULES[name]?.(params[name]!) === false ? null : params;
    }
    const s = segs[i];
    if (s === undefined) return null;
    if (p.startsWith(":")) {
      const d = decodeSegment(s);
      const rule = PARAM_RULES[p.slice(1)];
      if (d === null || (rule && !rule(d))) return null;
      params[p.slice(1)] = d;
    } else if (p !== s) return null;
  }
  return segs.length === pat.length ? params : null;
}

/** A query part's name or value as URLSearchParams reads it ("+" a space), or null when a percent escape does not decode. */
function decodeQueryPart(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * The keys of a raw query string (`url.search`) with a value whose percent escape does not decode. URLSearchParams
 * reads such a value with replacement characters and never throws, so the raw string is checked here (5.1 rule 6).
 */
function undecodableKeys(rawSearch: string): Set<string> {
  const bad = new Set<string>();
  const q = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;
  if (!q.includes("%")) return bad;
  for (const part of q.split("&")) {
    const eq = part.indexOf("=");
    const name = decodeQueryPart(eq < 0 ? part : part.slice(0, eq));
    if (name !== null && eq >= 0 && decodeQueryPart(part.slice(eq + 1)) === null) bad.add(name);
  }
  return bad;
}

/**
 * Decode the allowed query keys. An unknown key is ignored; a bad value drops that key alone. Only a multi key
 * repeats: a single-valued key given two different values is bad too, so neither is read. Newline and tab may stay in
 * a text value; every other control character drops it. `rawSearch` (the URL's own `search`): a key with a value whose
 * percent escape does not decode is bad too.
 */
export function decodeQueryFull(
  spec: Record<string, QuerySpec>,
  search: URLSearchParams,
  rawSearch = "",
): { query: Record<string, QueryValue>; dropped: boolean } {
  const out: Record<string, QueryValue> = {};
  let dropped = false;
  const clean = (v: string) => !CONTROL_CHARS.test(v.replace(/[\n\t]/g, ""));
  const undecodable = undecodableKeys(rawSearch);
  for (const [key, rule] of Object.entries(spec)) {
    if (!search.has(key)) continue;
    if (undecodable.has(key)) {
      dropped = true;
      continue;
    }
    if (rule.type === "multi") {
      const items = search.getAll(key);
      if (items.length <= rule.max && items.every((s) => s.length > 0 && s.length <= rule.itemMax && clean(s))) out[key] = items;
      else dropped = true;
      continue;
    }
    const values = search.getAll(key);
    const raw = values[0]!;
    let ok = false;
    if (values.every((v) => v === raw) && clean(raw)) {
      if (rule.type === "text") ok = raw.length <= rule.max;
      else if (rule.type === "enum") ok = rule.values.includes(raw);
      else if (rule.type === "int") ok = /^[0-9]{1,9}$/.test(raw) && Number(raw) >= rule.min && Number(raw) <= rule.max;
      else if (rule.type === "id") ok = rule.re.test(raw);
      else if (rule.type === "pane") ok = paneRouteOf(PATTERN_CHAT, raw) !== null;
    }
    if (ok) out[key] = rule.type === "int" ? Number(raw) : raw;
    else dropped = true;
  }
  return { query: out, dropped };
}

export function decodeQuery(spec: Record<string, QuerySpec>, search: URLSearchParams): Record<string, QueryValue> {
  return decodeQueryFull(spec, search).query;
}

const HOME = ROUTE_BY_NAME.home!;

/** Decode a URL into a route. Never throws; an invalid path falls back to its nearest valid parent, else Home. */
export function parse(url: URL): Route {
  const asked = url.pathname + url.search;
  try {
    const segs = url.pathname.split("/").filter(Boolean);
    for (let cut = 0; cut <= segs.length; cut++) {
      const trial = segs.slice(0, segs.length - cut);
      for (const def of ROUTES) {
        const params = matchDef(def, trial);
        if (!params) continue;
        const q = cut === 0 ? decodeQueryFull(def.query, url.searchParams, url.search) : { query: {}, dropped: false };
        if (cut === 0 && dropRefusedPair(def.name, q.query, url.searchParams)) q.dropped = true;
        const route: Route = { name: def.name, def, params, query: q.query };
        if (q.dropped) route.dropped = true;
        if (cut > 0) route.fallbackFrom = asked;
        return route;
      }
    }
  } catch {
    // fall through to Home
  }
  return { name: "home", def: HOME, params: {}, query: {}, fallbackFrom: asked };
}

/** Decode a path with its query string (for example `/c/<chat>/send?text=hi`). Never throws. */
export function parsePath(pathAndQuery: string): Route {
  try {
    return parse(new URL(pathAndQuery, "http://kitespan.invalid"));
  } catch {
    return { name: "home", def: HOME, params: {}, query: {}, fallbackFrom: pathAndQuery };
  }
}

/** The canonical URL of a route by name, with its params and the allowed query keys. An unknown name gives "/". */
export function href(name: string, params: Record<string, string> = {}, query: Record<string, QueryValue | undefined> = {}): string {
  const def = ROUTE_BY_NAME[name];
  if (!def) return "/";
  const path =
    def.path === "/"
      ? "/"
      : "/" +
        def.path
          .slice(1)
          .split("/")
          .map((p) => {
            if (p.startsWith("*")) return (params[p.slice(1)] ?? "").split("/").map(encodeURIComponent).join("/");
            if (p.startsWith(":")) return encodeURIComponent(params[p.slice(1)] ?? "");
            return p;
          })
          .join("/");
  const qs = new URLSearchParams();
  // U4: the other view of the split panel goes last, its slashes as they are, and only as a pair the decoder takes.
  const pair: string[] = [];
  const both = PAIR_KEYS.every((k) => typeof query[k] === "string" && query[k] !== "");
  for (const key of Object.keys(def.query)) {
    const v = query[key];
    if (v === undefined || v === "") continue;
    if (def.query[key]!.type === "pane") {
      if (!both && typeof v === "string" && pairAllowed(name, key as PairKey, v)) pair.push(`${key}=${encodeURIComponent(v).replace(/%2F/g, "/")}`);
      continue;
    }
    if (Array.isArray(v)) for (const item of v) qs.append(key, item);
    else qs.set(key, String(v));
  }
  const s = [qs.toString().replace(/\+/g, "%20"), ...pair].filter(Boolean).join("&");
  return s ? `${path}?${s}` : path;
}

/**
 * The route pattern of a path for a log line (4.4 logs, 5.1 rule 7): for example `/c/:chat/files/*`, never the path
 * itself. A path outside the route table gives null.
 */
export function routePattern(pathname: string): string | null {
  if (!isAppPath(pathname)) return null;
  const r = parsePath(pathname);
  if (r.fallbackFrom) return null;
  return r.def.path.replace(/\*[A-Za-z]+$/, "*");
}

/** Every pattern that `routePattern` can give. */
export const ROUTE_PATTERNS: readonly string[] = ROUTES.map((r) => r.path.replace(/\*[A-Za-z]+$/, "*"));
