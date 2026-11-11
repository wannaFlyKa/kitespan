// The side chat as it draws (owner rows 124 and 125; DESIGN-R124 sections 5 to 8), with React's server renderer: its
// head and Close, the thread (Clear at its top, earlier questions folded to one line with the chevron, the newest open
// with its question as a heading and its body a polite live region), each state (empty, asking with the retry line,
// answered with Copy, an empty answer, a refusal fallback, failed with Try again), the box (its words, its cap, Send and
// Stop, the link's fill with its line, the over-cap line), a held chat's locked box and an archived chat's read-only
// thread; the phone's sheet; and where Shell and the title bar put it: the laptop's column in the side panel's place
// with no rail toggle, the tablet's pane with the pane bar's fifth button lit, the title bar's Side chat tool with its
// key, and none of them where the agent answers no side question. The route itself is shared/route.ts's sideChat.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { PANEL_ROUTES, ROUTE_BY_NAME } from "../../web/routes";
import { resetState } from "../../web/state/store";
import type { Chat } from "../../web/state/types";
import { SIDE_FAILED, SIDE_PLACEHOLDER, SideChat, SideSheetFrame, dragCloses, retryLine, rideHeight, type SidePlace } from "../../web/side/SideChat";
import { resetSideNav, sideFillOf, sideHref, sideToggle } from "../../web/side/nav";
import { BTW_TOO_LONG } from "../../web/side/btw";
import { EMPTY_THREAD, type SideExchange, type SideThread } from "../../web/side/thread";
import { Shell } from "../../web/layout/Shell";
import { TopBar } from "../../web/layout/TopBar";
import { Composer } from "../../web/composer/Composer";
import { CHATS, PROJECTS } from "./fixtures";

const CHAT = "demoolxxxxxxxxxxxxxx";
const WEB = join(import.meta.dir, "..", "..", "web");
const at = (u: string) => parse(new URL(u, "http://127.0.0.1"));
const AT = "2026-11-04T10:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ans = (n: number, q: string, a: string, more: Partial<SideExchange> = {}): SideExchange => ({ id: uuid(n), question: q, at: AT, state: "answered", answer: a, ...more });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const count = (html: string, s: string) => html.split(s).length - 1;

