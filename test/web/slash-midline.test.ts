// The `/` menu at a mid-line `/` (D57, DECISIONS-OWNER row 57; DESIGN.md 6.4): a `/` that the user types at a word
// start in the middle of a message, in Chat mode or in a command's arguments after its chip, opens the `/` menu's own
// rows (the chat's list, draft.ts commandRows) over that word; never inside a word (src/app, a/b, http://), never in
// Bash mode or while the field is still the command filter, never from a paste, a drop or a link's text (5.1 rule 7).
// Its filter is the text from after the `/` to the caret, and it closes as the `@` picker's token does. A pick puts
// `/<name> ` in place of `/<filter>` as plain text with the caret after the space: no chip, no mode change, nothing
// sent, also for a terminal-only row, which reads there as any other row (no "Open in terminal"). The menu shows only
// while a row answers its filter: with none (a path such as /etc/hosts, since no command name holds a `/`, or /zzz) it
// does not show and Enter sends, as with no menu (W19b). Enter with the menu showing never sends; a laptop input method
// keeps its keys, and on touch Enter picks at once. No browser: the routes come from the real router, the menu renders
// with react-dom/server, and the composer's key order and pick are read from its source (the click-through drives the
// real page: scripts/ui-check.ts, the slash-midline flows).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommandInfo } from "../../shared/protocol";
import { parse as parseUrl } from "../../web/router";
import { EMPTY, commandMenu, menuRowsOf, outgoing, prefillOf, typed, type Draft } from "../../web/composer/draft";
import { mentionKey, nextToken, tokenAt, typedAt } from "../../web/composer/mention";
import { nextSlash, slashField, slashPick } from "../../web/composer/slashToken";
import { SlashMenu } from "../../web/composer/SlashMenu";
import { composingKey } from "../../web/ui/primitives";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
const at = (u: string) => parseUrl(new URL(u, "http://127.0.0.1:7941"));
const C = "k3m7q2x4abk3m7q2x4ab";

type Field = Pick<Draft, "mode" | "command" | "text">;
const chat = (text: string): Field => ({ mode: "chat", command: null, text });
const args = (command: string, text: string): Field => ({ mode: "slash", command, text });
const filter = (text: string): Field => ({ mode: "slash", command: null, text });
const bash = (text: string): Field => ({ mode: "bash", command: null, text });
const opens = (prev: Field, next: Field, caret: number, inputType: string | null = "insertText") => nextSlash(null, prev, next, caret, inputType);

