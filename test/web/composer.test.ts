// The composer on the server's lists (DESIGN.md 6.4 to 6.6, D49, D52; MINIMALISM M11, M12, M13, M19): the labels from
// the chat's own model rows, effort as the user's pick or Default, the pickers' one head line, the + menu's items,
// and the draft rules the composer keeps (the store keeps the rest: test/web/store.test.ts). No browser; the lists
// render with react-dom/server in a laptop window stand-in.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getState, modelRows, resetState } from "../../web/state/store";
import type { Chat, ModelRow } from "../../web/state/types";
import { effortLabel, effortLevel, effortsFor, modelLabel, showsEffort, supportsAuto } from "../../web/composer/labels";
import { linkMode, markLink, resetLinkMarks, textKey } from "../../web/composer/linkDrafts";
import { headLine, hasRemembered, markPicked, resetPicked } from "../../web/composer/origin";
import { ConnectorProblems } from "../../web/panels/problems";
import { EffortList, ModeList, ModelList } from "../../web/composer/lists";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

// The seed's rows, as `get models` answers them (sdk.d.ts ModelInfo, shared/protocol.ts).
const ROWS: ModelRow[] = modelRows({
  models: [
    { value: "default", displayName: "Default (recommended)", description: "Use the default model (currently Opus 5.5)", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
    { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "Most capable for complex work", efforts: ["low", "medium", "high", "xhigh", "max"], supportsAutoMode: true },
    { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "Earlier Opus", efforts: ["low", "medium", "high"], supportsAutoMode: false },
  ],
});

describe("labels from the chat's own rows", () => {
  test("a row's display name; the Default row names the model it stands for, else says Default", () => {
    expect(modelLabel("claude-opus-5-5", ROWS)).toBe("Opus 5.5");
    expect(modelLabel("default", ROWS)).toBe("Default (Opus 5.5)");
    expect(modelLabel("default", [{ id: "default", label: "Default (recommended)", hint: "Use the default model", efforts: [], supportsAutoMode: true }])).toBe("Default");
    expect(modelLabel("default", [])).toBe("Default");
  });
  test("a value the rows do not hold: as it is once the rows came, Model before (never a guess)", () => {
    expect(modelLabel("claude-sonnet-9", ROWS, true)).toBe("claude-sonnet-9");
    expect(modelLabel("claude-sonnet-9", ROWS, false)).toBe("Model");
  });
  test("effort shows the user's pick, or Default with none (6.6, D52)", () => {
    expect(effortLabel("default")).toBe("Default");
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLevel("default")).toBe(0);
    expect(effortLevel("max")).toBe(5);
  });
  test("the model button says Default once while the model and the effort are both the user's defaults", () => {
    expect(showsEffort("default", "default")).toBe(false);
    expect(showsEffort("default", "high")).toBe(true);
    expect(showsEffort("claude-opus-5-5", "default")).toBe(true);
    // Before Claude Code reports its rows the model part says "Model": the effort beside it is not a repeat.
    expect(showsEffort("", "default")).toBe(true);
    const composer = src("composer", "Composer.tsx");
    expect(composer).toContain('const effortShown = isSwitching("effort") || showsEffort(chat.model, chat.effort);');
    expect(composer).toContain("{effortShown ? (");
    expect(composer).toContain("modelName={showsEffort(chat.model, chat.effort) ?");
  });
  test("the levels and Auto come from the model's row", () => {
    expect(effortsFor("claude-opus-4-6", ROWS)).toEqual(["low", "medium", "high"]);
    expect(supportsAuto("claude-opus-4-6", ROWS)).toBe(false);
    expect(supportsAuto("claude-opus-5-5", ROWS)).toBe(true);
    expect(supportsAuto("not-a-row", ROWS)).toBe(true);
  });
});