const gm = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const own = { mm: !gm.matchMedia, win: !gm.window };
let coarse = false;
function viewport(width: number, height: number, touch: boolean) {
  coarse = touch;
  gm.window = { innerWidth: width, innerHeight: height, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => {
  gm.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
  viewport(1280, 800, false);
});
afterAll(() => {
  if (own.mm) delete gm.matchMedia;
  if (own.win) delete gm.window;
  resetState();
});
beforeEach(() => resetSideNav());

const THREAD: SideExchange[] = [
  ans(1, "What does the retry rule do again?", "It retries a failed upload three times."),
  ans(2, "Which file holds the size cap?", "`server/store/uploads.ts`, as `MAX_UPLOAD_BYTES`."),
  ans(3, "Why did the second test time out?", "The second test waits for the **uploaded** event.\n\n- add the listener first"),
];
const thread = (exchanges: SideExchange[]): SideThread => ({ ...EMPTY_THREAD, rev: 4, read: true, exchanges });

function state(opts: { exchanges?: SideExchange[]; chat?: Partial<Chat>; side?: boolean; sideDraft?: { text: string; link: boolean } } = {}) {
  const chats = CHATS.map((c) => (c.id === CHAT ? { ...c, ...opts.chat } : c));
  resetState({ projects: structuredClone(PROJECTS), chats, ready: true, sideQuestions: opts.side ?? true, side: opts.exchanges ? { [CHAT]: thread(opts.exchanges) } : {}, sideDraft: opts.sideDraft ? { [CHAT]: opts.sideDraft } : {} });
  return chats.find((c) => c.id === CHAT)!;
}
const draw = (chat: Chat, path = `/c/${CHAT}/btw`, place: SidePlace = "column") => renderToStaticMarkup(createElement(SideChat, { chat, route: at(path), place }));

describe("the route (shared/route.ts) and its helpers", () => {
  test("/c/<chat>/btw is the side chat, a side panel route whose text only fills", () => {
    const r = at(`/c/${CHAT}/btw?text=Which%20file%3F`);
    expect(r.name).toBe("sideChat");
    expect(r.query.text).toBe("Which file?");
    expect(ROUTE_BY_NAME.sideChat!.kind).toBe("action");
    expect(PANEL_ROUTES.has("sideChat")).toBe(true);
    expect(sideHref(CHAT)).toBe(`/c/${CHAT}/btw`);
    expect(sideHref(CHAT, "verbose")).toBe(`/c/${CHAT}/btw?view=verbose`);
  });

  test("its buttons open it, and close it back to the chat while it is open", () => {
    expect(sideToggle(at(`/c/${CHAT}`), CHAT)).toEqual({ to: `/c/${CHAT}/btw`, close: false });
    expect(sideToggle(at(`/c/${CHAT}/btw?view=thinking`), CHAT)).toEqual({ to: `/c/${CHAT}?view=thinking`, close: true });
  });

  test("a link's text fills the box; one over its cap fills nothing and says so; another route fills nothing", () => {
    expect(sideFillOf(at(`/c/${CHAT}/btw?text=Hi`), "?text=Hi")).toEqual({ key: "text|Hi", text: "Hi", overCap: false });
    const long = "x".repeat(5001);
    expect(sideFillOf(at(`/c/${CHAT}/btw?text=${long}`), `?text=${long}`)).toEqual({ key: "over", overCap: true });
    expect(sideFillOf(at(`/c/${CHAT}/btw`), "")).toBeNull();
    expect(sideFillOf(at(`/c/${CHAT}/send?text=Hi`), "?text=Hi")).toBeNull();
  });

  test("the box's unsent text is the chat's side draft, which the server holds (FIX-U2): no session storage of its own", () => {
    const src = readFileSync(join(WEB, "side", "SideChat.tsx"), "utf8") + readFileSync(join(WEB, "side", "nav.ts"), "utf8");
    expect(src).not.toContain("sessionStorage");
    expect(src).not.toContain("kitespan.side.");
  });
});

describe("the head and an empty side chat (principle 0)", () => {
  test("its title and Close (Esc on a laptop); the box alone, with no helper line, no Clear and no list", () => {
    const html = draw(state());
    expect(html).toContain('role="region" aria-label="Side chat"');
    expect(html).toMatch(/<h2 class="sc-title">Side chat<\/h2>/);
    expect(html).toMatch(/aria-label="Close side chat" title="Close side chat \(Esc\)"/);
    expect(html).not.toContain("sc-clear");
    expect(html).not.toContain("<ol");
    expect(text(html)).toBe("Side chat");
  });

  test("the box: the words, the 5,000 cap, and Send off while it is empty", () => {
    const html = draw(state());
    expect(html).toContain(`placeholder="${SIDE_PLACEHOLDER}"`);
    expect(SIDE_PLACEHOLDER).toBe("Ask a side question…");
    expect(html).toContain('aria-label="Side question"');
    expect(html).toContain('maxLength="5000"');
    expect(html).toMatch(/<button[^>]*class="cmp-key cmp-send sc-key"[^>]*aria-label="Send"[^>]*title="Send \(Enter\)"[^>]*disabled=""/);
  });
});

describe("the thread", () => {
  test("the Clear row stays whole at the list's top on the list's own ground while the thread scrolls under it", () => {
    const css = readFileSync(join(WEB, "styles", "side.css"), "utf8");
    expect(css).toMatch(/\.sc-thread-head \{[^}]*position: sticky;[^}]*top: 0;[^}]*background: var\(--bg\);/);
    expect(css).toMatch(/\.sc-at-sheet \.sc-thread-head \{[^}]*background: var\(--elevated\);/);
  });

  test("Clear puts the focus in the box on a laptop only: on touch nothing takes the focus, so no keyboard comes up", () => {
    const src = readFileSync(join(WEB, "side", "SideChat.tsx"), "utf8");
    const clear = src.slice(src.indexOf("  const clear = () => {"), src.indexOf("  return (", src.indexOf("  const clear = () => {")));
    expect(clear).toContain("void act.sideClear(chat.id);");
    expect(clear).toContain("if (!touch) field.current?.focus({ preventScroll: true });");
  });

  test("Clear at the top; earlier questions one folded line each with the chevron; the newest open, its question a heading", () => {
    const html = draw(state({ exchanges: THREAD }));
    expect(html).toMatch(/<div class="sc-thread-head"><button type="button" class="btn plain chat-mini sc-clear" aria-label="Clear side chat"[^>]*>Clear<\/button><\/div><ol class="sc-thread" aria-label="Side questions"/);
    expect(count(html, 'class="sc-x is-folded"')).toBe(2);
    expect(count(html, 'aria-expanded="false"')).toBe(2);
    expect(count(html, "sc-q-chev")).toBe(2);
    expect(html).toMatch(/<h3 class="sc-q is-static"><span class="sc-q-text" dir="auto">Why did the second test time out\?<\/span><\/h3>/);
    // The newest exchange has no chevron and no toggle (round 2's one removal).
    expect(html.slice(html.indexOf("is-newest"))).not.toContain("sc-q-chev");
    // The earlier answers are not drawn until opened.
    expect(html).not.toContain("MAX_UPLOAD_BYTES");
  });

  test("the newest answer: the reply's prose and markdown, Copy under it, in a polite live region", () => {
    const html = draw(state({ exchanges: THREAD }));
    expect(html).toContain('<div class="sc-body" aria-live="polite">');
    expect(html).toMatch(/class="chat-assistant sc-a"[\s\S]*class="chat-md"[\s\S]*<strong>uploaded<\/strong>/);
    expect(html).toContain("<li>add the listener first</li>");
    expect(html).toMatch(/class="copy chat-reveal"[\s\S]*data-testid="side-copy"/);
  });

  test("an empty answer shows nothing under its question, and no Copy", () => {
    const html = draw(state({ exchanges: [ans(1, "Anything?", "")] }));
    expect(html).toContain("Anything?");
    expect(html).not.toContain("chat-md");
    expect(html).not.toContain("side-copy");
  });

  test("a synthetic answer shows as Claude Code gives it, with no word of kitespan's", () => {
    const words = "(No answer available for this side question. Try again, or ask in the main conversation.)";
    const html = draw(state({ exchanges: [ans(1, "Q?", words, { synthetic: true })] }));
    expect(text(html)).toContain(words);
  });

  test("a refusal fallback: Claude Code's notice as the transcript's refusal line, above the answer", () => {
    const html = draw(state({ exchanges: [ans(1, "Q?", "The answer.", { fallback: "Another model answered this question." })] }));
    const note = html.indexOf("Another model answered this question.");
    expect(note).toBeGreaterThan(0);
    expect(html.indexOf("The answer.")).toBeGreaterThan(note);
    expect(html).toMatch(/class="chat-note is-text"/);
  });

  test("asking: the working mark named 'Claude is answering', the retry line, Stop in Send's place, no Clear", () => {
    const x: SideExchange = { id: uuid(9), question: "Is it the listener?", at: AT, state: "asking", retry: { attempt: 2, max: 10, delayMs: 3500 } };
    const html = draw(state({ exchanges: [...THREAD, x] }));
    expect(html).toContain('role="img" aria-label="Claude is answering"');
    expect(text(html)).toContain("Retrying (2 of 10) in 4 s");
    expect(retryLine({ attempt: 1, max: 3, delayMs: 0 })).toBe("Retrying (1 of 3) in 0 s");
    expect(html).toMatch(/class="cmp-key cmp-stop sc-key" aria-label="Stop side question" title="Stop"/);
    expect(html).not.toContain('aria-label="Send"');
    expect(html).not.toContain("sc-clear");
    // The field stays usable for the next question.
    expect(html).not.toContain("readOnly");
  });

  test("failed: one line in --danger and Try again (the transcript's small action)", () => {
    const x: SideExchange = { id: uuid(9), question: "Is it the listener?", at: AT, state: "failed", error: "failed" };
    const html = draw(state({ exchanges: [x] }));
    expect(SIDE_FAILED).toBe("The side question did not finish.");
    expect(html).toMatch(/<div class="sc-fail" role="status"[^>]*><span class="sc-fail-text">The side question did not finish\.<\/span><button type="button" class="btn chat-mini sc-again"[^>]*>Try again<\/button>/);
    expect(readFileSync(join(WEB, "styles", "side.css"), "utf8")).toMatch(/\.sc-fail \{[^}]*color: var\(--danger\)/);
  });
});