describe("a typed / at a word start opens the menu (D57 rule 1)", () => {
  test("after a space or a new line in Chat mode, typed or committed by an input method", () => {
    expect(opens(chat("test "), chat("test /"), 6)).toEqual({ at: 5, filter: "" });
    expect(opens(chat("line one\n"), chat("line one\n/"), 10)).toEqual({ at: 9, filter: "" });
    expect(opens(chat("see\t"), chat("see\t/"), 5)).toEqual({ at: 4, filter: "" });
    // An Android keyboard or an input method commits text with no key event: the input event alone opens it.
    expect(opens(chat("see "), chat("see /"), 5, "insertCompositionText")).toEqual({ at: 4, filter: "" });
    // In the middle of the text, before other words (the caret right after the new /).
    expect(opens(chat("run  now"), chat("run / now"), 5)).toEqual({ at: 4, filter: "" });
    // Typed over a selection: the selected text goes, the / takes its place.
    expect(opens(chat("see this"), chat("see /"), 5)).toEqual({ at: 4, filter: "" });
  });
  test("a / typed in front of existing text at position 0 of a non-empty Chat field is a word start too", () => {
    const front = typed({ ...EMPTY, text: "please" }, "/please", false);
    expect(front).toMatchObject({ mode: "chat", command: null, text: "/please" });
    expect(nextSlash(null, chat("please"), front, 1, "insertText")).toEqual({ at: 0, filter: "" });
  });
  test("a / typed into an empty field still picks the / mode: the start menu, not this one", () => {
    const fresh = typed(EMPTY, "/", false);
    expect(fresh).toMatchObject({ mode: "slash", command: null, text: "" });
    expect(nextSlash(null, EMPTY, fresh, 0, "insertText")).toBeNull();
    // Typed over the whole text too: that change picks the mode as before.
    const over = typed({ ...EMPTY, text: "hello" }, "/", true);
    expect(over).toMatchObject({ mode: "slash", command: null });
    expect(nextSlash(null, chat("hello"), over, 0, "insertText")).toBeNull();
  });
  test("in the arguments after a command chip (slash mode with its command)", () => {
    expect(opens(args("compact", ""), args("compact", "/"), 1)).toEqual({ at: 0, filter: "" });
    expect(opens(args("compact", "keep "), args("compact", "keep /"), 6)).toEqual({ at: 5, filter: "" });
    expect(slashField(args("compact", ""))).toBe(true);
  });
  test("never inside a word: src/app, a/b, http://, a second / in a row", () => {
    expect(opens(chat("src"), chat("src/"), 4)).toBeNull();
    expect(opens(chat("see a"), chat("see a/"), 6)).toBeNull();
    expect(opens(chat("open http:"), chat("open http:/"), 11)).toBeNull();
    expect(opens(chat("open http:/"), chat("open http://"), 12)).toBeNull();
    expect(opens(chat("see /"), chat("see //"), 6)).toBeNull();
    expect(opens(args("review", "src"), args("review", "src/"), 4)).toBeNull();
  });
  test("not in Bash mode, not while the field is still the command filter", () => {
    expect(opens(bash("ls "), bash("ls /"), 4)).toBeNull();
    expect(opens(filter("comp "), filter("comp /"), 6)).toBeNull();
    expect(opens(filter(""), filter("/"), 1)).toBeNull();
    expect(slashField(bash(""))).toBe(false);
    expect(slashField(filter("comp"))).toBe(false);
    expect(slashField(chat(""))).toBe(true);
  });
  test("never from a paste, a drop, an autocorrect's replacement or a deletion", () => {
    for (const t of ["insertFromPaste", "insertFromDrop", "insertReplacementText", "insertFromYank", "deleteContentBackward", "deleteContentForward"]) {
      expect(opens(chat("see "), chat("see /"), 5, t)).toBeNull();
      expect(opens(args("compact", ""), args("compact", "/"), 1, t)).toBeNull();
    }
    // A deletion that leaves a / before the caret is no typed /, whatever the input type says.
    expect(opens(chat("see /ab"), chat("see /b"), 5, null)).toBeNull();
    // With an unknown input type, only a plain insert of the / counts.
    expect(opens(chat("see "), chat("see /"), 5, null)).toEqual({ at: 4, filter: "" });
    expect(opens(chat("see "), chat("see a /"), 7, null)).toBeNull();
    expect(opens(chat("see this"), chat("see /"), 5, null)).toBeNull();
  });
  test("a link's text never opens it: /send?text= with a mid-line / fills plain text, and typing after it opens nothing", () => {
    const pre = prefillOf(at(`/c/${C}/send?text=${encodeURIComponent("test /comp")}`))!;
    expect(pre.draft).toEqual({ mode: "chat", command: null, text: "test /comp", fromLink: true });
    expect(pre.menu).toBeUndefined();
    expect(opens(chat("test /comp"), chat("test /compa"), 11)).toBeNull();
    // A command link's arguments are a link's text too.
    const row = prefillOf(at(`/c/${C}/slash/compact?args=${encodeURIComponent("keep /co")}`))!;
    expect(row.draft).toMatchObject({ mode: "slash", command: "compact", text: "keep /co", fromLink: true });
    expect(opens(args("compact", "keep /co"), args("compact", "keep /com"), 9)).toBeNull();
  });
});