describe("the pickers' head line (M19)", () => {
  const chat = { id: "c1", model: "claude-opus-5-5", effort: "default", mode: "default" } as Pick<Chat, "id" | "model" | "effort" | "mode">;
  const project = { name: "kitespan" };
  test("none for a value this page did not pick: the check mark shows the current value", () => {
    resetPicked();
    expect(headLine("model", chat, project)).toBeNull();
    expect(headLine("effort", chat, project)).toBeNull();
  });
  test("after a switch here: new chats in the project start with it; nothing for Plan or for the default", () => {
    resetPicked();
    markPicked("c1", "model", "claude-opus-5-5");
    expect(headLine("model", chat, project)).toBe("Picked here; new chats in kitespan start with it");
    markPicked("c1", "mode", "plan");
    expect(headLine("mode", { ...chat, mode: "plan" }, project)).toBeNull();
    markPicked("c1", "effort", "default");
    expect(headLine("effort", chat, project)).toBeNull();
    // Another page switched since: the line goes.
    expect(headLine("model", { ...chat, model: "claude-opus-4-6" }, project)).toBeNull();
  });
  test("Forget shows while the project remembers a pick", () => {
    expect(hasRemembered({ picks: {} })).toBe(false);
    expect(hasRemembered({ picks: { model: "claude-opus-5-5" } })).toBe(true);
    expect(hasRemembered(undefined)).toBe(false);
  });
  test("each picker offers Forget only for a pick it shows: the mode menu not for a remembered model and effort", () => {
    const project = { picks: { model: "claude-opus-5-5", effort: "xhigh" } };
    expect(hasRemembered(project, ["mode"])).toBe(false);
    expect(hasRemembered(project, ["model", "effort"])).toBe(true);
    expect(hasRemembered({ picks: { mode: "acceptEdits" as const } }, ["mode"])).toBe(true);
    expect(hasRemembered({ picks: { mode: "acceptEdits" as const } }, ["model", "effort"])).toBe(false);
    const pickers = src("composer", "Pickers.tsx");
    expect(pickers).toContain("hasRemembered(project, forgets)");
    expect([...pickers.matchAll(/forgets=\{MODE_MENU\}/g)].length).toBe(2);
    expect([...pickers.matchAll(/forgets=\{MODEL_MENU\}/g)].length).toBe(2);
  });
  test("the old origin lines are gone from the pickers", () => {
    const all = src("composer", "Pickers.tsx") + src("composer", "origin.ts");
    for (const line of ["Picked in this chat only", "Your Claude Code setting for", "Your Claude Code default", "Last used in", "Started with your last choice"]) expect(all).not.toContain(line);
  });
});

describe("the + menu (6.5, M11, M12)", () => {
  test("Connectors says something only when a connector needs the user (the Details card's renderer)", () => {
    const value = (list: { status: "connected" | "failed" | "needs-auth" | "pending" | "disabled" }[]) => renderToStaticMarkup(createElement(ConnectorProblems, { list })).replace(/<[^>]+>/g, "");
    expect(value([])).toBe("");
    expect(value([{ status: "connected" }, { status: "pending" }])).toBe("");
    expect(value([{ status: "connected" }, { status: "failed" }])).toBe("1 failed");
    expect(value([{ status: "failed" }, { status: "needs-auth" }, { status: "needs-auth" }])).toBe("1 failed, 2 need sign-in");
    expect(value([{ status: "needs-auth" }])).toBe("1 needs sign-in");
  });
  test("no helper line under an item; Permission and Model only while the phone's picker row is folded", () => {
    const menu = src("composer", "PlusMenu.tsx");
    for (const line of ["Saved in", "Or type /", "The plugins this chat loaded", "connected\""]) expect(menu).not.toContain(line);
    // Plugins lists the chat's loaded plugins in the menu itself (6.5): no link to a page that does not exist.
    expect(menu).toContain('label="Plugins"');
    expect(src("composer", "Composer.tsx")).toContain("plugins={chat.init ? chat.init.plugins : null}");
    expect(menu).toContain('{pickers ? <Item sheet={sheet} tile="orange"');
    expect(menu).toContain('{pickers ? <Item sheet={sheet} tile="indigo"');
    const composer = src("composer", "Composer.tsx");
    expect(composer).toContain("pickers={phone && plusFolded.current}");
    expect(composer).toContain("plusFolded.current = phone && riding;");
  });
  test("the iPhone fix stays: Add files or photos closes the menu as it opens the picker (f3e538b)", () => {
    const composer = src("composer", "Composer.tsx");
    // Row 80: the + menu opens only while the box can be used (not while another app holds the session).
    expect(composer).toContain('const addOpen = !held && route.name === "add";');
    expect(composer).toContain("open={addOpen && !picking}");
    expect(composer).toContain("fileInput.current?.click();\n              setPicking(true);\n              closeTo(chatUrl);");
    expect(composer).toContain('input?.addEventListener("cancel", back);');
  });
});

