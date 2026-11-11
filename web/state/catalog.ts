// The page's fixed lists: Desktop's modes and effort levels, the looks, the text sizes, the upload choices and the
// defaults of the settings. What the server knows (the model rows, the `/` menu, the claude binary, the provider, the
// machine's name) comes through the store; the few constants below marked "until wired" stand in for those reads where
// an area screen still imports a constant, and say nothing that is not true of every kitespan.
import type { AppSettings, CommandRow, LookId, ModelRow, PreviewSession, UploadFolder, ViewPrefs } from "./types";

/** Desktop's five modes, in the mode picker's order (6.6). */
export const MODES: { id: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions"; label: string; hint: string }[] = [
  { id: "default", label: "Manual", hint: "Claude asks before editing files or running commands" },
  { id: "acceptEdits", label: "Accept edits", hint: "Claude edits files without asking; still asks before commands" },
  { id: "plan", label: "Plan", hint: "Claude explores and proposes a plan before it changes anything" },
  { id: "auto", label: "Auto", hint: "Claude decides what needs your approval" },
  { id: "bypassPermissions", label: "Bypass permissions", hint: "Claude runs everything without asking" },
];

/** The effort levels from the lowest up (6.6). */
export const EFFORTS: { id: string; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
];

/** The text sizes of Settings > Appearance > Text size (A- and A+ step through them, DESIGN.md 6.13). */
export const TEXT_SIZES = [0.9, 1, 1.1, 1.2, 1.3] as const;

/**
 * Settings > Appearance > Look (D36): the four looks in the picker's order, each with the name under its tile and one
 * line on its feel. Each is a token set in styles/tokens.css (data-look on the root).
 */
export const LOOKS: { id: LookId; label: string; hint: string }[] = [
  { id: "glass", label: "Glass", hint: "Quiet chrome, soft materials and a blue accent" },
  { id: "paper", label: "Paper", hint: "Warm paper, a serif voice for replies and a clay accent" },
  { id: "mono", label: "Mono", hint: "Clean monochrome, a pill composer and black-and-white buttons" },
  { id: "editor", label: "Editor", hint: "An editor: compact, with crisp borders and small corners" },
];
export const LOOK_IDS: readonly LookId[] = LOOKS.map((l) => l.id);

/** The look a stored value names: a look's id; null for anything else. */
export function lookOf(v: unknown): LookId | null {
  return typeof v === "string" && (LOOK_IDS as readonly string[]).includes(v) ? (v as LookId) : null;
}

/** The settings before the server's reply (server/store/types.ts SETTINGS_DEFAULTS) and the device's own defaults. */
export const DEFAULT_SETTINGS: AppSettings = {
  look: "glass",
  theme: "system",
  liveChats: 10,
  idleMinutes: 30,
  allowBypass: false,
  nameChats: true,
  bashReply: "follow",
  returnKey: "send",
  newChats: "last",
  sessionsFromOtherApps: true,
  sessionsOpenElsewhere: false,
  textSize: 1,
  reduceMotion: "system",
  uploadFolder: "temp",
  customFolder: "",
  maxUploadMB: 100,
  keepDays: 7,
};

export const DEFAULT_VIEW: ViewPrefs = { railHidden: false, sidebarHidden: false, widths: {} };

/**
 * Settings > Chats > Uploads > Upload folder (D37): the four choices, their labels, the folder each one means
 * (`<session>` stands for the chat's session id, `<user>` for the user on the host) and one line on how long files
 * stay there. The server's reply names the chosen folder's real path (store.ts uploadRoot uses it).
 */
export const UPLOAD_FOLDERS: { id: UploadFolder; label: string; path: string; hint: string; kept: boolean }[] = [
  { id: "temp", label: "Temporary folder", path: "/tmp/kitespan-uploads-<user>/", hint: "Cleared when the machine restarts", kept: false },
  { id: "state", label: "kitespan's own folder", path: "~/.local/state/kitespan/uploads/", hint: "Kept across restarts", kept: true },
  { id: "claude", label: "Claude Code's uploads folder", path: "~/.claude/uploads/<session>/", hint: "Where Claude Code saves photos sent from its phone app", kept: true },
  { id: "custom", label: "Custom folder", path: "", hint: "A folder you choose on the host", kept: true },
];
/** Largest upload: the choices in MB (DEFAULT_SETTINGS.maxUploadMB is 100). */
export const UPLOAD_LIMITS_MB = [25, 50, 100, 250, 500] as const;
/** Delete uploads after: the choices in days (DEFAULT_SETTINGS.keepDays is 7). */
export const KEEP_DAYS = [1, 7, 30] as const;

// ---- until wired: the areas replace each of these with the store's read of the server

/** Claude Code's default model, the row a picker shows before a chat's `get models` answered (6.6). */
export const DEFAULT_MODEL_ROW: Readonly<ModelRow> = Object.freeze({ id: "default", label: "Default", hint: "Your Claude Code default", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true });
/** The model picker's rows until the composer reads a chat's own (store.ts modelRows). */
export const MODELS: ModelRow[] = [{ ...DEFAULT_MODEL_ROW, efforts: [...DEFAULT_MODEL_ROW.efforts] }];
/** The `/` menu before Claude Code sent one (chat.commands holds it then). */
export const COMMANDS: CommandRow[] = [];
/** Settings > Account: the store's `host.account` holds the provider. */
export const PROVIDER = "";
/** kitespan's own version: the store's `server.version` holds it after `welcome`. */
export const APP_VERSION = "0.1.0";
/** The claude on PATH: the store's `host.claude` holds the path, the real path and the version. */
export const CLAUDE_BINARY = { path: "", realPath: "", version: "", sdk: "0.3.322", sdkCli: "" };
/** From the terminal: the store's `sessions` holds each project's list once read. */
export const PREVIEW_SESSIONS: PreviewSession[] = [];
