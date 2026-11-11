// Settings > About's update rows on the page (owner row 108; DESIGN.md 4.10, 5.2, 6.8): Check for updates with its
// three choices (Manually, Daily, Every 3 hours), the server's value, Daily until it answers; its own URL, where a
// link's value is a draft until Save; Check now with the time of the last check and why it could not look; the update's
// confirm at /settings/about/update, whose Update button alone acts; each request (Check now, Update, the setting) is
// sent only from its own call and recorded; the update notice's line is About's own row, not a second line there
// (react-dom/server, a fake fetch). The notice on the other screens: update-line.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingsReply, UpdateReply } from "../../server/http/api-types";
import { checkedLine, failedLine, runningLine, UPDATE_REFUSAL_LINES, UPDATE_WORDS } from "../../shared/update";
import { act, resetState } from "../../web/state/store";
import { SectionBody, SettingsLine } from "../../web/screens/Settings";
import { parse } from "../../web/router";
import { checkNow, checkSettingOf, checkValueOf, getUpdateState, originNotice, resetUpdateState, saveCheckSetting, setUpdateState, startUpdate } from "../../web/update/state";
import { UpdateBody, UpdateDialog } from "../../web/update/UpdateDialog";
import { acted, doublePress, inRender } from "./presses";
import { UpdateLine } from "../../web/update/UpdateLine";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);

const LAPTOP = { touch: false, laptop: true, phone: false, narrow: false };
const about = (ctx: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SectionBody, { id: "about", ctx: { ...LAPTOP, ...ctx } }));
const row = (html: string, id: string) => {
  const at = html.indexOf(`data-testid="${id}"`);
  return at < 0 ? "" : html.slice(at, html.indexOf("</li>", at));
};
const facts = (p: Partial<UpdateReply> = {}): UpdateReply => ({ update: "none", build: "none", check: { at: null, ok: true, why: null, running: false }, job: { state: "idle" }, can: true, kind: "checkout", latest: null, next: null, ...p });

function hostWith(settings: Record<string, unknown>): SettingsReply {
  return {
    settings,
    server: { host: "127.0.0.1", port: 7946, auth: "none", version: "0.4.0" },
    access: { origins: [], hint: [] },
    adaptersProblem: null,
    phoneNotes: [],
    claude: { ok: true, path: null, realpath: null, version: null, drift: null },
    uploads: { ok: true, path: "/tmp/x" },
    agent: null,
    account: null,
    facts: null,
  };
}

