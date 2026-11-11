// R130 (owner rows 128 and 130; DESIGN-R130 sections 4.1 to 4.5): notifications through the browser's own push
// service (Web Push), the parts that the server, the page and the service worker share. The server sends a push at a
// moment that no page has on screen (R116's and R131's seen rules); the push carries only this payload, encrypted to
// the subscription (RFC 8291), and the service worker shows it. By default it holds no chat text: the moment's words
// only. A device's own setting (Show chat titles) adds the chat's title. The click only opens a path of the app.
//
// No DOM, no Bun API: the hash of a device's endpoint uses `crypto.subtle`, which both have.

import { AGENT_REF, BG_ID, ID_ALPHABET } from "./ids";

export const PUSH_LIMITS = {
  /** A notification's title (the chat title's cap, 6.10). */
  title: 120,
  /** A notification's body. */
  body: 160,
  /** The padded plaintext steps: the push service sees no difference between moments or titles of one step. */
  padStep: 256,
  /**
   * The padded plaintext, at most: one record of 4,096 octets with its 86-octet header and 16-octet tag leaves 3,994
   * octets (RFC 8291 section 4, RFC 8030 section 7.2); the last whole step under it is 3,840.
   */
  padded: 3840,
  /** The devices that the server keeps. */
  devices: 20,
  /** A device's name. */
  name: 40,
  /** A subscription's endpoint URL. */
  endpoint: 2048,
} as const;

/** The service worker (push and notificationclick only, no fetch handler, no cache), at the root so its scope is `/`. */
export const SERVICE_WORKER_PATH = "/sw.js";
/** Its file in the build folder. */
export const SERVICE_WORKER_FILE = "sw.js";
/** The app's icon (iOS shows the home-screen app's own icon instead). */
export const PUSH_ICON = "/assets/icon-192.png";
/** The title of a push that the service worker cannot read. */
export const PUSH_FALLBACK_TITLE = "kitespan";
/**
 * The VAPID token's `sub` (RFC 8292 section 2.1: a `mailto:` or `https:` contact; Apple requires one). kitespan has no
 * public page or address yet, so this is a placeholder at a domain that RFC 2606 reserves (DESIGN-R130 open question 1).
 */
export const PUSH_CONTACT = "mailto:kitespan@example.com";

/** The moments that notify (DESIGN-R130 4.1): a card waits, a turn ended unseen, a background session's moments. */
export const PUSH_MOMENTS = ["permission", "input", "done", "failed", "bg_needs", "bg_done", "bg_failed"] as const;
export type PushMoment = (typeof PUSH_MOMENTS)[number];

/** Each moment's words: Claude Code's own ("Claude needs your permission", "... your input"), agent view's form. */
export const PUSH_WORDS: Readonly<Record<PushMoment, string>> = {
  permission: "Claude needs your permission",
  input: "Claude needs your input",
  done: "Claude finished",
  failed: "Claude did not finish",
  bg_needs: "A background session needs your input",
  bg_done: "A background session finished",
  bg_failed: "A background session failed",
};

/** A background session's words with its name (only with Show chat titles: the name is text the chat made). */
const NAMED: Readonly<Record<"bg_needs" | "bg_done" | "bg_failed", string>> = {
  bg_needs: "needs your input",
  bg_done: "finished",
  bg_failed: "failed",
};

/** The cards whose own path a push may open (5.2): the card is focused there, and nothing is answered. */
export const PUSH_CARD_KINDS = ["permission", "question", "plan", "elicitation", "dialog"] as const;
export type PushCardKind = (typeof PUSH_CARD_KINDS)[number];

/** The push's plaintext, JSON (DESIGN-R130 4.3). */
export interface PushPayload {
  v: 1;
  title: string;
  /** "" when the title says it all. */
  body: string;
  /** `c:<chat>`, or `c:<chat>:bg:<id>` for a background session: a newer push of the tag replaces the shown one. */
  tag: string;
  /** The path the click opens. */
  url: string;
}

/** One moment, as the registry reports it. */
export interface PushMomentInput {
  chat: string;
  moment: PushMoment;
  /** The chat's title now; only in the push of a device with Show chat titles. */
  title: string | null;
  /** The card that waits (a card's moment). */
  card?: { kind: PushCardKind; id: string };
  /** The background session (its moments). */
  bg?: { id: string; name: string | null };
}

const TAG = /^c:[a-z2-7]{20}(?::bg:[a-f0-9]{8})?$/;

/** The notification's tag: one per chat, and one per background session of the chat (its own seen). */
export function pushTag(chat: string, bg?: string | null): string {
  return bg ? `c:${chat}:bg:${bg}` : `c:${chat}`;
}

/** RFC 8030 section 5.4's Topic: the chat id, or the chat id and the session's short id (28 alphanumerics). */
export function pushTopic(chat: string, bg?: string | null): string {
  return bg ? `${chat}${bg}` : chat;
}

