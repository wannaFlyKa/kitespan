// R130 (DESIGN-R130 4.4): the server's two push files in the state folder, each 0600 through the store's one atomic
// writer (server/store/files.ts), read with the store's checks, and set aside as `.bad` when a check fails.
//
// - push-key.json: the VAPID key pair, `{v, publicKey, privateKey}`. Made at the first opt-in (POST /api/push/key),
//   never by a read; never logged, and never in an answer but its public key. A key made anew (none was kept, or a bad
//   file was set aside) empties the device list: every subscription names the key it was made with.
// - push-devices.json: the devices that have notifications on, `{v, devices: [{id, name, endpoint, p256dh, auth,
//   titles, at, failing}]}`, at most 20. The endpoint is a capability: it never leaves the server (no answer, no log
//   line, no URL); the page finds its own row by the id, the hash of its endpoint (shared/push.ts pushDeviceId).
//
// Which endpoints are taken (`endpointProblem`): an https URL with no user or password, at most 2,048 characters, on a
// push service of the list (shared/push.ts pushHostOf) at its default port; or exactly the one loopback origin that a
// test names (KITESPAN_PUSH_TEST_ORIGIN, `http://127.0.0.1:<port>`). The sender checks it again before every send.

import { join } from "node:path";
import { PUSH_LIMITS, isPushDeviceId, pushDeviceId, pushDeviceName, pushHostOf } from "../../shared/push";
import { Serial, readJson, setAside, writeAtomic } from "../store/files";
import { b64urlDecode, isP256Point, makeVapidKeys, vapidKeysOf, type VapidKeys } from "./crypto";

export const PUSH_FILES = { key: "push-key.json", devices: "push-devices.json" } as const;
/** The largest push file read or written: 20 devices of at most about 2.4 KB each, with room. */
export const PUSH_FILE_BYTES = 128 * 1024;

/** One device as push-devices.json keeps it. */
export interface PushDevice {
  id: string;
  name: string;
  endpoint: string;
  /** base64url: the browser's P-256 key (65 octets) and its auth secret (16). */
  p256dh: string;
  auth: string;
  /** Show chat titles, this device's own setting. */
  titles: boolean;
  /** When it turned on (ISO 8601). */
  at: string;
  /** The last notification did not go through (401 or 403, or three failures in a row). */
  failing: boolean;
}

/** A subscription as the page sends it (`PushSubscription.toJSON()`), checked. */
export interface PushSubscriptionIn {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The loopback origin a test names for its stub push service, or null (any other value names none). */
export function pushTestOrigin(raw: string | undefined): string | null {
  const m = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(raw ?? "");
  return m && Number(m[1]) >= 1 && Number(m[1]) <= 65535 ? m[0] : null;
}

/** Why kitespan does not send to this endpoint: `bad` (not a URL it takes), `service` (a host off the list); else null. */
export function endpointProblem(endpoint: unknown, testOrigin: string | null): "bad" | "service" | null {
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > PUSH_LIMITS.endpoint) return "bad";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "bad";
  }
  if (url.username || url.password || url.hash || url.href !== endpoint) return "bad";
  if (testOrigin !== null && url.origin === testOrigin && url.protocol === "http:") return null;
  if (url.protocol !== "https:") return "bad";
  if (url.port !== "") return "service";
  return pushHostOf(url.hostname) ? null : "service";
}

