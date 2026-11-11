// The `@` picker's rules as pure functions (web/composer/mention.ts; DESIGN.md 6.4, 9.3; BUILD-CHECKLIST C6, L13): the
// token rule (a typed `@` at the start of the field or after white space, in Chat mode only; never inside a word,
// never from a paste, a drop or a link), the token that follows the caret and closes on white space, the text after a
// pick, the `@` button's insert, a /c/<chat>/mention link's pre-fill, and the picker's key function: Enter never sends,
// also with no row, and a laptop input method keeps its keys. No browser: the routes come from the real router.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseUrl } from "../../web/router";
import { EMPTY, fromStore, prefillOf } from "../../web/composer/draft";
import { insertAt, linkToken, mentionFill, mentionKey, nextToken, tokenAt, typedAt, waitedPick, withoutToken } from "../../web/composer/mention";
import { createFileEngine } from "../../web/search/engine";
import type { CorpusSearchReply } from "../../shared/corpus";
import { linkNoticeLine } from "../../web/ui/LinkNotice";
import { composingKey } from "../../web/ui/primitives";

const at = (u: string) => parseUrl(new URL(u, "http://127.0.0.1:7944"));
const C = "k3m7q2x4abk3m7q2x4ab";
const chat = (text: string) => ({ mode: "chat", text });

describe("a typed @ opens the picker (6.4)", () => {
  test("at the start of the field, or after white space, typed or committed by an input method", () => {
    expect(typedAt("", "@", 1, "insertText")).toBe(0);
    expect(typedAt("look at ", "look at @", 9, "insertText")).toBe(8);
    expect(typedAt("line one\n", "line one\n@", 10, "insertText")).toBe(9);
    // In the middle of the text, before other words (the caret right after the new @).
    expect(typedAt("read  please", "read @ please", 6, "insertText")).toBe(5);
    // An Android keyboard or an input method commits text with no key event: the input event alone opens it.
    expect(typedAt("see ", "see @", 5, "insertCompositionText")).toBe(4);
    // Typed over a selection: the selected text goes, the @ takes its place.
    expect(typedAt("see this", "see @", 5, "insertText")).toBe(4);
  });
  test("never inside a word (an e-mail address), never twice in a row, never for a change that typed no @", () => {
    expect(typedAt("mail me", "mail me@", 8, "insertText")).toBe(-1);
    expect(typedAt("a", "a@", 2, "insertText")).toBe(-1);
    expect(typedAt("@", "@@", 2, "insertText")).toBe(-1);
    expect(typedAt("@", "@x", 2, "insertText")).toBe(-1);
    expect(typedAt("", "x", 1, "insertText")).toBe(-1);
    expect(typedAt("", "", 0, "insertText")).toBe(-1);
  });
  test("never from a paste, a drop, an autocorrect's replacement or a deletion", () => {
    for (const t of ["insertFromPaste", "insertFromDrop", "insertReplacementText", "insertFromYank", "deleteContentBackward", "deleteContentForward"]) {
      expect(typedAt("", "@", 1, t)).toBe(-1);
      expect(typedAt("see ", "see @", 5, t)).toBe(-1);
    }
    // A deletion that leaves an @ before the caret is no typed @, whatever the input type says.
    expect(typedAt("@ab", "@b", 1, null)).toBe(-1);
    // With an unknown input type, only a plain insert counts.
    expect(typedAt("see ", "see @", 5, null)).toBe(4);
    expect(typedAt("see this", "see @", 5, null)).toBe(-1);
  });
  test("Chat mode only: in Bash mode @ is shell text, in / mode the field is a command", () => {
    expect(nextToken(null, chat(""), chat("@"), 1, "insertText")).toEqual({ at: 0, filter: "" });
    expect(nextToken(null, { mode: "bash", text: "git log " }, { mode: "bash", text: "git log @" }, 9, "insertText")).toBeNull();
    expect(nextToken(null, { mode: "slash", text: "" }, { mode: "slash", text: "@" }, 1, "insertText")).toBeNull();
    // A mode change closes an open picker.
    expect(nextToken({ at: 0, filter: "x" }, chat("@x"), { mode: "bash", text: "@x" }, 2, "insertText")).toBeNull();
  });
  test("a link's text never opens it: /send?text=@upl fills plain text, and only the user's own typed @ opens", () => {
    const pre = prefillOf(at(`/c/${C}/send?text=${encodeURIComponent("@upl")}`))!;
    expect(pre.draft).toEqual({ mode: "chat", command: null, text: "@upl", fromLink: true });
    expect(pre.mention).toBeUndefined();
    // Typing after the link's @upl is no typed @.
    expect(nextToken(null, chat("@upl"), chat("@uplx"), 5, "insertText")).toBeNull();
  });
});