/** The path a moment's click opens: the card's own path, the session's view, or the chat. */
export function pushUrl(chat: string, at: { card?: { kind: string; id: string }; bg?: string } = {}): string {
  if (at.bg && BG_ID.test(at.bg)) return `/c/${chat}/background/${at.bg}`;
  if (at.card && (PUSH_CARD_KINDS as readonly string[]).includes(at.card.kind) && AGENT_REF.test(at.card.id)) return `/c/${chat}/${at.card.kind}/${at.card.id}`;
  return `/c/${chat}`;
}

const PUSH_PATH = new RegExp(
  `^/c/[a-z2-7]{20}(?:/(?:${PUSH_CARD_KINDS.join("|")})/[A-Za-z0-9_-]{1,64}|/background/[a-f0-9]{8})?$`,
);

/** Whether a push may open this path: Home, a chat, a card's own path or a background session's view; nothing else. */
export function isPushUrl(v: unknown): v is string {
  return typeof v === "string" && (v === "/" || PUSH_PATH.test(v));
}

/** Whether the moment wants the push service's high urgency (RFC 8030 section 5.3): Claude waits for the user. */
export function pushUrgent(moment: PushMoment): boolean {
  return moment === "permission" || moment === "input" || moment === "bg_needs";
}

/** A text cut at `max` UTF-16 units, never inside a surrogate pair, with control characters made spaces. */
function clip(text: string, max: number): string {
  const t = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.charCodeAt(max - 1) >= 0xd800 && t.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return t.slice(0, cut);
}

/**
 * The payload of one moment for one device. Titles off: the moment's words are the title and the body is empty.
 * Titles on: the chat's title is the title and the words are the body (a background session's with its name). Never
 * the project's name, which a lock screen would show to anyone near the phone.
 */
export function pushPayload(m: PushMomentInput, titles: boolean): PushPayload {
  const words = PUSH_WORDS[m.moment];
  const tag = pushTag(m.chat, m.bg?.id);
  const url = pushUrl(m.chat, { ...(m.card ? { card: m.card } : {}), ...(m.bg ? { bg: m.bg.id } : {}) });
  const chatTitle = m.title ? clip(m.title, PUSH_LIMITS.title) : "";
  if (!titles || !chatTitle) return { v: 1, title: words, body: "", tag, url };
  const name = m.bg?.name ? clip(m.bg.name, 80) : "";
  const body = name && m.moment in NAMED ? `${name} ${NAMED[m.moment as keyof typeof NAMED]}` : words;
  return { v: 1, title: chatTitle, body: clip(body, PUSH_LIMITS.body), tag, url };
}

/** A payload as the service worker reads it: every field of its type and cap, a known tag and an app path; else null. */
export function pushPayloadOf(v: unknown): PushPayload | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return null;
  const { title, body, tag, url } = o;
  if (typeof title !== "string" || !title || title.length > PUSH_LIMITS.title) return null;
  if (typeof body !== "string" || body.length > PUSH_LIMITS.body) return null;
  if (typeof tag !== "string" || !TAG.test(tag) || !isPushUrl(url)) return null;
  return { v: 1, title, body, tag, url };
}

/** The push services that kitespan sends to (DESIGN-R130 4.4: a fixed public list, so 4.8's outbound list is exact). */
export const PUSH_HOSTS = ["apple", "fcm", "windows", "mozilla"] as const;
export type PushHost = (typeof PUSH_HOSTS)[number];

/** Which push service a host is (lowercase, no port), or null for one that kitespan does not send to. */
export function pushHostOf(host: string): PushHost | null {
  const h = host.toLowerCase();
  if (h === "fcm.googleapis.com") return "fcm";
  if (h === "updates.push.services.mozilla.com") return "mozilla";
  const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const under = (suffix: string) => h.endsWith(suffix) && h.length > suffix.length && h.slice(0, -suffix.length).split(".").every((l) => label.test(l));
  if (under(".push.apple.com")) return "apple";
  if (under(".notify.windows.com")) return "windows";
  return null;
}

/** A device's id (16 characters of `[a-z2-7]`): the server's and the page's, so the page finds its own row by its hash. */
export const PUSH_DEVICE_ID = /^[a-z2-7]{16}$/;
export const isPushDeviceId = (v: unknown): v is string => typeof v === "string" && PUSH_DEVICE_ID.test(v);

/** The id of a subscription's endpoint: the first 80 bits of its SHA-256, in kitespan's base32 (shared/ids.ts). */
export async function pushDeviceId(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of digest.subarray(0, 10)) {
    acc = ((acc << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += ID_ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** A device's name as the server keeps it: control characters out, white space as one space, 1 to 40; else null. */
export function pushDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t && t.length <= PUSH_LIMITS.name ? t : null;
}