type Call = { method: string; path: string; body: unknown; headers: Record<string, string> };
const gm = globalThis as unknown as { matchMedia?: unknown; window?: { __kitespanFrames?: { t: string }[] } & Record<string, unknown>; fetch: typeof fetch };
const own = { mm: !gm.matchMedia, win: !gm.window, fetch: gm.fetch };
let calls: Call[] = [];
let answer: (c: Call) => Response = () => new Response("{}", { status: 200 });
beforeAll(() => {
  gm.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  gm.window ??= { innerWidth: 1100, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  gm.fetch = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { method: String(init.method ?? "GET"), path: String(url), body: init.body ? JSON.parse(String(init.body)) : null, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as unknown as typeof fetch;
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  gm.fetch = own.fetch;
  resetUpdateState();
  resetState();
});
beforeEach(() => {
  resetState({ ready: true });
  resetUpdateState();
  calls = [];
  if (gm.window) gm.window.__kitespanFrames = [];
});

describe("Check for updates (row 108)", () => {
  test("three choices with kitespan's words; Daily until the server's settings answer; then the server's value", () => {
    let r = row(about(), "setting-check-for-updates");
    expect(text(r)).toContain("Check for updates");
    for (const w of ["Manually", "Daily", "Every 3 hours"]) expect(text(r)).toContain(w);
    expect(text(r)).not.toMatch(/stable|latest/i);
    expect(r).toMatch(/aria-checked="true"[^>]*>(<[^>]+>)*Daily/);
    resetState({ ready: true, host: hostWith({ "updates.check": "3h" }) });
    r = row(about(), "setting-check-for-updates");
    expect(r).toMatch(/aria-checked="true"[^>]*>(<[^>]+>)*Every 3 hours/);
    expect(checkSettingOf({ "updates.check": "manual" })).toBe("manual");
    expect(checkSettingOf({ "updates.check": "stable" })).toBe("daily");
    expect(checkSettingOf(null)).toBe("daily");
  });

  test("its own URL: the row is focused; a link's value is a draft, shown with Save and not saved; a bad value says so", () => {
    const route = parse(new URL("/settings/about/check-for-updates?value=manual", "http://127.0.0.1"));
    expect(route.name).toBe("setting");
    expect(route.params).toMatchObject({ section: "about", key: "check-for-updates" });
    const html = about({ focusKey: "check-for-updates", urlValue: "manual" });
    const r = row(html, "setting-check-for-updates");
    expect(r).toContain('data-focused="true"');
    expect(r).toMatch(/aria-checked="true"[^>]*>(<[^>]+>)*Manually/);
    expect(text(r)).toContain("Not saved Save");
    expect(ids(r)).toContain("confirm-save");
    expect(calls).toEqual([]);
    expect(text(row(about({ focusKey: "check-for-updates", urlValue: "hourly" }), "setting-check-for-updates"))).toContain("Part of that link could not be read.");
    // Its longer words are one tap away.
    expect(ids(about())).toContain("setting-more-check-for-updates");
    expect(ids(about({ focusKey: "check-for-updates" }))).toContain("setting-more-text-check-for-updates");
    expect(checkValueOf("every-3-hours")).toBe("3h");
    expect(checkValueOf("Manually")).toBe("manual");
    expect(checkValueOf("weekly")).toBeNull();
  });

  test("a choice is saved with one POST /api/settings of its one key; the server's value stands until the next read", async () => {
    answer = (c) => new Response(JSON.stringify(hostWith({ "updates.check": (c.body as Record<string, unknown>)["updates.check"] })), { status: 200 });
    expect(await saveCheckSetting("3h")).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/api/settings", body: { "updates.check": "3h" }, headers: expect.objectContaining({ "x-kitespan": "1" }) }]);
    expect(gm.window!.__kitespanFrames!.map((f) => f.t)).toEqual(["POST /api/settings"]);
    expect(getUpdateState().saved).toBe("3h");
    expect(row(about(), "setting-check-for-updates")).toMatch(/aria-checked="true"[^>]*>(<[^>]+>)*Every 3 hours/);
  });
});

describe("Check now (row 108)", () => {
  test("in every mode: Not checked yet, then Checked 2 h ago; why it could not look; a failed check; Checking...", () => {
    for (const mode of ["manual", "daily", "3h"]) {
      resetState({ ready: true, host: hostWith({ "updates.check": mode }) });
      expect(ids(about())).toContain("check-now");
    }
    expect(text(row(about(), "setting-check-now"))).toContain("Not checked yet. Check now");
    const twoHours = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    setUpdateState({ facts: facts({ check: { at: twoHours, ok: true, why: null, running: false } }) });
    expect(text(row(about(), "setting-check-now"))).toContain("Checked 2 h ago. Check now");
    setUpdateState({ facts: facts({ check: { at: twoHours, ok: true, why: "no_upstream", running: false } }) });
    expect(text(row(about(), "setting-check-now"))).toContain(`Checked 2 h ago. ${UPDATE_REFUSAL_LINES.no_upstream}`);
    setUpdateState({ facts: facts({ check: { at: twoHours, ok: false, why: null, running: false } }) });
    expect(text(row(about(), "setting-check-now"))).toContain("Checked 2 h ago. The check did not finish.");
    setUpdateState({ facts: facts({ check: { at: twoHours, ok: true, why: null, running: true } }) });
    const r = row(about(), "setting-check-now");
    expect(text(r)).toContain("Checking...");
    expect(r).toMatch(/<button[^>]*disabled=""[^>]*data-testid="check-now"|<button[^>]*data-testid="check-now"[^>]*disabled=""/);
    const now = Date.parse("2026-11-04T09:00:00Z");
    expect(checkedLine("2026-11-04T08:59:40Z", now)).toBe("Checked just now.");
    expect(checkedLine("2026-11-04T08:30:00Z", now)).toBe("Checked 30 min ago.");
    expect(checkedLine("2026-11-02T09:00:00Z", now)).toBe("Checked 2 d ago.");
  });

  test("Check now is one POST /api/update/check; its answer is About's facts", async () => {
    const at = new Date().toISOString();
    answer = () => new Response(JSON.stringify(facts({ update: "available", check: { at, ok: true, why: null, running: false } })), { status: 200 });
    await checkNow();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/update/check"]);
    expect(getUpdateState().facts?.update).toBe("available");
    expect(text(row(about(), "setting-check-now"))).toContain("Checked just now.");
    expect(ids(about())).toContain("update-open");
  });
});

describe("Update and its confirm (row 108)", () => {
  test("the confirm: one line that kitespan keeps running, Cancel and Update; a refusal is its one line", () => {
    const body = (line: string | null, sheet = false) => renderToStaticMarkup(createElement(UpdateBody, { line, sending: false, sheet, onUpdate: () => {}, onClose: () => {} }));
    expect(text(body(null))).toContain(`${UPDATE_WORDS.dialogLine} Cancel Update`);
    expect(ids(body(null))).toEqual(["confirm-update"]);
    expect(text(body("This checkout has local changes."))).toContain("This checkout has local changes.");
    expect(text(body(null, true))).not.toContain("Cancel");
    const route = parse(new URL("/settings/about/update", "http://127.0.0.1"));
    expect(route.name).toBe("setting");
    expect(route.params).toMatchObject({ section: "about", key: "update" });
  });

  test("Update is one POST /api/update: 202 runs (or joins) the job; 409 keeps the server's line", async () => {
    setUpdateState({ facts: facts({ update: "available" }) });
    answer = (c) => (c.method === "POST" ? new Response(JSON.stringify({ job: { state: "running", step: "fetch" } }), { status: 202 }) : new Response(JSON.stringify(facts({ job: { state: "running", step: "fetch" } })), { status: 200 }));
    expect(await startUpdate()).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/update", body: {} });
    expect(getUpdateState().facts?.job).toEqual({ state: "running", step: "fetch" });
    expect(text(about())).toContain(runningLine("fetch"));
    calls = [];
    answer = () => new Response(JSON.stringify({ error: { code: "update_refused", message: "This checkout has local changes." } }), { status: 409 });
    expect(await startUpdate()).toBe(false);
    expect(getUpdateState().line).toBe("This checkout has local changes.");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/update"]);
  });

  test("a double press is one press: a quick 202 can close the confirm between the two; the second click is swallowed, a later press acts", async () => {
    setUpdateState({ facts: facts({ update: "available" }) });
    answer = (c) => (c.method === "POST" ? new Response(JSON.stringify({ job: { state: "running", step: "fetch" } }), { status: 202 }) : new Response(JSON.stringify(facts()), { status: 200 }));
    // The 202 closes the confirm back to About (closeTo reads the router's history and address).
    const g = globalThis as Record<string, unknown>;
    const had = { history: g.history, location: g.location };
    const went: string[] = [];
    g.history = { state: null, replaceState: (_s: unknown, _t: string, u: string) => void went.push(u), pushState: () => {}, go: () => {}, back: () => {} };
    g.location = { pathname: "/settings/about/update", search: "" };
    try {
      const confirm = inRender(() => UpdateDialog()) as ReactElement<{ children: ReactElement<{ onUpdate: () => void }> }>;
      const { second, later } = doublePress(confirm.props.children.props.onUpdate);
      expect([acted(second), acted(later)]).toEqual([false, true]);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/update"]);
      await new Promise((r) => setTimeout(r, 0));
      expect(went).toEqual(["/settings/about"]);
    } finally {
      for (const [k, v] of Object.entries(had)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    }
  });

  test("drawing About sends nothing: no read, no check and no update starts from a render", () => {
    setUpdateState({ facts: facts({ update: "available" }) });
    about({ focusKey: "update" });
    about({ focusKey: "check-for-updates", urlValue: "3h" });
    expect(calls).toEqual([]);
  });

  test("the update notice as one line: its words, with Update only when the notice offers it", () => {
    const line = (n: { text: string; actions: "update"[] } | null, foot = true) => {
      resetState({ ready: true, updateNotice: n });
      return renderToStaticMarkup(createElement(UpdateLine, { foot }));
    };
    expect(line(null)).toBe("");
    // Origin's standing line only in the chat list's foot (principle 0).
    expect(line({ text: "Update available.", actions: ["update"] }, false)).toBe("");
    const offered = line({ text: "Update available.", actions: ["update"] });
    expect(text(offered)).toContain("Update available. Update");
    expect(offered).toContain('href="/settings/about/update"');
    const step = line({ text: runningLine("build"), actions: [] });
    expect(text(step)).toContain(runningLine("build"));
    expect(ids(step)).toEqual(["update-line"]);
  });

  test("the update notice's line is About's own row there, and the section's line elsewhere (with no docked sidebar)", () => {
    expect(originNotice("available")).toEqual({ text: UPDATE_WORDS.availableNotice, actions: ["update"] });
    expect(originNotice("diverged")).toEqual({ text: UPDATE_REFUSAL_LINES.diverged, actions: [] });
    expect(originNotice("none")).toBeNull();
    resetState({ ready: true, updateNotice: { text: runningLine("install"), actions: [] } });
    const route = parse(new URL("/settings/about", "http://127.0.0.1"));
    expect(text(renderToStaticMarkup(createElement(SettingsLine, { route, section: "about", ctx: { ...LAPTOP } })))).not.toContain("Updating kitespan");
    const general = parse(new URL("/settings/general", "http://127.0.0.1"));
    // This file's window is 1,100 px wide: the sidebar docks, and its foot has the line.
    expect(text(renderToStaticMarkup(createElement(SettingsLine, { route: general, section: "general", ctx: { ...LAPTOP } })))).not.toContain("Updating kitespan");
    // A refused save's line is the section's notice, as before.
    act.setNotice(failedLine("build"));
    expect(text(renderToStaticMarkup(createElement(SettingsLine, { route: general, section: "general", ctx: { ...LAPTOP } })))).toContain(failedLine("build"));
  });
});
