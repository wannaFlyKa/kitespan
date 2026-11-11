// Open on phone's rules (DESIGN-T1 2.5; DESIGN 7.9 and 9.6), pure: which remote origin the code uses, which path it
// holds, the text it encodes, and the dialog's state for a settings reply. The code holds the remote origin and the path
// of the page the dialog was opened over, and nothing else: no token, no host path (5.1 rule 2).
import { href, parse, type Route } from "../../shared/route";
import type { SettingsReply } from "../../server/http/api-types";
import { qrPath, type QrCode } from "../ui/qr";

/** The dialog's words (DESIGN-T1 2.5). No line asks the user to scan: the title says what the code is for. */
export const PHONE_WORDS = {
  title: "Open on phone",
  tile: "Code for the link below",
  none: "No remote address is set up for this host.",
  failed: "The address could not be read.",
  long: "This link is too long for a code.",
  copy: "Copy link",
  copied: "Copied",
  retry: "Try again",
} as const;

/** The access adapter's one placeholder (server/adapters/adapters.ts PHONE_LINK_SLOT). */
const SLOT = "{url}";

const loopback = (host: string) => host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/**
 * The origin a phone can reach, of the origins in force (`access.origins`): `https:` and not a loopback host (an `ssh -L`
 * forward on another local port is the laptop's own). The page's own origin when it is one of them (the user is on
 * that forward now), else the first; null when none is left.
 */
export function pickOrigin(origins: readonly string[], own: string | null): string | null {
  const reachable = origins.filter((o) => {
    try {
      const u = new URL(o);
      return u.protocol === "https:" && u.origin === o && !loopback(u.hostname);
    } catch {
      return false;
    }
  });
  return own !== null && reachable.includes(own) ? own : (reachable[0] ?? null);
}

/**
 * The path the code holds: `from`, the history entry's opener (router.ts EntryState), when it is a view of this chat
 * (its query as the decoder reads it, so a split's `above` and `below` stay), else the chat's own path with the
 * route's view. An action route (a pre-filled draft, a card's answer) is never sent to another device, and neither is
 * this route itself.
 */
export function openerPath(chatId: string, route: Pick<Route, "query">, from: unknown): string {
  const own = href("chat", { chat: chatId }, { view: typeof route.query.view === "string" ? route.query.view : undefined });
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//")) return own;
  const r = parse(new URL(from, "http://kitespan.invalid"));
  if (r.fallbackFrom || r.params.chat !== chatId || r.def.kind !== "view" || r.name === "phone") return own;
  return href(r.name, r.params, r.query);
}

/**
 * The link shown and copied (the origin and the path), and the text the code encodes: the link, or the access adapter's
 * link form (`access.phoneLink`) with its one `{url}` filled with the encoded link. A path of this route itself gives
 * the chat's own path, so a code never opens Open on phone.
 */
export function phoneLink(origin: string, path: string, template: string | null): { link: string; text: string } {
  const r = parse(new URL(path, "http://kitespan.invalid"));
  const safe = r.name === "phone" ? href("chat", r.params, { view: r.query.view }) : path;
  const link = origin + safe;
  const parts = typeof template === "string" ? template.split(SLOT) : [];
  return { link, text: parts.length === 2 ? `${parts[0]}${encodeURIComponent(link)}${parts[1]}` : link };
}

export type PhoneState =
  | { kind: "reading" }
  | { kind: "failed" }
  | { kind: "none" }
  | { kind: "long"; link: string; text: string }
  | { kind: "code"; link: string; text: string; code: QrCode };

/** The dialog's state for a settings reply: no reachable origin, a link too long for a code, or the code. */
export function phoneState(reply: Pick<SettingsReply, "access">, own: string | null, path: string): PhoneState {
  const origin = pickOrigin(Array.isArray(reply.access?.origins) ? reply.access.origins : [], own);
  if (origin === null) return { kind: "none" };
  const { link, text } = phoneLink(origin, path, typeof reply.access.phoneLink === "string" ? reply.access.phoneLink : null);
  const code = qrPath(text);
  return code ? { kind: "code", link, text, code } : { kind: "long", link, text };
}