describe("the lists render the chat's rows", () => {
  const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
  const own = { mm: !g.matchMedia, win: !g.window };
  beforeAll(() => {
    if (own.mm) g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    if (own.win) g.window = { innerWidth: 1100, innerHeight: 800, matchMedia: g.matchMedia, addEventListener() {}, removeEventListener() {} };
  });
  afterAll(() => {
    if (own.mm) delete g.matchMedia;
    if (own.win) delete g.window;
  });
  const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
  test("the model list: each row's name and line, the current one checked, a link's pick marked", () => {
    const out = html(createElement(ModelList, { value: "claude-opus-5-5", marked: "claude-opus-4-6", rows: ROWS, grouped: false, onPick() {} }));
    expect(out).toContain("Use the default model (currently Opus 5.5)");
    expect(out).toMatch(/aria-checked="true"[^>]*data-value="claude-opus-5-5"/);
    expect(out).toMatch(/data-value="claude-opus-4-6"[^>]*class="[^"]*is-marked/);
    expect(out).toContain("From the link");
  });
  test("the effort list starts with Default, which is checked while the user picked no level", () => {
    const out = html(createElement(EffortList, { model: "claude-opus-4-6", value: "default", rows: ROWS, grouped: false, withDefault: true, onPick() {} }));
    expect([...out.matchAll(/data-value="([a-z]+)"/g)].map((m) => m[1])).toEqual(["default", "low", "medium", "high"]);
    expect(out).toMatch(/aria-checked="true"[^>]*data-value="default"/);
    // The new-chat form's list has no Default row unless it asks for one.
    expect(html(createElement(EffortList, { model: "claude-opus-4-6", value: "", rows: ROWS, grouped: false, onPick() {} }))).not.toContain('data-value="default"');
  });
  test("the mode list turns Auto off on a model whose row cannot run it", () => {
    const out = html(createElement(ModeList, { value: "default", allowBypass: false, model: "claude-opus-4-6", rows: ROWS, grouped: false, onPick() {} }));
    expect(out).toContain("Auto needs a model that supports it.");
    expect(out).not.toContain("Bypass permissions");
  });
});