describe("the box's states", () => {
  test("a link's text fills the box as plain text, with 'Prompt from an external link' under it", () => {
    const html = draw(state(), `/c/${CHAT}/btw?text=%2Fbtw%20Which%20test%20first%3F`);
    expect(html).toMatch(/<textarea[^>]*>\/btw Which test first\?<\/textarea>/);
    expect(html).toContain("Prompt from an external link");
    expect(html).toMatch(/aria-label="Send"[^>]*title="Send \(Enter\)"(?![^>]*disabled)/);
  });

  test("the box shows the chat's side draft, the server's, as every page does; a link's fill shows over it, unsaved", () => {
    const html = draw(state({ sideDraft: { text: "Half a side question", link: false } }));
    expect(html).toMatch(/<textarea[^>]*>Half a side question<\/textarea>/);
    expect(html).not.toContain("Prompt from an external link");
    expect(html).toMatch(/aria-label="Send"[^>]*title="Send \(Enter\)"(?![^>]*disabled)/);
    // An edited link fill keeps its mark in the side draft, so every page shows its line.
    expect(draw(state({ sideDraft: { text: "From a link, edited", link: true } }))).toContain("Prompt from an external link");
    const filled = draw(state({ sideDraft: { text: "Half a side question", link: false } }), `/c/${CHAT}/btw?text=Which%20file%3F`);
    expect(filled).toMatch(/<textarea[^>]*>Which file\?<\/textarea>/);
    expect(filled).toContain("Prompt from an external link");
  });

  test("a held chat with no live process: the box is read-only with no placeholder, and Send is off", () => {
    const chat = state({ exchanges: THREAD, chat: { held: { app: "terminal", session: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }, serverState: "sleeping", state: "sleeping" } });
    const html = draw(chat);
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).toContain('placeholder=""');
    expect(html).toMatch(/aria-label="Send"[^>]*disabled=""/);
    // The thread stays readable; Clear is not offered.
    expect(html).toContain("Why did the second test time out?");
    expect(html).not.toContain("sc-clear");
  });

  test("every hold locks the box, as the server refuses every side question then: also kitespan's own finishing process and a hand-over", () => {
    const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    for (const held of [
      { app: "other" as const, session: SID, kind: "finishing" as const },
      { app: "terminal" as const, session: SID, kind: "handed" as const },
    ]) {
      const html = draw(state({ exchanges: THREAD, chat: { held, serverState: "idle", state: "idle" } }));
      expect(html).toMatch(/<textarea[^>]*readOnly=""/);
      expect(html).toMatch(/aria-label="Send"[^>]*disabled=""/);
      expect(html).not.toContain("sc-clear");
    }
  });

  test("an archived chat: the kept thread read-only, with no box, no Clear and no Try again", () => {
    const x: SideExchange = { id: uuid(9), question: "Last?", at: AT, state: "failed", error: "archived" };
    const html = draw(state({ exchanges: [...THREAD, x], chat: { archived: true } }));
    expect(html).toContain("What does the retry rule do again?");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("sc-clear");
    expect(html).not.toContain("Try again");
  });
});