describe("the open menu's token (rule 2)", () => {
  test("its filter is the text from after the / to the caret", () => {
    const open = { at: 5, filter: "" };
    const one = nextSlash(open, chat("test /"), chat("test /c"), 7, "insertText");
    expect(one).toEqual({ at: 5, filter: "c" });
    expect(nextSlash(one, chat("test /c"), chat("test /co"), 8, "insertText")).toEqual({ at: 5, filter: "co" });
    // Backspace widens it again; Backspace over the / closes it.
    expect(nextSlash(one, chat("test /c"), chat("test /"), 6, "deleteContentBackward")).toEqual({ at: 5, filter: "" });
    expect(nextSlash(open, chat("test /"), chat("test "), 5, "deleteContentBackward")).toBeNull();
    // A paste into the open token's word narrows it as typing does (the token is open already).
    expect(nextSlash(open, chat("test /"), chat("test /comp"), 10, "insertFromPaste")).toEqual({ at: 5, filter: "comp" });
    // In the arguments after a chip.
    expect(nextSlash({ at: 0, filter: "" }, args("review", "/"), args("review", "/co"), 3, "insertText")).toEqual({ at: 0, filter: "co" });
  });
  test("white space closes it, as does the / gone or moved, the caret out of the word, and a filter past 1,024", () => {
    const open = { at: 5, filter: "co" };
    expect(nextSlash(open, chat("test /co"), chat("test /co "), 9, "insertText")).toBeNull();
    expect(nextSlash(open, chat("test /co"), chat("test /co\n"), 9, "insertLineBreak")).toBeNull();
    expect(tokenAt("test /co", 5, 5, "/")).toBeNull();
    expect(tokenAt("test /co", 5, 3, "/")).toBeNull();
    expect(tokenAt("test xco", 5, 8, "/")).toBeNull();
    expect(tokenAt("testx/co", 5, 8, "/")).toBeNull();
    expect(tokenAt("test /compact", 5, 9, "/")).toEqual({ at: 5, filter: "com" });
    expect(tokenAt(`a /${"x".repeat(1024)}`, 2, 1027, "/")).toEqual({ at: 2, filter: "x".repeat(1024) });
    expect(tokenAt(`a /${"x".repeat(1025)}`, 2, 1028, "/")).toBeNull();
  });
  test("a mode change, or a chip that comes or goes, closes it", () => {
    const open = { at: 5, filter: "co" };
    expect(nextSlash(open, chat("test /co"), bash("test /co"), 8, "insertText")).toBeNull();
    // Backspace at the start takes the chip away: the field is the command filter again.
    expect(nextSlash({ at: 0, filter: "x" }, args("compact", "/x"), filter("/x"), 2, "deleteContentBackward")).toBeNull();
    expect(nextSlash({ at: 0, filter: "x" }, args("compact", "/x"), args("review", "/x"), 2, "insertText")).toBeNull();
  });
  test("the @ picker's rules are as they were: @ by default, Chat mode only, and a / opens no @ token", () => {
    expect(typedAt("see ", "see @", 5, "insertText")).toBe(4);
    expect(typedAt("see ", "see /", 5, "insertText")).toBe(-1);
    expect(typedAt("see ", "see /", 5, "insertText", "/")).toBe(4);
    expect(tokenAt("@comp", 0, 5)).toEqual({ at: 0, filter: "comp" });
    expect(tokenAt("/comp", 0, 5)).toBeNull();
    expect(nextToken(null, { mode: "chat", text: "see " }, { mode: "chat", text: "see /" }, 5, "insertText")).toBeNull();
    // And an @ opens no / menu.
    expect(opens(chat("see "), chat("see @"), 5)).toBeNull();
  });
});