describe("the open picker's token", () => {
  test("its filter is the text from after the @ to the caret", () => {
    expect(tokenAt("@comp", 0, 5)).toEqual({ at: 0, filter: "comp" });
    expect(tokenAt("fix @web/comp now", 4, 13)).toEqual({ at: 4, filter: "web/comp" });
    // The caret inside the token: the filter is the part before it.
    expect(tokenAt("@composer", 0, 4)).toEqual({ at: 0, filter: "com" });
  });
  test("it closes on white space, when the @ is gone or moved, when the caret leaves it, and past the route's 1,024", () => {
    expect(tokenAt("@comp ", 0, 6)).toBeNull();
    expect(tokenAt("@co\nmp", 0, 6)).toBeNull();
    expect(tokenAt("comp", 0, 4)).toBeNull();
    expect(tokenAt("x@comp", 1, 6)).toBeNull();
    expect(tokenAt("@comp", 0, 0)).toBeNull();
    expect(tokenAt("a @comp", 2, 1)).toBeNull();
    expect(tokenAt(`@${"a".repeat(1024)}`, 0, 1025)).toEqual({ at: 0, filter: "a".repeat(1024) });
    expect(tokenAt(`@${"a".repeat(1025)}`, 0, 1026)).toBeNull();
  });
  test("it follows the typing: a letter narrows, Backspace widens, Backspace over the @ closes", () => {
    const open = { at: 4, filter: "" };
    const one = nextToken(open, chat("fix @"), chat("fix @c"), 6, "insertText");
    expect(one).toEqual({ at: 4, filter: "c" });
    expect(nextToken(one, chat("fix @c"), chat("fix @"), 5, "deleteContentBackward")).toEqual({ at: 4, filter: "" });
    expect(nextToken(open, chat("fix @"), chat("fix "), 4, "deleteContentBackward")).toBeNull();
    expect(nextToken(one, chat("fix @c"), chat("fix @c "), 7, "insertText")).toBeNull();
  });
});

