// R130 (FIX-R130 1: "Log only the push service's host and the status code, never the endpoint's path (it is a
// capability) or the payload"; DESIGN-R130 4.4): a `push` line per push holds the push service's host, the status, the
// time and, with no answer, timeout or network; `push_gone` the host and the status; `push_device` what changed. None
// holds an endpoint, a path, a key, a payload, a title or a device's name, and no other event holds their fields.
import { describe, expect, test } from "bun:test";
import { logLine, type LogFields } from "../../server/log";

const ROUTES = new Set(["/ws"]);
const T0 = new Date("2026-11-05T10:00:00.000Z");
const BASE = { t: "2026-11-05T10:00:00.000Z", chat: null, route: null, code: null, signal: null, ms: null, ok: null, timeout: null, capped: null, err: null };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/cap-abc123";

describe("the push lines", () => {
  test("push: the host, the status, the time; with no answer, which; nothing else", () => {
    const passed = { host: "fcm.googleapis.com", status: 201, ms: 84.4, chat: "k3m7q2x4abk3m7q2x4ab", path: ENDPOINT, route: ENDPOINT, id: "3f9a1c2e", count: 3 } as LogFields;
    expect(logLine("push", passed, T0, ROUTES)).toEqual({ ...BASE, ev: "push", ms: 84, host: "fcm.googleapis.com", status: 201, answer: null });
    expect(logLine("push", { host: "web.push.apple.com", status: 0, ms: 10_000, answer: "timeout" }, T0, ROUTES)).toMatchObject({ host: "web.push.apple.com", status: 0, answer: "timeout" });
    expect(logLine("push", { host: "127.0.0.1", status: 0, answer: "network" }, T0, ROUTES)).toMatchObject({ host: "127.0.0.1", answer: "network" });
    expect(logLine("push", { host: "fcm.googleapis.com", status: 201, answer: "Claude finished" }, T0, ROUTES).answer).toBeNull();
  });

  test("a host off the push services' list, an endpoint, a path or a URL is never kept", () => {
    for (const host of [ENDPOINT, "fcm.googleapis.com/fcm/send/cap", "push.example.net", "10.0.0.1", "intranet", ""]) expect(logLine("push", { host, status: 201 }, T0, ROUTES).host).toBeNull();
    for (const status of [-1, 1.5, 1000, Number.NaN]) expect(logLine("push", { host: "fcm.googleapis.com", status }, T0, ROUTES).status).toBeNull();
  });

  test("push_gone: the host and the status only; push_device: added, removed or renamed only", () => {
    expect(logLine("push_gone", { host: "updates.push.services.mozilla.com", status: 410, ms: 3, answer: "removed" }, T0, ROUTES)).toEqual({ ...BASE, ev: "push_gone", host: "updates.push.services.mozilla.com", status: 410 });
    for (const a of ["added", "removed", "renamed"]) expect(logLine("push_device", { answer: a }, T0, ROUTES)).toEqual({ ...BASE, ev: "push_device", answer: a });
    expect(logLine("push_device", { answer: "Work laptop", host: "fcm.googleapis.com" } as LogFields, T0, ROUTES)).toEqual({ ...BASE, ev: "push_device", answer: null });
  });

  test("no other event holds a host or a status, even when one is passed", () => {
    for (const ev of ["claude_start", "turn_end", "bash", "side", "trust", "bg_stop", "bg_list", "error"] as const) {
      const line = logLine(ev, { host: "fcm.googleapis.com", status: 201 } as LogFields, T0, ROUTES) as unknown as Record<string, unknown>;
      expect("host" in line).toBe(false);
      expect("status" in line).toBe(false);
    }
  });
});
