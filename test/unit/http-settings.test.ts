// Settings writes and Settings > Account on the JSON API (DESIGN.md 4.3, 4.4, 4.9 guard 3, 6.8; the server additions
// that W10 left open): POST /api/settings passes the sender gate, writes kitespan's own settings through the real
// store's checks (settings.json in a scratch folder), then has the registry read them again, and answers with the
// Settings reply; a bad value or an unknown key is refused and changes nothing; the Settings reply names the
// provider that a live chat's Claude Code reports, or null when no chat is live. No server is started.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLIC_ADAPTERS } from "../../server/adapters/adapters";
import type { AgentDriver } from "../../server/agents/types";
import { ChatRegistry } from "../../server/chats/registry";
import { FakeDriver, MemoryStore, apply, autoReply, projectRecord, settle } from "../../server/chats/testing";
import { createGate } from "../../server/gate/guards";
import { createApi, type ApiDeps } from "../../server/http/api";
import { safeHeaders } from "../../server/http/headers";
import { createStore } from "../../server/store/store";
import type { Settings } from "../../server/store/types";

const PORT = 7944;
const OWN = `http://127.0.0.1:${PORT}`;
const SENDER: Record<string, string> = { host: `127.0.0.1:${PORT}`, "x-kitespan": "1", "content-type": "application/json", origin: OWN };
const root = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-settings-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const driver: Pick<AgentDriver, "probe" | "settings" | "listSessions" | "history" | "sessionInfo"> = {
  probe: async () => ({ ok: true, path: "/opt/bin/claude", realpath: "/opt/bin/claude", version: "2.1.312", source: "path", refused: [], platformPackages: [], drift: null, belowMinimum: null }),
  settings: async () => ({ respondToBash: true, cleanupPeriodDays: null, promptSuggestions: false, defaultMode: null }),
  listSessions: async () => [],
  sessionInfo: async () => null,
  history: async () => ({ events: [], more: null }),
};

async function setup(extra: Partial<ApiDeps> = {}) {
  const dir = mkdtempSync(join(root, "s-"));
  const store = createStore({ root: dir, user: "tester" });
  await store.open();
  const reloads: Settings[] = [];
  const api = createApi({
    gate: createGate(PORT),
    safe: safeHeaders("default-src 'self'"),
    store,
    driver,
    uploadFolder: async () => ({ ok: true, path: "/tmp/kitespan-uploads-tester", choice: "temp" }),
    chatForSession: () => null,
    heldSessions: () => new Set(),
    info: { port: PORT, version: "0.1.0", adapters: PUBLIC_ADAPTERS },
    settingsWriter: {
      write: (change) => store.writeSettings(change),
      reload: async () => void reloads.push(await store.readSettings()),
    },
    ...extra,
  });
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    api.handle(new Request(`${OWN}${path}`, { method: init.method ?? "GET", headers: init.headers ?? { host: `127.0.0.1:${PORT}` }, body: init.body }), new URL(`${OWN}${path}`));
  const post = (body: unknown, headers = SENDER) => call("/api/settings", { method: "POST", headers, body: JSON.stringify(body) });
  return { store, call, post, reloads, dir };
}