describe("a pick, the @ button and a mention link", () => {
  test("a pick takes the @<filter> text out and puts the caret where the @ was", () => {
    expect(withoutToken("@comp", { at: 0, filter: "comp" })).toEqual({ text: "", caret: 0 });
    expect(withoutToken("fix @comp now", { at: 4, filter: "comp" })).toEqual({ text: "fix  now", caret: 4 });
    // The caret was inside the token: the rest of the word stays.
    expect(withoutToken("@composer", { at: 0, filter: "com" })).toEqual({ text: "poser", caret: 0 });
  });
  test("the @ button puts @ at the caret, with a space first inside a word, over a selection too", () => {
    expect(insertAt("", 0, 0)).toEqual({ text: "@", at: 0 });
    expect(insertAt("see ", 4, 4)).toEqual({ text: "see @", at: 4 });
    expect(insertAt("see", 3, 3)).toEqual({ text: "see @", at: 4 });
    expect(insertAt("see this", 4, 8)).toEqual({ text: "see @", at: 4 });
    // The new @ opens the picker: it is at a word start.
    for (const [text, s, e] of [["", 0, 0], ["see", 3, 3], ["a b", 1, 1]] as const) {
      const put = insertAt(text, s, e);
      expect(tokenAt(put.text, put.at, put.at + 1)).toEqual({ at: put.at, filter: "" });
    }
  });
  test("/c/<chat>/mention?q= fills @<q> after the box's text, as the picker's token; it is not a draft by itself", () => {
    const pre = prefillOf(at(`/c/${C}/mention?q=upl`))!;
    expect(pre.mention).toBe("upl");
    expect(pre.draft).toBeUndefined();
    expect(pre.key).toBe("mention|upl");
    expect(pre.overCap).toBe(false);
    expect(prefillOf(at(`/c/${C}/mention`))).toMatchObject({ key: "mention|", mention: "" });
    expect(linkToken("", "upl")).toEqual({ text: "@upl", at: 0, lead: "" });
    expect(linkToken("fix this", "upl")).toEqual({ text: "fix this @upl", at: 9, lead: " " });
    expect(linkToken("fix this ", "")).toEqual({ text: "fix this @", at: 9, lead: "" });
  });
  test("the link's @<q> goes after the box's own text (the server's draft, also when it comes after the field was built)", () => {
    // The page loads /c/<chat>/mention?q=upl before the chat's draft came: the field holds the link's token only.
    expect(mentionFill(fromStore({ mode: "chat", command: null, text: "" }), "upl").draft.text).toBe("@upl");
    // The draft comes ("keep me", typed on another page): the token goes after it, and the picker's token moves with it.
    const fill = mentionFill(fromStore({ mode: "chat", command: null, text: "keep me" }), "upl");
    expect(fill.draft).toEqual({ mode: "chat", command: null, text: "keep me @upl", fromLink: true });
    expect(fill.mention).toEqual({ at: 8, filter: "upl", link: { lead: " ", fromLink: false } });
    // A `!` or `/` draft cannot hold the picker: the link's token takes its place.
    expect(mentionFill(fromStore({ mode: "bash", command: null, text: "ls" }), "upl").draft.text).toBe("@upl");
    // An empty q: "@" alone, which is no link text (no warning line).
    expect(mentionFill(fromStore({ mode: "chat", command: null, text: "keep me" }), "")).toMatchObject({ draft: { text: "keep me @", fromLink: false }, mention: { at: 8, filter: "" } });
  });
  test("a pick, or a close with no pick, takes the link's @<q> out with the space the link put before it: the box is as it was", () => {
    const fill = mentionFill(fromStore({ mode: "chat", command: null, text: "keep me" }), "upl");
    expect(withoutToken(fill.draft.text, fill.mention!)).toEqual({ text: "keep me", caret: 7 });
    // The user typed more of the filter: the whole token goes.
    expect(withoutToken("keep me @uplo", { ...fill.mention!, filter: "uplo" })).toEqual({ text: "keep me", caret: 7 });
    // A typed token keeps the space the user typed.
    expect(withoutToken("keep me @upl", { at: 8, filter: "upl" })).toEqual({ text: "keep me ", caret: 8 });
    // The box's text ended in white space: the link put none, and none is taken.
    const spaced = mentionFill(fromStore({ mode: "chat", command: null, text: "keep me\n" }), "upl");
    expect(withoutToken(spaced.draft.text, spaced.mention!)).toEqual({ text: "keep me\n", caret: 8 });
  });
  test("a q that a filter cannot hold (white space, over 1,024 characters) is dropped with 5.4's line, and the picker opens with no filter", () => {
    const two = prefillOf(at(`/c/${C}/mention?q=two%20words`))!;
    expect(two).toMatchObject({ mention: "", dropped: true, overCap: false });
    expect(two.key).toBe("mention|two words");
    // A control character: the router drops the value and says so itself (ChatView's line); the composer adds none.
    expect(at(`/c/${C}/mention?q=a%07b`).dropped).toBe(true);
    expect(prefillOf(at(`/c/${C}/mention?q=a%07b`))).toMatchObject({ mention: "", dropped: false });
    expect(prefillOf(at(`/c/${C}/mention?q=${"a".repeat(1025)}`))).toMatchObject({ mention: "", dropped: true });
    expect(prefillOf(at(`/c/${C}/mention?q=${"a".repeat(1024)}`))).toMatchObject({ mention: "a".repeat(1024), dropped: false });
    expect(prefillOf(at(`/c/${C}/mention?q=upl`))).toMatchObject({ mention: "upl", dropped: false });
    // The line is the router's own words for a value that did not parse (the composer shows it, as it does the over-cap
    // line, unless the route has a line of its own).
    const src = readFileSync(join(import.meta.dir, "..", "..", "web", "composer", "Composer.tsx"), "utf8");
    expect(src).toContain("const droppedLine = pre?.dropped && !linkNoticeLine(route) ? linkNoticeLine({ ...route, dropped: true }) : null;");
    expect(linkNoticeLine({ ...at(`/c/${C}/mention?q=two%20words`), dropped: true })).toBe("Part of that link could not be read.");
  });
  test("a q over its cap fills nothing and opens nothing; 5.4's over-cap line says why", () => {
    const g = globalThis as { location?: unknown };
    const had = "location" in g;
    const was = g.location;
    g.location = { search: `?q=${"x".repeat(5001)}` };
    try {
      const pre = prefillOf(at(`/c/${C}/mention?q=${"x".repeat(5001)}`))!;
      expect(pre).toEqual({ key: "mention|over", overCap: true, notAvailable: false });
    } finally {
      if (had) g.location = was;
      else delete g.location;
    }
  });
  test("the other composer links are as they were", () => {
    expect(prefillOf(at(`/c/${C}`))).toBeNull();
    expect(prefillOf(at(`/c/${C}/send?text=hi`))!.draft).toEqual({ ...EMPTY, text: "hi", fromLink: true });
  });
});