describe("the rows are the / menu's own (rule 2)", () => {
  const info = (name: string, more: Partial<CommandInfo> = {}): CommandInfo => ({ name, description: `about ${name}`, argumentHint: "", aliases: [], builtin: true, terminalOnly: false, ...more });
  const menu = commandMenu(menuRowsOf({ commands: [info("compact", { argumentHint: "[instructions]" }), info("context"), info("review-notes", { builtin: false, aliases: ["rn"] }), info("doctor", { terminalOnly: true })] }));
  const noop = () => {};
  const html = (filter: string, rows = menu.commandRows(filter)) => renderToStaticMarkup(createElement(SlashMenu, { id: "s", rows, active: 0, filter, onPick: noop, onHover: noop, onClose: noop }));
  test("commandRows(filter) of the chat's list: the same order, aliases, and the terminal-only rows", () => {
    expect(menu.commandRows("co").map((c) => c.name)).toEqual(["compact", "context"]);
    expect(menu.commandRows("rn").map((c) => c.name)).toEqual(["review-notes"]);
    expect(menu.commandRows("").map((c) => c.name)).toEqual(["compact", "context", "review-notes", "doctor"]);
    expect(menu.commandRows("doc")[0]).toMatchObject({ name: "doctor", terminalOnly: true });
  });
  test("SlashMenu draws them, and a filter that matches nothing has its one line (the start menu's)", () => {
    const out = html("co");
    expect(out).toContain('data-testid="slash-menu"');
    expect(out).toContain('data-command="compact"');
    expect(out).toContain('data-command="context"');
    expect(out).not.toContain('data-command="doctor"');
    expect(html("zz")).toContain("No command matches /zz.");
    expect(html("", [])).toContain("No commands yet.");
  });
  test("a path or a word that no command answers has no row: no command name holds a /", () => {
    for (const f of ["etc/hosts", "tmp/x.log", "a/", "/", "zzz", "or/and"]) expect(menu.commandRows(f)).toEqual([]);
    for (const c of menu.rows) expect(c.name).not.toContain("/");
  });
  test("in the text (inText) a terminal-only row reads as any other: no Open in terminal, not disabled, not quieter", () => {
    const rows = menu.commandRows("doc");
    const inText = renderToStaticMarkup(createElement(SlashMenu, { id: "s", rows, active: 0, filter: "doc", inText: true, onPick: noop, onHover: noop, onClose: noop }));
    expect(inText).toContain('data-command="doctor"');
    expect(inText).not.toContain("Open in terminal");
    expect(inText).not.toContain("aria-disabled");
    expect(inText).not.toContain("is-term");
    // A row of the user's own keeps its tag there.
    const own = renderToStaticMarkup(createElement(SlashMenu, { id: "s", rows: menu.commandRows("rn"), active: 0, filter: "rn", inText: true, onPick: noop, onHover: noop, onClose: noop }));
    expect(own).toContain(">yours<");
    // The start menu is as it was: a pick there opens Open in terminal.
    const start = html("doc");
    expect(start).toContain("Open in terminal");
    expect(start).toContain('aria-disabled="true"');
    expect(start).toContain("is-term");
  });
});

describe("a pick (rule 3)", () => {
  test("puts /<name> and one space in place of /<filter>, with the caret after the space", () => {
    expect(slashPick("test /co", { at: 5, filter: "co" }, "compact")).toEqual({ text: "test /compact ", caret: 14 });
    expect(slashPick("test /", { at: 5, filter: "" }, "context")).toEqual({ text: "test /context ", caret: 14 });
    expect(slashPick("/please", { at: 0, filter: "" }, "review")).toEqual({ text: "/review please", caret: 8 });
    expect(slashPick("line\n/co", { at: 5, filter: "co" }, "compact")).toEqual({ text: "line\n/compact ", caret: 14 });
    // A space after the word already: it is the one space, and the caret goes after it.
    expect(slashPick("run /co now", { at: 4, filter: "co" }, "compact")).toEqual({ text: "run /compact now", caret: 13 });
    // The caret was inside a word: the rest of it stays after the space, as the @ picker leaves it.
    expect(slashPick("test /comxyz", { at: 5, filter: "com" }, "compact")).toEqual({ text: "test /compact xyz", caret: 14 });
    // A terminal-only row too: plain text, nothing more.
    expect(slashPick("then /doc", { at: 5, filter: "doc" }, "doctor")).toEqual({ text: "then /doctor ", caret: 13 });
  });
  test("the field keeps its mode and chip, and Send sends the text as typed; the picked text opens no menu again", () => {
    const d: Draft = { mode: "chat", command: null, text: "test /co", fromLink: false };
    const out = slashPick(d.text, { at: 5, filter: "co" }, "compact");
    expect(outgoing({ ...d, text: out.text })).toBe("test /compact");
    const a: Draft = { mode: "slash", command: "review", text: "then /co", fromLink: false };
    expect(outgoing({ ...a, text: slashPick(a.text, { at: 5, filter: "co" }, "compact").text })).toBe("/review then /compact");
    // The pick's text is no typed /: the caret after the space is out of any token.
    expect(tokenAt(out.text, 5, out.caret, "/")).toBeNull();
  });
});

