// The scenes of the click-through seed. Every route example of shared/route.ts names the same chat, and several name
// the same tool-use id for different things (a tool row, a subagent, a workflow, three kinds of card), so no single
// state of one chat opens them all. A scene is one state of the example chat: the seed is written fresh for it, the
// server boots on it, and the harness sends the warm-up message that puts the chat's Claude Code (the fake claude)
// where the scene needs it. The other chats, the projects, the sessions and the uploads are the same in every scene.
//
// ROUTE_SCENES says which scene opens each route's example; ACTIONS lists the action checks of DESIGN.md 5.5 and 8.4:
// the button to press and exactly the request that the press must send.

import type { Unseen } from "../../../shared/protocol";
import { ROUTES } from "../../../shared/route";
import { CHANGES } from "./changes";
import { ANSWERED_CARD, TRUST_FOLDERS, type UploadSlots } from "./demo";
import { SIDE, SIDE_ANSWERS, WARM } from "./fixture";
import { EX, IDS } from "./ids";

export const SCENES = ["main", "agent", "workflow", "permission", "question", "plan", "elicitation", "running", "archived", "not-sent", "trust", "background"] as const;
export type SceneName = (typeof SCENES)[number];

/**
 * The scenes of the v0.3 search gate (DESIGN.md 9.3; build checklist B6, E1). They are not in SCENES: no route
 * example opens in them, and the route checks and the seed test boot SCENES only. The search gate boots one by name.
 */
export const SEARCH_SCENES = ["search"] as const;
export type SearchSceneName = (typeof SEARCH_SCENES)[number];
/**
 * The scenes of part 2's flows (row 73, D60; scripts/ui-check.ts worktree-new to worktree-off, and row 99's
 * env-remove-worktree). Not in SCENES either: the flows boot them by name, one fresh seed per size, since they add
 * projects, chats, worktrees and variables, or remove them.
 */
export const PART2_SCENES = ["worktree", "worktree-env"] as const;
export type Part2SceneName = (typeof PART2_SCENES)[number];
/**
 * Row 116's scene (R116; scripts/ui-check.ts unseen-dot): not in SCENES either, booted by name, so that one list shows
 * all four dots at once (a chat that needs you, one that runs, one with a reply nobody has seen, one that failed).
 */
export const DOT_SCENES = ["dots"] as const;
export type DotSceneName = (typeof DOT_SCENES)[number];
/**
 * R124's scene (scripts/ui-check.ts side-chat; side-seed.test.ts): not in SCENES either, booted by name: the main scene
 * with a kept side thread in the example chat (seed/side.ts), so the side chat opens with earlier questions.
 */
export const SIDE_SCENES = ["side"] as const;
export type SideSceneName = (typeof SIDE_SCENES)[number];
/**
 * U5's scene (scripts/ui-check.ts search-text; search-text-seed.test.ts): not in SCENES either, booted by name: the
 * main scene plus three chats whose messages hold the flow's words (seed/search-text.ts), one of them archived and one
 * with a transcript over a history page.
 */
export const SEARCH_TEXT_SCENES = ["search-text"] as const;
export type SearchTextSceneName = (typeof SEARCH_TEXT_SCENES)[number];
/**
 * U1's scene (scripts/ui-check.ts changes-card; changes-seed.test.ts): not in SCENES either, booted by name: the main
 * scene plus two chats whose turns change files (seed/changes.ts), one in the kitespan repository and one in the
 * scratch folder (no repository); its warm-up runs the two-file turn in the first.
 */
export const CHANGES_SCENES = ["changes"] as const;
export type ChangesSceneName = (typeof CHANGES_SCENES)[number];
/** Any scene the seed writer takes. */
export type SeedSceneName = SceneName | SearchSceneName | Part2SceneName | DotSceneName | SideSceneName | SearchTextSceneName | ChangesSceneName;

/** What the harness waits for after a warm-up message. */
export type Until =
  /** The turn ended (the chat is idle and its Claude Code stays open). */
  | { k: "turn_end" }
  /** A card with this id is open. */
  | { k: "card"; id: string }
  /** A task started for this tool use. */
  | { k: "task"; toolUse: string }
  /** A tool call with this id has its input (it runs). */
  | { k: "tool"; id: string }
  /** A user message with this uuid shows as Queued. */
  | { k: "queued"; uuid: string };

export interface WarmStep {
  /** The chat the message goes to; absent: the example chat. */
  chat?: string;
  text: string;
  /** The message's uuid (and the send's rid); a random one when absent. */
  uuid?: string;
  until: Until[];
}