describe("the picker's keys (6.4, L13)", () => {
  const key = (k: string, rows: number, more: { shiftKey?: boolean; ime?: boolean } = {}) => mentionKey({ key: k, shiftKey: more.shiftKey ?? false, ime: more.ime ?? false }, rows);
  test("Up and Down move, Enter and Tab pick", () => {
    expect(key("ArrowDown", 3)).toBe("down");
    expect(key("ArrowUp", 3)).toBe("up");
    expect(key("Enter", 3)).toBe("pick");
    expect(key("Tab", 3)).toBe("pick");
  });
  test("Enter never sends: with no row it does nothing (also before the list came)", () => {
    expect(key("Enter", 0)).toBe("stop");
    for (const rows of [0, 1, 120]) expect(key("Enter", rows)).not.toBe("pass");
  });
  test("Shift+Enter makes a new line (white space closes the picker); Tab with no row and Shift+Tab move the focus", () => {
    expect(key("Enter", 3, { shiftKey: true })).toBe("pass");
    expect(key("Tab", 0)).toBe("pass");
    expect(key("Tab", 3, { shiftKey: true })).toBe("pass");
    expect(key("ArrowDown", 0)).toBe("pass");
    expect(key("a", 3)).toBe("pass");
  });
  test("a laptop input method's Enter, Tab, arrows and Esc are its own; on touch Enter picks at once", () => {
    for (const k of ["Enter", "Tab", "ArrowDown", "ArrowUp", "Escape"]) for (const rows of [0, 3]) expect(key(k, rows, { ime: true })).toBe("ime");
    // The one guard (ui/primitives): composing, or the key code 229, with a fine pointer only.
    expect(composingKey({ isComposing: true, keyCode: 13 }, false)).toBe(true);
    expect(composingKey({ isComposing: false, keyCode: 229 }, false)).toBe(true);
    expect(composingKey({ isComposing: true, keyCode: 13 }, true)).toBe(false);
    expect(composingKey({ isComposing: false, keyCode: 13 }, false)).toBe(false);
    expect(key("Enter", 3, { ime: composingKey({ isComposing: true, keyCode: 13 }, true) })).toBe("pick");
  });
  test("Enter or Tab before the rows answer the filter waits for them: it never picks a row of an older filter", () => {
    const stale = (k: string, rows: number, more: { shiftKey?: boolean; ime?: boolean } = {}) => mentionKey({ key: k, shiftKey: more.shiftKey ?? false, ime: more.ime ?? false }, rows, false);
    for (const rows of [0, 3]) {
      expect(stale("Enter", rows)).toBe("wait");
      expect(stale("Tab", rows)).toBe("wait");
      expect(stale("Enter", rows, { ime: true })).toBe("ime");
      expect(stale("Enter", rows, { shiftKey: true })).toBe("pass");
      expect(stale("Tab", rows, { shiftKey: true })).toBe("pass");
    }
    expect(stale("ArrowDown", 3)).toBe("down");
  });
  test("the server path: a whole word in one input, then Return at once, picks the first row of that word's answer", async () => {
    const answers = new Map<string, (r: CorpusSearchReply) => void>();
    const engine = createFileEngine({ at: "server", search: (q) => new Promise<CorpusSearchReply>((res) => answers.set(q, res)) });
    const reply = (paths: string[]): CorpusSearchReply => ({ v: "v1", total: 100_000, count: paths.length, rows: paths.map((path) => ({ path, nameRanges: [] })) });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    engine.ask("");
    answers.get("")!(reply(["assets/team-notes.md", "assets/🚀 launch plan.md"]));
    await tick();
    // A keyboard suggestion's tap puts "launch" in one input; Return comes before the server's answer for it.
    const open = { at: 0, filter: "launch" };
    engine.ask("launch");
    const shown = engine.rows("launch")!;
    expect(shown.q).toBe("");
    expect(mentionKey({ key: "Enter", shiftKey: false, ime: false }, shown.rows.length, shown.q === open.filter)).toBe("wait");
    expect(waitedPick(open, open, shown)).toBe("wait");
    answers.get("launch")!(reply(["assets/🚀 launch plan.md"]));
    await tick();
    const now = engine.rows("launch")!;
    expect(waitedPick(open, open, now)).toBe(0);
    expect(now.rows[0]!.path).toBe("assets/🚀 launch plan.md");
    // The token changed in the meantime (one more letter, the picker closed): the remembered key is dropped.
    expect(waitedPick(open, { at: 0, filter: "launchx" }, now)).toBe("drop");
    expect(waitedPick(open, { at: 2, filter: "launch" }, now)).toBe("drop");
    expect(waitedPick(open, null, now)).toBe("drop");
    // Nothing matches, or the search failed: nothing to pick, and still nothing is sent.
    expect(waitedPick(open, open, { q: "launch", count: 0, rows: [] })).toBe("drop");
    expect(waitedPick(open, open, { q: "launch", count: 0, rows: [], failed: true })).toBe("drop");
    // Before any list came.
    expect(waitedPick(open, open, null)).toBe("wait");
    engine.close();
  });
});

