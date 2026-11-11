// kitespan's ids (DESIGN.md 4.3 and 4.4). The server and the page both import this file, so it has no runtime
// dependency and no DOM or Bun API beyond `crypto.getRandomValues`, which both have.

/** The 32 symbols of kitespan's own ids: lowercase letters and the digits 2 to 7 (RFC 4648 base32, lowercase). */
export const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export const CHAT_ID_LENGTH = 20;
export const PROJECT_ID_LENGTH = 10;
export const UPLOAD_ID_LENGTH = 16;
export const CHANGES_ID_LENGTH = 10;

/** A chat id (4.4): 20 characters of `[a-z2-7]`, minted by kitespan, never reused. URLs and file names use it. */
export const CHAT_ID = /^[a-z2-7]{20}$/;
/** A project id (4.4): 10 characters of `[a-z2-7]`. Never the folder path. */
export const PROJECT_ID = /^[a-z2-7]{10}$/;
/** An upload id (D37): 16 characters of `[a-z2-7]`. */
export const UPLOAD_ID = /^[a-z2-7]{16}$/;
/**
 * U1: a turn's changes summary (DESIGN-U1 5): 10 characters of `[a-z2-7]`, minted by the server at the turn's end mark.
 * The URL names the turn by it (`/c/<chat>/changes/<id>`); `all` (3 characters) is never one.
 */
export const CHANGES_ID = /^[a-z2-7]{10}$/;
/** A UUID in lowercase: a Claude Code session id, a request id (`rid`) and a user message's `uuid`. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A tab id (the `hello` frame): a random id per browser tab, at most 64 characters. */
export const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * An id that Claude Code makes: a message uuid, a tool-use id, a card's request id, a task id. They are opaque, so the
 * rule only keeps them safe in a URL path and a log-free frame.
 */
export const AGENT_REF = /^[A-Za-z0-9_-]{1,64}$/;
/** A boot epoch (4.3): the boot time in base 36, a dash, then 12 random id symbols. */
export const EPOCH = /^[0-9a-z]{1,12}-[a-z2-7]{12}$/;
/**
 * R131: the short id of a Claude Code background session, as `claude --bg` prints it: 8 lowercase hex characters
 * (Claude Code 2.1.318's own rule, `IM`). A link and a frame name a background session by it, never by a path.
 */
export const BG_ID = /^[a-f0-9]{8}$/;
/**
 * Iteration 7 (DESIGN-B1 3.7): a tab of the shared browser, as the pane, the URL (`/browser/<tab>`) and `tabs.json`
 * name it: 10 characters of `[a-z2-7]`, minted by the server when it first sees the tab, never Chrome's target id.
 */
export const BROWSER_TAB_ID = /^[a-z2-7]{10}$/;
export const BROWSER_TAB_ID_LENGTH = 10;
/** A download of the shared browser (DESIGN-B1 2.12): 16 characters of `[a-z2-7]`, minted when it begins. */
export const BROWSER_DOWNLOAD_ID = /^[a-z2-7]{16}$/;
export const BROWSER_DOWNLOAD_ID_LENGTH = 16;

/**
 * A reply block's key (`<API message id>:<index>`) as the page's row id, which a URL path takes (AGENT_REF): the key
 * when it fits, else every character outside `[A-Za-z0-9_-]` as `-`, the last 64 kept. One rule for the page's rows
 * and the server's message search (U5), whose hits name the row a link lands on.
 */
export function itemIdOf(key: string): string {
  if (AGENT_REF.test(key)) return key;
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "-").slice(-64);
  return safe || "block";
}

export const isChatId = (v: unknown): v is string => typeof v === "string" && CHAT_ID.test(v);
export const isProjectId = (v: unknown): v is string => typeof v === "string" && PROJECT_ID.test(v);
export const isUploadId = (v: unknown): v is string => typeof v === "string" && UPLOAD_ID.test(v);
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isTabId = (v: unknown): v is string => typeof v === "string" && TAB_ID.test(v);
export const isAgentRef = (v: unknown): v is string => typeof v === "string" && AGENT_REF.test(v);
export const isEpoch = (v: unknown): v is string => typeof v === "string" && EPOCH.test(v);
export const isBgId = (v: unknown): v is string => typeof v === "string" && BG_ID.test(v);
export const isChangesId = (v: unknown): v is string => typeof v === "string" && CHANGES_ID.test(v);
export const isBrowserTabId = (v: unknown): v is string => typeof v === "string" && BROWSER_TAB_ID.test(v);
export const isBrowserDownloadId = (v: unknown): v is string => typeof v === "string" && BROWSER_DOWNLOAD_ID.test(v);

/** A new random id of `length` symbols of ID_ALPHABET. 256 is a multiple of 32, so every symbol is equally likely. */
export function newId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return out;
}

export const newChatId = (): string => newId(CHAT_ID_LENGTH);
export const newProjectId = (): string => newId(PROJECT_ID_LENGTH);
export const newUploadId = (): string => newId(UPLOAD_ID_LENGTH);
export const newChangesId = (): string => newId(CHANGES_ID_LENGTH);
export const newBrowserTabId = (): string => newId(BROWSER_TAB_ID_LENGTH);
export const newBrowserDownloadId = (): string => newId(BROWSER_DOWNLOAD_ID_LENGTH);

/** A new boot epoch (4.3): a random value plus the boot time, so two boots never share one. */
export function newEpoch(bootMs: number = Date.now()): string {
  return `${Math.max(0, Math.floor(bootMs)).toString(36)}-${newId(12)}`;
}
