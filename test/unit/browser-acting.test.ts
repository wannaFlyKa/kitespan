// "Claude is acting" from the stream (DESIGN-B1 2.13), tabs.json (2.8) and the downloads' records (2.12). The result
// texts are Playwright MCP 0.0.84's own, as B1's SERVER lane logged them (its s4-mcp log, the lines restored).

import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Acting, matchTab, resultTab, type ActingFact } from "../../server/browser/acting";
import { Downloads, downloadName, downloadRecordOf } from "../../server/browser/downloads";
import { TabsFileStore, savedSizeOf, tabsFileOf } from "../../server/browser/tabs";
import type { BrowserActing } from "../../shared/browser";
import type { ChatEvent } from "../../shared/protocol";

const CHAT = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "m7q2x4abk3m7q2x4abk3";

const TABS_LIST = `### Result
- 0: (current) [](about:blank)
- 1: [s4 user /userA](http://127.0.0.1:7948/userA)
- 2: [s4 user /userB](http://127.0.0.1:7948/userB)`;
const NAVIGATE = `### Ran Playwright code
\`\`\`js
await page.goto('http://127.0.0.1:7948/c');
\`\`\`
### Open tabs
- 0: (current) [s4 page C](http://127.0.0.1:7948/c)
- 1: [s4 user /userA](http://127.0.0.1:7948/userA)
- 2: [s4 user /userB](http://127.0.0.1:7948/userB)
- 3: [](about:blank)
- 4: [s4 user /claudeNew](http://127.0.0.1:7948/claudeNew)
### Page
- Page URL: http://127.0.0.1:7948/c
- Page Title: s4 page C
### Snapshot
- [Snapshot](page-2026-11-09T09-10-45-975Z.yml)`;
const SNAPSHOT_ONLY_PAGE = `### Page
- Page URL: http://127.0.0.1:7948/c
- Page Title: confirm=false
### Snapshot
\`\`\`yaml
- generic [ref=e1]:
  - button "Alert" [ref=e2]
\`\`\``;
const MODAL = `### Error
Error: Tool "browser_snapshot" does not handle the modal state.
### Modal state
- [File chooser]: can be handled by browser_file_upload`;

describe("the tab a result names", () => {
  test("the (current) line of Open tabs or Result, a title that holds brackets, else the Page section", () => {
    expect(resultTab(TABS_LIST)).toEqual({ title: "", url: "about:blank" });
    expect(resultTab(NAVIGATE)).toEqual({ title: "s4 page C", url: "http://127.0.0.1:7948/c" });
    expect(resultTab(SNAPSHOT_ONLY_PAGE)).toEqual({ url: "http://127.0.0.1:7948/c", title: "confirm=false" });
    expect(resultTab("### Open tabs\n- 0: (current) [a [b] ](c)](https://x.test/p?q=(1))")).toEqual({ title: "a [b] ](c)", url: "https://x.test/p?q=(1)" });
    expect(resultTab(MODAL)).toBeNull();
    expect(resultTab("")).toBeNull();
    expect(resultTab("some future format\n- 0: (current) [t](https://a/)")).toBeNull();
  });
  test("matched by URL, then by title; two matches or none give no tab", () => {
    const tabs = [
      { id: "aaaaaaaaaa", url: "http://127.0.0.1:7948/c", title: "s4 page C" },
      { id: "bbbbbbbbbb", url: "http://127.0.0.1:7948/userA", title: "A" },
      { id: "cccccccccc", url: "http://127.0.0.1:7948/userA", title: "A twin" },
      { id: "dddddddddd", url: "https://other/", title: "same" },
      { id: "eeeeeeeeee", url: "https://other2/", title: "same" },
    ];
    expect(matchTab({ url: "http://127.0.0.1:7948/c", title: "" }, tabs)).toBe("aaaaaaaaaa");
    expect(matchTab({ url: "http://127.0.0.1:7948/userA", title: "A twin" }, tabs)).toBe("cccccccccc");
    expect(matchTab({ url: "http://127.0.0.1:7948/userA", title: "" }, tabs)).toBeNull();
    expect(matchTab({ url: "https://moved/", title: "s4 page C" }, tabs)).toBe("aaaaaaaaaa");
    expect(matchTab({ url: "https://moved/", title: "same" }, tabs)).toBeNull();
    expect(matchTab({ url: "https://moved/", title: "" }, tabs)).toBeNull();
  });
});

