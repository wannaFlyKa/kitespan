// D47: the terminal-only slash commands show on every size, because the Terminal pane is on every size. A pick opens
// /c/<chat>/shell?type=resume, as Open in terminal does: the server types the resume command at the prompt, and the
// pane says "Then type /<command>." above the terminal, after the fork line when there is one. The command's name
// rides in the history entry's state (router.ts EntryState thenType), never in the URL; opening records nothing and
// the composer's draft stays empty.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { navigate, parse, type EntryState } from "../../web/router";
import { COMMANDS, useScriptedCatalog } from "./fixtures";
import { commandRows, prefillOf } from "../../web/composer/draft";
import { FORK_LINE, NO_SESSION_LINE, thenTypeLine } from "../../web/terminal/command";
import { noteLines } from "../../web/terminal/session";
import { openInTerminalHref, thenTypeOf } from "../../web/terminal/route";
import type { CommandRow } from "../../web/state/types";

useScriptedCatalog();

const SRC = join(import.meta.dir, "..", "..", "web");
const BASE = "http://127.0.0.1:7941";
const at = (u: string) => parse(new URL(u, BASE));
const TERMINAL_ONLY = COMMANDS.filter((c) => c.terminalOnly).map((c) => c.name);

// A small stand-in for the tab's history, enough for navigate: the entries, their states, the current one.
/** The page's record of mutating frames (web/net/frames.ts). */
type Log = { t: string; at: number }[];
const g = globalThis as unknown as { history?: unknown; location?: unknown; window?: { __kitespanFrames?: Log } };
const had = { history: "history" in g, location: "location" in g, window: "window" in g };
let entries: { url: string; state: unknown }[] = [];
let current = 0;
function tab(start: string, state: unknown = null) {
  entries = [{ url: start, state }];
  current = 0;
  const url = () => new URL(entries[current]!.url, BASE);
  g.location = {
    get pathname() {
      return url().pathname;
    },
    get search() {
      return url().search;
    },
    get href() {
      return url().href;
    },
  };
  g.history = {
    get state() {
      return entries[current]!.state;
    },
    pushState(s: unknown, _t: string, to: string) {
      entries.splice(current + 1);
      entries.push({ url: to, state: structuredClone(s) });
      current++;
    },
    replaceState(s: unknown, _t: string, to?: string) {
      entries[current] = { url: to ?? entries[current]!.url, state: structuredClone(s) };
    },
  };
}
if (!had.window) g.window = {};
afterAll(() => {
  if (!had.history) delete g.history;
  if (!had.location) delete g.location;
  if (!had.window) delete g.window;
});
const log = (): Log => (g.window!.__kitespanFrames ??= []);
const here = () => entries[current]!;

describe("the / menu shows the terminal-only commands on every size", () => {
  test("the scripted list has them, and the menu's rows hold them by default", () => {
    expect(TERMINAL_ONLY).toEqual(["doctor", "statusline"]);
    const rows = commandRows("").map((c) => c.name);
    for (const name of TERMINAL_ONLY) expect(rows).toContain(name);
    expect(commandRows("doc").map((c) => c.name)).toEqual(["doctor"]);
  });
  test("the composer no longer hides them on the phone or on touch", () => {
    const composer = readFileSync(join(SRC, "composer", "Composer.tsx"), "utf8");
    expect(composer).not.toContain("hideTerminal");
    expect(composer).toContain("commandRows(filtering ? d.text : \"\")");
    expect(composer).toContain("prefillOf(route)");
  });
  test("a /slash/doctor link opens the menu at its row and fills nothing, on every size", () => {
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/doctor"))).toMatchObject({ notAvailable: false, menu: { command: "doctor" }, draft: { mode: "slash", command: null, text: "" } });
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/statusline?args=x"))).toMatchObject({ notAvailable: false, draft: { command: null, text: "" } });
  });
});

