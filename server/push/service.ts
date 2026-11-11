// R130 (DESIGN-R130 4.4): notifications on the server: the store of the key and the devices, the sender, the notify
// rule's marks, and the JSON API's part (server/http/api.ts routes /api/push...). main.ts makes one and gives its
// `hooks` to the registry and its `api` to the JSON API.

import type { PushDeviceView, PushReply } from "../http/api-types";
import { pushDeviceName } from "../../shared/push";
import { PushNotifier } from "./notify";
import { PushSender, type PushLogFields, type PushSenderDeps } from "./send";
import { PushStore, subscriptionOf, type PushDevice } from "./store";

/** What the JSON API asks of notifications. */
export interface PushApi {
  /** GET /api/push: the public key (null before the first opt-in) and the devices. Makes nothing. */
  read(): Promise<PushReply>;
  /** POST /api/push/key: the public key, made the first time. */
  makeKey(): Promise<string>;
  /** POST /api/push/devices. */
  add(body: unknown): Promise<{ ok: true; device: PushDeviceView; added: boolean } | { ok: false; code: "bad_request" | "push_service" | "too_many" }>;
  /** POST /api/push/devices/:device: `bad` for a body that is not a change; null for an id that is not here. */
  update(id: string, body: unknown): Promise<PushDeviceView | null | "bad">;
  /** POST /api/push/devices/:device/remove: false for an id that is not here. */
  remove(id: string): Promise<boolean>;
}

/** A `push_device` line's answer (log.ts). */
export type PushDeviceChange = "added" | "removed" | "renamed";

export interface PushDeps {
  /** The state folder. */
  dir: string;
  uid: number;
  /** The loopback origin of a test's stub push service (store.ts pushTestOrigin), or null. */
  testOrigin: string | null;
  log?: {
    push(f: PushLogFields): void;
    gone(f: { host: string; status: number }): void;
    device(change: PushDeviceChange): void;
  };
  onSetAside?: () => void;
  /** The sender's options (tests: a stand-in fetch, a short deadline). */
  sender?: Omit<PushSenderDeps, "log">;
  now?: () => Date;
}

export interface Push {
  hooks: PushNotifier;
  api: PushApi;
  store: PushStore;
}

const view = (d: PushDevice): PushDeviceView => ({ id: d.id, name: d.name, titles: d.titles, at: d.at, failing: d.failing });

export function createPush(deps: PushDeps): Push {
  const store = new PushStore({ dir: deps.dir, uid: deps.uid, ...(deps.onSetAside ? { onSetAside: deps.onSetAside } : {}), ...(deps.now ? { now: deps.now } : {}) });
  const sender = new PushSender({ ...deps.sender, ...(deps.log ? { log: deps.log.push } : {}) });
  const hooks = new PushNotifier({ store, sender, testOrigin: deps.testOrigin, ...(deps.log ? { logGone: deps.log.gone } : {}) });
  const api: PushApi = {
    async read() {
      const [key, devices] = await Promise.all([store.key(), store.devices()]);
      return { key: key?.publicKey ?? null, devices: devices.map(view) };
    },
    async makeKey() {
      return (await store.makeKey()).publicKey;
    },
    async add(body) {
      const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const name = pushDeviceName(b.name);
      if (name === null || !(await store.key())) return { ok: false, code: "bad_request" };
      const sub = await subscriptionOf(b.subscription, deps.testOrigin);
      if (sub === "bad") return { ok: false, code: "bad_request" };
      if (sub === "service") return { ok: false, code: "push_service" };
      const r = await store.add(sub, name);
      if (!r) return { ok: false, code: "too_many" };
      if (r.added) deps.log?.device("added");
      return { ok: true, device: view(r.device), added: r.added };
    },
    async update(id, body) {
      if (typeof body !== "object" || body === null || Array.isArray(body)) return "bad";
      const b = body as Record<string, unknown>;
      const change: { name?: string; titles?: boolean } = {};
      if ("name" in b) {
        const name = pushDeviceName(b.name);
        if (name === null) return "bad";
        change.name = name;
      }
      if ("titles" in b) {
        if (typeof b.titles !== "boolean") return "bad";
        change.titles = b.titles;
      }
      if (change.name === undefined && change.titles === undefined) return "bad";
      const was = (await store.devices()).find((d) => d.id === id);
      const d = await store.update(id, change);
      if (d && was && change.name !== undefined && was.name !== d.name) deps.log?.device("renamed");
      return d ? view(d) : null;
    },
    async remove(id) {
      const gone = await store.remove(id);
      if (gone) deps.log?.device("removed");
      return gone !== null;
    },
  };
  return { hooks, api, store };
}

