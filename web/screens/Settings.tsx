// Settings (DESIGN.md 6.8, 5.3): /settings, /settings/<section>, /settings/<section>/<key> and /settings/about/restart.
// A laptop and a medium touch device show the sections on the left, each with a small rounded icon tile, and one
// section on the right as grouped lists (prototype design plan v3: .group in base.css, so every look restyles it); a
// phone shows the list of sections, then one section per screen. Every on/off row is the shared Switch, and every
// choice of two to four is the shared Segmented control or a menu.
//
// The values come from the server (GET /api/settings, read when Settings opens: kitespan's own settings, the claude on
// PATH, the upload folder's check, the account, and the user's own Claude Code settings for a project's folder). A
// change goes to POST /api/settings through the store (act.setSetting), only on its own click, key or Save; this
// device's own settings (the look's first paint, the theme, the text size, Reduce motion, the Return key) stay in local
// storage too. A value in a link is shown and not saved until Save (5.1 rule 3).
//
// Principle 0 (D51): each row has a label, at most one short line and a control; a longer explanation sits one tap
// away, in the row's own view at /settings/<section>/<key> (the "i" beside the label opens it). A clause that keeps
// the user safe stays on the row. No row carries a milestone label or a "Read-only" badge, and a control that is not
// built is not drawn. Until Claude Code reports a value, its place shows "...". What a chat's Claude Code loaded at its
// start (the `session` event's init facts: fast mode, skills and plugins, output style) is read from the chat the user
// came from, else the newest chat that has them; while they are on their way it shows "..." too, and it says "Start a
// chat to read it." only when no chat that runs can bring them.
// Iteration 8 (touch, DESIGN-T1 2.3, 2.9): Keyboard shortcuts is a row of General on every size, since a tablet or a
// phone with a hardware keyboard has every key (T-7); the list leaves out Tab and Right arrow, whose suggested prompt
// is not drawn yet (T-9); About shows the notes for a phone's browser that the server sends (T-23).
// No named Fragment import here: with one, Bun's development JSX transform links this module's <> to a symbol it
// never defines, and a development build shows a blank page.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CHAT_ID } from "../../shared/ids";
import { closeTo, href, navigate, type Route } from "../router";
import { closeSettings, settingsCameFrom, useSettingsDepth } from "./settingsHistory";
import { SETTINGS_SECTIONS, SETTING_KEYS } from "../routes";
import { Shell } from "../layout/Shell";
import { useViewport } from "../layout/size";
import { act, cleanFolder, settingsInit, uploadRoot, useStore, visibleChats } from "../state/store";
import { EFFORTS, KEEP_DAYS, TEXT_SIZES, UPLOAD_FOLDERS, UPLOAD_LIMITS_MB } from "../state/catalog";
import type { AppSettings, Chat, InitFacts, UploadFolder } from "../state/types";
import type { FastModeInfo, ModelInfo } from "../../shared/protocol";
import type { SettingsReply } from "../../server/http/api-types";
import { Link, Popup, Segmented, Switch, relTime } from "../ui/primitives";
import { LinkNotice } from "../ui/LinkNotice";
import { IconBell, IconBolt, IconCheck, IconChevron, IconGear, IconGlobe, IconInfo, IconRight, IconTerminal } from "../ui/icons";
import { BrowserSettings } from "../settings/Browser";
import { listKeys, useSheet } from "../composer/lists";
import { PathText, UNKNOWN } from "../panels/details";
import { MinimumWords, useClaudeFacts } from "../panels/parts";
import { LookRow } from "./LookPicker";
import { IS_MAC } from "../ui/shortcuts";
import { askModelRows } from "./common";
import { aboutFacts, aboutLines, RestartRow, UpdateLink } from "../settings/about";
import { RestartDialog } from "../settings/RestartDialog";
import { RESTART_WORDS } from "../settings/restart";
import { checkedLine, UPDATE_CHECK_LABELS, UPDATE_CHECKS, UPDATE_REFUSAL_LINES, UPDATE_WORDS, type UpdateCheck } from "../../shared/update";
import { checkNow, checkSettingOf, checkValueOf, getUpdateLine, saveCheckSetting, setUpdateState, useUpdateFacts } from "../update/state";
import { UpdateLine } from "../update/UpdateLine";
import type { UpdateReply } from "../../server/http/api-types";
import { UpdateDialog } from "../update/UpdateDialog";
import { NotificationsBody } from "../settings/Notifications";
import { useNotify } from "../notify/useNotify";
import { NOTIFY_WORDS } from "../notify/words";

type SectionId = (typeof SETTINGS_SECTIONS)[number];
type SettingKey = (typeof SETTING_KEYS)[number];

const SECTION_LABEL: Record<SectionId, string> = {
  general: "General",
  chats: "Chats",
  notifications: NOTIFY_WORDS.section,
  // Iteration 7 (DESIGN-B1 4.14): the shared browser, after Notifications.
  browser: "Browser",
  models: "Models",
  appearance: "Appearance",
  "claude-code": "Claude Code",
  account: "Account",
  about: "About",
};