describe("a pick opens the pane with the name in the entry's state, never in the URL", () => {
  beforeEach(() => {
    log().length = 0;
  });
  test("from the chat: a new entry at the pane's URL, the name beside from and back", () => {
    tab("/c/demoolxxxxxxxxxxxxxx", { from: "/", back: ["/"] });
    navigate(openInTerminalHref("demoolxxxxxxxxxxxxxx"), { state: { thenType: "doctor" } });
    expect(here().url).toBe("/c/demoolxxxxxxxxxxxxxx/shell?type=resume");
    expect(here().state).toEqual({ from: "/c/demoolxxxxxxxxxxxxxx", back: ["/c/demoolxxxxxxxxxxxxxx", "/"], doc: expect.any(String), inDoc: 1, thenType: "doctor" });
    expect(entries).toHaveLength(2);
    expect(log()).toEqual([]);
  });
  test("from a / menu link: the menu's entry becomes the pane's, with a fresh state that keeps only from and back", () => {
    tab("/c/demoolxxxxxxxxxxxxxx/slash", { from: "/c/demoolxxxxxxxxxxxxxx", back: ["/c/demoolxxxxxxxxxxxxxx"], terminalTyped: "old:1", other: 1 });
    navigate(openInTerminalHref("demoolxxxxxxxxxxxxxx", "verbose"), { replace: true, state: { thenType: "statusline" } });
    expect(entries).toHaveLength(1);
    expect(here()).toEqual({ url: "/c/demoolxxxxxxxxxxxxxx/shell?type=resume&view=verbose", state: { from: "/c/demoolxxxxxxxxxxxxxx", back: ["/c/demoolxxxxxxxxxxxxxx"], thenType: "statusline" } });
  });
  test("while the pane is open at that URL already: the same entry, its typed mark gone, so the pane types again", () => {
    tab("/c/demoolxxxxxxxxxxxxxx/shell?type=resume", { from: "/c/demoolxxxxxxxxxxxxxx", back: ["/c/demoolxxxxxxxxxxxxxx"], terminalTyped: "page:1" });
    navigate("/c/demoolxxxxxxxxxxxxxx/shell?type=resume", { state: { thenType: "doctor" } });
    expect(entries).toHaveLength(1);
    expect(here().state).toEqual({ from: "/c/demoolxxxxxxxxxxxxxx", back: ["/c/demoolxxxxxxxxxxxxxx"], thenType: "doctor" });
  });
  test("without a state, a go to the open URL still does nothing and a replace keeps the entry's state", () => {
    const st = { from: "/c/demoolxxxxxxxxxxxxxx", back: ["/c/demoolxxxxxxxxxxxxxx"], thenType: "doctor", terminalTyped: "page:1" };
    tab("/c/demoolxxxxxxxxxxxxxx/shell?type=resume", st);
    navigate("/c/demoolxxxxxxxxxxxxxx/shell?type=resume");
    expect(here().state).toEqual(st);
    navigate("/c/demoolxxxxxxxxxxxxxx", { replace: true });
    expect(here()).toEqual({ url: "/c/demoolxxxxxxxxxxxxxx", state: st });
  });
  test("the URL never holds the name: the pane's route reads type and view only", () => {
    const r = at("/c/demoolxxxxxxxxxxxxxx/shell?type=resume&thenType=doctor&cmd=doctor");
    expect(r.query).toEqual({ type: "resume" });
    expect(openInTerminalHref("demoolxxxxxxxxxxxxxx")).not.toContain("doctor");
    const composer = readFileSync(join(SRC, "composer", "Composer.tsx"), "utf8");
    expect(composer).toMatch(/if \(c\.terminalOnly\) \{[\s\S]*?commit\(EMPTY\);\s*navigate\(openInTerminalHref\(chat\.id, view\), \{ replace: MENU_ROUTES\.has\(route\.name\), state: \{ thenType: c\.name \} \}\);\s*return;/);
  });
  test("the pane takes only a known terminal-only command's name from the state", () => {
    expect(thenTypeOf({ thenType: "doctor" } satisfies EntryState)).toBe("doctor");
    expect(thenTypeOf({ from: "/c/demoolxxxxxxxxxxxxxx", thenType: "statusline" })).toBe("statusline");
    for (const st of [null, undefined, "doctor", {}, { thenType: "compact" }, { thenType: "doctor; rm -rf ~" }, { thenType: "/doctor" }, { thenType: 1 }]) expect([st, thenTypeOf(st)]).toEqual([st, null]);
  });
  test("the chat's own / menu rows count too: a terminal-only command that Claude Code sent for this chat", () => {
    const rows: CommandRow[] = [
      { name: "mine", hint: "", source: "user", terminalOnly: true },
      { name: "plain", hint: "", source: "user" },
    ];
    expect(thenTypeOf({ thenType: "mine" }, rows)).toBe("mine");
    expect(thenTypeOf({ thenType: "plain" }, rows)).toBeNull();
    expect(thenTypeOf({ thenType: "mine" })).toBeNull();
  });
});

describe("the pane says the line above the terminal, and records nothing", () => {
  test("the words", () => {
    expect(thenTypeLine("doctor")).toBe("Then type /doctor.");
  });
  test("a chat whose Claude Code lives: the fork line, then the line", () => {
    expect(noteLines({ status: "open", refusal: null, note: { case: "fork", then: "doctor" } })).toEqual([FORK_LINE, "Then type /doctor."]);
  });
  test("a sleeping chat: the line alone (the plain command is at the prompt)", () => {
    expect(noteLines({ status: "open", refusal: null, note: { case: "plain", then: "statusline" } })).toEqual(["Then type /statusline."]);
  });
  test("no pick: no line; a chat with no message: the no-session line, never the then line", () => {
    expect(noteLines({ status: "open", refusal: null, note: { case: "plain", then: null } })).toEqual([]);
    expect(noteLines({ status: "open", refusal: null, note: { case: "none", then: null } })).toEqual([NO_SESSION_LINE]);
  });
  test("TerminalPane reads the name from the entry's state when it asks for the command, once per entry", () => {
    const pane = readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8");
    expect(pane).toMatch(/if \(!attached \|\| type !== "resume"\) return;\s*typeForEntry\(session, thenTypeOf\(history\.state, commandRowsOf\(\{ commands \}\)\)\);/);
    // The session keeps the name for the server's answer; "none" never shows it.
    const session = readFileSync(join(SRC, "terminal", "session.ts"), "utf8");
    expect(session).toContain('s.note = { case: c, then: c === "none" ? null : s.then };');
  });
});