export interface Scene {
  name: SeedSceneName;
  about: string;
  /** The ids of the example chat's history rows (demo.ts). */
  slots: UploadSlots;
  /** The example chat's ledger in this scene. */
  upload: { mode?: "plan"; archived?: boolean };
  warm: WarmStep[];
  /** The gate folders this scene adds, each a project with one chat (seed/search.ts GATE). */
  gate?: readonly ("big" | "phone")[];
  /** Messages in the example chat's queue file (RD-8): they waited when kitespan stopped, so boot restores them Not sent. */
  notSent?: readonly { uuid: string; text: string }[];
  /** Part 2's git repositories under the home folder (seed/repos.ts): `~/code/shop`, `~/code/hooks` and `~/code/linked`. */
  repos?: true;
  /** Row 99 in part 2: `~/code/shop` is an environment already (PART2_IDS.shop), with Worktree on and one variable. */
  shopEnv?: true;
  /** Row 116: the chats whose ledger says that an end waits to be seen (`unseen`), by chat id. */
  unseen?: Readonly<Record<string, Unseen>>;
  /** R124: the example chat has a kept side thread (seed/side.ts SIDE_KEPT). */
  side?: true;
  /**
   * R130: kitespan's notifications state: a key and one device that has them on (seed/push.ts), at a host that the
   * server never sends to.
   */
  push?: true;
  /**
   * R131: the example chat's background session runs: its task folder and its own transcript are seeded, the harness
   * starts a stand-in process and writes its record in the seed's registry of running sessions (busy), and the fake
   * claude's agents list holds it beside another folder's session (seed/background.ts).
   */
  bg?: true;
  /** U5: the three chats of seed/search-text.ts, their ledgers and transcripts, beside the seed's own. */
  searchText?: true;
  /** U1: the two chats of seed/changes.ts whose turns change files (the main scene keeps the example chat's summary). */
  changes?: true;
}

const S = EX.message;
const T = EX.toolUse;
/** R131: the Bash call of the background scene whose `claude --bg` printed the launch line. */
export const BG_CALL = "toolu_01StartInvestigator";
// The example message id names the chat's first user message (/m/) and its reply's API message id (/thinking/).
const BASE_SLOTS: UploadSlots = { message: S, thinking: S, edit: T, agent: "toolu_01ExploreCallers", workflow: "toolu_01ReviewWorkflow" };
const AWAY = { edit: "toolu_01EditUpload" };

export const SCENE: Record<SceneName, Scene> = {
  main: {
    name: "main",
    about: "The example chat with its history (the Edit with a diff under the example tool id), live and idle after one more turn that keeps its steps in a to-do list (three TaskCreate and two TaskUpdate calls)",
    slots: BASE_SLOTS,
    upload: {},
    warm: [{ text: WARM.main, until: [{ k: "turn_end" }] }],
    push: true,
  },
  agent: {
    name: "agent",
    about: "A foreground subagent under the example tool id that keeps running",
    slots: { ...BASE_SLOTS, ...AWAY },
    upload: {},
    warm: [{ text: WARM.agent, until: [{ k: "task", toolUse: T }] }],
  },
  workflow: {
    name: "workflow",
    about: "A review workflow under the example tool id that runs while the turn waits on it",
    slots: { ...BASE_SLOTS, ...AWAY, workflow: null },
    upload: {},
    warm: [{ text: WARM.workflow, until: [{ k: "task", toolUse: T }] }],
  },
  permission: {
    name: "permission",
    about: "A Bash permission card that waits, under the example tool id",
    slots: { ...BASE_SLOTS, ...AWAY },
    upload: {},
    warm: [{ text: WARM.permission, until: [{ k: "card", id: T }] }],
  },
  question: {
    name: "question",
    about: "A question card (a multi-select and a single choice) that waits, under the example tool id",
    slots: { ...BASE_SLOTS, ...AWAY },
    upload: {},
    warm: [{ text: WARM.question, until: [{ k: "card", id: T }] }],
  },
  plan: {
    name: "plan",
    about: "A plan card that waits, under the example tool id, in a chat in Plan mode",
    slots: { ...BASE_SLOTS, ...AWAY },
    upload: { mode: "plan" },
    warm: [{ text: WARM.plan, until: [{ k: "card", id: T }] }],
  },
  elicitation: {
    name: "elicitation",
    about: "An MCP elicitation card (form mode) that waits, under the example request id",
    slots: BASE_SLOTS,
    upload: {},
    warm: [{ text: WARM.elicitation, until: [{ k: "card", id: EX.request }] }],
  },
  running: {
    name: "running",
    about: "A turn that runs a Bash call under the example tool id, with a queued message under the example message id",
    slots: { ...BASE_SLOTS, ...AWAY, message: null, thinking: "msg_01FirstLook" },
    upload: {},
    warm: [
      { text: WARM.running, until: [{ k: "tool", id: T }] },
      { text: WARM.queued, uuid: S, until: [{ k: "queued", uuid: S }] },
    ],
  },
  archived: {
    name: "archived",
    about: "The example chat archived (D48): read-only, with Unarchive",
    slots: BASE_SLOTS,
    upload: { archived: true },
    warm: [],
  },
  "not-sent": {
    name: "not-sent",
    about: "A message that waited in the example chat when kitespan stopped, under the example message id: Not sent, with Send again and Take back (RD-8)",
    slots: { ...BASE_SLOTS, message: null, thinking: "msg_01FirstLook" },
    upload: {},
    warm: [],
    notSent: [{ uuid: S, text: WARM.notSent }],
  },
  trust: {
    name: "trust",
    about:
      "R127: the example chat, asleep, whose last turn staged two task folders and started a worker in each with claude --bg; Claude Code refused both (\"Workspace not trusted. ...\"): the one under the example tool id in a new repository nested in the project (tasks/remove-negative-qty), the other in a plain folder of the project's repository (tasks/search-index)",
    slots: { ...BASE_SLOTS, ...AWAY, trust: T },
    upload: {},
    warm: [],
  },
  background: {
    name: "background",
    about:
      "R131: the example chat, asleep, whose last turn staged a task folder in the project (worktrees/remove-negative-qty) and started an investigator there with claude --bg -n investigate-negative-qty: its Bash row printed Claude Code's launch line with the example's short id; the session works (a stand-in process's record in the seed's registry of running sessions), its own transcript is under its folder's slug (a bypass session whose last call waits), and the fake's agents list holds it beside another folder's session",
    slots: { ...BASE_SLOTS, ...AWAY, background: BG_CALL },
    upload: {},
    warm: [],
    bg: true,
  },
};

