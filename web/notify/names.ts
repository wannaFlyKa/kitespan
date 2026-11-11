// A device's default name and its id on the page (DESIGN-R130 4.4 and 4.5). The name comes from the push service that
// the subscription's endpoint names, and the size class (7.1), never the User-Agent; the user edits it. The id is the
// server's (shared/push.ts pushDeviceId, the hash of the endpoint), so the page finds its own row in the server's list
// while the endpoint, a capability, never leaves the server in an answer, a log or a URL.
import { PUSH_DEVICE_ID, PUSH_LIMITS, pushDeviceId, pushHostOf, type PushHost } from "../../shared/push";
import type { SizeClass } from "../layout/size";

/** A device name's cap (the server's). */
export const DEVICE_NAME_MAX = PUSH_LIMITS.name;

export type PushService = PushHost | null;

/** The push service that an endpoint names, by its host (the server's list); null for any other. */
export function pushServiceOf(endpoint: string): PushService {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" ? pushHostOf(u.hostname) : null;
  } catch {
    return null;
  }
}

/** The name a size class gives: the phone, a touch device that is not a phone (a medium touch or large tablet), a laptop. */
type Form = "phone" | "tablet" | "laptop";
const NAMES: Record<Exclude<PushService, null>, Record<Form, string>> = {
  apple: { phone: "iPhone", tablet: "iPad", laptop: "Mac" },
  fcm: { phone: "Android phone", tablet: "Android tablet", laptop: "Chrome" },
  windows: { phone: "Edge", tablet: "Edge", laptop: "Edge" },
  mozilla: { phone: "Firefox", tablet: "Firefox", laptop: "Firefox" },
};
/** A push service that is not on the list (the server takes one only as its test origin). */
const OTHER = "Browser";

export function formOf(size: SizeClass, touch: boolean): Form {
  if (size === "phone") return "phone";
  return touch ? "tablet" : "laptop";
}

/** A name at most DEVICE_NAME_MAX characters, with no control character and its spaces folded. */
export function cleanName(raw: string): string {
  return [...raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, DEVICE_NAME_MAX).join("").trim();
}

/** The name the page proposes for this device: " 2", " 3" and so on after a name another device has. */
export function defaultName(endpoint: string, size: SizeClass, touch: boolean, taken: readonly string[]): string {
  const service = pushServiceOf(endpoint);
  const base = service ? NAMES[service][formOf(size, touch)] : OTHER;
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** The server's id of the device with this endpoint. */
export const deviceIdOf = pushDeviceId;

/** A device id as the server makes it. */
export const DEVICE_ID = PUSH_DEVICE_ID;
