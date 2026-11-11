// The composer's text model (DESIGN.md 6.4 and 5.1 rule 7): the mode chips, what Send sends, what each composer
// link fills, the chat's own `/` menu (the `commands` event, D47) and how a draft from the store (D49) reads: its mode
// is its own field, never its text's first character. No browser: the routes come from the real router.
import { describe, expect, test } from "bun:test";
import type { CommandInfo } from "../../shared/protocol";
import { parse as parseUrl } from "../../web/router";
import { EMPTY, commandMenu, commandRows, draftKey, fromStore, menuRowsOf, outgoing, prefillOf, toInput, typed, type Draft } from "../../web/composer/draft";
import { useScriptedCatalog } from "./fixtures";

useScriptedCatalog();

const at = (u: string) => parseUrl(new URL(u, "http://127.0.0.1:7943"));

describe("drafts", () => {
  test("a stored draft comes back with its own mode and chip, whatever its text's first character", () => {
    expect(fromStore({ mode: "bash", command: null, text: "git status", link: false })).toEqual({ mode: "bash", command: null, text: "git status", fromLink: false });
    expect(fromStore({ mode: "slash", command: "compact", text: "keep the plan", link: false })).toEqual({ mode: "slash", command: "compact", text: "keep the plan", fromLink: false });
    // A message that starts with "!" (link text, a message taken back or refused) is a message, never a command.
    expect(fromStore({ mode: "chat", command: null, text: "!rm -rf build", link: false })).toEqual({ mode: "chat", command: null, text: "!rm -rf build", fromLink: false });
    expect(fromStore({ mode: "chat", command: null, text: "/compact now", link: true })).toEqual({ mode: "chat", command: null, text: "/compact now", fromLink: true });
    // A chip outside slash mode is not the draft's.
    expect(fromStore({ mode: "chat", command: "compact", text: "x", link: false }).command).toBeNull();
  });
  test("the field's draft goes to the store field for field, and back", () => {
    const all: Draft[] = [
      { mode: "bash", command: null, text: "ls -la", fromLink: true },
      { mode: "slash", command: "compact", text: "x", fromLink: false },
      { mode: "chat", command: null, text: "!not a command", fromLink: false },
      EMPTY,
    ];
    for (const d of all) {
      expect(fromStore(toInput(d))).toEqual(d);
      expect(draftKey(fromStore(toInput(d)))).toBe(draftKey(d));
    }
    expect(toInput({ mode: "chat", command: null, text: "!x", fromLink: false })).toEqual({ mode: "chat", command: null, text: "!x", link: false });
  });
  test("typing picks the mode only into an empty field: an edit of a message that starts with ! keeps it a message", () => {
    const message = fromStore({ mode: "chat", command: null, text: "!rm -rf build", link: false });
    expect(typed(message, "!rm -rf build now", false)).toEqual({ mode: "chat", command: null, text: "!rm -rf build now", fromLink: false });
    expect(typed({ ...EMPTY, text: "hello" }, "!hello", false)).toMatchObject({ mode: "chat", text: "!hello" });
    expect(typed(EMPTY, "!", false)).toEqual({ mode: "bash", command: null, text: "", fromLink: false });
    expect(typed(EMPTY, "!git status", false)).toEqual({ mode: "bash", command: null, text: "git status", fromLink: false });
    expect(typed(EMPTY, "/co", false)).toEqual({ mode: "slash", command: null, text: "co", fromLink: false });
    // Typed over as a whole (select all, then type): the field was as good as empty.
    expect(typed({ ...EMPTY, text: "hello" }, "!", true)).toMatchObject({ mode: "bash", text: "" });
    // Link text stays plain until it is sent or cleared (5.1 rule 7); cleared, it is the user's own.
    const link: Draft = { mode: "chat", command: null, text: "", fromLink: true };
    expect(typed({ ...link, text: "abc" }, "!abc", false)).toMatchObject({ mode: "chat", fromLink: true });
    expect(typed({ ...link, text: "abc" }, "", false)).toEqual(EMPTY);
    expect(typed({ ...link, text: "abc" }, "!x", true)).toMatchObject({ mode: "bash", text: "x", fromLink: false });
    // A mode that is set stays: Bash text that starts with ! is the command's own.
    expect(typed({ mode: "bash", command: null, text: "", fromLink: false }, "!!", false)).toMatchObject({ mode: "bash", text: "!!" });
  });
  test("what Send sends", () => {
    expect(outgoing({ mode: "slash", command: "compact", text: "  keep it  ", fromLink: false })).toBe("/compact keep it");
    expect(outgoing({ mode: "slash", command: "context", text: "", fromLink: false })).toBe("/context");
    expect(outgoing({ mode: "slash", command: null, text: "etc/hosts is wrong", fromLink: false })).toBe("/etc/hosts is wrong");
    expect(outgoing({ mode: "slash", command: null, text: "", fromLink: false })).toBe("");
    expect(outgoing({ mode: "bash", command: null, text: " git status ", fromLink: false })).toBe("git status");
    expect(outgoing({ mode: "chat", command: null, text: "  indented\n", fromLink: false })).toBe("  indented");
    expect(outgoing({ mode: "chat", command: null, text: " \n ", fromLink: false })).toBe("");
  });
  test("the / menu: name prefixes first; terminal-only commands on every size (D47), out only when asked", () => {
    expect(commandRows("co").map((c) => c.name).slice(0, 3)).toEqual(["compact", "context", "cost"]);
    expect(commandRows("").some((c) => c.name === "doctor")).toBe(true);
    expect(commandRows("", true).some((c) => c.terminalOnly)).toBe(false);
  });
});