export const SEARCH_SCENE: Record<SearchSceneName, Scene> = {
  search: {
    name: "search",
    about: "The main scene plus two project folders for the search gate, each with one chat: a git index of 100,000 paths and one of 20,000, with no files on disk",
    slots: BASE_SLOTS,
    upload: {},
    warm: SCENE.main.warm,
    gate: ["big", "phone"],
  },
};

export const PART2_SCENE: Record<Part2SceneName, Scene> = {
  worktree: {
    name: "worktree",
    about: "The seed's projects and chats, all asleep, plus three git repositories under the home folder that no project has: ~/code/shop (two commits on main), ~/code/hooks (a WorktreeCreate hook in its project settings) and ~/code/linked (its .claude a symbolic link)",
    slots: BASE_SLOTS,
    upload: {},
    warm: [],
    repos: true,
  },
  "worktree-env": {
    name: "worktree-env",
    about: "The worktree scene with ~/code/shop an environment already: Worktree on, one variable (SHOP_API_TOKEN), no chat yet",
    slots: BASE_SLOTS,
    upload: {},
    warm: [],
    repos: true,
    shopEnv: true,
  },
};

export const DOT_SCENE: Record<DotSceneName, Scene> = {
  dots: {
    name: "dots",
    about:
      "The four dots of the chat list at once (row 116): the example chat's Bash permission card waits (Needs input), Connect the docs server runs a Bash call (Working), Pick the test layers has a finished turn that no page has seen (Unread) and Refactor the query parser's last turn failed unseen (Failed)",
    slots: { ...BASE_SLOTS, ...AWAY },
    upload: {},
    warm: [
      { text: WARM.permission, until: [{ k: "card", id: T }] },
      { chat: IDS.chats.docs, text: WARM.running, until: [{ k: "tool", id: T }] },
    ],
    unseen: { [IDS.chats.layers]: "done", [IDS.chats.parser]: "failed" },
  },
};

export const SIDE_SCENE: Record<SideSceneName, Scene> = {
  side: {
    name: "side",
    about: "The main scene, with two earlier side questions and their answers kept in the example chat's side thread (R124)",
    slots: BASE_SLOTS,
    upload: {},
    warm: [{ text: WARM.main, until: [{ k: "turn_end" }] }],
    side: true,
  },
};

export const SEARCH_TEXT_SCENE: Record<SearchTextSceneName, Scene> = {
  "search-text": {
    name: "search-text",
    about:
      "The main scene plus three chats whose messages hold the message search's words (U5): a finished turn with a word only in a reply inside its work and one only in a tool's output, an archived chat, and a chat whose matching message is older than its newest history page",
    slots: BASE_SLOTS,
    upload: {},
    warm: [{ text: WARM.main, until: [{ k: "turn_end" }] }],
    searchText: true,
  },
};

export const CHANGES_SCENE: Record<ChangesSceneName, Scene> = {
  changes: {
    name: "changes",
    about:
      "The main scene plus two chats whose turns change files (U1): Tidy the upload retries in the kitespan repository, whose two-file turn (an Edit and a formatter run, the user's own line in README.md between them) ran at warm-up, and Draft the release checklist in the scratch folder, which is not a repository",
    slots: BASE_SLOTS,
    upload: {},
    warm: [{ chat: CHANGES.chats.tidy, text: CHANGES.texts.two, until: [{ k: "turn_end" }] }],
    changes: true,
  },
};

