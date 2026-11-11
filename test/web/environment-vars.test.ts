// D60 on the page (build checklist E6, EN 5.7): the KEY=value field names each line's problem before Save, by the line's
// number and never by its text; the page's refused names are the server's (E2); the API's answers keep names only; a
// value goes once, in the POST's body, and never reaches local storage, a URL or the page's own record of requests;
// the editor's rows show each name with one fixed mask, Edit with an empty "New value" field, Remove that asks in
// place, the settings mark, the running foot and the unreadable file's line; every field is plain text with
// autocomplete, autocapitalize and autocorrect off and no spell check. Rendered with React's server renderer.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { refusedName, type EnvProblem } from "../../server/env/names";
import { CLEAN_ENV } from "../../server/agents/types";
import { SDK_CHILD_ENV } from "../../server/agents/claude/sdk-env";
import { ApiError } from "../../web/net/api";
import { EnvSection, refusedLines } from "../../web/env/EnvSection";
import { SECRET_FIELD, ValueField, VarsField, fieldNotes } from "../../web/env/EnvFields";
import { ENV_LIMITS, ENV_WORDS, PROBLEM, cleanReply, countWords, envSummary, inSettingsLine, readEnv, readField, refusedKind, refusedLine, removeAsk, saveEnv, serverLine, valueProblem, type EnvReply } from "../../web/env/vars";
import { resetState } from "../../web/state/store";
import { ERROR_MESSAGES } from "../../shared/protocol";
import { InfoLine } from "../../web/chat/items/Notes";
import { TranscriptProvider } from "../../web/chat/items/context";
import type { Project } from "../../web/state/types";

const WEB = join(import.meta.dir, "..", "..", "web");
const code = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const SECRET = "sk-planted-7f3a9e";
const P: Project = { id: "k3m7q2x4ab", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {}, env: 2 };

describe("the KEY=value field (EN 5.7)", () => {
  test("one variable per line, split at the first =, blank and # lines skipped, the value kept as typed", () => {
    const r = readField(`API_TIMEOUT_MS=1200000\n\n# a comment\nTOKEN=a=b=c \r\n  SPACED  = x`);
    expect(r.ok).toBe(true);
    expect(r.set).toEqual([
      { name: "API_TIMEOUT_MS", value: "1200000" },
      { name: "TOKEN", value: "a=b=c " },
      { name: "SPACED", value: " x" },
    ]);
    expect(r.lines.map((l) => l.n)).toEqual([1, 4, 5]);
    expect(readField("").ok).toBe(false); // nothing to save
    expect(readField("  \n# only\n").ok).toBe(false);
  });

  test("each line's problem by its number; a bad name is never shown back, nor is any value", () => {
    const r = readField(`${SECRET}\nsk-${SECRET}=x\n9LIVES=1\nGOOD=1\nGOOD=2\nhome=/tmp\nPath=/bin\ngit_dir=.\nnode_options=--x\nclaudecode=1\nCLAUDE_CODE_MESSAGING_X=1\nXDG_STATE_HOME=/s\nNUL=a\u0000b\n${"N".repeat(129)}=1\nBIG=${"x".repeat(ENV_LIMITS.valueBytes + 1)}`);
    expect(r.ok).toBe(false);
    expect(r.set).toEqual([]);
    const notes = fieldNotes(r).map((n) => n.text);
    expect(notes).toEqual([
      `Line 1: ${PROBLEM.noEquals}`,
      `Line 2: ${PROBLEM.badName}`,
      `Line 3: ${PROBLEM.badName}`,
      `Line 5: ${PROBLEM.twice("GOOD")}`,
      "Line 6: home moves Claude Code's own files. Set it in your start-env file, then restart kitespan.",
      "Line 7: Set PATH in your shell profile or your start-env file, then restart kitespan.",
      "Line 8: git_dir would point git away from the chat's folder, so it cannot be set here.",
      "Line 9: The Agent SDK sets or removes node_options itself.",
      "Line 10: kitespan removes claudecode when it starts, so it cannot be set here.",
      "Line 11: kitespan removes CLAUDE_CODE_MESSAGING_X when it starts, so it cannot be set here.",
      "Line 12: XDG_STATE_HOME moves Claude Code's own files. Set it in your start-env file, then restart kitespan.",
      `Line 13: ${PROBLEM.badChar}`,
      `Line 14: ${PROBLEM.tooLong}`,
      `Line 15: ${PROBLEM.tooLong}`,
    ]);
    for (const n of notes) expect(n).not.toContain(SECRET);
    expect(r.lines.find((l) => l.n === 2)!.name).toBe("");
  });

  test("a saved name says it replaces the saved value; the count and the size of one environment have limits", () => {
    const r = readField("API_KEY=x\nNEW=y", ["API_KEY"]);
    expect(r.ok).toBe(true);
    expect(fieldNotes(r)).toEqual([{ text: `Line 1: API_KEY. ${ENV_WORDS.replaces}.`, bad: false }]);
    const saved = Array.from({ length: ENV_LIMITS.count }, (_, i) => `V${i}`);
    expect(readField("V0=1", saved).ok).toBe(true); // a replace adds none
    const over = readField("ONE_MORE=1", saved);
    expect(over.ok).toBe(false);
    expect(over.problem).toBe(PROBLEM.tooMany);
    const lines = Array.from({ length: 5 }, (_, i) => `BIG${i}=${"x".repeat(ENV_LIMITS.valueBytes)}`).join("\n");
    expect(readField(lines).problem).toBe(PROBLEM.tooBig);
  });

  test("Edit's one value: no line end, no NUL, at most 16,384 bytes", () => {
    expect(valueProblem("fine value")).toBeNull();
    expect(valueProblem("a\rb")).toBe(PROBLEM.badChar);
    expect(valueProblem("a\u0000b")).toBe(PROBLEM.badChar);
    expect(valueProblem("\ud800")).toBe(PROBLEM.badChar);
    expect(valueProblem("é".repeat(ENV_LIMITS.valueBytes / 2))).toBeNull();
    expect(valueProblem("é".repeat(ENV_LIMITS.valueBytes / 2 + 1))).toBe(PROBLEM.tooLong);
  });
});