/** The subscription of a request's body: `bad` for any field that is not one, `service` for a host off the list. */
export async function subscriptionOf(v: unknown, testOrigin: string | null): Promise<PushSubscriptionIn | "bad" | "service"> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "bad";
  const { endpoint, keys } = v as Record<string, unknown>;
  if (typeof keys !== "object" || keys === null) return "bad";
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 128 || auth.length > 64) return "bad";
  const point = b64urlDecode(p256dh);
  const secret = b64urlDecode(auth);
  if (!point || !(await isP256Point(point)) || secret?.length !== 16) return "bad";
  const problem = endpointProblem(endpoint, testOrigin);
  if (problem) return problem;
  return { endpoint: endpoint as string, p256dh, auth };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** One device of a file, every field checked (the endpoint's form only: the sender checks its host again). */
function deviceOf(v: unknown): PushDevice | null {
  if (typeof v !== "object" || v === null) return null;
  const d = v as Record<string, unknown>;
  if (!isPushDeviceId(d.id) || pushDeviceName(d.name) !== d.name || typeof d.titles !== "boolean" || typeof d.failing !== "boolean") return null;
  if (typeof d.at !== "string" || !ISO.test(d.at)) return null;
  if (typeof d.endpoint !== "string" || d.endpoint.length > PUSH_LIMITS.endpoint || !/^https?:\/\//.test(d.endpoint)) return null;
  if (typeof d.p256dh !== "string" || b64urlDecode(d.p256dh)?.length !== 65) return null;
  if (typeof d.auth !== "string" || b64urlDecode(d.auth)?.length !== 16) return null;
  return { id: d.id, name: d.name as string, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth, titles: d.titles, at: d.at, failing: d.failing };
}

export interface PushStoreDeps {
  /** The state folder. */
  dir: string;
  uid: number;
  /** A file failed its check and was set aside (the server logs `bad_record`). */
  onSetAside?: () => void;
  now?: () => Date;
}

/** The push files, read once and kept in memory; every change is written at once, one write after another. */
export class PushStore {
  private keys: VapidKeys | null | undefined = undefined;
  private list: PushDevice[] | undefined = undefined;
  private readonly serial = new Serial();

  constructor(private readonly deps: PushStoreDeps) {}

  private async readFile(name: string, check: (v: unknown) => boolean): Promise<unknown | null> {
    const r = await readJson(join(this.deps.dir, name), PUSH_FILE_BYTES, this.deps.uid);
    if (r.kind === "absent") return null;
    if (r.kind === "ok" && check(r.value)) return r.value;
    await setAside(this.deps.dir, name);
    this.deps.onSetAside?.();
    return null;
  }

  private write(name: string, value: unknown): Promise<void> {
    return writeAtomic(this.deps.dir, name, JSON.stringify(value), PUSH_FILE_BYTES, this.deps.uid);
  }

  /** The key pair, or null before the first opt-in. A read makes nothing. */
  async key(): Promise<VapidKeys | null> {
    if (this.keys === undefined) {
      const v = await this.readFile(PUSH_FILES.key, (x) => (x as { v?: unknown } | null)?.v === 1 && vapidKeysOf(x) !== null);
      this.keys = v === null ? null : vapidKeysOf(v);
    }
    return this.keys;
  }

  /** The key pair, made now if there is none (and then the device list starts empty). */
  makeKey(): Promise<VapidKeys> {
    return this.serial.run("key", async () => {
      const have = await this.key();
      if (have) return have;
      const made = await makeVapidKeys();
      await this.write(PUSH_FILES.key, { v: 1, ...made });
      this.keys = made;
      await this.change((list) => ({ next: list.length ? [] : null, out: undefined }));
      return made;
    });
  }

  async devices(): Promise<readonly PushDevice[]> {
    if (this.list === undefined) {
      const v = await this.readFile(PUSH_FILES.devices, (x) => {
        const o = x as { v?: unknown; devices?: unknown } | null;
        return o?.v === 1 && Array.isArray(o.devices) && o.devices.length <= PUSH_LIMITS.devices && o.devices.every((d) => deviceOf(d) !== null);
      });
      // A second read that raced this one keeps the first one's list.
      this.list ??= v === null ? [] : (v as { devices: unknown[] }).devices.map((d) => deviceOf(d)!);
    }
    return this.list;
  }

  private async saveDevices(next: PushDevice[]): Promise<void> {
    await this.write(PUSH_FILES.devices, { v: 1, devices: next });
    this.list = next;
  }

  /** One change of the device list at a time: `fn` gets the list now and returns the new one, or null for no change. */
  private change<T>(fn: (list: readonly PushDevice[]) => { next: PushDevice[] | null; out: T }): Promise<T> {
    return this.serial.run("devices", async () => {
      const r = fn(await this.devices());
      if (r.next) await this.saveDevices(r.next);
      return r.out;
    });
  }

  /**
   * A device turns on: a new one at the end (null when 20 are on), or the same endpoint again, which takes the new
   * keys and keeps its name and titles. `added`: a new device.
   */
  async add(sub: PushSubscriptionIn, name: string): Promise<{ device: PushDevice; added: boolean } | null> {
    const id = await pushDeviceId(sub.endpoint);
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    return this.change<{ device: PushDevice; added: boolean } | null>((list) => {
      const known = list.find((d) => d.endpoint === sub.endpoint);
      if (known) {
        const device = { ...known, p256dh: sub.p256dh, auth: sub.auth, failing: false };
        return { next: list.map((d) => (d === known ? device : d)), out: { device, added: false } };
      }
      if (list.length >= PUSH_LIMITS.devices) return { next: null, out: null };
      // Two endpoints whose hashes share 80 bits: the older device goes, so an id names one device.
      const device: PushDevice = { id, name, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, titles: false, at, failing: false };
      return { next: [...list.filter((d) => d.id !== id), device], out: { device, added: true } };
    });
  }

  /** A device's name or Show chat titles; null for an id that is not here. */
  async update(id: string, change: { name?: string; titles?: boolean }): Promise<PushDevice | null> {
    return this.change((list) => {
      const known = list.find((d) => d.id === id);
      if (!known) return { next: null, out: null };
      const device = { ...known, ...(change.name !== undefined ? { name: change.name } : {}), ...(change.titles !== undefined ? { titles: change.titles } : {}) };
      const same = device.name === known.name && device.titles === known.titles;
      return { next: same ? null : list.map((d) => (d === known ? device : d)), out: device };
    });
  }

  /** A device turns off (Turn off, or its push service said it is gone); null for an id that is not here. */
  async remove(id: string): Promise<PushDevice | null> {
    return this.change((list) => {
      const known = list.find((d) => d.id === id);
      return known ? { next: list.filter((d) => d !== known), out: known } : { next: null, out: null };
    });
  }

  /**
   * A send's mark: `failing` after a refusal or three failures in a row, cleared by a send that went through. Only for
   * the device of that endpoint still (a device that turned on again meanwhile keeps its own state).
   */
  async markFailing(id: string, endpoint: string, failing: boolean): Promise<void> {
    await this.change((list) => {
      const known = list.find((d) => d.id === id && d.endpoint === endpoint);
      if (!known || known.failing === failing) return { next: null, out: undefined };
      return { next: list.map((d) => (d === known ? { ...known, failing } : d)), out: undefined };
    });
  }

  /** The writes queued so far have ended (tests). */
  idle(): Promise<void> {
    return this.serial.idle();
  }
}