describe("the acting list and its facts", () => {
  const tabs = [
    { id: "aaaaaaaaaa", url: "http://127.0.0.1:7948/c", title: "s4 page C" },
    { id: "bbbbbbbbbb", url: "http://127.0.0.1:7948/userA", title: "s4 user /userA" },
  ];
  const make = () => {
    const lists: BrowserActing[][] = [];
    const facts: ActingFact[] = [];
    const a = new Acting({ tabs: () => tabs, onChange: (l) => lists.push(l), onFact: (f) => facts.push(f), now: () => new Date("2026-11-09T10:00:00.000Z") });
    const call = (chat: string, id: string, name: string, input: unknown = {}): ChatEvent => ({ k: "tool_call", id, name, input, parent: null });
    const result = (id: string, text: string, isError = false): ChatEvent => ({ k: "tool_result", id, text, isError, parent: null, report: null });
    return { a, lists, facts, call, result };
  };
  test("a playwright call lights it, its result names the tab and puts it out; ToolSearch and other servers never count", () => {
    const { a, lists, facts, call, result } = make();
    a.event(CHAT, call(CHAT, "t0", "ToolSearch"));
    a.event(CHAT, call(CHAT, "t1", "mcp__other__browser_click"));
    expect(lists).toEqual([]);
    a.event(CHAT, call(CHAT, "t2", "mcp__playwright__browser_navigate", null));
    expect(a.list()).toEqual([{ chat: CHAT, tool: "browser_navigate", tab: null, since: "2026-11-09T10:00:00.000Z" }]);
    a.event(CHAT, call(CHAT, "t2", "mcp__playwright__browser_navigate", { url: "http://127.0.0.1:7948/c" }));
    expect(lists.length).toBe(1);
    a.event(CHAT, result("t2", NAVIGATE));
    expect(a.list()).toEqual([]);
    expect(facts).toContainEqual({ k: "named", chat: CHAT, tab: "aaaaaaaaaa" });
    expect(a.lastOf("aaaaaaaaaa")).toBe(CHAT);
    // The next call's tab is the chat's last uniquely named tab (but navigate, tabs and close stay unknown).
    a.event(CHAT, call(CHAT, "t3", "mcp__playwright__browser_click"));
    expect(a.list()[0]!.tab).toBe("aaaaaaaaaa");
    a.event(CHAT, call(CHAT, "t4", "mcp__playwright__browser_tabs"));
    expect(a.list()[1]!.tab).toBeNull();
    expect(a.actsIn("aaaaaaaaaa")).toBe(true);
    expect(a.actsIn("bbbbbbbbbb")).toBe(false);
  });
  test("tool_stopped removes one call; turn_end and exit clear the chat; the last tab counts only while its turn runs", () => {
    const { a, call, result } = make();
    a.event(CHAT, call(CHAT, "t1", "mcp__playwright__browser_snapshot"));
    a.event(CHAT, result("t1", NAVIGATE));
    a.event(CHAT, call(CHAT, "t2", "mcp__playwright__browser_click"));
    a.event(OTHER, call(OTHER, "o1", "mcp__playwright__browser_click"));
    a.event(CHAT, { k: "tool_stopped", id: "t2", parent: null });
    expect(a.list().map((x) => x.chat)).toEqual([OTHER]);
    expect(a.actsIn("aaaaaaaaaa")).toBe(true);
    a.event(CHAT, { k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] });
    expect(a.actsIn("aaaaaaaaaa")).toBe(false);
    expect(a.lastOf("aaaaaaaaaa")).toBe(CHAT);
    a.event(OTHER, { k: "exit", code: 0, signal: null, stderr: [] });
    expect(a.list()).toEqual([]);
  });
  test("the facts: browser_resize's size, browser_file_upload with or without paths, a running browser_handle_dialog", () => {
    const { a, facts, call, result } = make();
    a.event(CHAT, call(CHAT, "t1", "mcp__playwright__browser_snapshot"));
    a.event(CHAT, result("t1", NAVIGATE));
    a.event(CHAT, call(CHAT, "r1", "mcp__playwright__browser_resize", { width: 390, height: 844 }));
    a.event(CHAT, result("r1", SNAPSHOT_ONLY_PAGE));
    a.event(CHAT, call(CHAT, "u1", "mcp__playwright__browser_file_upload", { paths: ["/tmp/a.txt"] }));
    a.event(CHAT, result("u1", NAVIGATE));
    a.event(CHAT, call(CHAT, "u2", "mcp__playwright__browser_file_upload", {}));
    a.event(CHAT, result("u2", NAVIGATE));
    a.event(CHAT, call(CHAT, "u3", "mcp__playwright__browser_file_upload", { paths: ["/x"] }));
    a.event(CHAT, result("u3", MODAL, true));
    expect(facts.filter((f) => f.k === "resized" || f.k === "uploaded")).toEqual([
      { k: "resized", chat: CHAT, tab: "aaaaaaaaaa", w: 390, h: 844 },
      { k: "uploaded", chat: CHAT, tab: "aaaaaaaaaa", paths: true },
      { k: "uploaded", chat: CHAT, tab: "aaaaaaaaaa", paths: false },
    ]);
    a.event(CHAT, call(CHAT, "d1", "mcp__playwright__browser_handle_dialog", { accept: true }));
    expect(a.running("aaaaaaaaaa", "browser_handle_dialog")).toBe(true);
    expect(a.running("aaaaaaaaaa", "browser_click")).toBe(false);
    expect(a.running("aaaaaaaaaa")).toBe(true);
    expect(a.running("bbbbbbbbbb", "browser_handle_dialog")).toBe(false);
  });
  test("whose call runs on a tab (a chooser's and a dialog's by): a navigate, tabs or close call of a chat whose last tab is another tab counts for no other tab; with no tab known yet, for any; a call on the tab itself comes first", () => {
    const { a, call, result } = make();
    const [A, B] = ["aaaaaaaaaa", "bbbbbbbbbb"];
    a.event(CHAT, call(CHAT, "n0", "mcp__playwright__browser_navigate"));
    expect([a.running(A), a.running(B), a.runner(B)]).toEqual([true, true, CHAT]);
    a.event(CHAT, result("n0", NAVIGATE));
    for (const tool of ["browser_navigate", "browser_tabs", "browser_close"]) {
      a.event(CHAT, call(CHAT, tool, `mcp__playwright__${tool}`));
      expect([tool, a.list().at(-1)!.tab, a.running(A), a.running(B), a.runner(B)]).toEqual([tool, null, true, false, null]);
      a.event(CHAT, { k: "tool_stopped", id: tool, parent: null });
    }
    // A call of another kind whose chat knows no tab yet runs on an unknown tab: any tab.
    a.event(OTHER, call(OTHER, "o1", "mcp__playwright__browser_snapshot"));
    expect([a.running(B), a.runner(B), a.runner(A)]).toEqual([true, OTHER, OTHER]);
    // A call on the tab itself names its chat before a call on an unknown tab.
    a.event(CHAT, call(CHAT, "c1", "mcp__playwright__browser_click"));
    expect([a.runner(A), a.runner(B)]).toEqual([CHAT, OTHER]);
    expect([a.runner(A, "browser_snapshot"), a.runner(A, "browser_handle_dialog")]).toEqual([OTHER, null]);
  });
  test("a resize sent with the navigate in one message (the lead's live run 4): its result names no page, so its tab is the chat's last named tab when the result comes", () => {
    const { a, facts, call, result } = make();
    a.event(CHAT, call(CHAT, "n1", "mcp__playwright__browser_navigate"));
    a.event(CHAT, call(CHAT, "r1", "mcp__playwright__browser_resize", { width: 900, height: 700 }));
    expect(a.list().map((x) => x.tab)).toEqual([null, null]);
    a.event(CHAT, result("n1", NAVIGATE));
    a.event(CHAT, result("r1", "### Ran Playwright code\n```js\nawait page.setViewportSize({ width: 900, height: 700 });\n```"));
    expect(facts.filter((f) => f.k === "resized")).toEqual([{ k: "resized", chat: CHAT, tab: "aaaaaaaaaa", w: 900, h: 700 }]);
    expect(facts.filter((f) => f.k === "result").map((f) => f.tab)).toEqual(["aaaaaaaaaa", "aaaaaaaaaa"]);
  });
  test("a chat's first browser call is a resize whose result names no page: its size names no tab (the relay then sets none)", () => {
    const { a, facts, call, result } = make();
    a.event(CHAT, call(CHAT, "r1", "mcp__playwright__browser_resize", { width: 900, height: 700 }));
    a.event(CHAT, result("r1", "### Ran Playwright code\n```js\nawait page.setViewportSize({ width: 900, height: 700 });\n```"));
    expect(facts.filter((f) => f.k === "resized")).toEqual([{ k: "resized", chat: CHAT, tab: null, w: 900, h: 700 }]);
  });
  test("a resize whose width or height is not a finite number tells no size", () => {
    const { a, facts, call, result } = make();
    a.event(CHAT, call(CHAT, "r1", "mcp__playwright__browser_resize", { width: Number.NaN, height: 700 }));
    a.event(CHAT, result("r1", NAVIGATE));
    a.event(CHAT, call(CHAT, "r2", "mcp__playwright__browser_resize", { width: "900", height: 700 }));
    a.event(CHAT, result("r2", NAVIGATE));
    expect(facts.filter((f) => f.k === "resized")).toEqual([]);
  });
});