describe("the refused names are the server's (E2)", () => {
  test("for every name some list holds, in upper and lower case, the page refuses what the server does, for the same reason", () => {
    const names = [
      ...CLEAN_ENV.always,
      ...CLEAN_ENV.alwaysPrefixes.map((p) => `${p}ANY`),
      ...CLEAN_ENV.desktopMarkers,
      ...CLEAN_ENV.desktop,
      ...CLEAN_ENV.traceAfterSession,
      ...SDK_CHILD_ENV.host,
      ...SDK_CHILD_ENV.added,
      ...SDK_CHILD_ENV.conditional,
      ...SDK_CHILD_ENV.removed,
      "DEBUG_CLAUDE_AGENT_SDK",
      "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_X", "PATH",
      "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
      "ANTHROPIC_API_KEY", "AWS_REGION", "HTTPS_PROXY", "http_proxy", "API_TIMEOUT_MS", "CLAUDE_CODE_USE_BEDROCK", "LD_PRELOAD",
    ];
    for (const n of names) for (const v of [n, n.toLowerCase()]) expect({ v, page: refusedKind(v) }).toEqual({ v, page: refusedName(v) });
  });

  test("every problem code the server's POST names has its line; an unknown one reads as the page's own line", () => {
    const codes: EnvProblem[] = ["clean", "files", "path", "git", "sdk", "bad_name", "too_long", "bad_char", "twice", "too_many", "too_big"];
    for (const c of codes) expect(serverLine(c, "NAME")).not.toBe(PROBLEM.server);
    expect(serverLine("twice", "API_KEY")).toBe(PROBLEM.twice("API_KEY"));
    expect(serverLine("clean", "AI_AGENT")).toBe(refusedLine("clean", "AI_AGENT"));
    expect(serverLine("something_new", "API_KEY")).toBe(PROBLEM.server);
    expect(serverLine("something_new", "home")).toBe(refusedLine("files", "home"));
  });
});