describe("the phone's sheet", () => {
  test("the grip, the title row with 'Side chat' and Done, a modal dialog that takes no first focus", () => {
    const html = renderToStaticMarkup(createElement(SideSheetFrame, { onClose() {}, children: createElement("div", { className: "body" }) }));
    expect(html).toMatch(/^<div class="sheet sc-sheet" role="dialog" aria-modal="true" aria-labelledby="[^"]+" data-testid="side-chat" data-place="sheet" tabindex="-1">/);
    expect(html).toContain('<div class="sheet-grip" aria-hidden="true"');
    expect(html).toMatch(/<h2 class="sheet-title" id="[^"]+">Side chat<\/h2><button type="button" class="btn plain sheet-done"[^>]*>Done<\/button>/);
    expect(html).toContain('<div class="sc sc-at-sheet"><div class="body"></div></div>');
  });

  test("as tall as its content, up to half the screen; it rides the keyboard; its drag closes past 64 px or on a flick", () => {
    const css = readFileSync(join(WEB, "styles", "side.css"), "utf8");
    expect(css).toMatch(/\.sheet\.sc-sheet \{[^}]*height: auto;[^}]*max-height: 50dvh;/);
    const src = readFileSync(join(WEB, "side", "SideChat.tsx"), "utf8");
    // Riding the keyboard it keeps half the visual viewport, so part of the chat stays in view, never less than its
    // title row and box, and never over the title bar (390x844 with a 336 px keyboard: 508 px).
    expect(src).toContain("maxHeight: rideHeight(kb.visualHeight, rest)");
    expect(rideHeight(508, 130)).toBe(254);
    expect(rideHeight(508, 300)).toBe(300);
    expect(rideHeight(150, 134)).toBe(106);
    expect(rideHeight(0, 0)).toBe(0);
    expect(css).toMatch(/\.sheet\.sc-sheet\.is-riding \{[^}]*max-height: none;/);
    // A drag that does not close settles back with a transition of the property it moves (translate).
    expect(css).toMatch(/\.sheet\.sc-sheet\.is-settling \{[^}]*transition: translate var\(--t-reveal\) var\(--ease\);/);
    expect(src).toContain("box.current.style.translate = `0 ${s.dy}px`");
    expect(dragCloses(64, 400)).toBe(true);
    expect(dragCloses(63, 400)).toBe(false);
    expect(dragCloses(30, 40)).toBe(true);
    expect(dragCloses(10, 5)).toBe(false);
    // Reduce motion: the sheet does not follow the finger.
    expect(src).toMatch(/if \(!reduceMotion\(\) && box\.current\) box\.current\.style\.translate/);
  });
});