describe("the composer's part of the draft rules (D49, 7.5)", () => {
  const composer = src("composer", "Composer.tsx");
  test("a draft is saved at once on blur, and an input method that composes holds a draft from the server", () => {
    expect(composer).toContain("flushDrafts(); // a draft is saved at once on blur (7.5)");
    expect(composer).toContain("onCompositionStart={() => act.setComposing(chat.id, true)}");
    expect(composer).toContain("onCompositionEnd={() => act.setComposing(chat.id, false)}");
  });
  test("a link's pre-fill or text the user has not changed keeps its place and is never saved by itself", () => {
    expect(composer).toContain("const untouchedLink = prefilled.current || (d.fromLink && draftKey(d) !== written.current);");
    expect(composer).toContain("if (untouchedLink && !leftLately(chat.id)) {");
    // act.setDraft runs only from commit, the user's own change, from Send's set-aside text, for a refused /
    // command that takes that text's place again, and (R124) for a /btw side question that another page's running
    // one turned away (busy), which comes back as it was.
    expect([...composer.matchAll(/act\.setDraft\(/g)].length).toBe(4);
    expect(composer).toContain("if (key !== storedKey) act.setDraft(chat.id, toInput(next));");
  });
  test("the draft's mode is the store's own field, never its text's first character (D49, the safety fix)", () => {
    expect(composer).toContain("const stored = useStore((s) => draftOf(s, chat.id));");
    expect(composer).toContain("const next = fromStore(stored);");
    expect(composer).toContain("let next = typed(d, value, replacingAll.current);");
    // No reading of the one-string form, and no link marks beside it.
    expect(composer).not.toMatch(/s\.drafts\[|markLink|linkMode|fromServer|serialize\(/);
    expect(src("chat", "ChatScreen.tsx")).not.toContain("s.drafts[");
  });
  test("the field measures its height again when its placeholder changes (an empty field's height is its placeholder's)", () => {
    // A chat's page opens with "Ask Claude to work in <folder>" until its items come, then "Reply to Claude…". On the
    // phone, beside + and @, the first one takes two lines: a height measured for it alone stays two lines high.
    const effect = /el\.style\.height = "auto";[\s\S]*?\}, \[([^\]]*)\]\);/.exec(composer);
    expect(effect).not.toBeNull();
    expect(effect![1]!.split(",").map((s) => s.trim())).toContain("placeholder");
    // The dependency is read during the render, so the effect comes after the placeholder's const.
    expect(composer.indexOf("const placeholder =")).toBeGreaterThan(0);
    expect(composer.indexOf("const placeholder =")).toBeLessThan(composer.indexOf('el.style.height = "auto";'));
  });
  test("a taken draft changes the field's value only, keeps the focus and puts the caret at the end", () => {
    expect(composer).toContain("if (document.activeElement === field.current) caretTo.current = next.text.length;");
    expect(composer).toContain("<ComposerBody key={chat.id} chat={chat} route={route} />");
  });
  test("Stop names the turn's turn_start seq; Send and Run go through act.send and act.bash with the box's draft", () => {
    expect(composer).toContain('const canStop = chat.turn !== null || held?.kind === "finishing";');
    // The box's draft goes with the request, so a refused one comes back as it was: a link's text keeps its mark and
    // its warning line (5.1 rule 7), also when it was never saved as the store's draft.
    expect(composer).toContain('const done = d.mode === "bash" ? act.bash(chat.id, message, toInput(d)) : act.send(chat.id, message, toInput(d), now);');
  });
  test("Send and Run empty the box and close a link's route at the press, so the text is in one place and a remount cannot send it again", () => {
    const send = composer.slice(composer.indexOf("const send = (now = false) => {"), composer.indexOf("const stop = () =>"));
    expect(send).toContain("if (!canSend) return;");
    // The box empties (to the set-aside chat text, if any) and the route closes in the press's own handler, before
    // any answer: nothing waits on component state that a remount (a chat switch and back) would lose (F2, F6).
    const press = send.slice(0, send.indexOf("void done.then("));
    expect(press).toContain("const next = aside ?? EMPTY;");
    expect(press.indexOf("act.send(chat.id, message, toInput(d), now)")).toBeLessThan(press.indexOf("setD(next);"));
    expect(press).toContain("leaveRoute();");
    expect(composer).not.toMatch(/setSending|const \[sending/);
    // Row 78: nothing sends while another app holds the session (the box's line takes Send's place). R124: nor a /btw
    // side question over its 5,000 characters (its own line says so).
    expect(composer).toContain("const canSend = !held && !uploading && !sideOver && (message !== \"\" || (d.mode === \"chat\" && ids.length > 0));");
    // A refused / command takes the place of the chat text that + > Slash commands set aside, which goes aside again.
    const answer = send.slice(send.indexOf("void done.then("));
    expect(answer).toContain("if (ok || !shown.current.mounted || draftKey(shown.current.d) !== draftKey(aside)) return;");
    expect(answer).toContain("stash.current = aside;");
  });
  test("no line under the Bash composer explains Bash mode (M13); the chip says when Claude will not reply", () => {
    expect(composer).not.toContain("Bash mode runs in");
    expect(composer).toContain('<span className="cmp-chip-word">No reply</span>');
  });
  test("the 5.4 lines of the composer carry the link-notice test id", () => {
    expect(composer).toContain('<p className="cmp-line is-warn" data-testid="link-notice" role="status">');
    expect(composer).toContain('<p className="notice cmp-archived-line" data-testid="link-notice" role="status">');
    expect(src("composer", "SlashMenu.tsx")).toContain('data-testid="link-notice"');
    expect(src("composer", "Pickers.tsx")).toContain('data-testid="link-notice"');
  });
  test("an archived chat says so on composer, picker, Stop and card paths (5.4), and the card's own line stays out", () => {
    // R127: Trust this folder's confirm too (an archived chat never opens it).
    expect(src("chat", "cards", "WaitingCard.tsx")).toContain('return COMPOSER_ROUTES.has(route.name) || route.name === "stop" || route.name === "trust" || CARD_ROUTES.has(route.name);');
    expect(composer).toContain("const linked = archivedLinePath(route);");
    const view = src("chat", "ChatView.tsx");
    expect(view).toContain("chat.archived && requestId ? null");
    // Nor does the router's line for a bad part of such a link: the archived line is the one line (principle 0).
    // (A held chat's composer paths are left out the same way: row 80, test/web/held-box.test.ts.)
    expect(view).toContain("chatLinkLine(route, line, (chat.archived && archivedLinePath(route)) || (!!chat.held && COMPOSER_ROUTES.has(route.name)) || (!!requestId && !routedCard))");
  });
});

describe("a send that waits for the socket (4.3, M4): one line on the chat screen", () => {
  test("Reconnecting... above the composer while this page's send or ! command waits and the socket is not open, where the list's foot is not on screen", () => {
    const screen = src("chat", "ChatScreen.tsx");
    // A send waits while the socket is not open, or while its ack is overdue on an open socket (a silent link).
    expect(screen).toContain('return out.length > 0 && (s.net !== "open" || out.some((id) => s.overdue.includes(id)));');
    expect(screen).toContain('const docked = useShellLayout().sidebar === "docked";');
    // While kitespan restarts, the line says so whatever waits (4.10 step 8, 6.8: every page shows Restarting).
    expect(screen).toContain("const restarting = useStore(restartingNow);");
    expect(screen).toMatch(/\) : \(offline \|\| restarting\) && !docked \? \(\s*<div className="chat-gone chat-notice-line">\s*<div className="chat-measure">\s*<p className="notice" data-testid="chat-reconnecting" role="status">\s*\{restarting \? RESTARTING : RECONNECTING\}/);
  });
});

describe("this device's link marks (5.1 rule 7, D49)", () => {
  test("Send or Run on a /send or /bash link closes back to the chat (closeTo), leaving no repeated history entry", () => {
    const composer = src("composer", "Composer.tsx");
    const leave = /const leaveRoute = \(\) => \{([^}]*)\};/.exec(composer)?.[1] ?? "";
    expect(leave).toContain("closeTo(chatUrl)");
    expect(leave).not.toContain("navigate(");
  });
  const C = "k3m7q2x4abk3m7q2x4ab";
  test("a mark counts only for the text it was made for: another device's draft is never read with it", () => {
    resetLinkMarks();
    markLink(C, "bash", "!ls -la");
    expect(linkMode(C, "!ls -la")).toBe("bash");
    // Device A's text link draft that starts with "!": this device's Bash link mark says nothing about it.
    expect(linkMode(C, "!echo LINKTEXT ok")).toBeUndefined();
    expect(linkMode(C, "")).toBeUndefined();
    markLink(C, "chat", "!echo LINKTEXT ok");
    expect(linkMode(C, "!echo LINKTEXT ok")).toBe("chat");
    expect(linkMode(C, "!ls -la")).toBeUndefined();
    markLink(C, null, "");
    expect(linkMode(C, "!echo LINKTEXT ok")).toBeUndefined();
  });
  test("the store's reader checks the mark against the store's own draft text", () => {
    resetLinkMarks();
    resetState({ drafts: { [C]: "!echo hi" } });
    markLink(C, "chat", "!echo hi");
    expect(linkMode(C)).toBe("chat");
    resetState({ drafts: { [C]: "!echo bye" } });
    expect(getState().drafts[C]).toBe("!echo bye");
    expect(linkMode(C)).toBeUndefined();
    resetState();
    markLink(C, null, "");
  });
  test("marks come back from storage after a reload; a mark without its text's key counts for nothing", () => {
    const g = globalThis as unknown as { localStorage?: Storage };
    const had = g.localStorage;
    const mem = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } as unknown as Storage;
    try {
      resetLinkMarks();
      markLink(C, "bash", "!ls -la");
      resetLinkMarks(); // a reload: the drafts are not in the store yet, and the mark stays
      expect(linkMode(C, "!ls -la")).toBe("bash");
      mem.set("kitespan.proto.composer.links", JSON.stringify({ [C]: "bash" }));
      resetLinkMarks();
      expect(linkMode(C, "!ls -la")).toBeUndefined();
      expect(textKey("!ls -la")).not.toBe(textKey("!ls -lb"));
    } finally {
      if (had) g.localStorage = had;
      else delete g.localStorage;
      resetLinkMarks();
    }
  });
});