/** The scene of any name the seed writer takes. */
export function sceneOf(name: SeedSceneName): Scene {
  return (
    (SCENE as Record<string, Scene>)[name] ??
    (SEARCH_SCENE as Record<string, Scene>)[name] ??
    (DOT_SCENE as Record<string, Scene>)[name] ??
    (SIDE_SCENE as Record<string, Scene>)[name] ??
    (SEARCH_TEXT_SCENE as Record<string, Scene>)[name] ??
    (CHANGES_SCENE as Record<string, Scene>)[name] ??
    PART2_SCENE[name as Part2SceneName]
  );
}

/** The scenes a route's example opens in: SCENES, and the side scene for R130's link to one exchange. */
export type RouteSceneName = SceneName | SideSceneName;

/** The scene that opens each route's example; every route not named here opens in main. */
const ROUTE_SCENE_OVERRIDES: Partial<Record<string, RouteSceneName>> = {
  agent: "agent",
  workflow: "workflow",
  permission: "permission",
  question: "question",
  plan: "plan",
  elicitation: "elicitation",
  stop: "running",
  trust: "trust",
  background: "background",
  backgroundStop: "background",
  // R130: the example names the first exchange of the side scene's kept thread; main's side thread is empty.
  sideExchange: "side",
};

export function sceneOfRoute(route: string): RouteSceneName {
  return ROUTE_SCENE_OVERRIDES[route] ?? "main";
}

/**
 * Route checks beyond the examples in their own scene: a composer path on an archived chat shows the archived chat and
 * "This chat is archived." (5.4, D48).
 */
export interface RouteVariant {
  id: string;
  route: string;
  scene: SceneName;
  /** The path to open; the route's example by default. */
  path?: string;
  /** The nearest valid parent that the page may move to (5.4). */
  fallback?: string;
  /** The 5.4 line the page must show (instead of no line at all). */
  notice?: string;
  /** The test ids that must show, in place of the route's own (an archived chat shows Unarchive, not the composer). */
  shows?: string[];
}

export const ROUTE_VARIANTS: RouteVariant[] = [
  { id: "send-archived", route: "send", scene: "archived", notice: "This chat is archived.", shows: ["chat"] },
  { id: "chat-archived", route: "chat", scene: "archived", shows: ["chat"] },
  // 8.4: a fresh load of a dead chat link, a bad path inside a family, a card that is not waiting, an over-cap pre-fill.
  { id: "chat-gone", route: "chat", scene: "main", path: `/c/${"z".repeat(20)}`, fallback: "/", notice: "That chat is not here. It may have been deleted.", shows: ["home"] },
  { id: "chat-bad-path", route: "chat", scene: "main", path: `/c/${EX.chat}/contxt`, fallback: `/c/${EX.chat}`, notice: "That link could not be read.", shows: ["chat"] },
  { id: "permission-gone", route: "permission", scene: "main", path: `/c/${EX.chat}/permission/toolu_01NotWaiting`, fallback: `/c/${EX.chat}`, notice: "That request is not waiting in this chat.", shows: ["chat"] },
  // A card that was answered (its record is in the history, from the server's notes, demo.ts ANSWERED_CARD).
  { id: "permission-answered", route: "permission", scene: "main", path: `/c/${EX.chat}/permission/${ANSWERED_CARD}`, fallback: `/c/${EX.chat}`, notice: "That request was already answered.", shows: ["chat"] },
  // A bad value on a card path whose card does not wait (no card waits in main): the card's line alone (principle 0).
  { id: "permission-bad-value", route: "permission", scene: "main", path: `/c/${EX.chat}/permission/${EX.toolUse}?answer=bad`, fallback: `/c/${EX.chat}`, notice: "That request is not waiting in this chat.", shows: ["chat"] },
  { id: "plan-bad-value", route: "plan", scene: "main", path: `/c/${EX.chat}/plan/${EX.toolUse}?answer=bogus`, fallback: `/c/${EX.chat}`, notice: "That request is not waiting in this chat.", shows: ["chat"] },
  {
    id: "send-over-cap",
    route: "send",
    scene: "main",
    path: `/c/${EX.chat}/send?text=${"a".repeat(5001)}`,
    fallback: `/c/${EX.chat}/send`,
    notice: "That link's text is too long to fill in",
    shows: ["chat", "composer"],
  },
  // v0.3 search (8.4): the @ picker's path on an archived chat shows the archived chat and its line; a q over its cap
  // fills nothing and shows the over-cap line, on /search and on the picker's path.
  { id: "mention-archived", route: "mention", scene: "archived", notice: "This chat is archived.", shows: ["chat"] },
  { id: "search-over-cap", route: "search", scene: "main", path: `/search?q=${"a".repeat(5001)}`, fallback: "/search", notice: "That link's text is too long to fill in", shows: ["search-page", "search"] },
  { id: "mention-over-cap", route: "mention", scene: "main", path: `/c/${EX.chat}/mention?q=${"a".repeat(5001)}`, fallback: `/c/${EX.chat}/mention`, notice: "That link's text is too long to fill in", shows: ["chat", "composer"] },
  // The Terminal pane's links (6.10, 5.4): a bad part of the query, and a path past the pane; neither types anything.
  { id: "shell-bad-query", route: "shell", scene: "main", path: `/c/${EX.chat}/shell?type=bogus`, notice: "Part of that link could not be read.", shows: ["terminal-pane", "terminal"] },
  { id: "shell-bad-path", route: "shell", scene: "main", path: `/c/${EX.chat}/shell/extra`, fallback: `/c/${EX.chat}/shell`, notice: "That link could not be read.", shows: ["terminal-pane", "terminal"] },
  // Row 77: each of the two session settings has its own URL; a link's value is marked there and nothing is saved.
  { id: "setting-sessions-from-other-apps", route: "setting", scene: "main", path: "/settings/chats/sessions-from-other-apps?value=off", shows: ["settings-chats", "setting-sessions-from-other-apps", "confirm-save"] },
  { id: "setting-sessions-open-elsewhere", route: "setting", scene: "main", path: "/settings/chats/sessions-open-elsewhere?value=on", shows: ["settings-chats", "setting-sessions-open-elsewhere", "confirm-save"] },
  // Row 108: Check for updates with a link's value (a draft until Save), and the update's confirm (opening it acts on
  // nothing; only its Update button does).
  { id: "setting-check-for-updates", route: "setting", scene: "main", path: "/settings/about/check-for-updates?value=3h", shows: ["settings-about", "setting-check-for-updates", "confirm-save"] },
  { id: "setting-update", route: "setting", scene: "main", path: "/settings/about/update", shows: ["settings-about", "dialog-update", "confirm-update"] },
];