describe("where it shows (Shell, the title bar, the pane bar)", () => {
  const shell = (path: string, chat: Chat) =>
    renderToStaticMarkup(createElement(Shell, { route: at(path), chat, side: () => createElement("div", { "data-testid": "side-panel" }), children: createElement("div", { className: "chat-screen" }) }));
  beforeEach(() => viewport(1280, 800, false));

  test("a laptop: the side panel's column holds it, not the cards; the rail toggle brings the cards in (U4)", () => {
    const chat = state({ exchanges: THREAD });
    const html = shell(`/c/${CHAT}/btw`, chat);
    expect(html).toContain('class="side-col sc-col"');
    expect(html).toContain('data-place="column"');
    expect(html).not.toContain('data-testid="side-panel"');
    expect(html).not.toContain("Hide session rail");
    // U4 (DESIGN-U4 4.3): Show session rail opens the cards below the side chat, as a pair.
    expect(html).toContain('aria-label="Show session rail"');
  });

  test("the title bar: Side chat before Open in terminal, its key in the tooltip; lit and Close side chat while open", () => {
    const chat = state();
    const closed = renderToStaticMarkup(createElement(TopBar, { route: at(`/c/${CHAT}`), chat }));
    expect(closed).toMatch(new RegExp(`href="/c/${CHAT}/btw"[^>]*aria-label="Side chat"[^>]*aria-keyshortcuts="(Meta|Control)\\+;"[^>]*title="Side chat \\((Cmd|Ctrl)\\+;\\)"[\\s\\S]*aria-label="Open in terminal"`));
    const open = renderToStaticMarkup(createElement(TopBar, { route: at(`/c/${CHAT}/btw`), chat }));
    expect(open).toMatch(new RegExp(`href="/c/${CHAT}"[^>]*class="icon-btn scr-bar-icon on"[^>]*aria-label="Close side chat"[^>]*aria-current="page"`));
  });

  test("a tablet: the docked pane, with the pane bar's fifth button, Side chat, lit; Details is not", () => {
    viewport(834, 1194, true);
    const chat = state();
    const html = shell(`/c/${CHAT}/btw`, chat);
    expect(html).toContain('data-side="pane"');
    expect(html).toContain('data-place="pane"');
    expect(html).toMatch(/class="pane-bar-btn on"[^>]*aria-current="page"[^>]*title="Close side chat"[^>]*>.*?<span class="pane-bar-name">Side chat<\/span>/);
    expect(html).not.toMatch(/class="pane-bar-btn on"[^>]*>.*?<span class="pane-bar-name">Details/);
    const names = [...shell(`/c/${CHAT}`, chat).matchAll(/<span class="pane-bar-name">([^<]+)<\/span>/g)].map((m) => m[1]);
    // Iteration 7 (DESIGN-B1 4.1): the Browser is the sixth, after Side chat.
    expect(names).toEqual(["Details", "Files", "Terminal", "Search", "Side chat", "Browser"]);
  });

  test("1,040 px with the sidebar docked: over the chat, as every pane is there", () => {
    viewport(1040, 800, false);
    const html = shell(`/c/${CHAT}/btw`, state());
    expect(html).toContain('data-side="over"');
    expect(html).toContain('data-place="over"');
  });

  test("no way in where the agent answers no side question, or on an archived chat", () => {
    const off = state({ side: false });
    expect(renderToStaticMarkup(createElement(TopBar, { route: at(`/c/${CHAT}`), chat: off }))).not.toContain("Side chat");
    viewport(834, 1194, true);
    expect(shell(`/c/${CHAT}`, off)).not.toContain("Side chat");
    const archived = state({ chat: { archived: true } });
    expect(shell(`/c/${CHAT}`, archived)).not.toContain("Side chat");
  });

  test("the phone: its own sheet over the chat, and Side chat in the session menu after Search (phone only)", () => {
    const shellSrc = readFileSync(join(WEB, "layout", "Shell.tsx"), "utf8");
    expect(shellSrc).toContain('sideChat && chat ? <SideChat chat={chat} route={route} place="sheet" /> : side("sheet")');
    const menu = readFileSync(join(WEB, "dialogs", "SessionMenu.tsx"), "utf8");
    expect(menu).toMatch(/layout\.size === "phone"/);
    expect(menu.lastIndexOf("Side chat")).toBeGreaterThan(menu.indexOf('chatHref("chatSearch"'));
  });
});