describe("the tab mark: the chat whose result named the tab most recently (DESIGN-B1 2.13; the live run's D2)", () => {
  const C = "aaaaaaaaaa";
  const A = "bbbbbbbbbb";
  const tabs = [
    { id: C, url: "http://127.0.0.1:7948/c", title: "s4 page C" },
    { id: A, url: "http://127.0.0.1:7948/userA", title: "s4 user /userA" },
  ];
  const ON_A = "### Page\n- Page URL: http://127.0.0.1:7948/userA\n- Page Title: s4 user /userA";
  const THIRD = "q2x4abk3m7q2x4abk3m7";
  const make = () => {
    const facts: ActingFact[] = [];
    const lists: BrowserActing[][] = [];
    const a = new Acting({ tabs: () => tabs, onChange: (l) => lists.push(l), onFact: (f) => facts.push(f) });
    /** One browser call of `chat` and its result. */
    const used = (chat: string, id: string, text: string, tool = "browser_snapshot") => {
      a.event(chat, { k: "tool_call", id, name: `mcp__playwright__${tool}`, input: {}, parent: null });
      a.event(chat, { k: "tool_result", id, text, isError: false, parent: null, report: null });
    };
    const turnEnd = (chat: string) => a.event(chat, { k: "turn_end", ok: true, subtype: "success", durationMs: 1, error: null, uuids: [] });
    return { a, facts, lists, used, turnEnd };
  };
  test("a later chat's result on the tab takes the mark, and an older chat's newer result takes it back", () => {
    const { a, used, turnEnd } = make();
    used(CHAT, "a1", NAVIGATE, "browser_navigate");
    turnEnd(CHAT);
    expect(a.lastOf(C)).toBe(CHAT);
    used(OTHER, "b1", NAVIGATE, "browser_navigate");
    expect(a.lastOf(C)).toBe(OTHER);
    used(THIRD, "c1", NAVIGATE);
    expect(a.lastOf(C)).toBe(THIRD);
    used(CHAT, "a2", NAVIGATE);
    expect(a.lastOf(C)).toBe(CHAT);
    // A result that names another tab moves that chat's mark only: the newest of the others keeps tab C.
    used(CHAT, "a3", ON_A);
    expect([a.lastOf(C), a.lastOf(A)]).toEqual([THIRD, CHAT]);
    // A result that names no tab moves no mark.
    used(THIRD, "c2", MODAL);
    expect(a.lastOf(C)).toBe(THIRD);
  });
  test("a chat's mark goes when its process ends (exit) or the registry says the chat ended (archived, deleted, its process closed): the newest remaining chat keeps it, or none", () => {
    const { a, facts, used, turnEnd } = make();
    used(CHAT, "a1", NAVIGATE);
    used(OTHER, "b1", NAVIGATE);
    used(THIRD, "c1", NAVIGATE);
    // A turn's end keeps the mark.
    turnEnd(THIRD);
    expect(a.lastOf(C)).toBe(THIRD);
    a.event(THIRD, { k: "exit", code: 0, signal: null, stderr: [] });
    expect(a.lastOf(C)).toBe(OTHER);
    expect(facts).toContainEqual({ k: "forgot", chat: THIRD });
    a.ended(OTHER);
    expect(a.lastOf(C)).toBe(CHAT);
    expect(facts).toContainEqual({ k: "forgot", chat: OTHER });
    a.ended(CHAT);
    expect(a.lastOf(C)).toBeNull();
    // Each word of an end tells the relay that the chat ended (its size and its chooser go); the mark goes once only.
    const n = facts.length;
    a.ended(CHAT);
    a.event(CHAT, { k: "exit", code: 0, signal: null, stderr: [] });
    expect(facts.slice(n)).toEqual([
      { k: "ended", chat: CHAT },
      { k: "ended", chat: CHAT },
    ]);
    expect(facts.filter((f) => f.k === "forgot")).toEqual([
      { k: "forgot", chat: THIRD },
      { k: "forgot", chat: OTHER },
      { k: "forgot", chat: CHAT },
    ]);
    expect(facts.filter((f) => f.k === "ended").map((f) => f.chat)).toEqual([THIRD, OTHER, CHAT, CHAT, CHAT]);
  });
  test("an ended chat's running calls go out too, and a result that comes after it was ended marks nothing", () => {
    const { a, lists } = make();
    a.event(CHAT, { k: "tool_call", id: "a1", name: "mcp__playwright__browser_click", input: {}, parent: null });
    expect(a.list().length).toBe(1);
    a.ended(CHAT);
    expect(a.list()).toEqual([]);
    expect(lists.at(-1)).toEqual([]);
    expect(a.actsIn(C)).toBe(false);
    a.event(CHAT, { k: "tool_result", id: "a1", text: NAVIGATE, isError: false, parent: null, report: null });
    expect(a.lastOf(C)).toBeNull();
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const dirOf = () => {
  const d = mkdtempSync(join(tmpdir(), "kba-"));
  roots.push(d);
  return d;
};

describe("tabs.json (DESIGN-B1 2.8)", () => {
  const R = { origins: ["http://127.0.0.1:7945"], loopbackPorts: [7945, 9340] };
  const tab = (over: Record<string, unknown> = {}) => ({ id: "aaaaaaaaaa", target: "A".repeat(32), url: "https://example.com/a?b=c", title: "Example", by: "user", at: "2026-11-09T09:00:00.000Z", size: { kind: "desktop" }, ...over });
  test("only http and https tabs through the URL rule, each id once, at most 50; a bad tab is dropped, the rest kept", () => {
    const f = tabsFileOf(
      {
        v: 1,
        browserStart: "1@x",
        spare: "B".repeat(32),
        tabs: [
          tab(),
          tab({ id: "bbbbbbbbbb", url: "http://127.0.0.1:7945/c/x" }),
          tab({ id: "cccccccccc", url: "file:///etc/passwd" }),
          tab({ id: "dddddddddd", url: "http://localhost:9340/json" }),
          tab({ id: "aaaaaaaaaa" }),
          tab({ id: "eeeeeeeeee", target: "../x" }),
          tab({ id: "ffffffffff", by: "claude" }),
          tab({ id: "gggggggggg", title: "t".repeat(500), size: { kind: "phone", w: 390, h: 844 } }),
          tab({ id: "hhhhhhhhhh", size: { kind: "phone", w: 2000, h: 844 } }),
        ],
      },
      R,
    )!;
    expect(f.tabs.map((t) => t.id)).toEqual(["aaaaaaaaaa", "gggggggggg", "hhhhhhhhhh"]);
    expect(f.tabs[1]!.title.length).toBe(200);
    expect(f.tabs.map((t) => t.size)).toEqual([{ kind: "desktop" }, { kind: "phone", w: 390, h: 844 }, { kind: "desktop" }]);
    expect(f.spare).toBe("B".repeat(32));
    const many = Array.from({ length: 60 }, (_, i) => tab({ id: `${"abcdefghijklmnopqrstuvwxyz234567"[i % 32]}${"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(i / 32)]}aaaaaaaa` }));
    expect(tabsFileOf({ v: 1, browserStart: "", spare: null, tabs: many }, R)!.tabs.length).toBe(50);
    for (const bad of [null, [], { v: 2, browserStart: "", tabs: [] }, { v: 1, tabs: [] }, { v: 1, browserStart: "", tabs: {} }]) expect(tabsFileOf(bad, R)).toBeNull();
    expect(savedSizeOf({ kind: "phone", w: 320, h: 480 })).toEqual({ kind: "phone", w: 320, h: 480 });
    expect(savedSizeOf("phone")).toEqual({ kind: "desktop" });
  });
  test("`shown` (the saved tab that a pane socket viewed last, D-6 Q3): kept when it names a kept tab; else none, as in a file without it", () => {
    const file = (shown: unknown) => tabsFileOf({ v: 1, browserStart: "1@x", spare: null, tabs: [tab(), tab({ id: "cccccccccc", url: "file:///etc/passwd" })], shown }, R)!;
    expect(file("aaaaaaaaaa").shown).toBe("aaaaaaaaaa");
    for (const bad of ["cccccccccc", "zzzzzzzzzz", "AAAAAAAAAA", 7, null, undefined]) expect([bad, file(bad).shown]).toEqual([bad, null]);
  });
  test("written 0600 at most once a second; a file that fails its checks is set aside", async () => {
    const dir = dirOf();
    const store = new TabsFileStore(dir, process.getuid!(), () => R);
    store.save({ v: 1, browserStart: "1@x", spare: null, tabs: [tab() as never] });
    await store.flush();
    expect((statSync(join(dir, "tabs.json")).mode & 0o777).toString(8)).toBe("600");
    expect((await store.read())!.tabs.length).toBe(1);
    writeFileSync(join(dir, "tabs.json"), "{bad", { mode: 0o600 });
    const fresh = new TabsFileStore(dir, process.getuid!(), () => R);
    expect(await fresh.read()).toBeNull();
    expect(lstatSync(join(dir, "tabs.json.bad")).isFile()).toBe(true);
    await fresh.clear();
    expect((await fresh.read())!.tabs).toEqual([]);
  });
});

describe("downloads (DESIGN-B1 2.12)", () => {
  const GUID = "0f0e2c8c-1f4a-4c41-a3c6-6b2c1a7f0d12";
  test("a finished download: its file made 0600, a record with the cleaned name, never the URL; canceled removes it", async () => {
    const dir = dirOf();
    mkdirSync(join(dir, "downloads"), { mode: 0o700 });
    const seen: string[] = [];
    const ended: boolean[] = [];
    const d = new Downloads({ dir, uid: process.getuid!(), keepDays: async () => 7, onChange: (v) => seen.push(`${v.state}:${v.name}`), ended: (ok) => ended.push(ok) });
    d.begin(GUID, "../../etc/passwd\u202e.txt");
    writeFileSync(join(dir, "downloads", GUID), "hello", { mode: 0o644 });
    await d.progress(GUID, 2, 5, "inProgress");
    await d.progress(GUID, 5, 5, "completed");
    const [v] = d.list();
    expect(v).toMatchObject({ name: ".._.._etc_passwd_.txt", state: "completed", received: 5, total: 5 });
    expect((statSync(join(dir, "downloads", GUID)).mode & 0o777).toString(8)).toBe("600");
    expect(d.fileOf(v!.id)).toEqual({ path: join(dir, "downloads", GUID), name: ".._.._etc_passwd_.txt", size: 5 });
    expect(seen).toEqual(["progress:.._.._etc_passwd_.txt", "progress:.._.._etc_passwd_.txt", "completed:.._.._etc_passwd_.txt"]);
    const other = "1f0e2c8c-1f4a-4c41-a3c6-6b2c1a7f0d12";
    d.begin(other, "b.bin");
    writeFileSync(join(dir, "downloads", other), "x", { mode: 0o644 });
    expect(d.guidOf(d.list().find((x) => x.state === "progress")!.id)).toBe(other);
    await d.progress(other, 0, 0, "canceled");
    expect(Bun.file(join(dir, "downloads", other)).size).toBe(0);
    expect(ended).toEqual([true, false]);
    expect(await d.remove(v!.id)).toBe(true);
    expect(d.list()).toEqual([]);
  });
  test("downloads.json's records are checked; old ones go at the next open", async () => {
    const dir = dirOf();
    mkdirSync(join(dir, "downloads"), { mode: 0o700 });
    writeFileSync(join(dir, "downloads", GUID), "x", { mode: 0o600 });
    writeFileSync(join(dir, "downloads.json"), JSON.stringify({ v: 1, downloads: [{ id: "abcdefghijk23456", guid: GUID, name: "old.txt", size: 1, at: "2020-01-01T00:00:00.000Z" }, { id: "x", guid: "nope", name: "/etc", size: -1, at: "" }] }), { mode: 0o600 });
    const d = new Downloads({ dir, uid: process.getuid!(), keepDays: async () => 7, onChange: () => {} });
    await d.open();
    expect(d.list()).toEqual([]);
    expect(Bun.file(join(dir, "downloads", GUID)).size).toBe(0);
    expect(downloadRecordOf({ id: "abcdefghijk23456", guid: GUID, name: "a/b", size: 1, at: "x" })).toBeNull();
    expect(downloadName(undefined)).toBe("download");
  });
});