// The section list's icon tiles: iOS colours in the glass look, quiet fills in the others (tokens.css --tile-*).
const stroke = { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const IconBubble = () => (
  <svg {...stroke}>
    <path d="M3.2 3h9.6c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H8.4L5.2 14v-2.6h-2c-.7 0-1.2-.5-1.2-1.2v-6C2 3.5 2.5 3 3.2 3z" />
  </svg>
);
const IconHalf = () => (
  <svg {...stroke}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none" />
  </svg>
);
const IconPerson = () => (
  <svg {...stroke}>
    <circle cx="8" cy="5.6" r="2.6" />
    <path d="M3 13.6c.6-2.5 2.6-3.9 5-3.9s4.4 1.4 5 3.9" />
  </svg>
);
const SECTION_TILE: Record<SectionId, { tile: string; icon: ReactNode }> = {
  general: { tile: "tile-grey", icon: <IconGear size={14} /> },
  chats: { tile: "tile-blue", icon: <IconBubble /> },
  // R130: the red tile (every look has it), the colour iOS gives Notifications, with a bell in the tiles' stroke.
  notifications: { tile: "tile-red", icon: <IconBell size={14} /> },
  browser: { tile: "tile-blue", icon: <IconGlobe size={14} /> },
  models: { tile: "tile-purple", icon: <IconBolt size={14} /> },
  appearance: { tile: "tile-indigo", icon: <IconHalf /> },
  "claude-code": { tile: "tile-orange", icon: <IconTerminal size={14} /> },
  account: { tile: "tile-green", icon: <IconPerson /> },
  about: { tile: "tile-grey", icon: <IconInfo size={14} /> },
};

function SectionTile({ id }: { id: SectionId }) {
  return (
    <span className={`group-icon set-tile ${SECTION_TILE[id].tile}`} aria-hidden="true">
      {SECTION_TILE[id].icon}
    </span>
  );
}

/** The section of each key (DESIGN.md 6.8). The restart dialog's key, `restart`, has its own route under About. */
export const KEY_SECTION: Record<SettingKey, SectionId> = {
  "return-key": "general",
  shortcuts: "general",
  "idle-minutes": "chats",
  "live-max": "chats",
  "new-chats": "chats",
  "allow-bypass": "chats",
  "auto-title": "chats",
  "bash-reply": "chats",
  "sessions-from-other-apps": "chats",
  "sessions-open-elsewhere": "chats",
  "prompt-suggestions": "chats",
  "upload-folder": "chats",
  "max-upload": "chats",
  "keep-days": "chats",
  look: "appearance",
  theme: "appearance",
  "text-size": "appearance",
  "reduce-motion": "appearance",
  skills: "claude-code",
  "output-style": "claude-code",
  // Row 108: Check for updates, and Update, whose own view is the update's confirm.
  "check-for-updates": "about",
  update: "about",
  // R130: this device's switch and Show chat titles.
  "this-device": "notifications",
  "show-titles": "notifications",
};

/** The spike's words, one tap away (D51): they head the own view of each row that reads Claude Code's settings. */
export const NOTHING_CHANGES = "Nothing here changes your Claude Code settings files.";
export const START_A_CHAT = "Start a chat to read it.";
/** Row 97: the one line under a section that shows what a chat's Claude Code reported last, with its age. */
export function keptLine(at: string, now = Date.now()): string {
  const age = relTime(at, now);
  return `From the last chat, ${age === "now" ? "just now" : `${age} ago`}.`;
}
/** REQUIREMENTS item 3, verbatim (8.3 check 1). */
export const RAW_STATEMENT = "Raw Claude Code experience. This app adds no ACP layer and no prompt of its own.";
/** DESIGN.md 5.4 and M16: a path of a later milestone keeps one line and its way back. */
export const NOT_IN_THIS_VERSION = "Not in this version.";

/** The rows that read the user's own Claude Code settings, or what Claude Code loaded from them. */
const READS_CLAUDE: ReadonlySet<SettingKey> = new Set(["bash-reply", "prompt-suggestions", "skills", "output-style"]);

/** The longer explanation of each keyed row, shown in the row's own view (D51). */
export const MORE: Partial<Record<SettingKey, ReactNode>> = {
  "return-key": "With Send, Return sends your message. With New line, Return adds a line and only the Send button sends.",
  "idle-minutes": "After this long with nothing running and nobody viewing it, the chat's Claude Code stops and the chat sleeps. Your next message wakes it in the same session.",
  "live-max": "How many chats can run Claude Code at the same time. When a new chat needs a place, the idle chat you used longest ago sleeps first.",
  "new-chats": "My last choice here uses the model, effort and mode you last picked in that project, as Claude Desktop does; a Plan pick is never kept. My Claude Code defaults uses your Claude Code settings.",
  "allow-bypass": "Adds Bypass permissions to the mode picker. It applies to chats whose Claude Code starts after you turn it on.",
  "auto-title": "Claude Code names each chat after its first reply; until then, the first message is the title. A name you give a chat always wins.",
  "bash-reply": (
    <>
      Follow Claude Code uses your own Claude Code setting, <code>respondToBashCommands</code>: Claude replies to the output of a <code>!</code> command unless you turned that off.
    </>
  ),
  "sessions-from-other-apps": "The Claude Code sessions that you started outside kitespan, in the terminal, the desktop app or another app, under From the terminal on Home and on each project's page, where Continue here makes one a chat. Off hides those lists.",
  "sessions-open-elsewhere": "A session that the terminal, the desktop app or another app has open now, busy or idle. Off leaves it out of the lists. On shows it marked, and its Continue in a copy starts a chat on a copy, so the other app keeps its session. It applies while Show sessions from other apps is on.",
  "prompt-suggestions": (
    <>
      On only while your Claude Code setting <code>promptSuggestionEnabled</code> is true; with no such setting, they are off. kitespan never changes it.
    </>
  ),
  "upload-folder": "Where the files you drop, paste or add land on the host. Each upload gets its own new folder inside it, so the file keeps its name. Claude Code's uploads folder is where Claude Code saves photos sent from its phone app.",
  "max-upload": "A larger file is not uploaded; its chip in the message box says why.",
  "keep-days": "For the kept folders only: kitespan's own, Claude Code's and a custom folder. The temporary folder is cleared when the machine restarts.",
  theme: "System follows your device's light or dark setting, and changes when it does.",
  "text-size": "The size of all text, from 90% to 130%. On a phone, use it instead of pinch zoom.",
  "reduce-motion": "On turns off the reveals and the pulse on a chat that needs you. Follow the system uses your device's setting.",
  skills: "What Claude Code loaded when the chat started. Reload reads skills, plugins and output styles from disk again in every live chat; a sleeping chat reads them when it starts. Install and manage plugins with your own claude.",
  "output-style": (
    <>
      The chat's output style. Claude Code's own <code>/output-style</code> command changes it, when the chat's <code>/</code> menu lists it.
    </>
  ),
  "check-for-updates": "Daily and Every 3 hours look for a new commit on this checkout's origin when the last check is older than that, then on that interval. Manually looks only when you press Check now. A check only reads; kitespan updates only when you press Update, and restarts only when you press Restart.",
};

/** Check for updates' longer words for a kitespan that install.sh installed (DESIGN-I1 3.6). */
export const MORE_RELEASE_CHECK =
  "Daily and Every 3 hours look for a newer kitespan release on GitHub when the last check is older than that, then on that interval. Manually looks only when you press Check now. A check downloads one small file of the latest release, and names no version, no machine and no account. kitespan updates only when you press Update, and restarts only when you press Restart.";

// ---- the rows that change a setting ----

type Field = keyof AppSettings;
type Value = AppSettings[Field];
interface Choice {
  value: string;
  label: string;
  /** Another word a link may use for this choice, such as "auto" for the theme's System. */
  alias?: string;
}
interface Base {
  key: SettingKey;
  field: Field;
  label: ReactNode;
  /** The row's name as plain words, for a control that a screen reader names with a string. */
  name: string;
  /** The one short line that stays on the row: a clause that keeps the user safe. */
  line?: string;
}
type SettingDef =
  /** A choice: the segmented control, or a menu where `menu` says so (and on the phone, for long words). */
  | (Base & { kind: "choice"; choices: Choice[]; numeric?: boolean; menu?: boolean })
  | (Base & {
      kind: "switch";
      risky?: string;
      /** A switch that applies only while another one is on: disabled while that one is off. */
      needs?: Field;
    })
  | (Base & { kind: "number"; min: number; max: number; unit: string })
  | (Base & { kind: "steps"; steps: readonly number[] });

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const DEFS: SettingDef[] = [
  {
    key: "return-key",
    field: "returnKey",
    kind: "choice",
    label: "Return key on touch keyboards",
    name: "Return key on touch keyboards",
    choices: [
      { value: "send", label: "Send" },
      { value: "newline", label: "New line", alias: "new-line" },
    ],
  },
  { key: "idle-minutes", field: "idleMinutes", kind: "number", label: "Keep an idle chat running for", name: "Keep an idle chat running for", min: 1, max: 1440, unit: "minutes" },
  { key: "live-max", field: "liveChats", kind: "number", label: "Live chats at most", name: "Live chats at most", min: 1, max: 20, unit: "chats" },
  {
    key: "new-chats",
    field: "newChats",
    kind: "choice",
    label: "New chats start with",
    name: "New chats start with",
    choices: [
      { value: "last", label: "My last choice here" },
      { value: "defaults", label: "My Claude Code defaults" },
    ],
  },
  {
    key: "allow-bypass",
    field: "allowBypass",
    kind: "switch",
    risky: "Allow bypass permissions mode",
    label: "Allow bypass permissions mode",
    name: "Allow bypass permissions mode",
    line: "In that mode Claude skips most permission prompts.",
  },
  { key: "auto-title", field: "nameChats", kind: "switch", label: "Name chats from their content", name: "Name chats from their content" },
  {
    key: "bash-reply",
    field: "bashReply",
    kind: "choice",
    label: (
      <>
        Claude replies to <code>!</code> output
      </>
    ),
    name: "Claude replies to ! output",
    choices: [
      { value: "follow", label: "Follow Claude Code" },
      { value: "always", label: "Always" },
      { value: "never", label: "Never" },
    ],
  },
  { key: "sessions-from-other-apps", field: "sessionsFromOtherApps", kind: "switch", label: "Show sessions from other apps", name: "Show sessions from other apps" },
  // With no lists (the first one off) there is nothing for it to show: its switch waits for the first one.
  { key: "sessions-open-elsewhere", field: "sessionsOpenElsewhere", kind: "switch", label: "Show sessions open in another app", name: "Show sessions open in another app", needs: "sessionsFromOtherApps" },
  {
    key: "max-upload",
    field: "maxUploadMB",
    kind: "choice",
    numeric: true,
    menu: true,
    label: "Largest upload",
    name: "Largest upload",
    choices: UPLOAD_LIMITS_MB.map((n) => ({ value: String(n), label: `${n} MB` })),
  },
  {
    key: "keep-days",
    field: "keepDays",
    kind: "choice",
    numeric: true,
    label: "Delete uploads after",
    name: "Delete uploads after",
    choices: KEEP_DAYS.map((n) => ({ value: String(n), label: plural(n, "day", "days") })),
  },
  {
    key: "theme",
    field: "theme",
    kind: "choice",
    label: "Theme",
    name: "Theme",
    choices: [
      { value: "system", label: "System", alias: "auto" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },
  { key: "text-size", field: "textSize", kind: "steps", label: "Text size", name: "Text size", steps: TEXT_SIZES },
  {
    key: "reduce-motion",
    field: "reduceMotion",
    kind: "choice",
    label: "Reduce motion",
    name: "Reduce motion",
    choices: [
      { value: "system", label: "Follow the system" },
      { value: "on", label: "On" },
    ],
  },
];
const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));

const percent = (size: number) => `${Math.round(size * 100)}%`;

/** The value a choice saves: its words for most, a number for the upload limit and the days. */
function choiceValue(def: SettingDef, v: string): Value {
  return (def.kind === "choice" && def.numeric ? Number(v) : v) as Value;
}

function parseValue(def: SettingDef, raw: string): Value | null {
  const v = raw.trim().toLowerCase();
  if (def.kind === "choice") {
    // 100, 100mb and "100 MB" name the same upload limit; 7, 7d and "7 days" the same days.
    const n = def.numeric ? /^([0-9]{1,5})\s*(?:mb|d|days?)?$/.exec(v)?.[1] : undefined;
    const c = def.choices.find((c) => c.value === (n ?? v) || c.alias === v);
    return c ? choiceValue(def, c.value) : null;
  }
  if (def.kind === "switch") return ["on", "true", "1"].includes(v) ? true : ["off", "false", "0"].includes(v) ? false : null;
  if (def.kind === "steps") {
    // 1.2, 120 or 120% all name the same step.
    const m = /^([0-9]{1,3}(?:\.[0-9]{1,2})?)%?$/.exec(v);
    if (!m) return null;
    const n = Number(m[1]) > 3 ? Number(m[1]) / 100 : Number(m[1]);
    return def.steps.find((s) => Math.abs(s - n) < 0.001) ?? null;
  }
  if (!/^[0-9]{1,5}$/.test(v)) return null;
  const n = Number(v);
  return n >= def.min && n <= def.max ? n : null;
}

const PART_UNREAD = "Part of that link could not be read.";
const TOO_LONG = "That link's text is too long to fill in (the limit is 5,000 characters, or 120 for a title or a setting).";
function valueOverCap(): boolean {
  if (typeof location === "undefined") return false;
  const raw = new URLSearchParams(location.search).get("value");
  return raw !== null && raw.length > 120;
}

/** The chat a path names, if it is a chat path (`/c/<chat>` and below). */
export function chatOfPath(path: string): string | undefined {
  const id = /^\/c\/([^/?#]+)/.exec(path)?.[1];
  return id && CHAT_ID.test(id) ? id : undefined;
}

/**
 * Where the user was before Settings: Done goes back there (settingsHistory.ts; a fresh tab has no such place, so
 * Done goes Home), and the Claude Code rows read the chat it names, if any.
 */
function useCameFrom(): { to: string; real: boolean; chatId?: string } {
  const [from] = useState(() => {
    const came = settingsCameFrom();
    return { ...came, chatId: chatOfPath(came.to) };
  });
  return from;
}

/** What each section needs to draw its rows. */
interface Ctx {
  focusKey?: SettingKey;
  /** The link's `value`, for the focused key only. */
  urlValue?: string;
  touch: boolean;
  laptop: boolean;
  phone: boolean;
  /** The section is as narrow as the width where its rows stack (panels.css), as on the phone. */
  narrow: boolean;
  /** The chat the user came from, for the rows that read a chat's Claude Code. */
  chat?: Chat;
  /** R130: /settings/notifications/device/<device>?name=: that device's row, and the link's name for it. */
  device?: string;
  deviceName?: string;
}

/**
 * The read of /api/settings when Settings opens (a GET: it changes nothing): with the project of the chat the user
 * came from, else the newest project, so the rows that read the user's own Claude Code settings have a folder. The
 * came-from chat's init facts are read too (a reload keeps settingsFrom, but this page life never attached it), again
 * once the chat list has come; before the first paint, so the rows wait quietly instead of saying Start a chat.
 */
function useSettingsRead(chat?: Chat) {
  const project = useStore((s) => chat?.projectId ?? s.projects[0]?.id);
  const ready = useStore((s) => s.ready);
  useLayoutEffect(() => {
    act.refreshSettings(project, chat?.id);
  }, [project, chat?.id, ready]);
  // A notice left from another screen is not about Settings; one that a save here gets shows (SettingsLine).
  useEffect(() => act.setNotice(null), []);
}

export function Settings({ route }: { route: Route }) {
  const vp = useViewport();
  const phone = vp.size === "phone";
  const came = useCameFrom();
  const chat = useStore((s) => (came.chatId ? s.chats.find((c) => c.id === came.chatId) : undefined));
  const asked = route.name === "restart" ? "about" : route.name === "settingsDevice" ? "notifications" : (route.params.section as SectionId | undefined);
  const section: SectionId = asked ?? "general";
  const focusKey = route.name === "setting" ? (route.params.key as SettingKey) : undefined;
  const ctx: Ctx = {
    focusKey,
    urlValue: route.name === "setting" && typeof route.query.value === "string" ? route.query.value : undefined,
    touch: vp.touch,
    laptop: vp.size === "laptop",
    phone,
    narrow: phone,
    chat,
    device: route.name === "settingsDevice" ? route.params.device : undefined,
    deviceName: route.name === "settingsDevice" && typeof route.query.name === "string" ? route.query.name : undefined,
  };
  useSettingsDepth(route, came);
  useSettingsRead(chat);

  return (
    <Shell route={route}>
      <div className={`set-page${phone ? " set-phone" : ""}`} data-testid="settings">
        {phone && !asked ? (
          <PhoneList route={route} />
        ) : phone ? (
          <div className="set-screen">
            <SectionView id={section} route={route} ctx={ctx} heading="h1" />
          </div>
        ) : (
          <div className="set-wide">
            <h1 className="visually-hidden">Settings</h1>
            <div className="set-body">
              <nav className="set-nav" aria-label="Settings sections">
                {SETTINGS_SECTIONS.map((id) => (
                  <Link key={id} to={href("settingsSection", { section: id })} className="set-nav-item" aria-current={id === section ? "page" : undefined}>
                    <SectionTile id={id} />
                    <span className="set-nav-label">{SECTION_LABEL[id]}</span>
                  </Link>
                ))}
              </nav>
              <SectionView
                id={section}
                route={route}
                ctx={ctx}
                heading="h2"
                action={
                  <button type="button" className="btn" data-testid="settings-done" onClick={closeSettings}>
                    Done
                  </button>
                }
              />
            </div>
          </div>
        )}
        {route.name === "restart" ? <RestartDialog /> : null}
        {/* Row 108: /settings/about/update is the update's confirm over About; only its Update button acts. */}
        {focusKey === "update" && section === "about" ? <UpdateDialog /> : null}
      </div>
    </Shell>
  );
}

/** The phone's list of sections; its title bar (TopBar) has the title and Done, and a section's has Back. */
function PhoneList({ route }: { route: Route }) {
  return (
    <div className="set-screen">
      <h1 className="visually-hidden">Settings</h1>
      <LinkNotice route={route} />
      <UpdateLine screen className="set-notice" />
      <nav aria-label="Settings sections">
        <ul className="group set-list" data-testid="settings-list">
          {SETTINGS_SECTIONS.map((id) => (
            <li key={id}>
              <Link to={href("settingsSection", { section: id })} className="group-row set-list-row">
                <SectionTile id={id} />
                <span className="group-label set-list-label">{SECTION_LABEL[id]}</span>
                <IconRight size={16} className="group-chevron" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="notice set-notice" data-testid="link-notice">
      <span>{children}</span>
    </p>
  );
}

/**
 * The one plain line for this Settings URL (DESIGN.md 5.4), or a save that the server refused, or none; then, where no
 * docked sidebar shows the chat list's foot, the update's line (row 108), except in About, whose rows say it. Exported
 * for the tests.
 */
export function SettingsLine({ route, section, ctx }: { route: Route; section: SectionId; ctx: Ctx }) {
  return (
    <>
      <SectionNotice route={route} section={section} ctx={ctx} />
      {section === "about" ? null : <UpdateLine screen className="set-notice" />}
    </>
  );
}

function SectionNotice({ route, section, ctx }: { route: Route; section: SectionId; ctx: Ctx }) {
  const notice = useStore((s) => s.notice);
  if (route.name === "settingsSection" && route.fallbackFrom) {
    const path = route.fallbackFrom.split("?")[0]!.split("/").filter(Boolean);
    if (path.length >= 3 && path[0] === "settings" && path[1] === section) {
      // Restart is About's key with its own route (the restart dialog).
      if (path.length === 3 && path[2] === "restart")
        return (
          <Notice>
            That setting is in <Link to={href("restart")}>{SECTION_LABEL.about}</Link>.
          </Notice>
        );
      return <Notice>That setting does not exist.</Notice>;
    }
  }
  if (route.name === "setting") {
    const key = route.params.key as SettingKey;
    const home = KEY_SECTION[key];
    if (home !== section)
      return (
        <Notice>
          That setting is in <Link to={href("setting", { section: home, key }, { value: ctx.urlValue })}>{SECTION_LABEL[home]}</Link>.
        </Notice>
      );
    if (route.dropped && valueOverCap()) return <Notice>{TOO_LONG}</Notice>;
  }
  // Over the restart dialog, the restart's own result is the dialog's line (principle 0: one line).
  if (notice && !(route.name === "restart" && notice === RESTART_WORDS.notDone))
    return (
      <p className="notice set-notice" role="status">
        <span>{notice}</span>
      </p>
    );
  return <LinkNotice route={route} />;
}

/** The width at which a section's rows stack, the container query's in panels.css. */
const NARROW_SECTION = 520;

/**
 * True while the section is no wider than NARROW_SECTION, always on the phone; null until the first measure, which
 * runs before the first paint. The rows wait for it, so each row mounts once with its control in the right form.
 */
function useNarrow(ref: RefObject<HTMLElement | null>, phone: boolean): boolean | null {
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (phone || !el) return;
    const read = () => setNarrow(el.getBoundingClientRect().width <= NARROW_SECTION);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [phone]);
  return phone || narrow;
}

function SectionView(props: { id: SectionId; route: Route; ctx: Ctx; heading: "h1" | "h2"; action?: ReactNode }) {
  const { id, route, heading, action } = props;
  const H = heading;
  const box = useRef<HTMLElement>(null);
  const narrow = useNarrow(box, props.ctx.phone);
  const ctx: Ctx = { ...props.ctx, narrow: !!narrow };
  // A key from another section only names its section; it focuses nothing here.
  const own: Ctx = ctx.focusKey && KEY_SECTION[ctx.focusKey] !== id ? { ...ctx, focusKey: undefined, urlValue: undefined } : ctx;
  return (
    <section ref={box} className="set-section" data-testid={`settings-${id}`} aria-labelledby={`set-h-${id}`}>
      <div className="set-title-row">
        <H id={`set-h-${id}`} className="set-title">
          {SECTION_LABEL[id]}
        </H>
        {action}
      </div>
      <SettingsLine route={route} section={id} ctx={ctx} />
      {narrow === null ? null : <SectionBody id={id} ctx={own} />}
    </section>
  );
}

/** A section's rows. Exported for the tests, which draw each section with a chosen context. */
export function SectionBody({ id, ctx }: { id: SectionId; ctx: Ctx }) {
  if (id === "general") return <GeneralSection ctx={ctx} />;
  if (id === "chats") return <ChatsSection ctx={ctx} />;
  if (id === "notifications") return <NotificationsSection ctx={ctx} />;
  if (id === "browser") return <BrowserSettings narrow={ctx.narrow} menu={(m) => <ChoiceMenu {...m} />} />;
  if (id === "models") return <ModelsSection ctx={ctx} />;
  if (id === "appearance") return <AppearanceSection ctx={ctx} />;
  if (id === "claude-code") return <ClaudeCodeSection ctx={ctx} />;
  if (id === "account") return <AccountSection />;
  return <AboutSection ctx={ctx} />;
}

/** A group of rows (an inset grouped list), with its title above it when it has one. */
function Group({ title, children, testId }: { title?: ReactNode; children: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <div className="set-block">
      {title ? (
        <h3 className="group-title set-group-title" id={id}>
          {title}
        </h3>
      ) : null}
      <ul className="group set-group" aria-labelledby={title ? id : undefined} data-testid={testId}>
        {children}
      </ul>
    </div>
  );
}

/** The "i" beside a row's label: it opens the row's own view, where its longer explanation is (D51). */
function MoreLink({ k, name }: { k: SettingKey; name: string }) {
  const to = href("setting", { section: KEY_SECTION[k], key: k });
  return (
    <a
      href={to}
      className="set-more-link"
      data-testid={`setting-more-${k}`}
      aria-label={`About ${name}`}
      title={`About ${name}`}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      <IconInfo size={15} />
    </a>
  );
}

/**
 * A row's words: its label (with the "i" when the row has more to say and its own view is not open), its one short
 * line, a link line when the link's value could not be read, and, in the row's own view, the longer explanation.
 */
function RowWords(props: { k?: SettingKey; label: ReactNode; name: string; labelId?: string; line?: ReactNode; focused: boolean; status?: ReactNode; children?: ReactNode; more?: ReactNode }) {
  const { k, label, name, labelId, line, focused, status, children } = props;
  const more = k ? (props.more ?? MORE[k]) : undefined;
  return (
    <div className="set-row-text">
      <span className="set-label-line">
        <span className="set-label" id={labelId}>
          {label}
        </span>
        {k && more && !focused ? <MoreLink k={k} name={name} /> : null}
      </span>
      {line ? <span className="set-help">{line}</span> : null}
      {status}
      {k && more && focused ? (
        <span className="set-more" data-testid={`setting-more-text-${k}`}>
          {READS_CLAUDE.has(k) ? <span className="set-more-head">{NOTHING_CHANGES}</span> : null}
          <span>{more}</span>
        </span>
      ) : null}
      {children}
    </div>
  );
}

/** A row that changes a setting, keyed by the link's value, so a new value in the link starts a new draft. */
function Editable({ k, ctx }: { k: SettingKey; ctx: Ctx }) {
  const def = DEF_BY_KEY.get(k)!;
  const focused = ctx.focusKey === k;
  const raw = focused ? ctx.urlValue : undefined;
  return <SettingRow key={`${k}|${raw ?? ""}`} def={def} focused={focused} urlRaw={raw} touch={ctx.touch} phone={ctx.phone} narrow={ctx.narrow} />;
}

/**
 * One row that shows a value (or holds a button): its words and its value. `more` sits under the row at full width. A
 * row that its path focuses takes the focus itself, or gives it to `focusRef` (the button that names its action).
 */
function Row(props: {
  rowKey?: SettingKey;
  testId?: string;
  focused?: boolean;
  /** The link gave a value, which a row that shows a value cannot take. */
  badValue?: boolean;
  label: ReactNode;
  name?: string;
  line?: ReactNode;
  readOnly?: boolean;
  value?: ReactNode;
  more?: ReactNode;
  focusRef?: RefObject<HTMLElement | null>;
}) {
  const { rowKey, testId, focused = false, badValue, label, name, line, readOnly, value, more, focusRef } = props;
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    (focusRef?.current ?? rowRef.current)?.focus({ preventScroll: true });
  }, [focused]);
  return (
    <li
      ref={rowRef}
      className="set-row"
      data-testid={testId ?? (rowKey ? `setting-${rowKey}` : undefined)}
      data-focused={focused || undefined}
      data-readonly={readOnly || undefined}
      tabIndex={rowKey ? -1 : undefined}
    >
      <div className="set-row-main">
        <RowWords
          k={rowKey}
          label={label}
          name={name ?? (typeof label === "string" ? label : "")}
          line={line}
          focused={focused}
          status={
            badValue ? (
              <span className="set-row-line" role="status">
                {PART_UNREAD}
              </span>
            ) : null
          }
        />
        {value !== undefined ? <div className="set-value">{value}</div> : null}
      </div>
      {more ? <div className="set-row-more">{more}</div> : null}
    </li>
  );
}

/** Props for a keyed row that is not an editable setting: the path focuses it, and a value in the link is not read. */
function keyed(k: SettingKey, ctx: Ctx) {
  const focused = ctx.focusKey === k;
  return { rowKey: k, focused, badValue: focused && !!ctx.urlValue };
}

/** "Saved", for a moment after a change. */
function useSavedNote(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), 1600);
    return () => clearTimeout(t);
  }, [on]);
  return [on, () => setOn(true)];
}