describe("POST /api/settings", () => {
  test("a write passes the sender gate, is checked and kept, makes the registry read it again, and answers with the Settings reply", async () => {
    const { post, store, reloads, dir } = await setup();
    const res = await post({ "chats.maxLive": 12, "chats.bashReply": "never", "appearance.look": "editor" });
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { settings: Record<string, unknown>; claude: { ok: boolean }; account: unknown };
    expect(reply.settings).toMatchObject({ "chats.maxLive": 12, "chats.bashReply": "never", "appearance.look": "editor", "chats.keepIdleMinutes": 30 });
    expect(reply.claude.ok).toBe(true);
    expect(reply.account).toBe(null);
    expect(reloads.length).toBe(1);
    expect(reloads[0]!["chats.maxLive"]).toBe(12);
    expect((await store.readSettings())["appearance.look"]).toBe("editor");
    // A second store on the same folder reads what the first wrote: it is on disk.
    const again = createStore({ root: dir, user: "tester" });
    await again.open();
    expect((await again.readSettings())["chats.bashReply"]).toBe("never");
  });

  test("without the sender gate a write is refused with 403 and changes nothing", async () => {
    const { post, store, reloads } = await setup();
    const { "x-kitespan": _h, ...noHeader } = SENDER;
    for (const headers of [noHeader, { ...SENDER, "content-type": "text/plain" }, { ...SENDER, origin: "https://evil.example" }, { host: SENDER.host!, "x-kitespan": "1", "content-type": "application/json" }]) {
      expect((await post({ "chats.maxLive": 3 }, headers)).status).toBe(403);
    }
    expect((await store.readSettings())["chats.maxLive"]).toBe(10);
    expect(reloads).toEqual([]);
  });

  test("an unknown key, a bad value or a body that is not an object is refused, and nothing is written", async () => {
    const { post, store, reloads } = await setup();
    for (const body of [{ "chats.nope": 1 }, { "chats.maxLive": "twelve" }, { "chats.maxLive": 12, "appearance.look": "solarized" }, ["chats.maxLive"], "x"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
    expect((await store.readSettings())["chats.maxLive"]).toBe(10);
    expect(reloads).toEqual([]);
  });

  test("a custom upload folder that does not exist gets the folder line; one that does is kept as its real path", async () => {
    const { post, dir } = await setup();
    const res = await post({ "uploads.folder": "custom", "uploads.customFolder": join(dir, "missing") });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("That folder does not exist.");
    const real = join(dir, "mine");
    mkdirSync(real);
    const ok = (await (await post({ "uploads.folder": "custom", "uploads.customFolder": real })).json()) as { settings: Record<string, unknown> };
    expect(ok.settings).toMatchObject({ "uploads.folder": "custom", "uploads.customFolder": real });
  });

  test("two writes at once both land", async () => {
    const { post, store } = await setup();
    const [a, b] = await Promise.all([post({ "chats.maxLive": 4 }), post({ "chats.keepIdleMinutes": 5 })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await store.readSettings()).toMatchObject({ "chats.maxLive": 4, "chats.keepIdleMinutes": 5 });
  });

  test("a server built without a settings writer keeps settings read only (405)", async () => {
    const { post } = await setup({ settingsWriter: undefined });
    expect((await post({ "chats.maxLive": 4 })).status).toBe(405);
  });
});

describe("Settings > Account", () => {
  test("the provider that a live chat's Claude Code reports (no time: it is live); null while no chat is live and none is kept; a failed read is null too", async () => {
    const live = await setup({ account: async () => ({ provider: "bedrock" }) });
    expect(((await (await live.call("/api/settings")).json()) as { account: unknown }).account).toEqual({ provider: "bedrock", at: null });
    const none = await setup({ account: async () => ({ provider: null }) });
    expect(((await (await none.call("/api/settings")).json()) as { account: unknown }).account).toEqual({ provider: null, at: null });
    const asleep = await setup({ account: async () => null });
    expect(((await (await asleep.call("/api/settings")).json()) as { account: unknown }).account).toBe(null);
    const broken = await setup({
      account: async () => {
        throw new Error("no");
      },
    });
    const res = await broken.call("/api/settings");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { account: unknown }).account).toBe(null);
  });

  test("the registry reads it from a live chat (accountInfo().apiProvider), and null when every chat sleeps", async () => {
    const fake = new FakeDriver();
    const store = new MemoryStore();
    store.projects = [projectRecord("k3m7q2x4ab")];
    autoReply(fake);
    const reg = new ChatRegistry({ driver: fake, store }, { idleMs: 60_000, closeGraceMs: 20, shutdownMs: 500 });
    await reg.boot();
    expect(await reg.account()).toBe(null);
    const o = await apply(reg, { t: "new_chat", rid: crypto.randomUUID(), project: "k3m7q2x4ab", uuid: crypto.randomUUID(), text: "hi", picks: { model: null, effort: null, mode: null }, uploads: [] });
    expect(o.ok).toBe(true);
    await settle(10);
    fake.last.provider = "vertex";
    expect(await reg.account()).toEqual({ provider: "vertex" });
    await reg.shutdown();
  });
});