describe("the composer's part (web/composer/Composer.tsx)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "..", "web", "composer", "Composer.tsx"), "utf8");
  test("the picker's keys come first, and pick or stop return before the Enter that sends", () => {
    const keys = src.slice(src.indexOf("const onKeyDown = "), src.indexOf("// ---- files (D37, D50)"));
    const picker = keys.indexOf("if (mentionShown) {");
    expect(picker).toBeGreaterThan(0);
    expect(keys).toContain('if (k === "ime") return;');
    expect(keys).toMatch(/if \(k === "pick" \|\| k === "stop"\) \{\s*e\.preventDefault\(\);\s*if \(k === "pick"\) pickMention\(mentionAt\);\s*return;\s*\}/);
    expect(picker).toBeLessThan(keys.indexOf('send(now === "send-now");'));
    // The / menu's arrows, Tab and Enter wait for an input method too (one guard for both menus: composition.ts).
    expect(keys).toContain("const ime = imeKey(e.nativeEvent, coarse);");
    expect(keys).toContain("if (menuVisible && !ime) {");
  });
  test("the picker opens from the input event and the caret, never from a key; a pick asks no upload route", () => {
    const change = src.slice(src.indexOf("const onChange = "), src.indexOf("const onKeyDown = "));
    expect(change).toContain("followMention(mentionAfter(next, field.current?.selectionStart ?? value.length));");
    expect(src).toContain("inputType.current = (e as InputEvent).inputType ?? null;");
    const pick = src.slice(src.indexOf("const pickMention = "), src.indexOf("const openAt = "));
    expect(pick).toContain("act.addMention(chat.id, row.path);");
    expect(pick).not.toMatch(/upload|apiSend|fetch\(/i);
    expect(src).toContain("act.removeMention(chat.id, path);");
  });
  test("a mention link's untouched token follows the server's draft when it comes (on attach, or from another page)", () => {
    const effect = src.slice(src.indexOf("// The server's draft changed"), src.indexOf("// A composer link was opened"));
    expect(effect).toContain("if (prefilled.current && pre?.mention !== undefined && mention?.link) {");
    expect(effect).toContain("const fill = mentionFill(next, pre.mention);");
    // The refill is no edit: nothing is saved, the composer has written nothing.
    const refill = effect.slice(effect.indexOf("const fill = mentionFill(next, pre.mention);"), effect.indexOf("if (route.name === \"slashMenu\""));
    expect(refill).not.toContain("act.");
    expect(refill).not.toContain("commit(");
    expect(refill).not.toContain("written.current =");
  });
  test("Enter or Tab before the rows for the filter came is remembered, and picks once they come", () => {
    const keys = src.slice(src.indexOf("const onKeyDown = "), src.indexOf("// ---- files (D37, D50)"));
    expect(keys).toContain("const k = mentionKey({ key: e.key, shiftKey: e.shiftKey, ime }, n, mentionCurrent);");
    expect(keys).toMatch(/if \(k === "wait"\) \{\s*e\.preventDefault\(\);\s*waiting\.current = \{ at: mention\.at, filter: mention\.filter \};\s*return;\s*\}/);
    // Rows of an older filter make the key wait; before any list came there is no row, and Enter does nothing (stop).
    expect(src).toContain("const mentionCurrent = !fileRows || fileRows.q === mention?.filter;");
    expect(mentionKey({ key: "Enter", shiftKey: false, ime: false }, 0, true)).toBe("stop");
    expect(src).toContain("const next = waitedPick(waiting.current, mentionShown ? mention : null, fileRows);");
  });
  test("closing a link's picker with no pick takes the link's @<q> out; the @ button closes the open picker", () => {
    const close = src.slice(src.indexOf("const closeMention = "), src.indexOf("const pickMention = "));
    expect(close).toContain("if (mention?.link) dropLink(mention);");
    const drop = src.slice(src.indexOf("const dropLink = "), src.indexOf("const closeMention = "));
    // Untouched, the box is the server's draft again with no frame; after an edit, the edit without the token is saved.
    expect(drop).toContain("const back = fromStore(stored);");
    expect(drop).toContain("commit({ ...d, text: out.text, fromLink: m.link.fromLink && out.text !== \"\" });");
    // Back from the link closes it the same way.
    const link = src.slice(src.indexOf("// A composer link was opened"), src.indexOf("// DESIGN.md 5.3: on a composer path"));
    expect(link).toContain("if (was?.startsWith(\"mention|\")) {");
    expect(link).toContain("if (mention?.link) dropLink(mention);");
    expect(src).toContain("<AtButton open={mentionShown} off={isHeld} onOpen={openAt} onClose={closeAtPicker} />");
  });
  test("Send closes the picker; the mention chips count as files for Send", () => {
    const send = src.slice(src.indexOf("const send = (now = false) => {"), src.indexOf("const stop = () =>"));
    expect(send).toContain("setMention(null);");
    expect(src).toContain("const ids = useMemo(() => (mentions.length ? [...uploadIds, ...mentions] : uploadIds), [uploadIds, mentions]);");
  });
  test("the @ button only on a coarse pointer and in Chat mode, beside + in the phone's field row and the tablet's bar", () => {
    // Row 80: off while the chat is held (held-box.test.ts).
    expect(src).toContain('const atButton = coarse && d.mode === "chat" ? <AtButton open={mentionShown} off={isHeld} onOpen={openAt} onClose={closeAtPicker} /> : null;');
    expect(src).toContain("{phone ? plusButton : null}\n              {phone ? atButton : null}");
    expect(src).toContain("{plusButton}\n                {atButton}");
  });
});