const Dim = ({ children }: { children: ReactNode }) => <span className="set-dim">{children}</span>;

// ---- General ----

/** Desktop's keys as this platform writes them (DESIGN.md 6.11): Cmd Option is Alt, Cmd Ctrl is Ctrl Alt, Cmd is Ctrl. */
export function platformKeys(keys: string[]): string[] {
  const at = keys.indexOf("Cmd");
  if (IS_MAC || at < 0) return keys;
  const out = [...keys];
  if (out[at + 1] === "Option") out.splice(at, 2, "Alt");
  else if (out[at + 1] === "Ctrl") out.splice(at, 2, "Ctrl", "Alt");
  else out[at] = "Ctrl";
  return out;
}

interface Shortcut {
  words: string; // Desktop's words, or kitespan's where 6.11 changes them
  keys: string[][]; // one or more key combinations; "to" between two keys names a range
  note?: string;
}

/**
 * Close focused pane's note (U4): off macOS, inside the Terminal pane Ctrl backslash stays the shell's quit key, which
 * stops the program running there, so the row says where the key acts; on macOS the terminal passes Cmd backslash on.
 */
export function paneKeyNote(mac: boolean = IS_MAC): string | undefined {
  return mac ? undefined : "Outside the terminal pane";
}

/** The rows of DESIGN.md 6.11 that this version binds, in Desktop's order (D51: only those). */
export const SHORTCUTS: Shortcut[] = [
  { words: "Show keyboard shortcuts", keys: [["Cmd", "/"]] },
  { words: "Next or previous chat", keys: [["Cmd", "Shift", "]"], ["Cmd", "Shift", "["]] },
  { words: "Stop Claude's response", keys: [["Esc"]] },
  { words: "Toggle terminal pane", keys: [["Ctrl", "`"]] },
  // Iteration 5 (U4, DESIGN-U4 11): Desktop's Close focused pane, Ctrl backslash off macOS (platformKeys writes Cmd as Ctrl).
  { words: "Close focused pane", keys: [["Cmd", "\\"]], note: paneKeyNote() },
  // Iteration 5 (R124): Desktop's side chat key, Ctrl ; off macOS (platformKeys writes Cmd as Ctrl there).
  { words: "Open side chat", keys: [["Cmd", ";"]] },
  // Iteration 7 (DESIGN-B1 4.14, PAGE 15): Desktop's "Toggle Browser pane", after Open side chat in Desktop's order.
  { words: "Toggle Browser pane", keys: [["Cmd", "Shift", "B"]] },
  { words: "Cycle view modes", keys: [["Ctrl", "O"]] },
  { words: "Open permission mode menu", keys: [["Cmd", "Shift", "M"]] },
  { words: "Open model menu", keys: [["Cmd", "Shift", "I"]] },
  { words: "Open effort menu", keys: [["Cmd", "Shift", "E"]] },
  { words: "Select item in an open menu", keys: [["1", "to", "9"]] },
  // kitespan's own, at the end of 6.11's table (v0.3 search): Ctrl K off macOS, as platformKeys writes Cmd there.
  { words: "Search", keys: [["Cmd", "K"]] },
  // Iteration 7: kitespan's way out of the browser pane's frame (DESIGN-B1 4.3), Ctrl L off macOS.
  { words: "Go to the address", keys: [["Cmd", "L"]], note: "In the browser pane" },
  // Row 111, the CLI's key: Ctrl+Enter on every platform (a key that starts with Ctrl stays as it is), and Cmd+Enter on
  // macOS too.
  { words: "Send now", keys: IS_MAC ? [["Ctrl", "Enter"], ["Cmd", "Enter"]] : [["Ctrl", "Enter"]] },
  // Iteration 5 (U3, DESIGN-U3 7): the CLI's transcript keys (2.1.139, "Jump to the previous or next prompt"), with
  // "turn" because the turn rail also marks the turns Claude Code started.
  { words: "Jump to the previous or next turn", keys: [["{"], ["}"]], note: "Outside the message box" },
];

