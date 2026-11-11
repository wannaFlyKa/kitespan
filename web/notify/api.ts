// The server's push routes (DESIGN-R130 4.4), the page's side: GET /api/push reads the key (null before the first
// opt-in) and the devices and makes nothing; the POSTs (the sender gate's header, guard 3) make the key at the first
// opt-in, add this browser's subscription as a device, rename one or set its titles, and remove one. A device never
// carries its endpoint back to the page. Each POST is the user's own press.
import type { PushDeviceView, PushReply } from "../../server/http/api-types";
import { apiGet, apiSend } from "../net/api";

/** A device as the server lists it: its id, name, Show chat titles, when it turned on, and whether it is failing. */
export type PushDevice = PushDeviceView;

/** The server's public key (base64url, the 65-octet point; null before the first device turned on) and the devices. */
export type PushRead = PushReply;

/** The subscription as the browser gives it (PushSubscription.toJSON()). */
export interface SubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The error code for a push service that is not on the server's list. */
export const PUSH_SERVICE_CODE = "push_service" as const;

export interface PushApi {
  read(): Promise<PushRead>;
  makeKey(): Promise<string>;
  add(subscription: SubscriptionJson, name: string): Promise<PushDevice>;
  change(id: string, p: { name?: string; titles?: boolean }): Promise<PushDevice>;
  remove(id: string): Promise<void>;
}

/** A read answer the page can trust: anything else in it is left out. */
export function cleanRead(raw: unknown): PushRead {
  const r = (raw && typeof raw === "object" ? raw : {}) as { key?: unknown; devices?: unknown };
  const devices = Array.isArray(r.devices) ? r.devices.flatMap((d) => (isDevice(d) ? [cleanDevice(d)] : [])) : [];
  return { key: typeof r.key === "string" && r.key !== "" ? r.key : null, devices };
}

function isDevice(d: unknown): d is PushDevice {
  const x = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  return typeof x.id === "string" && typeof x.name === "string";
}

function cleanDevice(d: PushDevice): PushDevice {
  return { id: d.id, name: d.name, titles: d.titles === true, at: typeof d.at === "string" ? d.at : "", failing: d.failing === true };
}

export const pushApi: PushApi = {
  read: async () => cleanRead(await apiGet<unknown>("/api/push")),
  makeKey: async () => {
    const r = await apiSend<{ key?: unknown }>("POST", "/api/push/key", {});
    if (typeof r?.key !== "string" || r.key === "") throw new Error("no key");
    return r.key;
  },
  add: async (subscription, name) => {
    const r = await apiSend<{ device?: unknown }>("POST", "/api/push/devices", { subscription, name });
    if (!isDevice(r?.device)) throw new Error("no device");
    return cleanDevice(r.device);
  },
  change: async (id, p) => {
    const r = await apiSend<{ device?: unknown }>("POST", `/api/push/devices/${encodeURIComponent(id)}`, p);
    if (!isDevice(r?.device)) throw new Error("no device");
    return cleanDevice(r.device);
  },
  remove: async (id) => {
    await apiSend("POST", `/api/push/devices/${encodeURIComponent(id)}/remove`, {});
  },
};