describe("the API (E5): names only", () => {
  const g = globalThis as unknown as { fetch: typeof fetch; window?: { __kitespanFrames?: { t: string }[] }; localStorage?: unknown };
  const real = { fetch: g.fetch, window: g.window, localStorage: g.localStorage, hadWindow: "window" in g, hadLs: "localStorage" in g };
  const stored = new Map<string, string>();
  beforeAll(() => {
    g.window = { __kitespanFrames: [] } as never;
    g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) };
  });
  afterAll(() => {
    g.fetch = real.fetch;
    if (real.hadWindow) g.window = real.window;
    else delete g.window;
    if (real.hadLs) g.localStorage = real.localStorage;
    else delete g.localStorage;
  });

  test("a reply keeps each name, its time and its mark, and nothing else, a planted value included", () => {
    const r = cleanReply({ vars: [{ name: "API_KEY", at: "2026-11-03T10:00:00.000Z", inSettings: true, value: SECRET, length: 17 }, { name: "bad name", at: "" }, "x"], unreadable: false, extra: SECRET });
    expect(r).toEqual({ vars: [{ name: "API_KEY", at: "2026-11-03T10:00:00.000Z", inSettings: true }], unreadable: false });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  test("Save sends one POST with the value in its body only: no URL, no local storage, no record of requests holds it", async () => {
    const calls: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
    g.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? ""), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ vars: [{ name: "API_KEY", at: "2026-11-03T10:00:00.000Z", inSettings: false }], unreadable: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const answer = await saveEnv(P.id, { set: [{ name: "API_KEY", value: SECRET }], remove: [] });
    expect(answer).toEqual({ ok: true, reply: { vars: [{ name: "API_KEY", at: "2026-11-03T10:00:00.000Z", inSettings: false }], unreadable: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/api/projects/${P.id}/env`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["x-kitespan"]).toBe("1");
    expect(JSON.parse(calls[0]!.body)).toEqual({ set: [{ name: "API_KEY", value: SECRET }], remove: [] });
    expect(calls[0]!.url).not.toContain(SECRET);
    expect(g.window!.__kitespanFrames!.map((f) => f.t)).toEqual(["POST /api/projects/:project/env"]);
    for (const v of stored.values()) expect(v).not.toContain(SECRET);
    // The read is a GET with no body, and its answer is names only.
    calls.length = 0;
    const read = await readEnv(P.id);
    expect(calls[0]!.method).toBe("GET");
    expect(read.vars.map((v) => v.name)).toEqual(["API_KEY"]);
  });

  test("a refused save: each line the server named, by its number in the field, with nothing written", async () => {
    g.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "bad_request", message: "That request could not be read.", lines: [{ i: 1, why: "clean" }, { i: 0, why: "bogus" }, { i: "x", why: "twice" }, { i: 2, why: SECRET }] } }), { status: 400 })) as unknown as typeof fetch;
    const field = readField("A=1\n\nAI_AGENT_X=2");
    const change = { set: [{ name: "A", value: "1" }, { name: "AI_AGENT", value: "2" }], remove: [] };
    const answer = await saveEnv(P.id, change);
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    // A line whose index or code is not one is left out: the code is a short word, never a value.
    expect(answer.lines).toEqual([{ i: 1, why: "clean" }, { i: 0, why: "bogus" }]);
    expect(refusedLines(answer, change, field)).toEqual([`Line 3: ${refusedLine("clean", "AI_AGENT")}`, `Line 1: ${PROBLEM.server}`]);
    expect(new ApiError(400, "bad_request", "x").lines).toEqual([]);
  });
});

describe("the editor's rows (EN 5.7)", () => {
  const reply: EnvReply = {
    vars: [
      { name: "API_TIMEOUT_MS", at: "2026-11-03T10:00:00.000Z", inSettings: false },
      { name: "ANTHROPIC_BASE_URL", at: "2026-11-03T10:00:00.000Z", inSettings: true },
    ],
    unreadable: false,
  };
  const render = (o: { start?: EnvReply; marked?: string | null; running?: boolean; askDiscard?: boolean } = {}) =>
    renderToStaticMarkup(createElement(EnvSection, { project: P, marked: o.marked ?? null, running: o.running ?? false, start: "start" in o ? o.start : reply, askDiscard: o.askDiscard }));
  beforeEach(() => resetState({ projects: [P] }));

  test("one row per variable: its name, one fixed mask for every value, Edit and Remove as visible buttons", () => {
    const html = render();
    expect(text(html)).toBe(
      `${ENV_WORDS.title} API_TIMEOUT_MS ${ENV_WORDS.mask} Edit Remove ANTHROPIC_BASE_URL ${ENV_WORDS.mask} Edit Remove ${inSettingsLine("ANTHROPIC_BASE_URL")} ${ENV_WORDS.add}`,
    );
    expect(ENV_WORDS.mask).toBe("••••••••");
    expect(html.match(/aria-label="Edit API_TIMEOUT_MS"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Remove ANTHROPIC_BASE_URL"/g)).toHaveLength(1);
    expect(inSettingsLine("NAME")).toBe("Your Claude Code settings set NAME too, and their value wins.");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
  });

  test("Desktop's words with none; the running foot only while a chat of this environment runs and there is something to say", () => {
    const none = render({ start: { vars: [], unreadable: false } });
    expect(text(none)).toBe(`${ENV_WORDS.title} None for this environment ${ENV_WORDS.add}`);
    expect(text(render({ start: { vars: [], unreadable: false }, running: true }))).not.toContain(ENV_WORDS.running);
    expect(text(render({ running: true }))).toContain(ENV_WORDS.running);
    expect(ENV_WORDS.running).toBe("Chats get these the next time their Claude Code starts. A chat that runs now keeps the values it started with.");
    expect(envSummary(0)).toBe("None for this environment");
    expect(envSummary(undefined)).toBe("None for this environment");
    expect(envSummary(1)).toBe("1 variable");
    expect(countWords(3)).toBe("3 variables");
  });

  test("?name= marks that row and focuses its Edit, which still waits for a click; a name that is not a row marks nothing", () => {
    const html = render({ marked: "ANTHROPIC_BASE_URL" });
    expect(html).toMatch(/data-name="ANTHROPIC_BASE_URL" data-marked="true" aria-current="true"/);
    expect(html.match(/data-marked/g)).toHaveLength(1);
    expect(html).toContain('class="btn env-edit primary" aria-label="Edit ANTHROPIC_BASE_URL"');
    expect(render({ marked: "NOT_A_ROW" })).not.toContain("data-marked");
    // Opening the editor sends reads only: a GET of the names, again when the page comes back into view.
    const src = code("env", "EnvSection.tsx");
    expect(src).toContain("readEnv(project.id)");
    expect(src).toContain("whenBack(");
    expect(src.match(/saveEnv\(/g)).toHaveLength(1);
  });

  test("an unreadable file: its one line, and Remove the unreadable file; a save then also discards it", () => {
    const html = render({ start: { vars: [], unreadable: true } });
    expect(text(html)).toContain(ENV_WORDS.unreadable);
    expect(ENV_WORDS.unreadable).toBe("kitespan could not read this environment's variables, so its chats do not start. Enter them again, or remove the unreadable file.");
    // Remove the unreadable file asks in place first (its Remove is the ask's), as a variable's Remove does.
    expect(html).toContain('data-testid="env-discard"');
    expect(html).not.toContain('data-testid="confirm-env-discard"');
    expect(render({ start: { vars: [], unreadable: true }, askDiscard: true })).toContain('data-testid="confirm-env-discard"');
    expect(code("env", "EnvSection.tsx")).toContain("reply?.unreadable ? { ...change, discardUnreadable: true } : change");
  });

  test("Edit opens an empty New value field; Remove asks in place; each Save empties what was typed", () => {
    const src = code("env", "EnvSection.tsx");
    // Edit: always empty at its start; the field's value is this component's own state, never a saved value.
    expect(src).toMatch(/setValue\(""\);\s*setRefused\(null\);\s*setEditing\(editing === v\.name \? null : v\.name\);/);
    expect(src).toMatch(/const stopEdit = \(\) => \{\s*setEditing\(null\);\s*setValue\(""\);/);
    expect(src).toMatch(/const stopAdd = \(\) => \{\s*setAdding\(false\);\s*setText\(""\);/);
    // Each Save's done empties the box (stopEdit, stopAdd) and gives the focus back to the button that opened it.
    expect(src).toContain('void save(`edit:${name}`, { set: [{ name, value }], remove: [] }, closeTo(stopEdit, `edit:${name}`));');
    expect(src).toContain('void save("add", { set: fieldRead.set, remove: [] }, closeTo(stopAdd, "add"), fieldRead);');
    expect(src).toContain("{ set: [], remove: [v.name] }");
    expect(removeAsk("API_KEY")).toBe("Remove API_KEY? Chats stop getting it from their next start.");
    // The values stay out of local storage and of the store: the section writes neither.
    expect(src).not.toContain("localStorage");
    expect(src).not.toMatch(/act\.\w+\([^)]*value/);
  });
});

describe("the fields: plain text, nothing filled or kept by the browser (MDN on autocomplete)", () => {
  test("the KEY=value field and New value: no password type, autocomplete, autocapitalize and autocorrect off, no spell check", () => {
    const field = renderToStaticMarkup(createElement(VarsField, { text: "", onText: () => {}, read: readField("") }));
    const value = renderToStaticMarkup(createElement(ValueField, { name: "API_KEY", value: "", onValue: () => {}, problem: null }));
    // HTML attribute names have no case (the server renderer writes React's own spelling).
    for (const raw of [field, value]) {
      const html = raw.toLowerCase();
      expect(html).toContain('autocomplete="off"');
      expect(html).toContain('autocapitalize="off"');
      expect(html).toContain('autocorrect="off"');
      expect(html).toContain('spellcheck="false"');
      expect(html).not.toContain('type="password"');
    }
    expect(value).toContain('type="text"');
    expect(value).toContain(`placeholder="${ENV_WORDS.newValue}"`);
    expect(value).toContain('value=""');
    expect(field).toContain(`placeholder="${ENV_WORDS.field}"`);
    expect(SECRET_FIELD).toEqual({ autoComplete: "off", autoCapitalize: "off", autoCorrect: "off", spellCheck: false });
  });

  test("a field's problems are listed under it, each by its line, and the field says it is invalid", () => {
    const html = renderToStaticMarkup(createElement(VarsField, { text: "NO_EQUALS\nOK=1", onText: () => {}, read: readField("NO_EQUALS\nOK=1") }));
    expect(text(html)).toContain(`Line 1: ${PROBLEM.noEquals}`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('class="env-note is-bad"');
  });
});

describe("an unreadable environment in the chat (L39)", () => {
  test("the server's line of a refused start links to the environment, where its file can be removed", () => {
    const chat = { id: "envchataaaaaaaaaaaaa", projectId: P.id } as never;
    resetState({ ready: true, projects: [P], chats: [chat] });
    const item = { kind: "info" as const, id: "n1", text: ERROR_MESSAGES.env_unreadable, level: "notice" as const, code: "env_unreadable" as const };
    const html = renderToStaticMarkup(
      createElement(TranscriptProvider, { value: { chatId: "envchataaaaaaaaaaaaa", view: "normal", readOnly: false, isOpen: () => false, toggle: () => {} } }, createElement(InfoLine, { item })),
    );
    expect(html).toContain('data-testid="env-unreadable-line"');
    expect(html).toContain(`href="/p/${P.id}/environment"`);
    expect(text(html)).toBe(`${ERROR_MESSAGES.env_unreadable} ${ENV_WORDS.title}`);
    expect(ENV_WORDS.unreadable as string).toBe(ERROR_MESSAGES.env_unreadable);
    const plain = renderToStaticMarkup(createElement(InfoLine, { item: { kind: "info", id: "n2", text: "This chat waits for a free slot.", level: "notice" } }));
    expect(plain).not.toContain("env-unreadable-line");
  });
});