function KeyList({ items, label }: { items: Shortcut[]; label: string }) {
  return (
    <dl className="set-keys" aria-label={label}>
      {items.map((s) => (
        <div className="set-key" key={s.words}>
          <dt>
            {s.words}
            {s.note ? <span className="set-key-note">{s.note}</span> : null}
          </dt>
          <dd>
            {s.keys.map((combo, i) => (
              <span className="set-combo" key={i}>
                {i ? <span className="set-or">or</span> : null}
                {platformKeys(combo).map((k) =>
                  k === "to" ? (
                    <span className="set-or" key={k}>
                      to
                    </span>
                  ) : (
                    <kbd key={k}>{k}</kbd>
                  ),
                )}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Keyboard shortcuts: a row that opens the list one tap away, and the list in its own view. */
function ShortcutsRow({ ctx }: { ctx: Ctx }) {
  if (ctx.focusKey === "shortcuts") return <Row {...keyed("shortcuts", ctx)} label="Keyboard shortcuts" more={<KeyList items={SHORTCUTS} label="Keyboard shortcuts" />} />;
  return (
    <li data-testid="setting-shortcuts">
      <Link to={href("setting", { section: "general", key: "shortcuts" })} className="group-row set-link-row">
        <span className="group-label set-link-label">Keyboard shortcuts</span>
        <IconRight size={14} className="group-chevron" />
      </Link>
    </li>
  );
}

function GeneralSection({ ctx }: { ctx: Ctx }) {
  return (
    <>
      <Group>
        <Editable k="return-key" ctx={ctx} />
      </Group>
      <Group>
        <ShortcutsRow ctx={ctx} />
      </Group>
    </>
  );
}

// ---- Chats ----

function RememberedRow() {
  const projects = useStore((s) => s.projects);
  const n = projects.filter((p) => Object.values(p.picks).some((v) => v !== undefined)).length;
  const [cleared, noteCleared] = useSavedNote();
  return (
    <Row
      testId="setting-remembered"
      label="Remembered choices"
      value={
        <span className="set-control">
          {cleared ? (
            <span className="set-saved" role="status">
              Cleared
            </span>
          ) : (
            <span className="set-count">{n ? plural(n, "project", "projects") : "None"}</span>
          )}
          <button
            type="button"
            className="btn"
            data-testid="confirm-clear-remembered"
            disabled={!n}
            onClick={() => {
              act.clearRemembered();
              noteCleared();
            }}
          >
            Clear
          </button>
        </span>
      }
    />
  );
}

/**
 * The user's own Claude Code settings for a project's folder (/api/settings?project=), as last read: a later reply
 * without a project (the answer to a save) does not blank them.
 */
function useAgentSettings(): { agent: NonNullable<SettingsReply["agent"]> | null; noProject: boolean } {
  const now = useStore((s) => s.host?.agent ?? null);
  const noProject = useStore((s) => s.projects.length === 0);
  const last = useRef(now);
  if (now) last.current = now;
  return { agent: last.current, noProject };
}

function ChatsSection({ ctx }: { ctx: Ctx }) {
  const { agent, noProject } = useAgentSettings();
  const unread = noProject ? <Dim>{START_A_CHAT}</Dim> : <Dim>{UNKNOWN}</Dim>;
  return (
    <>
      <Group>
        <Editable k="idle-minutes" ctx={ctx} />
        <Editable k="live-max" ctx={ctx} />
        <Editable k="new-chats" ctx={ctx} />
        <RememberedRow />
        <Editable k="allow-bypass" ctx={ctx} />
        <Editable k="auto-title" ctx={ctx} />
        <Editable k="bash-reply" ctx={ctx} />
      </Group>
      {/* Row 77: the server filters the lists of Claude Code sessions by these two, so every page shows the same. */}
      <Group testId="settings-sessions">
        <Editable k="sessions-from-other-apps" ctx={ctx} />
        <Editable k="sessions-open-elsewhere" ctx={ctx} />
      </Group>
      <Group title="Uploads" testId="settings-uploads">
        <UploadFolderRow ctx={ctx} />
        <Editable k="max-upload" ctx={ctx} />
        <Editable k="keep-days" ctx={ctx} />
      </Group>
      <Group>
        <Row {...keyed("prompt-suggestions", ctx)} readOnly label="Prompt suggestions" value={agent ? (agent.promptSuggestions ? "On" : "Off") : unread} />
        {/* D15: Claude Code's cleanupPeriodDays, 30 days when the user's settings do not set it (SL-18). */}
        <Row testId="setting-transcripts" readOnly label="Claude Code keeps transcripts for" value={agent ? plural(agent.cleanupPeriodDays ?? 30, "day", "days") : unread} />
        {/* D16: an Agent SDK host's limit on a background command (PA-11). */}
        <Row testId="setting-background-commands" readOnly label="Background commands stop after" value="30 minutes" />
      </Group>
    </>
  );
}

// ---- Chats > Uploads > Upload folder (D37) ----

const FOLDER_WORDS: Record<string, UploadFolder> = {
  temp: "temp",
  tmp: "temp",
  temporary: "temp",
  state: "state",
  kitespan: "state",
  claude: "claude",
  "claude-code": "claude",
  custom: "custom",
};

/** The upload folder a link's value names: temp, state, claude or custom (and a few other words for them). */
function parseFolder(raw: string): UploadFolder | null {
  return FOLDER_WORDS[raw.trim().toLowerCase()] ?? null;
}

/**
 * Upload folder: four choices, each with the folder it means, and the custom path field under Custom folder. A choice
 * saves on its click, unless the link put a draft here (then Save saves it). The custom path saves with its own
 * button, after a check that it is a folder path (absolute, or under ~). The server checks the chosen folder each time
 * Settings reads it; a folder that fails shows the server's line under the row.
 */
function UploadFolderRow({ ctx }: { ctx: Ctx }) {
  const focused = ctx.focusKey === "upload-folder";
  const raw = focused ? ctx.urlValue : undefined;
  return <UploadFolderInner key={raw ?? ""} focused={focused} urlRaw={raw} />;
}

function UploadFolderInner({ focused, urlRaw }: { focused: boolean; urlRaw?: string }) {
  const saved = useStore((s) => s.settings.uploadFolder);
  const custom = useStore((s) => s.settings.customFolder);
  const check = useStore((s) => s.host?.uploads);
  const labelId = useId();
  const pathId = useId();
  const groupName = useId();
  const fromUrl = urlRaw !== undefined && urlRaw !== "" ? parseFolder(urlRaw) : null;
  const badUrl = urlRaw !== undefined && urlRaw !== "" && fromUrl === null;
  const [draft, setDraft] = useState<UploadFolder | null>(fromUrl);
  const [path, setPath] = useState(custom);
  const [savedNote, noteSaved] = useSavedNote();
  const [pathNote, notePath] = useSavedNote();
  const rowRef = useRef<HTMLLIElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const shown = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const cleanPath = cleanFolder(path);
  const pathDirty = path.trim() !== "" && cleanPath !== null && cleanPath !== custom;
  const pathBad = path.trim() !== "" && cleanPath === null;
  // The chosen folder now: the server's checked path, or its line when the folder fails the check (store.ts).
  const root = check === undefined ? null : uploadRoot({ uploadFolder: saved, customFolder: custom }, "");

  useEffect(() => setPath(custom), [custom]);
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    if (dirty) saveRef.current?.focus({ preventScroll: true });
    else (rowRef.current?.querySelector<HTMLElement>("input:checked") ?? rowRef.current)?.focus({ preventScroll: true });
  }, [focused]);

  const choose = (id: UploadFolder) => {
    if (draft !== null) setDraft(id);
    else if (id !== saved) {
      act.setSetting("uploadFolder", id);
      noteSaved();
    }
  };
  const save = () => {
    if (draft === null) return;
    act.setSetting("uploadFolder", draft);
    setDraft(null);
    noteSaved();
  };
  const savePath = () => {
    if (!cleanPath) return;
    act.setSetting("customFolder", cleanPath);
    setPath(cleanPath);
    notePath();
  };
  const customPath = cleanFolder(custom);
  /** The folder a choice means, in mono as a path: the server's own path for the chosen one once it checked it. */
  const where = (f: (typeof UPLOAD_FOLDERS)[number]) => {
    if (f.id === "custom") return customPath ? <span className="set-choice-path mono">{customPath}/</span> : null;
    const real = f.id === saved && f.id !== "claude" && root && !root.refused && root.path ? `${root.path}/` : f.path;
    return <span className="set-choice-path mono">{real}</span>;
  };

  return (
    <li ref={rowRef} className="set-row set-row-folder" data-testid="setting-upload-folder" data-focused={focused || undefined} tabIndex={-1}>
      <div className="set-row-main">
        <RowWords
          k="upload-folder"
          label="Upload folder"
          name="Upload folder"
          labelId={labelId}
          focused={focused}
          status={
            badUrl ? (
              <span className="set-row-line" role="status">
                {PART_UNREAD}
              </span>
            ) : null
          }
        />
        {dirty ? (
          <div className="set-control">
            <span className="set-save">
              <span className="set-unsaved">Not saved</span>
              <button type="button" ref={saveRef} className="btn primary" data-testid="confirm-save" onClick={save}>
                Save
              </button>
            </span>
          </div>
        ) : savedNote ? (
          <div className="set-control">
            <span className="set-saved" role="status">
              Saved
            </span>
          </div>
        ) : null}
      </div>
      <div className="set-choices" role="radiogroup" aria-labelledby={labelId}>
        {UPLOAD_FOLDERS.map((f) => {
          const on = shown === f.id;
          return (
            <label key={f.id} className="set-choice" data-on={on || undefined} data-testid={`upload-folder-${f.id}`}>
              <input type="radio" className="set-choice-input" name={groupName} value={f.id} checked={on} onChange={() => choose(f.id)} />
              <span className="set-choice-text">
                <span className="set-choice-label">{f.label}</span>
                {where(f)}
                {/* The safety clause stays on the row (D51); the kept folders' rule is Delete uploads after. */}
                {f.kept ? null : <span className="set-choice-hint">Cleared when the machine restarts.</span>}
              </span>
              <IconCheck size={16} className="set-choice-check" />
            </label>
          );
        })}
      </div>
      {root?.refused && !dirty ? (
        <p className="set-row-line set-folder-line" role="status">
          {root.refused}
        </p>
      ) : null}
      {shown === "custom" ? (
        <div className="set-custom">
          <label className="set-custom-label" htmlFor={pathId}>
            Custom folder
          </label>
          <span className="set-custom-line">
            <input
              id={pathId}
              className="field mono set-custom-field"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="~/kitespan-uploads"
              aria-invalid={pathBad || undefined}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pathDirty) {
                  e.preventDefault();
                  savePath();
                }
              }}
            />
            {pathDirty ? (
              <button type="button" className="btn primary" data-testid="confirm-save-folder" onClick={savePath}>
                Save folder
              </button>
            ) : pathNote ? (
              <span className="set-saved" role="status">
                Saved
              </span>
            ) : null}
          </span>
          {pathBad ? (
            <span className="set-row-line" role="status">
              Give a folder path that starts with / or ~/.
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ---- Notifications (R130) ----

/** This device's notifications and the devices that have them on (settings/Notifications.tsx; notify/useNotify.ts). */
function NotificationsSection({ ctx }: { ctx: Ctx }) {
  const { model, actions } = useNotify(ctx.phone ? "phone" : ctx.laptop ? "laptop" : "medium", ctx.touch);
  return <NotificationsBody model={model} actions={actions} ctx={{ focusKey: ctx.focusKey, urlValue: ctx.urlValue, device: ctx.device, deviceName: ctx.deviceName, touch: ctx.touch }} />;
}

// ---- Models ----

const effortWord = (id: string) => (EFFORTS.find((e) => e.id === id)?.label ?? id).toLowerCase();

/** "Effort low to max", in the picker's words. */
export function effortLine(levels: readonly string[]): string {
  if (!levels.length) return "No effort levels";
  if (levels.length === 1) return `Effort ${effortWord(levels[0]!)} only`;
  return `Effort ${effortWord(levels[0]!)} to ${effortWord(levels[levels.length - 1]!)}`;
}

/** The chat whose rows Settings reads: the one the user came from, else the newest chat in the lists. */
function useReadChat(ctx: Ctx): Chat | undefined {
  const newest = useStore((s) => visibleChats(s.chats)[0]);
  return ctx.chat ?? newest;
}

/**
 * What a chat's Claude Code loaded at its start (its init facts, 6.5 and 6.8): the chat the user came from, else the
 * newest chat in the lists that has them (store.ts settingsInit). "waiting" while they are on their way, so the rows
 * show "..."; null when no chat that runs can bring them, so the rows say START_A_CHAT.
 */
function useInitFacts(ctx: Ctx): InitFacts | null | "waiting" {
  const id = ctx.chat?.id;
  const init = useStore((s) => settingsInit(s, id).init);
  const waiting = useStore((s) => settingsInit(s, id).waiting);
  return init ?? (waiting ? "waiting" : null);
}

/**
 * The start facts Settings shows: a live chat's (useInitFacts, `at` null), else, while none can come, those the server
 * kept last (row 97, with `at` when they were read); "waiting" and null as useInitFacts says.
 */
function useStartFacts(ctx: Ctx): { facts: InitFacts; at: string | null } | "waiting" | null {
  const init = useInitFacts(ctx);
  const kept = useStore((s) => s.host?.facts ?? null);
  if (init === "waiting") return init;
  if (init) return { facts: init, at: null };
  return kept ? { facts: kept, at: kept.at } : null;
}

/** Row 97: under a section that shows a kept value, its age in one dim line; nothing for a live value. */
function KeptLine({ at }: { at: string | null | undefined }) {
  return at ? (
    <p className="group-foot set-kept" data-testid="settings-kept">
      {keptLine(at)}
    </p>
  ) : null;
}

/** A row's value while its init facts are on their way, or when none can come. */
const factsPending = (init: "waiting" | null) => <Dim>{init === "waiting" ? UNKNOWN : START_A_CHAT}</Dim>;

/** The CLI's fast-mode reasons (`fast_mode_disabled_reason`, sdk.d.ts 0.3.322 line 812) in words. */
const FAST_REASON: Record<string, string> = {
  free: "Not available on the free plan.",
  preference: "Turned off in your Claude Code settings.",
  extra_usage_disabled: "Extra usage is turned off.",
  network_error: "Claude Code could not check it.",
  unknown: "Claude Code did not say why.",
  not_first_party: "Not available with this provider.",
  disabled_by_env: "Turned off by an environment variable.",
  model_not_allowed: "Not available for this model.",
  sdk_opt_in_required: "Not turned on for this app.",
  pending: "Claude Code is still checking.",
};
const FAST_STATE: Record<FastModeInfo["state"], string> = { off: "Off", on: "On", cooldown: "Cooling down" };

/** The Fast mode row's value and its one line: the state, and the CLI's reason (its own word when it is a new one). */
export function fastModeWords(f: FastModeInfo): { value: string; line: string | null } {
  return { value: FAST_STATE[f.state] ?? f.state, line: f.reason ? (FAST_REASON[f.reason] ?? f.reason) : null };
}

/** Fast mode (D35, AR-7): read-only, no toggle, since kitespan builds no fast mode. No row for a CLI that sends no state. */
function FastModeGroup({ ctx }: { ctx: Ctx }) {
  const shown = useStartFacts(ctx);
  const init = shown && shown !== "waiting" ? shown.facts : shown;
  if (init && init !== "waiting" && !init.fastMode) return null;
  const w = init && init !== "waiting" && init.fastMode ? fastModeWords(init.fastMode) : null;
  return (
    <>
      <Group>
        <Row testId="setting-fast-mode" readOnly label="Fast mode" line={w?.line} value={w ? w.value : factsPending(init === "waiting" ? init : null)} />
      </Group>
      <KeptLine at={shown && shown !== "waiting" ? shown.at : null} />
    </>
  );
}

/**
 * The model picker's rows (row 81): Claude Code's one list, the same in every chat and project, as the new-chat form and
 * the project page show it. A chat's own `get models` reads it (the server answers a chat with no process from its kept
 * list); with no chat, the server's kept list through a project (askModelRows: its one short read when none is kept).
 */
function ModelsSection({ ctx }: { ctx: Ctx }) {
  const chat = useReadChat(ctx);
  const open = useStore((s) => s.net === "open");
  const kept = useStore((s) => s.modelList);
  const project = useStore((s) => s.projects[0]?.id);
  useEffect(() => {
    if (!open) return;
    if (chat) void act.load(chat.id, "models");
    else askModelRows(project);
  }, [chat?.id, open, project]);
  const rows: ModelInfo[] | null = chat?.models?.length ? chat.models : kept?.length ? kept : null;
  return (
    <>
      <Group testId="setting-models">
        {rows?.length ? (
          rows.map((m) => (
            <li key={m.value} className="set-row set-model" data-testid={`setting-model-${m.value}`}>
              <span className="set-model-name">
                <span className="set-model-label">{m.displayName}</span>
                <code className="set-dim">{m.value}</code>
              </span>
              <span className="set-model-facts">
                {m.description ? <span>{m.description}</span> : null}
                <span>{effortLine(m.efforts)}</span>
              </span>
            </li>
          ))
        ) : (
          <Row testId="setting-model-none" label="Model picker rows" value={<Dim>{chat ? UNKNOWN : START_A_CHAT}</Dim>} />
        )}
      </Group>
      <FastModeGroup ctx={ctx} />
    </>
  );
}

// ---- Appearance ----

function AppearanceSection({ ctx }: { ctx: Ctx }) {
  const focused = ctx.focusKey === "look";
  const raw = focused ? ctx.urlValue : undefined;
  return (
    <>
      <Group>
        <LookRow key={`look|${raw ?? ""}`} focused={focused} urlRaw={raw} touch={ctx.touch} />
        <Editable k="theme" ctx={ctx} />
      </Group>
      <Group>
        <Editable k="text-size" ctx={ctx} />
        <Editable k="reduce-motion" ctx={ctx} />
      </Group>
    </>
  );
}

// ---- Claude Code ----

/** A plugin as the lists name it: its name, and its version when its manifest declares one. */
export function pluginLabel(p: { name: string; version: string | null }): string {
  return p.version ? `${p.name} ${p.version}` : p.name;
}

/**
 * Skills and plugins (SE-3): what the chat's Claude Code loaded, one per line, and one Reload, which re-reads skills,
 * plugins and output styles from disk in every live chat. Reload is drawn only once the store can send it (no control
 * that sends nothing), and acts only on its click.
 */
function SkillsRow({ ctx }: { ctx: Ctx }) {
  const shown = useStartFacts(ctx);
  // Reload acts on live chats only: none with a kept list.
  const reload = shown && shown !== "waiting" && shown.at === null ? (act as { reloadSkills?: () => void }).reloadSkills : undefined;
  if (!shown || shown === "waiting") return <Row {...keyed("skills", ctx)} readOnly label="Skills and plugins" value={factsPending(shown)} />;
  const init = shown.facts;
  const none = !init.skills.length && !init.plugins.length;
  return (
    <Row
      {...keyed("skills", ctx)}
      label="Skills and plugins"
      line={none ? "None" : undefined}
      value={
        reload ? (
          <span className="set-control">
            <button type="button" className="btn" data-testid="confirm-reload-skills" onClick={() => reload()}>
              Reload
            </button>
          </span>
        ) : undefined
      }
      more={
        none ? undefined : (
          <ul className="set-loaded" aria-label="Skills and plugins">
            {init.skills.map((name) => (
              <li key={`s:${name}`} className="set-loaded-row">
                <span className="mono">{name}</span>
              </li>
            ))}
            {init.plugins.map((p) => (
              <li key={`p:${p.name}`} className="set-loaded-row">
                <span className="mono">{p.name}</span>
                {p.version ? <span className="set-dim"> {p.version}</span> : null}
              </li>
            ))}
          </ul>
        )
      }
    />
  );
}

/** Output style (SE-4): the chat's style, read-only. */
function OutputStyleRow({ ctx }: { ctx: Ctx }) {
  const shown = useStartFacts(ctx);
  return <Row {...keyed("output-style", ctx)} readOnly label="Output style" value={shown && shown !== "waiting" ? (shown.facts.outputStyle ?? <Dim>None</Dim>) : factsPending(shown)} />;
}

function ClaudeCodeSection({ ctx }: { ctx: Ctx }) {
  const claude = useClaudeFacts();
  const shown = useStartFacts(ctx);
  return (
    <>
      <Group>
        <Row
          testId="setting-claude"
          readOnly
          label="Claude Code"
          line={
            // Below kitespan's minimum (rows 118, 119), its line takes the drift line's place: one line per row.
            claude.belowMinimum ? (
              <span className="set-row-line" data-testid="setting-claude-minimum">
                <MinimumWords below={claude.belowMinimum} />
              </span>
            ) : claude.drift ? (
              <span className="set-drift">{claude.drift}</span>
            ) : null
          }
          more={
            <span className="set-paths">
              {claude.path ? (
                <>
                  <PathText path={claude.path} className="set-path" />
                  {claude.realpath && claude.realpath !== claude.path ? <PathText path={claude.realpath} className="set-path set-dim" /> : null}
                  {claude.version ? <span>Version {claude.version}</span> : null}
                </>
              ) : claude.ok === false ? (
                <span className="set-row-line">There is no claude on your PATH, so no chat can start.</span>
              ) : (
                <span>{UNKNOWN}</span>
              )}
            </span>
          }
        />
        <Row testId="setting-sdk" readOnly label="Agent SDK" value={`Version ${claude.sdk}`} />
      </Group>
      <Group>
        <SkillsRow ctx={ctx} />
        <OutputStyleRow ctx={ctx} />
      </Group>
      <KeptLine at={shown && shown !== "waiting" ? shown.at : null} />
    </>
  );
}

// ---- Account and About ----

/** The provider names of the values `accountInfo().apiProvider` documents; any other value shows as it came. */
const PROVIDER_NAMES: Record<string, string> = { firstParty: "Anthropic", bedrock: "Bedrock", vertex: "Google Vertex AI", foundry: "Microsoft Foundry" };

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/**
 * Account (6.8, SE-6): only the provider that a live chat's Claude Code reports; while no chat is live, the one kept
 * last (row 97) with its age under it, else "Start a chat to read it". When Claude Code reports none, there is no
 * provider row (the owner's rule). No email, no organisation.
 */
function AccountSection() {
  const loaded = useStore((s) => s.host !== null);
  const account = useStore((s) => s.host?.account ?? null);
  if (!loaded)
    return (
      <Group>
        <Row testId="setting-provider" readOnly label="Account" value={<Dim>{UNKNOWN}</Dim>} />
      </Group>
    );
  if (!account)
    return (
      <Group>
        <Row testId="setting-provider" readOnly label="Account" value={<Dim>{START_A_CHAT}</Dim>} />
      </Group>
    );
  if (!account.provider) return null;
  return (
    <>
      <Group>
        <Row testId="setting-provider" readOnly label="Provider" value={providerName(account.provider)} />
      </Group>
      <KeptLine at={account.at} />
    </>
  );
}

/**
 * About (6.8): the statement, the warning and roadmap lines, Version and Licence; then the update rows (row 108; read
 * when About opens, GET /api/update; until it answers, origin's line from `welcome`): Update available with Update,
 * or the step line while an update runs, or the line of one that did not finish; Check for updates (the server's
 * setting, the same on every device) and Check now with the time of the last check; then Restart to apply and
 * Restart, which opens the restart dialog (4.10). An installed kitespan (DESIGN-I1 3.6): a release install names the
 * versions under its rows and has its own words for the check; a Homebrew install has its own row in place of the
 * check's two.
 */
const NO_NOTES: readonly string[] = [];

function AboutSection({ ctx }: { ctx: Ctx }) {
  const version = useStore((s) => s.server.version ?? s.host?.server.version ?? null);
  const epoch = useStore((s) => s.server.epoch);
  // Another page's Update sends the step line to every page: About reads its facts again at each change of it.
  const updateLine = useStore((s) => s.updateNotice?.text ?? null);
  const welcomeUpdate = useStore((s) => s.update);
  const hostSettings = useStore((s) => s.host?.settings ?? null);
  const u = useUpdateFacts(epoch, updateLine);
  const f = aboutFacts(u.facts, welcomeUpdate);
  const lines = aboutLines(f.update, f.build, f.job, f.can, f);
  const updateLines = lines.filter((l) => l.testId !== "setting-restart-to-apply");
  const buildLines = lines.filter((l) => l.testId === "setting-restart-to-apply");
  // A value this page saved stands until the next read of the server's settings (that read has it too).
  useEffect(() => setUpdateState({ saved: null }), [hostSettings]);
  const now = useMinute();
  const notes = useStore((s) => s.host?.phoneNotes ?? NO_NOTES);
  const row = (l: (typeof lines)[number]) => <Row key={l.testId} testId={l.testId} readOnly={!l.update} label={l.label} line={l.line} value={l.update ? <UpdateLink /> : undefined} />;
  return (
    <>
      <div className="set-about">
        <p className="set-claim" data-testid="raw-statement">
          {RAW_STATEMENT}
        </p>
        <p className="set-warn-line">kitespan is experimental and is not guaranteed to work. It runs your own Claude Code, and you can open any chat in the terminal at any time.</p>
      </div>
      {notes.length ? (
        <Group title="On a phone" testId="phone-notes">
          {notes.map((n, i) => (
            <li key={i} className="set-row">
              <span className="set-note-line">{n}</span>
            </li>
          ))}
        </Group>
      ) : null}
      <Group>
        <Row testId="setting-version" label="Version" value={version ?? <Dim>{UNKNOWN}</Dim>} />
        <Row testId="setting-licence" label="Licence" value="Apache-2.0" />
      </Group>
      <Group testId="settings-updates">
        {updateLines.map(row)}
        {f.kind === "brew" ? null : (
          <>
            <CheckRow
              key={`check|${ctx.focusKey === "check-for-updates" ? (ctx.urlValue ?? "") : ""}`}
              ctx={ctx}
              server={u.saved ?? checkSettingOf(hostSettings)}
              more={f.kind === "release" ? MORE_RELEASE_CHECK : undefined}
            />
            <CheckNowRow check={u.facts?.check ?? null} checking={u.checking} now={now} />
          </>
        )}
      </Group>
      <Group>
        {buildLines.map(row)}
        <RestartRow />
      </Group>
    </>
  );
}

/** The time now, again each minute, for "Checked 2 h ago." */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const CHECK_CHOICES: Choice[] = UPDATE_CHECKS.map((v) => ({ value: v, label: UPDATE_CHECK_LABELS[v] }));

/**
 * Check for updates (row 108): Manually, Daily or Every 3 hours, saved on the server at its pick; a value in the link
 * (/settings/about/check-for-updates?value=3h) is a draft, shown and not saved until Save (5.1 rule 3).
 */
function CheckRow({ ctx, server, more }: { ctx: Ctx; server: UpdateCheck; more?: ReactNode }) {
  const k: SettingKey = "check-for-updates";
  const focused = ctx.focusKey === k;
  const urlRaw = focused ? ctx.urlValue : undefined;
  const fromUrl = urlRaw ? checkValueOf(urlRaw) : null;
  const badUrl = !!urlRaw && fromUrl === null;
  const [draft, setDraft] = useState<UpdateCheck | null>(fromUrl);
  const [savedNote, noteSaved] = useSavedNote();
  const labelId = useId();
  const rowRef = useRef<HTMLLIElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const dirty = draft !== null && draft !== server;
  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    if (dirty) saveRef.current?.focus({ preventScroll: true });
    else (rowRef.current?.querySelector<HTMLElement>('.set-control [role="radio"][tabindex="0"], .set-control .set-menu-btn') ?? rowRef.current)?.focus({ preventScroll: true });
  }, [focused]);
  const put = (v: UpdateCheck) =>
    void saveCheckSetting(v).then((ok) => {
      if (ok) noteSaved();
      else act.setNotice(getUpdateLine());
    });
  const choose = (v: string) => {
    const pick = checkValueOf(v);
    if (!pick) return;
    if (draft !== null) setDraft(pick);
    else if (pick !== server) put(pick);
  };
  const save = () => {
    if (draft === null) return;
    put(draft);
    setDraft(null);
  };
  const shown = draft ?? server;
  const control =
    ctx.narrow && longWords(CHECK_CHOICES) ? (
      <ChoiceMenu name={UPDATE_WORDS.check} choices={CHECK_CHOICES} value={shown} labelId={labelId} testId={`setting-${k}`} onPick={choose} />
    ) : (
      <Segmented value={shown} options={CHECK_CHOICES} onChange={choose} label={UPDATE_WORDS.check} block={ctx.phone} className="set-seg" />
    );
  return (
    <li ref={rowRef} className="set-row set-row-choice" data-testid={`setting-${k}`} data-focused={focused || undefined} tabIndex={-1}>
      <div className="set-row-main">
        <RowWords
          k={k}
          label={UPDATE_WORDS.check}
          name={UPDATE_WORDS.check}
          labelId={labelId}
          focused={focused}
          more={more}
          status={
            badUrl ? (
              <span className="set-row-line" role="status">
                {PART_UNREAD}
              </span>
            ) : null
          }
        />
        <div className="set-control">
          {control}
          {dirty ? (
            <span className="set-save">
              <span className="set-unsaved">Not saved</span>
              <button type="button" ref={saveRef} className="btn primary" data-testid="confirm-save" onClick={save}>
                Save
              </button>
            </span>
          ) : savedNote ? (
            <span className="set-saved" role="status">
              Saved
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Check now (row 108), in every mode: the time of the last check, and why it could not look when it could not. */
function CheckNowRow({ check, checking, now }: { check: UpdateReply["check"] | null; checking: boolean; now: number }) {
  const running = checking || !!check?.running;
  const label = running ? UPDATE_WORDS.checking : check?.at ? checkedLine(check.at, now) : UPDATE_WORDS.never;
  const line = !running && check?.at ? (check.why ? UPDATE_REFUSAL_LINES[check.why] : !check.ok ? UPDATE_WORDS.checkFailed : undefined) : undefined;
  return (
    <Row
      testId="setting-check-now"
      label={label}
      line={line}
      value={
        <button
          type="button"
          className="btn"
          data-testid="check-now"
          disabled={running}
          onClick={() =>
            void checkNow().then(() => {
              const l = getUpdateLine();
              if (l) act.setNotice(l);
            })
          }
        >
          {UPDATE_WORDS.checkNow}
        </button>
      }
    />
  );
}

// ---- a row that changes a setting ----

/** A choice shows as a menu in a narrow section when its words would not fit a segmented control's equal segments. */
function longWords(choices: Choice[]): boolean {
  return choices.some((c) => c.label.length > 12) || choices.reduce((n, c) => n + c.label.length, 0) > 26;
}

/**
 * A choice as a menu (DESIGN.md 7.6 and 8.2: kitespan draws every picker and uses no native select). The button shows
 * the value; it opens the choices as a menu beside it on a laptop and a tablet and as a sheet of grouped rows on the
 * phone, each with a check on the current one. A pick closes the menu and goes to `onPick`.
 */
function ChoiceMenu(props: { name: string; choices: Choice[]; value: string; labelId: string; testId: string; onPick: (v: string) => void }) {
  const { name, choices, value, labelId, testId, onPick } = props;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const sheet = useSheet();
  const close = () => setOpen(false);
  // The menu beside the button takes the focus on its current row; a sheet's layer does that itself.
  useEffect(() => {
    const list = open ? box.current : null;
    (list?.querySelector<HTMLElement>('[aria-checked="true"]') ?? list?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus({ preventScroll: true });
  }, [open]);
  return (
    <>
      <button
        ref={button}
        id={buttonId}
        type="button"
        className="btn set-menu-btn"
        data-testid={`${testId}-button`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${buttonId}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        <span className="set-menu-value">{choices.find((c) => c.value === value)?.label ?? value}</span>
        <IconChevron size={14} className="set-menu-chevron" />
      </button>
      <Popup open={open} onClose={close} anchor={button} title={name} testId={`${testId}-menu`}>
        <div className={sheet ? "set-menu set-menu-sheet" : "set-menu"} ref={box}>
          <div className={sheet ? "group" : "set-menu-list"} role="menu" aria-label={name} onKeyDown={listKeys}>
            {choices.map((c) => {
              const on = c.value === value;
              return (
                <button
                  key={c.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  className={sheet ? "group-row" : "menu-row"}
                  onClick={() => {
                    close();
                    onPick(c.value);
                  }}
                >
                  <span className={sheet ? "group-label set-menu-label" : "set-menu-label"}>{c.label}</span>
                  <IconCheck size={16} className={sheet ? "group-check" : "menu-check"} />
                </button>
              );
            })}
          </div>
        </div>
      </Popup>
    </>
  );
}

function SettingRow(props: { def: SettingDef; focused: boolean; urlRaw?: string; touch: boolean; phone: boolean; narrow: boolean }) {
  const { def, focused, urlRaw, touch, phone, narrow } = props;
  const saved = useStore((s) => s.settings[def.field]);
  const needs = def.kind === "switch" ? def.needs : undefined;
  const applies = useStore((s) => !needs || s.settings[needs] === true);
  const labelId = useId();
  const fromUrl = urlRaw !== undefined && urlRaw !== "" ? parseValue(def, urlRaw) : null;
  const badUrl = urlRaw !== undefined && urlRaw !== "" && fromUrl === null;
  // A value from the link is a draft: shown, not saved. Without a draft, a switch or a choice saves on its change.
  const [draft, setDraft] = useState<Value | null>(fromUrl);
  const [text, setText] = useState(() => String(fromUrl ?? saved));
  const [savedNote, noteSaved] = useSavedNote();
  const rowRef = useRef<HTMLLIElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const numberValue = def.kind === "number" ? parseValue(def, text) : null;
  const pending: Value | null = def.kind === "number" ? (text.trim() === "" ? null : numberValue) : draft;
  const dirty = pending !== null && pending !== saved;
  const badText = def.kind === "number" && text.trim() !== "" && numberValue === null;

  // Follow a value saved elsewhere (another page, or the server's reply), unless the link put a draft here.
  useEffect(() => {
    if (def.kind === "number" && draft === null) setText(String(saved));
  }, [saved]);

  useEffect(() => {
    if (!focused) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    // Focus the button that names the action; on touch never a text field, so the keyboard stays down.
    if (dirty) saveRef.current?.focus({ preventScroll: true });
    else if (!(touch && def.kind === "number")) {
      const control = rowRef.current?.querySelector<HTMLElement>('.set-control [role="radio"][tabindex="0"], .set-control input:not(:disabled), .set-control .set-menu-btn, .set-control [data-autofocus]');
      (control ?? rowRef.current)?.focus({ preventScroll: true });
    }
  }, [focused]);

  const save = () => {
    if (pending === null) return;
    act.setSetting(def.field, pending as never);
    setDraft(null);
    if (def.kind === "number") setText(String(pending));
    noteSaved();
  };
  const choose = (v: Value) => {
    if (draft !== null) setDraft(v);
    else if (v !== saved) {
      act.setSetting(def.field, v as never);
      noteSaved();
    }
  };

  const shown = def.kind === "number" ? text : (draft ?? saved);
  const risky = def.kind === "switch" && def.risky && pending === true ? def.risky : null;

  let control: ReactNode;
  if (def.kind === "choice") {
    const options = def.choices.some((c) => c.value === String(shown)) ? def.choices : [...def.choices, { value: String(shown), label: def.numeric && def.key === "max-upload" ? `${shown} MB` : String(shown) }];
    control =
      def.menu || (narrow && longWords(def.choices)) ? (
        <ChoiceMenu name={def.name} choices={options} value={String(shown)} labelId={labelId} testId={`setting-${def.key}`} onPick={(v) => choose(choiceValue(def, v))} />
      ) : (
        <Segmented value={String(shown)} options={def.choices.map((c) => ({ value: c.value, label: c.label }))} onChange={(v) => choose(choiceValue(def, v))} label={def.name} block={phone} className="set-seg" />
      );
  } else if (def.kind === "switch") control = <Switch checked={shown === true} onChange={(on) => choose(on)} labelledBy={labelId} disabled={!applies} className="set-switch" />;
  else if (def.kind === "steps") {
    const at = def.steps.indexOf(shown as number);
    const smaller = at > 0 ? def.steps[at - 1] : undefined;
    const larger = at >= 0 && at < def.steps.length - 1 ? def.steps[at + 1] : undefined;
    control = (
      <div className="set-steps" role="group" aria-labelledby={labelId}>
        <button type="button" className="set-step" aria-label="Smaller text" disabled={smaller === undefined} data-autofocus={larger === undefined ? "" : undefined} onClick={() => smaller !== undefined && choose(smaller)}>
          A−
        </button>
        <span className="set-step-value" aria-live="polite">
          {percent(shown as number)}
        </span>
        <button type="button" className="set-step set-step-up" aria-label="Larger text" disabled={larger === undefined} data-autofocus={larger !== undefined ? "" : undefined} onClick={() => larger !== undefined && choose(larger)}>
          A+
        </button>
      </div>
    );
  } else
    control = (
      <span className="set-num-wrap">
        <input
          className="field set-num"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-labelledby={labelId}
          aria-invalid={badText || undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) {
              e.preventDefault();
              save();
            }
          }}
        />
        <span className="set-unit">{def.unit}</span>
      </span>
    );

  const limits = def.kind === "number" ? `Choose a number from ${def.min} to ${def.max}.` : null;
  return (
    <li ref={rowRef} className={`set-row set-row-${def.kind}`} data-testid={`setting-${def.key}`} data-focused={focused || undefined} tabIndex={-1}>
      <div className="set-row-main">
        <RowWords
          k={def.key}
          label={def.label}
          name={def.name}
          labelId={labelId}
          line={def.line}
          focused={focused}
          status={
            badUrl || badText ? (
              <span className="set-row-line" role="status">
                {badUrl ? PART_UNREAD : null}
                {badUrl && limits ? " " : null}
                {limits}
              </span>
            ) : null
          }
        />
        <div className="set-control">
          {control}
          {dirty ? (
            <span className="set-save">
              <span className="set-unsaved">Not saved</span>
              <button type="button" ref={saveRef} className={`btn ${risky ? "set-risky" : "primary"}`} data-testid="confirm-save" onClick={save}>
                {risky ?? "Save"}
              </button>
            </span>
          ) : savedNote ? (
            <span className="set-saved" role="status">
              Saved
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