// ---------------------------------------------------------------------------------------------------------------
// The action checks (DESIGN.md 5.5 item 4 and its table, 8.4)

type Frame = Record<string, any>;

/** What the press must send: one request frame on /ws with this `t`, one mutating /api/ request, or nothing (Copy). */
export type Expect =
  | { ws: string; check?: (f: Frame) => string | null }
  | { http: RegExp; methods: readonly string[] }
  | { copy: RegExp };

export interface ActionSpec {
  /** A name for the report: the route's, or the route's with what makes this case its own. */
  id: string;
  route: string;
  scene: SceneName;
  /** The confirm-* test ids to press, the first shown and enabled one; absent: the confirm finder picks. */
  button?: string[];
  expect: Expect;
  /**
   * "variant": one server life for the three sizes (the press leaves what the next size needs); "check": a fresh seed
   * and boot for each size (the press uses up the card, the turn, the task or the chat).
   */
  fresh: "variant" | "check";
  /** The path to open; the route's example by default. */
  path?: string;
  /** A later milestone: a silent button is a warning, not a failure. */
  later?: string;
  /** Why no card may wait here (no dialog kind is built yet): the check presses nothing, and a card that waits fails it. */
  noButton?: string;
  /**
   * "update": the press runs a real update (row 108), so the check boots a scratch checkout of its own, whose origin
   * has one new commit (test/click/scratch.ts), and never this checkout; --base runs none of these.
   */
  scratch?: "update";
  /** How long the server's ack may take, in ms (default 3000). */
  ackMs?: number;
  /** What an ok ack's result must be: null when it is, else what is wrong; absent: any result. */
  ackResult?: (result: unknown) => string | null;
}

const eq = (f: Frame, key: string, want: unknown): string | null => (JSON.stringify(f[key]) === JSON.stringify(want) ? null : `${key} is ${JSON.stringify(f[key])}, not ${JSON.stringify(want)}`);
const all = (...checks: (string | null)[]): string | null => checks.filter(Boolean).join("; ") || null;
/** A `send_now` ack whose result says that the press did `want` (4.3). */
const actedIs =
  (want: string) =>
  (r: unknown): string | null => {
    const acted = (r as { acted?: unknown } | null)?.acted;
    return acted === want ? null : `acted is ${JSON.stringify(acted)}, not ${JSON.stringify(want)}`;
  };
/** R127: a `trust_folder` ack whose answer is `want`. */
const trustIs =
  (want: string) =>
  (r: unknown): string | null => {
    const got = (r as { trust?: unknown } | null)?.trust;
    return got === want ? null : `trust is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`;
  };
