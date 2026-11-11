// `/btw` in the message box and its key (owner row 124; DESIGN-R124 sections 2.6, 6, 7 and 8): kitespan's own `/` menu
// row with the CLI's words, never terminal-only and only where the agent answers side questions; the drafts that are a
// side question at Send (the chip, the filter text, a link's plain "/btw" text) and those that are not; and Desktop's
// key, Cmd+; on macOS and Ctrl+; elsewhere, in its 6.11 place in Settings' list.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BTW_NO_CHAT, BTW_ROW, formSideLine, sideQuestionOf, withSideRow } from "../../web/side/btw";
import { menuRowsOf, type MenuRow } from "../../web/composer/draft";
import { shortcutFor } from "../../web/ui/shortcuts";

const row = (name: string, more: Partial<MenuRow> = {}): MenuRow => ({ name, hint: `${name} hint`, source: "built-in", ...more });

describe("the / menu's /btw row", () => {
  test("added with the CLI's description and hint when Claude Code's list has none, in the list's name order", () => {
    const rows = withSideRow([row("add-dir"), row("clear"), row("compact")], true);
    expect(rows.map((r) => r.name)).toEqual(["add-dir", "btw", "clear", "compact"]);
    const btw = rows.find((r) => r.name === "btw")!;
    expect(btw.hint).toBe("Ask a quick side question without interrupting the main conversation");
    expect(btw.args).toBe("[question]");
    expect(btw.terminalOnly).toBeUndefined();
    expect(btw).toEqual(BTW_ROW);
  });

  test("Claude Code's own btw row keeps its words and is never terminal-only", () => {
    const own = row("btw", { hint: "Claude Code's words", terminalOnly: true });
    const rows = withSideRow([row("clear"), own], true);
    expect(rows.filter((r) => r.name === "btw").length).toBe(1);
    expect(rows.find((r) => r.name === "btw")).toEqual({ ...own, terminalOnly: undefined });
  });

  test("none where the agent does not answer side questions, and none before Claude Code's list came", () => {
    const list = [row("clear")];
    expect(withSideRow(list, false)).toBe(list);
    expect(withSideRow([], true)).toEqual([]);
  });

  test("the new-chat form's rows (menuRowsOf) have no kitespan row", () => {
    const chat = { commands: [{ name: "clear", description: "Clear", argumentHint: "", aliases: [], builtin: true, terminalOnly: false }] };
    expect(menuRowsOf(chat).map((r) => r.name)).toEqual(["clear"]);
  });
});

describe("which drafts are a side question at Send", () => {
  test("the btw chip: its arguments are the question; with none it only opens the side chat", () => {
    expect(sideQuestionOf({ mode: "slash", command: "btw", text: "  Which file holds the cap? " })).toEqual({ question: "Which file holds the cap?" });
    expect(sideQuestionOf({ mode: "slash", command: "btw", text: "" })).toEqual({ question: "" });
  });

  test("the / filter text 'btw ...' with no chip, and a bare 'btw'", () => {
    expect(sideQuestionOf({ mode: "slash", command: null, text: "btw why did it fail?" })).toEqual({ question: "why did it fail?" });
    expect(sideQuestionOf({ mode: "slash", command: null, text: "btw" })).toEqual({ question: "" });
    expect(sideQuestionOf({ mode: "slash", command: null, text: "btw\nline two" })).toEqual({ question: "line two" });
  });

  test("a message whose plain text starts with /btw and white space or its end (a link's text)", () => {
    expect(sideQuestionOf({ mode: "chat", command: null, text: "/btw what is the cap?" })).toEqual({ question: "what is the cap?" });
    expect(sideQuestionOf({ mode: "chat", command: null, text: "/btw" })).toEqual({ question: "" });
  });

  test("not a side question: another command, a longer name, a mid-line /btw, Bash mode", () => {
    expect(sideQuestionOf({ mode: "slash", command: "compact", text: "btw keep it" })).toBeNull();
    expect(sideQuestionOf({ mode: "slash", command: null, text: "btwx" })).toBeNull();
    expect(sideQuestionOf({ mode: "chat", command: null, text: "/btwx" })).toBeNull();
    expect(sideQuestionOf({ mode: "chat", command: null, text: "Run it, /btw what is it?" })).toBeNull();
    expect(sideQuestionOf({ mode: "chat", command: null, text: "btw what is it?" })).toBeNull();
    expect(sideQuestionOf({ mode: "bash", command: null, text: "/btw x" })).toBeNull();
  });
});

describe("the new-chat form's first message /btw (no chat to ask about yet)", () => {
  test("Start sends nothing and says what to do: the line names the chat that must exist first", () => {
    expect(BTW_NO_CHAT).toBe("Start the chat first, then ask a side question.");
    expect(formSideLine("/btw what does this repo do?", true)).toBe(BTW_NO_CHAT);
    expect(formSideLine("  /btw", true)).toBe(BTW_NO_CHAT);
    // Not a side question: a first message as before, and none where the agent answers no side question (the
    // server's own refusal, unsupported, says that).
    expect(formSideLine("What does /btw do?", true)).toBeNull();
    expect(formSideLine("/btwx", true)).toBeNull();
    expect(formSideLine("/btw what?", false)).toBeNull();
  });

  test("the form checks it before act.newChat, so no new_chat goes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "screens", "NewChatForm.tsx"), "utf8");
    const start = src.slice(src.indexOf("  const start = () => {"), src.indexOf("  startNow.current = start;"));
    const line = start.indexOf("const sideLine = formSideLine(message, sideOn);");
    expect(line).toBeGreaterThan(0);
    expect(start.indexOf("if (sideLine) return act.setNotice(sideLine, null);")).toBeGreaterThan(line);
    expect(start.indexOf("if (sideLine) return act.setNotice(sideLine, null);")).toBeLessThan(start.indexOf("act.newChat("));
  });
});

describe("Desktop's key: Open side chat (DESIGN.md 6.11)", () => {
  const k = (p: Partial<KeyboardEvent>) => ({ key: ";", code: "Semicolon", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...p });
  test("Cmd+; on macOS, Ctrl+; elsewhere", () => {
    expect(shortcutFor(k({ metaKey: true }), true)).toBe("side");
    expect(shortcutFor(k({ ctrlKey: true }), false)).toBe("side");
    // A layout that puts ; elsewhere still sends its code.
    expect(shortcutFor(k({ metaKey: true, key: "ö" }), true)).toBe("side");
  });
  test("not with Shift or Alt, not Ctrl on macOS, not Cmd elsewhere", () => {
    expect(shortcutFor(k({ metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(shortcutFor(k({ metaKey: true, altKey: true }), true)).toBeNull();
    expect(shortcutFor(k({ ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(k({ metaKey: true }), false)).toBeNull();
    expect(shortcutFor(k({}), true)).toBeNull();
  });
});
