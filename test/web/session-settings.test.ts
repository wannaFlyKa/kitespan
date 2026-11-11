// Row 77 on the page: Settings > Chats > "Show sessions from other apps" (on by default) and "Show sessions open in
// another app" (off by default), each with its own URL (/settings/chats/<key>): a link only marks the value, Save
// saves, and the server keeps them with the other settings (the store sends their server keys). The server filters
// the lists, so the page keeps what it says: the store remembers why a project's list is empty or short, and the
// session preview says in one line which setting hides a session, with that setting's link. A settings reply that
// changes either one reads the lists the page holds again, so a page that shows a list follows the change.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTING_KEYS } from "../../shared/route";
import type { SessionsReply } from "../../server/http/api-types";
import { act, connectWith, getState, resetState } from "../../web/state/store";
import { DEFAULT_SETTINGS } from "../../web/state/catalog";
import type { Project } from "../../web/state/types";
import { KEY_SECTION, MORE, SectionBody } from "../../web/screens/Settings";
import { HiddenLine, hiddenBy } from "../../web/screens/ProjectScreen";
import { parse } from "../../web/router";

const P: Project = { id: "k3m7q2x4ab", name: "app", folder: "/srv/work/app", branch: "", picks: {} };
const Q: Project = { id: "abcdefghij", name: "notes", folder: "/srv/work/notes", branch: "", picks: {} };
const A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const B = "0b1e2a3c-4d5e-4f60-8172-93a4b5c6d7e8";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const rowOf = (html: string, key: string) => {
  const at = html.indexOf(`data-testid="setting-${key}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</li>", at));
};
const LAPTOP = { touch: false, laptop: true, phone: false, narrow: false };
const chats = (ctx: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SectionBody, { id: "chats", ctx: { ...LAPTOP, ...ctx } as never }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A menu row reads the viewport (layout/size.ts): a laptop window with a mouse for these renders.
const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown; fetch: typeof fetch };
const own = { mm: !g.matchMedia, win: !g.window };
const realFetch = g.fetch;
beforeAll(() => {
  connectWith(null);
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.window = { innerWidth: 1100, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
});
afterAll(() => {
  if (own.mm) delete g.matchMedia;
  if (own.win) delete g.window;
  g.fetch = realFetch;
  resetState();
});
beforeEach(() => resetState({ projects: [P, Q], ready: true }));

/** A fake server: GET /api/settings and POST /api/settings answer `settings`; a session list answers from `lists`. */
function server(settings: Record<string, unknown>, lists: Record<string, SessionsReply> = {}) {
  const calls: string[] = [];
  const state = { settings: { ...settings } };
  g.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("/api/settings")) {
      if (init?.method === "POST") Object.assign(state.settings, JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ settings: state.settings, agent: null, account: null, uploads: { ok: true, path: "/tmp/u" } }), { status: 200 });
    }
    const m = /^\/api\/projects\/([a-z2-7]{10})\/sessions$/.exec(url);
    if (m) return new Response(JSON.stringify(lists[m[1]!] ?? { sessions: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, state };
}

describe("the two rows in Settings > Chats", () => {
  test("each key has its own URL under /settings/chats", () => {
    for (const key of ["sessions-from-other-apps", "sessions-open-elsewhere"] as const) {
      expect(SETTING_KEYS).toContain(key);
      expect(KEY_SECTION[key]).toBe("chats");
      const route = parse(new URL(`/settings/chats/${key}?value=on`, "http://127.0.0.1"));
      expect(route.name).toBe("setting");
      expect(route.params).toEqual({ section: "chats", key });
      expect(route.query.value).toBe("on");
    }
  });

  test("two switches, on and off by default, as the page's defaults and the server's say", () => {
    expect(DEFAULT_SETTINGS.sessionsFromOtherApps).toBe(true);
    expect(DEFAULT_SETTINGS.sessionsOpenElsewhere).toBe(false);
    const html = chats();
    const other = rowOf(html, "sessions-from-other-apps");
    const open = rowOf(html, "sessions-open-elsewhere");
    expect(text(other)).toContain("Show sessions from other apps");
    expect(text(open)).toContain("Show sessions open in another app");
    expect(other).toContain('data-on="true"');
    expect(open).toContain('data-on="false"');
    expect(other).toContain('role="switch"');
    expect(open).toContain('role="switch"');
    // One label each, no longer line on the row (principle 0): the longer words are one tap away.
    expect(other).not.toContain('class="set-help"');
    expect(open).not.toContain('class="set-help"');
    expect(other).toContain('href="/settings/chats/sessions-from-other-apps"');
    expect(open).toContain('href="/settings/chats/sessions-open-elsewhere"');
  });

  test("the row's own view says what each does", () => {
    for (const key of ["sessions-from-other-apps", "sessions-open-elsewhere"] as const) {
      expect(MORE[key]).toBeTruthy();
      expect(chats({ focusKey: key })).toContain(`data-testid="setting-more-text-${key}"`);
    }
    expect(text(chats({ focusKey: "sessions-from-other-apps" }))).toMatch(/From the terminal/);
    expect(text(chats({ focusKey: "sessions-open-elsewhere" }))).toMatch(/Continue in a copy/);
  });

  test("a link's value is marked, not saved: Not saved and Save, and nothing goes out", () => {
    const { calls } = server({});
    const off = rowOf(chats({ focusKey: "sessions-from-other-apps", urlValue: "off" }), "sessions-from-other-apps");
    expect(off).toContain('data-on="false"');
    expect(text(off)).toContain("Not saved Save");
    const on = rowOf(chats({ focusKey: "sessions-open-elsewhere", urlValue: "on" }), "sessions-open-elsewhere");
    expect(on).toContain('data-on="true"');
    expect(text(on)).toContain("Not saved Save");
    expect(getState().settings).toMatchObject({ sessionsFromOtherApps: true, sessionsOpenElsewhere: false });
    expect(calls).toEqual([]);
  });

  test("the rows show the server's values", () => {
    resetState({ projects: [P], ready: true, settings: { ...DEFAULT_SETTINGS, sessionsFromOtherApps: false, sessionsOpenElsewhere: true } });
    const html = chats();
    expect(rowOf(html, "sessions-from-other-apps")).toContain('data-on="false"');
    expect(rowOf(html, "sessions-open-elsewhere")).toContain('data-on="true"');
  });

  test("with Show sessions from other apps off there are no lists: the second switch is disabled, and its row and its link stay", () => {
    const sw = (row: string) => /<input[^>]*role="switch"[^>]*>/.exec(row)?.[0] ?? "";
    expect(sw(rowOf(chats(), "sessions-open-elsewhere"))).not.toContain("disabled");
    resetState({ projects: [P], ready: true, settings: { ...DEFAULT_SETTINGS, sessionsFromOtherApps: false } });
    const open = rowOf(chats(), "sessions-open-elsewhere");
    expect(sw(open)).toContain("disabled");
    expect(sw(rowOf(chats(), "sessions-from-other-apps"))).not.toContain("disabled");
    expect(open).toContain('href="/settings/chats/sessions-open-elsewhere"');
    // Its link still opens the row and marks it; its own view says when it applies.
    const focused = rowOf(chats({ focusKey: "sessions-open-elsewhere" }), "sessions-open-elsewhere");
    expect(focused).toContain('data-focused="true"');
    expect(text(focused)).toContain("It applies while Show sessions from other apps is on.");
  });
});

describe("the store keeps them on the host", () => {
  test("the server's values come in with the settings; absent ones keep the defaults", async () => {
    server({ "chats.sessionsFromOtherApps": false, "chats.sessionsOpenElsewhere": true });
    act.refreshSettings();
    await sleep(5);
    expect(getState().settings).toMatchObject({ sessionsFromOtherApps: false, sessionsOpenElsewhere: true });
    server({});
    act.refreshSettings();
    await sleep(5);
    expect(getState().settings).toMatchObject({ sessionsFromOtherApps: true, sessionsOpenElsewhere: false });
  });

  test("Save sends each one under its server key", async () => {
    const { calls, state } = server({});
    act.setSetting("sessionsFromOtherApps", false);
    act.setSetting("sessionsOpenElsewhere", true);
    await sleep(5);
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /api/settings", "POST /api/settings"]);
    expect(state.settings).toEqual({ "chats.sessionsFromOtherApps": false, "chats.sessionsOpenElsewhere": true });
    expect(getState().settings).toMatchObject({ sessionsFromOtherApps: false, sessionsOpenElsewhere: true });
  });
});

describe("the lists follow the server's filter", () => {
  test("the store keeps why a list is empty or short", async () => {
    server({}, { [P.id]: { sessions: [], hidden: "all" }, [Q.id]: { sessions: [{ sessionId: B, title: "Closed", lastModified: 1 }], hiddenOpen: [A] } });
    await act.loadSessions(P.id);
    await act.loadSessions(Q.id);
    expect(getState().sessions).toEqual({ [P.id]: [], [Q.id]: [{ sessionId: B, title: "Closed", lastModified: 1 }] });
    expect(getState().sessionsHidden).toEqual({ [P.id]: { all: true, open: [] }, [Q.id]: { all: false, open: [A] } });
    // A reply with neither field hides nothing.
    server({}, { [P.id]: { sessions: [{ sessionId: A, title: "Open", lastModified: 2, open: { app: "terminal", busy: false } }] } });
    await act.loadSessions(P.id);
    expect(getState().sessionsHidden[P.id]).toEqual({ all: false, open: [] });
  });

  test("a save that changes either setting reads every list the page holds again; another save reads none", async () => {
    const { calls } = server({}, { [P.id]: { sessions: [{ sessionId: B, title: "Closed", lastModified: 1 }] }, [Q.id]: { sessions: [] } });
    act.refreshSettings();
    await sleep(5);
    await act.loadSessions(P.id);
    await act.loadSessions(Q.id);
    const lists = () => calls.filter((c) => /\/sessions$/.test(c));
    expect(lists()).toHaveLength(2);
    act.setSetting("liveChats", 12);
    await sleep(5);
    expect(lists()).toHaveLength(2);
    act.setSetting("sessionsFromOtherApps", false);
    await sleep(5);
    expect(lists().slice(2).sort()).toEqual([`GET /api/projects/${P.id}/sessions`, `GET /api/projects/${Q.id}/sessions`].sort());
    act.setSetting("sessionsOpenElsewhere", true);
    await sleep(5);
    expect(lists()).toHaveLength(6);
  });

  test("a change made on another page comes with the next settings read, and the lists follow it", async () => {
    const { calls, state } = server({}, { [P.id]: { sessions: [] } });
    act.refreshSettings();
    await sleep(5);
    await act.loadSessions(P.id);
    state.settings["chats.sessionsOpenElsewhere"] = true;
    act.refreshSettings();
    await sleep(5);
    expect(calls.filter((c) => /\/sessions$/.test(c))).toHaveLength(2);
  });
});

describe("the preview of a session that a setting hides", () => {
  test("which setting hides it: all sessions, or this one because it is open in another app", () => {
    expect(hiddenBy(undefined, A)).toBe(null);
    expect(hiddenBy({ all: true, open: [] }, A)).toBe("all");
    expect(hiddenBy({ all: false, open: [A] }, A)).toBe("open");
    expect(hiddenBy({ all: false, open: [A] }, B)).toBe(null);
  });

  test("one line each, with the setting's link", () => {
    const all = renderToStaticMarkup(createElement(HiddenLine, { why: "all" }));
    expect(text(all)).toBe("Show sessions from other apps is off in Settings, so this session does not show here.");
    expect(all).toContain('href="/settings/chats/sessions-from-other-apps"');
    const open = renderToStaticMarkup(createElement(HiddenLine, { why: "open" }));
    expect(text(open)).toBe("Another app has this session open now, and Show sessions open in another app is off in Settings, so it does not show here.");
    expect(open).toContain('href="/settings/chats/sessions-open-elsewhere"');
  });
});