/** R131: a `background_stop` ack whose answer is `want`. */
const bgStopIs =
  (want: string) =>
  (r: unknown): string | null => {
    const got = (r as { background?: unknown } | null)?.background;
    return got === want ? null : `background is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`;
  };
/** R124: a `side_question` ack whose exchange answered `question` with `answer`. */
const sideAnswered =
  (question: string, answer: string) =>
  (r: unknown): string | null => {
    const x = (r as { answered?: { question?: unknown; state?: unknown; answer?: unknown } } | null)?.answered;
    return x?.question === question && x.state === "answered" && x.answer === answer ? null : `the ack's result is ${JSON.stringify(r)}, not the answered side question`;
  };
const C = EX.chat;

export const ACTIONS: ActionSpec[] = [
  {
    id: "new",
    route: "new",
    scene: "main",
    button: ["confirm-start"],
    fresh: "variant",
    expect: {
      ws: "new_chat",
      check: (f) => all(eq(f, "project", EX.project), eq(f, "text", "Plan the upload feature"), eq(f.picks ?? {}, "model", EX.model), eq(f.picks ?? {}, "effort", "high"), eq(f.picks ?? {}, "mode", "plan")),
    },
  },
  { id: "project", route: "project", scene: "main", button: ["confirm-forget"], fresh: "check", expect: { http: new RegExp(`^/api/projects/${EX.project}/forget$`), methods: ["POST"] } },
  // Row 99: an environment's Rename saves the link's name; Remove takes the example project and its chats out of kitespan,
  // so a fresh seed at each size.
  { id: "project-rename", route: "projectRename", scene: "main", button: ["confirm-save-name"], fresh: "variant", expect: { http: new RegExp(`^/api/projects/${EX.project}/rename$`), methods: ["POST"] } },
  { id: "project-remove", route: "projectRemove", scene: "main", button: ["confirm-remove"], fresh: "check", expect: { http: new RegExp(`^/api/projects/${EX.project}/remove$`), methods: ["POST"] } },
  { id: "session", route: "session", scene: "main", button: ["confirm-continue"], fresh: "check", expect: { ws: "continue_session", check: (f) => all(eq(f, "project", EX.project), eq(f, "session", EX.session)) } },
  {
    id: "permission",
    route: "permission",
    scene: "permission",
    button: ["confirm-once"],
    fresh: "check",
    expect: { ws: "answer", check: (f) => all(eq(f, "chat", C), eq(f, "card", T), eq(f, "answer", { kind: "permission", allow: true, scope: "once" })) },
  },
  {
    id: "question",
    route: "question",
    scene: "question",
    button: ["confirm-submit"],
    fresh: "check",
    expect: {
      ws: "answer",
      check: (f) => {
        const a = f.answer ?? {};
        if (a.kind !== "question") return `answer.kind is ${JSON.stringify(a.kind)}, not "question"`;
        const multi = a.answers?.["Which tests should the fix add?"];
        return all(eq(f, "card", T), multi === "Unit tests, Click-through" ? null : `the multi-select answer is ${JSON.stringify(multi)}, not the two ticked labels`);
      },
    },
  },
  {
    id: "elicitation",
    route: "elicitation",
    scene: "elicitation",
    // Submit stays off until the required field is filled; Decline answers the card as it opens.
    button: ["confirm-accept", "confirm-decline"],
    fresh: "check",
    expect: { ws: "answer", check: (f) => all(eq(f, "card", EX.request), f.answer?.kind === "elicitation" ? null : `answer.kind is ${JSON.stringify(f.answer?.kind)}`) },
  },
  { id: "dialog", route: "dialog", scene: "main", fresh: "variant", noButton: "no Claude Code dialog kind is declared yet (DESIGN 6.3), so no dialog card waits", expect: { ws: "answer" } },
  {
    id: "plan",
    route: "plan",
    scene: "plan",
    button: ["confirm-manual"],
    fresh: "check",
    expect: { ws: "answer", check: (f) => all(eq(f, "card", T), eq(f, "answer", { kind: "plan", approve: true, mode: "default" })) },
  },
  { id: "send", route: "send", scene: "main", button: ["confirm-send"], fresh: "variant", expect: { ws: "send", check: (f) => all(eq(f, "chat", C), eq(f, "text", "Run the tests again")) } },
  { id: "bash", route: "bash", scene: "main", button: ["confirm-run", "confirm-send"], fresh: "variant", expect: { ws: "bash", check: (f) => all(eq(f, "chat", C), eq(f, "input", "git status")) } },
  { id: "slash", route: "slash", scene: "main", button: ["confirm-send"], fresh: "variant", expect: { ws: "send", check: (f) => all(eq(f, "chat", C), eq(f, "text", `/${EX.command} keep the test plan`)) } },
  { id: "model", route: "model", scene: "main", button: ["confirm-switch-model", "confirm-switch"], fresh: "check", expect: { ws: "set_model", check: (f) => eq(f, "value", EX.model) } },
  { id: "effort", route: "effort", scene: "main", button: ["confirm-switch-effort", "confirm-switch-model", "confirm-switch"], fresh: "check", expect: { ws: "set_effort", check: (f) => eq(f, "value", "high") } },
  { id: "mode", route: "mode", scene: "main", button: ["confirm-switch-mode", "confirm-switch"], fresh: "check", expect: { ws: "set_mode", check: (f) => eq(f, "value", "acceptEdits") } },
  { id: "stop", route: "stop", scene: "running", button: ["confirm-stop"], fresh: "check", expect: { ws: "interrupt", check: (f) => eq(f, "chat", C) } },
  { id: "rename", route: "rename", scene: "main", button: ["confirm-save-title", "confirm-save"], fresh: "variant", expect: { ws: "rename", check: (f) => eq(f, "title", "Flaky upload test") } },
  { id: "archive", route: "archive", scene: "main", button: ["confirm-archive"], fresh: "check", expect: { ws: "archive", check: (f) => all(eq(f, "on", true), eq(f, "stop", false)) } },
  { id: "archive-busy", route: "archive", scene: "running", button: ["confirm-stop-and-archive", "confirm-archive"], fresh: "check", expect: { ws: "archive", check: (f) => all(eq(f, "on", true), eq(f, "stop", true)) } },
  { id: "unarchive", route: "archive", scene: "archived", button: ["confirm-unarchive", "confirm-archive"], fresh: "check", expect: { ws: "archive", check: (f) => eq(f, "on", false) } },
  { id: "delete", route: "delete", scene: "main", button: ["confirm-delete"], fresh: "check", expect: { ws: "delete", check: (f) => eq(f, "chat", C) } },
  { id: "terminal", route: "terminal", scene: "main", button: ["confirm-copy-fork", "confirm-copy"], fresh: "variant", expect: { copy: new RegExp(`claude --resume ${IDS.sessions.upload}`) } },
  // S16: End it here and copy, while the chat's Claude Code lives: the copy inside the click, then one end_here. It ends
  // the chat's process and holds the chat, so a fresh seed at each size.
  { id: "terminal-end-here", route: "terminal", scene: "main", button: ["confirm-end-here"], fresh: "check", expect: { ws: "end_here", check: (f) => eq(f, "chat", C) } },
  { id: "connectors", route: "connectors", scene: "main", button: [`confirm-reconnect-${EX.connector}`], fresh: "variant", expect: { ws: "reconnect_mcp", check: (f) => eq(f, "server", EX.connector) } },
  { id: "setting", route: "setting", scene: "main", button: ["confirm-save"], fresh: "check", expect: { http: /^\/api\/settings$/, methods: ["POST", "PUT"] } },
  // Row 77: Save on each session setting's own URL saves the value its link marked.
  { id: "setting-sessions-from-other-apps", route: "setting", scene: "main", path: "/settings/chats/sessions-from-other-apps?value=off", button: ["confirm-save"], fresh: "check", expect: { http: /^\/api\/settings$/, methods: ["POST"] } },
  { id: "setting-sessions-open-elsewhere", route: "setting", scene: "main", path: "/settings/chats/sessions-open-elsewhere?value=on", button: ["confirm-save"], fresh: "check", expect: { http: /^\/api\/settings$/, methods: ["POST"] } },
  // Row 108: Save on Check for updates' own URL saves the value its link marked.
  { id: "setting-check-for-updates", route: "setting", scene: "main", path: "/settings/about/check-for-updates?value=3h", button: ["confirm-save"], fresh: "check", expect: { http: /^\/api\/settings$/, methods: ["POST"] } },
  // Row 108: the confirm's Update runs a real update, so on a scratch checkout only (one for the three sizes: a second
  // press joins the job that runs, or runs the steps again).
  { id: "update", route: "setting", scene: "main", path: "/settings/about/update", button: ["confirm-update"], fresh: "variant", scratch: "update", expect: { http: /^\/api\/update$/, methods: ["POST"] } },
  // A press restarts the server (4.10): a fresh seed at each size; the harness ends the successor.
  { id: "restart", route: "restart", scene: "main", button: ["confirm-restart"], fresh: "check", expect: { http: /^\/api\/restart$/, methods: ["POST"] } },
  // The rows of the 5.5 table on view routes: a queued message's Take back and a Not sent one's Send again, a running
  // Bash call's and a subagent's Run in background, a subagent's and a workflow's Stop.
  { id: "take-back", route: "message", scene: "running", button: ["confirm-take-back"], fresh: "check", expect: { ws: "take_back", check: (f) => eq(f, "uuid", S) } },
  // Row 111: Send now under the queued message (the link only opens the chat at it); the press acts (it stops the turn).
  // The scene's Bash call never starts a task, so the server first waits its 5 s for one (SEND_NOW_WAIT_MS).
  // The scene's Bash call starts no task: the server waits its 5 s for one, then stops the turn.
  { id: "send-now", route: "message", scene: "running", button: ["send-now", "confirm-send-now"], fresh: "check", ackMs: 8000, ackResult: actedIs("interrupt"), expect: { ws: "send_now", check: (f) => all(eq(f, "chat", C), eq(f, "uuid", S)) } },
  // RD-8: Send again on a message that waited when kitespan stopped (Not sent) starts the chat for it.
  { id: "send-again", route: "message", scene: "not-sent", button: ["send-again"], fresh: "check", expect: { ws: "send_queued", check: (f) => eq(f, "chat", C) } },
  { id: "tool-background", route: "tool", scene: "running", button: ["confirm-background"], fresh: "check", expect: { ws: "background", check: (f) => eq(f, "toolUse", T) } },
  { id: "agent-background", route: "agent", scene: "agent", button: ["confirm-background"], fresh: "check", expect: { ws: "background", check: (f) => eq(f, "toolUse", T) } },
  { id: "agent-stop", route: "agent", scene: "agent", button: ["confirm-stop-task"], fresh: "check", expect: { ws: "stop_task", check: (f) => eq(f, "task", IDS.tasks.agent) } },
  { id: "workflow-stop", route: "workflow", scene: "workflow", button: ["confirm-stop-task"], fresh: "check", expect: { ws: "stop_task", check: (f) => eq(f, "task", IDS.tasks.workflow) } },
  { id: "upload-remove", route: "uploads", scene: "main", button: ["confirm-remove-upload"], fresh: "check", expect: { http: /^\/api\/uploads\/[a-z2-7]{16}$/, methods: ["DELETE"] } },
  // R124: the side chat's link only fills its box; its Send asks the side question (never a send) on the example chat's
  // live Claude Code, which answers in 1.5 s (seed/fixture.ts SIDE.link). Each size's press adds one exchange.
  {
    id: "side-chat",
    route: "sideChat",
    scene: "main",
    button: ["side-send"],
    fresh: "variant",
    ackMs: 8000,
    ackResult: sideAnswered(SIDE.link, SIDE_ANSWERS.link),
    expect: { ws: "side_question", check: (f) => all(eq(f, "chat", C), eq(f, "text", SIDE.link)) },
  },
  // R127: the confirm's link only opens it; its Trust this folder sends one trust_folder for the row's folder, and the
  // server's trust start with the fake claude answers trusted. A press uses the offer up (the next is "already"), so a
  // fresh seed at each size.
  {
    id: "trust",
    route: "trust",
    scene: "trust",
    button: ["confirm-trust"],
    fresh: "check",
    ackMs: 8000,
    ackResult: trustIs("trusted"),
    expect: {
      ws: "trust_folder",
      check: (f) => all(eq(f, "chat", C), eq(f, "toolUse", T), String(f.path).endsWith(`/${TRUST_FOLDERS.nested}`) ? null : `path is ${JSON.stringify(f.path)}, not the refused folder`),
    },
  },
  // R131: the Stop confirm's link only opens it; its Stop sends one background_stop for the example's short id, and
  // the fake claude's `claude stop <id>` answers stopped. A press stops the session, so a fresh seed at each size.
  {
    id: "background-stop",
    route: "backgroundStop",
    scene: "background",
    button: ["confirm-stop-background", "confirm-stop"],
    fresh: "check",
    ackMs: 8000,
    ackResult: bgStopIs("stopped"),
    expect: { ws: "background_stop", check: (f) => all(eq(f, "chat", C), eq(f, "id", EX.bg)) },
  },
  // R130: a device's row with a link's name: its Save renames that device and nothing else (Turn off acts only on its
  // own press). The main scene's device (seed/push.ts) is at a host that the server never sends to.
  // A press renames the device to the link's name, so the next size's link would hold no draft: a fresh seed at each size.
  { id: "settings-device", route: "settingsDevice", scene: "main", button: ["device-save", "confirm-save-name", "confirm-save"], fresh: "check", expect: { http: new RegExp(`^/api/push/devices/${EX.device}$`), methods: ["POST"] } },
];

// Every action route has at least one check, and every check names a known route and scene.
for (const r of ROUTES) if (r.kind === "action" && !ACTIONS.some((a) => a.route === r.name)) throw new Error(`no action check for the action route ${r.name}`);
for (const a of ACTIONS) if (!ROUTES.some((r) => r.name === a.route)) throw new Error(`the action check ${a.id} names no route`);