describe("composer links fill and never act", () => {
  test("send: the text stays plain, even with a leading ! or /", () => {
    for (const text of ["!rm -rf build", "/compact now", "@src/a.ts look"]) {
      const p = prefillOf(at(`/c/idleo6xxxxxxxxxxxxxx/send?text=${encodeURIComponent(text)}`), false);
      expect(p?.draft).toEqual({ mode: "chat", command: null, text, fromLink: true });
      expect(p?.menu).toBeUndefined();
    }
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/send"), false)).toBeNull();
  });
  test("bash: Bash mode holds the command", () => {
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/bash?cmd=git%20status"), false)?.draft).toEqual({ mode: "bash", command: null, text: "git status", fromLink: true });
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/bash"), false)?.draft).toMatchObject({ mode: "bash", text: "", fromLink: false });
  });
  test("slash: the menu at the top, or on a command's row with its chip and args", () => {
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash"), false)).toMatchObject({ menu: { top: true }, draft: { mode: "slash", command: null } });
    const row = prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/compact?args=keep%20the%20test%20plan"), false);
    expect(row).toMatchObject({ menu: { command: "compact" }, draft: { mode: "slash", command: "compact", text: "keep the test plan", fromLink: true }, notAvailable: false });
  });
  test("slash: a command the chat does not offer here", () => {
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/nope"), false)?.notAvailable).toBe(true);
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/doctor"), true)?.notAvailable).toBe(true); // terminal-only, where the menu leaves them out
    expect(prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/doctor"), false)).toMatchObject({ notAvailable: false, menu: { command: "doctor" }, draft: { command: null } });
  });
  test("a changed link gives a new key, so Back and Forward fill again", () => {
    const a = prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/send?text=a"), false)?.key;
    const b = prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/send?text=b"), false)?.key;
    const aView = prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/send?text=a&view=verbose"), false)?.key;
    expect(a).not.toBe(b);
    expect(aView).toBe(a);
  });
});

describe("the / menu is the chat's own list (the commands event)", () => {
  const info = (name: string, more: Partial<CommandInfo> = {}): CommandInfo => ({ name, description: `about ${name}`, argumentHint: "", aliases: [], builtin: true, terminalOnly: false, ...more });
  const chat = {
    commands: [
      info("compact", { argumentHint: "[instructions]" }),
      info("review-notes", { builtin: false, aliases: ["rn"], argumentHint: "[file]" }),
      info("doctor", { terminalOnly: true }),
    ],
  };
  test("the rows: Claude Code's names, hints and argument hints; yours for a command that is not built in; terminal-only marked", () => {
    expect(menuRowsOf(chat)).toEqual([
      { name: "compact", hint: "about compact", args: "[instructions]", source: "built-in", terminalOnly: undefined, aliases: undefined },
      { name: "review-notes", hint: "about review-notes", args: "[file]", source: "user", terminalOnly: undefined, aliases: ["rn"] },
      { name: "doctor", hint: "about doctor", args: undefined, source: "built-in", terminalOnly: true, aliases: undefined },
    ]);
  });
  test("before Claude Code sent a list, the catalog's rows stand in (none on the real page)", () => {
    expect(menuRowsOf({ commands: null }).map((c) => c.name)).toContain("compact"); // the scripted catalog of the tests
    expect(menuRowsOf({ commands: [] }).length).toBeGreaterThan(0);
  });
  test("typing filters by name or alias, name prefixes first; an alias typed in full finds its command", () => {
    const m = commandMenu(menuRowsOf(chat));
    expect(m.commandRows("rn").map((c) => c.name)).toEqual(["review-notes"]);
    expect(m.commandRows("").map((c) => c.name)).toEqual(["compact", "review-notes", "doctor"]);
    expect(m.findCommand("rn")?.name).toBe("review-notes");
  });
  test("a command link is judged against the chat's list; before the list came it fills its chip as it is", () => {
    const m = commandMenu(menuRowsOf(chat));
    expect(m.prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/compact?args=keep"))).toMatchObject({ draft: { command: "compact", text: "keep", fromLink: true }, menu: { command: "compact" }, notAvailable: false });
    expect(m.prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/nope"))?.notAvailable).toBe(true);
    expect(m.prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/doctor"))).toMatchObject({ draft: { command: null }, menu: { command: "doctor" } });
    const before = commandMenu([]).prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/compact?args=keep"));
    expect(before).toMatchObject({ draft: { mode: "slash", command: "compact", text: "keep", fromLink: true }, notAvailable: false });
    // The key changes when the list comes, so the link fills again against it.
    expect(before?.key).not.toBe(m.prefillOf(at("/c/idleo6xxxxxxxxxxxxxx/slash/compact?args=keep"))?.key);
  });
});