describe("the message box's /btw (the composer)", () => {
  const commands = [
    { name: "clear", description: "Clear the conversation", argumentHint: "", aliases: [], builtin: true, terminalOnly: false },
    { name: "compact", description: "Keep a summary", argumentHint: "[instructions]", aliases: [], builtin: true, terminalOnly: false },
  ];
  const box = (path: string, side = true) => {
    const chat = state({ chat: { commands, pending: [], held: null }, side });
    return renderToStaticMarkup(createElement(Composer, { chat, route: at(path) }));
  };

  test("the / menu lists /btw with the CLI's hint, never as Open in terminal; none where the agent has no side questions", () => {
    const html = box(`/c/${CHAT}/slash`);
    expect(text(html)).toMatch(/\/btw \[question\] Ask a quick side question without interrupting the main conversation/);
    expect(text(html).indexOf("/btw")).toBeLessThan(text(html).indexOf("/clear"));
    expect(text(html)).not.toMatch(/\/btw[^/]*Open in terminal/);
    expect(text(box(`/c/${CHAT}/slash`, false))).not.toContain("/btw");
  });

  test("a /c/<chat>/slash/btw link fills the btw chip and its question, and sends nothing", () => {
    const html = box(`/c/${CHAT}/slash/btw?args=Which%20file%3F`);
    expect(html).toContain('<span class="cmp-chip-name">/btw</span>');
    expect(html).toMatch(/<textarea[^>]*>Which file\?<\/textarea>/);
  });

  test("Send on a /btw draft asks a side question and opens the side chat; it never reaches act.send", () => {
    const src = readFileSync(join(WEB, "composer", "Composer.tsx"), "utf8");
    const send = src.slice(src.indexOf("  const send = (now = false) => {"), src.indexOf("  const stop = () => void act.stop(chat.id);"));
    expect(send.indexOf("if (sideAsk) return sendSide(sideAsk.question);")).toBeGreaterThan(0);
    expect(send.indexOf("if (sideAsk) return sendSide(sideAsk.question);")).toBeLessThan(send.indexOf("act.send(chat.id"));
    const side = send.slice(send.indexOf("const sendSide"));
    expect(side).toContain("void act.sideAsk(chat.id, text).then(");
    // U4: by the split side panel's opener rules (layout/split.ts openHref).
    expect(side).toContain("navigate(openHref(route, sideHref(chat.id, view))");
    expect(side).not.toContain("act.send(");
    // While a side question runs the box keeps its text and only the side chat opens; one over the cap asks nothing;
    // a busy ack (another page asked first) gives the box its draft back, or the side box the question.
    const keep = side.indexOf("if (question && sideAsking) return openSide();");
    expect(keep).toBeGreaterThan(0);
    expect(keep).toBeLessThan(side.indexOf("commit(next);"));
    expect(side.indexOf("if (question && questionTooLong(question)) return;")).toBeLessThan(side.indexOf("commit(next);"));
    expect(side).toContain('if (end !== "busy") return;');
    expect(side).toContain("sideBoxBack(chat.id, text)");
  });

  test("a /btw question over 5,000 characters: the box keeps it with the line that says so, and Send is off", () => {
    const chats = CHATS.map((c) => (c.id === CHAT ? { ...c, commands, pending: [], held: null } : c));
    const long = `/btw ${"why ".repeat(1500)}`;
    resetState({ projects: structuredClone(PROJECTS), chats, ready: true, sideQuestions: true, side: {}, draft: { [CHAT]: { mode: "chat", command: null, text: long, link: false, uploads: [] } } });
    const html = renderToStaticMarkup(createElement(Composer, { chat: chats.find((c) => c.id === CHAT)!, route: at(`/c/${CHAT}`) }));
    expect(BTW_TOO_LONG).toBe("That side question is too long (the limit is 5,000 characters).");
    expect(html).toMatch(/<p class="cmp-line is-warn" data-testid="side-too-long" role="status">That side question is too long \(the limit is 5,000 characters\)\.<\/p>/);
    expect(html).toMatch(/data-testid="composer-send" disabled=""/);
    // At the cap it is a side question that Send asks.
    resetState({ projects: structuredClone(PROJECTS), chats, ready: true, sideQuestions: true, side: {}, draft: { [CHAT]: { mode: "chat", command: null, text: `/btw ${"x".repeat(5000)}`, link: false, uploads: [] } } });
    const ok = renderToStaticMarkup(createElement(Composer, { chat: chats.find((c) => c.id === CHAT)!, route: at(`/c/${CHAT}`) }));
    expect(ok).not.toContain("side-too-long");
    expect(ok).not.toMatch(/data-testid="composer-send" disabled=""/);
  });
});