describe("the keys while it shows (rule 3)", () => {
  const key = (k: string, rows: number, more: { shiftKey?: boolean; ime?: boolean } = {}) => mentionKey({ key: k, shiftKey: more.shiftKey ?? false, ime: more.ime ?? false }, rows);
  test("Up and Down move, Enter and Tab pick; Enter never sends while it shows (the @ picker's keys, also with no row)", () => {
    expect(key("ArrowDown", 3)).toBe("down");
    expect(key("ArrowUp", 3)).toBe("up");
    expect(key("Enter", 3)).toBe("pick");
    expect(key("Tab", 3)).toBe("pick");
    expect(key("Enter", 0)).toBe("stop");
    for (const rows of [0, 1, 40]) expect(key("Enter", rows)).not.toBe("pass");
    // Shift+Enter makes a new line (white space closes the menu); Tab with no row moves the focus.
    expect(key("Enter", 3, { shiftKey: true })).toBe("pass");
    expect(key("Tab", 0)).toBe("pass");
  });
  test("a laptop input method keeps its keys; on touch Enter picks at once", () => {
    for (const k of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"]) expect(key(k, 3, { ime: composingKey({ isComposing: true, keyCode: 13 }, false) })).toBe("ime");
    expect(key("Enter", 3, { ime: composingKey({ isComposing: false, keyCode: 229 }, false) })).toBe("ime");
    expect(key("Enter", 3, { ime: composingKey({ isComposing: true, keyCode: 13 }, true) })).toBe("pick");
  });
});

describe("the composer's part (web/composer/Composer.tsx)", () => {
  const composer = src("composer", "Composer.tsx");
  const keys = composer.slice(composer.indexOf("const onKeyDown = "), composer.indexOf("// ---- files (D37, D50)"));
  test("the menu's keys come before the Enter that sends: pick or stop return, and the one IME guard leaves its keys", () => {
    const menu = keys.indexOf("if (slashShown) {");
    expect(menu).toBeGreaterThan(keys.indexOf("if (mentionShown) {"));
    expect(menu).toBeLessThan(keys.indexOf("if (menuVisible && !ime) {"));
    expect(menu).toBeLessThan(keys.indexOf('send(now === "send-now");'));
    const own = keys.slice(menu, keys.indexOf("if (menuVisible && !ime) {"));
    expect(own).toContain("const k = mentionKey({ key: e.key, shiftKey: e.shiftKey, ime }, n);");
    expect(own).toContain('if (k === "ime") return;');
    expect(own).toMatch(/if \(k === "pick" \|\| k === "stop"\) \{\s*e\.preventDefault\(\);\s*if \(k === "pick"\) pickSlash\(slashAt\);\s*return;\s*\}/);
    expect(own).not.toContain("send(");
  });
  test("it opens from the input event and the caret, never from a key, and follows the caret", () => {
    const change = composer.slice(composer.indexOf("const onChange = "), composer.indexOf("const onKeyDown = "));
    expect(change).toContain("followSlash(nextSlash(slash, d, next, field.current?.selectionStart ?? value.length, inputType.current));");
    expect(change.indexOf("followSlash(")).toBeLessThan(change.indexOf("inputType.current = null;"));
    const select = composer.slice(composer.indexOf("const onSelect = "), composer.indexOf("const onChange = "));
    expect(select).toContain('tokenAt(el.value, slash.at, el.selectionStart, "/")');
  });
  test("a pick is plain text in the field: no chip, no mode change, no route, nothing sent", () => {
    const pick = composer.slice(composer.indexOf("const pickSlash = "), composer.indexOf("// ---- the `@` picker (9.3) ----"));
    expect(pick).toContain("const out = slashPick(d.text, slash, c.name);");
    expect(pick).toContain("commit({ ...d, text: out.text });");
    expect(pick).toContain("caretTo.current = out.caret;");
    for (const no of ["navigate(", "closeTo(", "act.", "send(", "command:", "mode:", "openInTerminalHref", "setMenuOpen("]) expect(pick).not.toContain(no);
  });
  test("one / menu: the mid-line one is SlashMenu over commandRows, in the start menu's place, with the field's own state (no URL)", () => {
    expect(composer).toContain("const slashRows = useMemo(() => (slashOpen ? commandRows(slash.filter) : NO_COMMANDS), [menu, slashOpen, slash?.filter]);");
    expect(composer).toContain("<SlashMenu id={menuId} rows={slashRows} active={slashAt} filter={slash.filter} inText maxHeight={slashMaxHeight} onPick={pickSlash} onHover={setSlashActive} onClose={closeSlash} />");
    expect([...composer.matchAll(/<SlashMenu /g)].length).toBe(2);
    expect(src("composer", "SlashMenu.tsx").match(/export function SlashMenu/g)?.length).toBe(1);
    // Only SlashMenu draws command rows.
    for (const f of ["Composer.tsx", "MentionMenu.tsx", "PlusMenu.tsx", "Pickers.tsx"]) expect(src("composer", f)).not.toContain("cmp-slash-row");
    expect(src("composer", "slashToken.ts")).not.toMatch(/navigate|href\(|location/);
  });
  test("it shows in Chat mode and in a command's arguments only, never beside the start menu or the @ picker", () => {
    // Row 80: hidden while the chat is held (held-box.test.ts), and back as it was when the hold ends.
    expect(composer).toContain("const slashOpen = slash !== null && slashField(d) && !menuVisible && !mentionShown && !held;");
  });
  test("it shows only with a row: with none its keys are the field's own, so Enter sends; the token stays open", () => {
    expect(composer).toContain("const slashShown = slashOpen && slashRows.length > 0;");
    // The list is read while the token is open, so its rows can come; the token follows the text as before.
    expect(composer).toContain("if ((menuVisible || slashOpen) && !commandsKnown) void act.load(chat.id, \"commands\");");
    expect(composer).not.toMatch(/followSlash\([^)]*slashRows/);
    // The keys' branch, the menu and the field's aria are all the shown menu's.
    expect(keys).toContain("if (slashShown) {");
    expect(composer).toContain("{slashShown ? (");
    expect(composer).toContain("aria-controls={menuVisible || slashShown ? menuId : mentionShown ? mentionId : undefined}");
  });
  test("the things that close the @ picker close it too: Send, the server's draft, a link, a popup, a press outside, the keyboard", () => {
    const send = composer.slice(composer.indexOf("const send = (now = false) => {"), composer.indexOf("const stop = () =>"));
    expect(send).toContain("setSlash(null);");
    const server = composer.slice(composer.indexOf("// The server's draft changed"), composer.indexOf("// A composer link was opened"));
    expect(server).toContain("setSlash(null);");
    const link = composer.slice(composer.indexOf("// A composer link was opened"), composer.indexOf("// DESIGN.md 5.3: on a composer path"));
    expect(link).toContain("setSlash(null);");
    const popup = composer.slice(composer.indexOf("const openPopup = "), composer.indexOf("const closePopup = "));
    expect(popup).toContain("if (slashShown) closeSlash();");
    const outside = composer.slice(composer.indexOf("// Close the / menu, or the `@` picker, on a press outside"), composer.indexOf("// ---- the field ----"));
    expect(outside).toContain("if (!menuVisible && !mentionShown && !slashShown) return;");
    const kb = composer.slice(composer.indexOf("const kb = useSoftKeyboard("), composer.indexOf("const [focusIn, setFocusIn]"));
    expect(kb).toContain("closeSlash();");
    // The chip's Backspace makes the field the command filter: the mid-line menu goes.
    const back = keys.slice(keys.indexOf('if (e.key === "Backspace"'));
    expect(back.slice(0, back.indexOf("if (d.mode === \"bash\")"))).toContain("setSlash(null);");
  });
});
