// Open on phone's server part (v0.6 touch; DESIGN-T1 2.5 and 2.9, T-14, T-23): GET /api/settings sends the origins in
// force, the access adapter's link form (`access.phoneLink`, null when unset) and the phone-browser notes (the public
// default's one line, or the owner's). No server is started: the handler is called.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PUBLIC_ADAPTERS, PUBLIC_PHONE_NOTE, allowedOrigins, type Adapters } from "../../server/adapters/adapters";
import type { AgentDriver, BinaryProbe } from "../../server/agents/types";
import { createGate } from "../../server/gate/guards";
import { createApi } from "../../server/http/api";
import type { SettingsReply } from "../../server/http/api-types";
import { createApp, type Upgrader } from "../../server/http/app";
import { loadSite } from "../../server/http/static";
import { SETTINGS_DEFAULTS } from "../../server/store/types";

const PORT = 7941;
const OWN = `http://127.0.0.1:${PORT}`;
const FORWARD = "https://phone.example.test";
const PROBE: BinaryProbe = { ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.318", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null };

async function settings(adapters: Adapters, flag: string[] = []): Promise<SettingsReply> {
  const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
    probe: async () => PROBE,
    settings: async () => ({ respondToBash: true, cleanupPeriodDays: 30, promptSuggestions: false, defaultMode: null }),
    listSessions: async () => [],
    sessionInfo: async () => null,
    history: async () => ({ events: [], more: null }),
  };
  const allowed = allowedOrigins(PORT, flag, adapters.origins);
  const gate = createGate(PORT, allowed.map((a) => a.origin));
  const site = loadSite(join(tmpdir(), "kitespan-no-dist"), gate.origins);
  const api = createApi({
    gate,
    safe: site.safe,
    store: { listProjects: async () => [], putProject: async () => {}, readSettings: async () => ({ ...SETTINGS_DEFAULTS }), readChat: async () => null, listUploads: async () => [], putUpload: async () => {}, removeUpload: async () => null },
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-x", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.6.0", adapters, allowed },
  });
  const app = createApp({ gate, site, api, sockets: {} });
  const noServer: Upgrader = { upgrade: () => false };
  const res = (await app.fetch(new Request(`${OWN}/api/settings`, { headers: { host: `127.0.0.1:${PORT}` } }), noServer))!;
  expect(res.status).toBe(200);
  return (await res.json()) as SettingsReply;
}

describe("the settings reply's phone parts", () => {
  test("the public defaults: no origin, no link form (null, never absent) and the one public note", async () => {
    const r = await settings({ ...PUBLIC_ADAPTERS });
    expect(r.access.origins).toEqual([]);
    expect("phoneLink" in r.access).toBe(true);
    expect(r.access.phoneLink).toBeNull();
    expect(r.phoneNotes).toEqual([PUBLIC_PHONE_NOTE]);
  });

  test("the owner's link form, origins and notes as the file gives them; --origin's origins come first", async () => {
    const link = "https://open.example.test/?u={url}";
    const r = await settings({ ...PUBLIC_ADAPTERS, origins: [FORWARD], phoneLink: link, phoneNotes: ["No notifications here."] }, ["https://flag.example.test"]);
    expect(r.access.origins).toEqual(["https://flag.example.test", FORWARD]);
    expect(r.access.phoneLink).toBe(link);
    expect(r.phoneNotes).toEqual(["No notifications here."]);
  });
});
