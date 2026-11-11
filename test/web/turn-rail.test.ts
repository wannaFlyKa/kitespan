// U3 (FIX-U3 section 2, DESIGN-U3 4 to 8, 13, 15.4): the turn rail as it draws. A navigation list named "Turns" with
// one link per turn to /c/<chat>/m/<target> (the view kept), each named by its turn, one of them the current one and
// the one Tab stop; the partial cue; the preview card's two lines; the styles (tokens only, the 2 px ticks and their
// three steps, the running colour, the focus ring, no motion); how ChatView mounts it and which keys it leaves to
// others. Rendered with React's server renderer; the marks come from the model (rail.ts) on recorded events.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEvent } from "../../shared/protocol";
import { parse } from "../../shared/route";
import { cardCalls } from "../../web/chat/fold";
import { railCard, railMarks, railSpots, type RailMark } from "../../web/chat/rail";
import { INTENT_MS, OLDER_NOT_LOADED, RAIL_NAME, RailCardBody, TurnRail, type RailApi, type RailHooks } from "../../web/chat/TurnRail";
import { turnLayout, turnList, turnsOf } from "../../web/chat/turns";
import { applyEvent, type ChatPart } from "../../web/state/reduce";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");

function blank(): ChatPart {
  return { items: [], pending: [], title: "", titleSource: "first-prompt", model: "default", effort: "default", mode: "default", picks: { model: null, effort: null, mode: null }, sessionId: "", bypassFlag: false, lostRequests: [], turn: null, liveModel: null, version: null, commands: null, tasks: [], suggestion: null, outputs: [], init: null, workingFolder: null };
}
function live(events: ChatEvent[]): ChatPart {
  let c = blank();
  events.forEach((e, i) => {
    c = applyEvent(c, e, { seq: i + 1, replay: false, cwd: null, now: 1_000_000 });
  });
  return c;
}
const start = (by: "user" | "agent" = "user"): ChatEvent => ({ k: "turn_start", by });
const user = (uuid: string, text: string): ChatEvent => ({ k: "user", uuid, text, queued: false });
const reply = (msg: string, t: string): ChatEvent => ({ k: "block", key: `${msg}:0`, kind: "text", text: t, parent: null });
const end = (): ChatEvent => ({ k: "turn_end", ok: true, subtype: "success", durationMs: 3_000, error: null, uuids: [] });
const turn = (n: number): ChatEvent[] => [start(), user(`m${n}`, `Prompt number ${n}.`), reply(`msg_${n}`, `Reply number ${n}.`), end()];

const CHAT = "fixtheflakyupload2ab";
const chat = live([1, 2, 3, 4, 5, 6].flatMap(turn).concat([start(), user("m7", "Run the tests.")]));
const RUNNING = { running: true, waiting: false, partial: false };
function marksOf(c: ChatPart, opts = RUNNING): RailMark[] {
  const calls = cardCalls(c.items, c.pending);
  const turns = turnList(turnsOf(c.items, c.marks ?? [], opts));
  return railMarks(railSpots(turns, (t) => turnLayout(t, "normal", undefined, calls)));
}
const hooks: { current: RailHooks } = { current: { card: () => null, leave: () => {}, wheel: () => {} } };
const api: { current: RailApi | null } = { current: null };
const draw = (marks: RailMark[], partial = false, view?: string) => renderToStaticMarkup(createElement(TurnRail, { marks, partial, chatId: CHAT, view, api, hooks }));

describe("the rail's links and names (DESIGN-U3 7)", () => {
  const marks = marksOf(chat);
  const html = draw(marks, false, "thinking");
  const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);

  test("a navigation list named Turns, one link per turn, in order", () => {
    expect(RAIL_NAME).toBe("Turns");
    expect(html).toMatch(/^<nav class="chat-rail" aria-label="Turns" data-testid="turn-rail"><ol class="chat-rail-list"><li><a /);
    expect(links.length).toBe(7);
    expect(html).not.toMatch(/>[^<]+</); // no visible words: the names are the links' own
  });

  test("each link goes to /c/<chat>/m/<target> with the view; each target's route parses back", () => {
    const hrefs = links.map((a) => /href="([^"]+)"/.exec(a)![1]!.replace(/&amp;/g, "&"));
    expect(hrefs).toEqual(marks.map((m) => `/c/${CHAT}/m/${m.target}?view=thinking`));
    hrefs.forEach((h, i) => {
      const r = parse(new URL(h, "http://127.0.0.1:1"));
      expect([r.name, r.params.message, r.query.view, r.fallbackFrom ?? null]).toEqual(["message", marks[i]!.target, "thinking", null]);
    });
    expect(draw(marks)).toContain(`href="/c/${CHAT}/m/m1"`);
  });

  test("named by its turn: the prompt, and the running turn's word", () => {
    expect(links.map((a) => /aria-label="([^"]+)"/.exec(a)![1])).toEqual(["Prompt number 1.", "Prompt number 2.", "Prompt number 3.", "Prompt number 4.", "Prompt number 5.", "Prompt number 6.", "Run the tests., Working"]);
  });

  test("one current mark (the last while following) and one Tab stop; the running turn's tick in the running colour", () => {
    expect(links.filter((a) => a.includes('aria-current="location"')).length).toBe(1);
    expect(links.at(-1)).toContain('aria-current="location"');
    expect(links.filter((a) => a.includes('tabindex="0"')).length).toBe(1);
    expect(links.filter((a) => a.includes('tabindex="-1"')).length).toBe(6);
    expect(links.at(-1)).toContain('class="chat-rail-mark is-running"');
    expect(links[0]).toContain('class="chat-rail-mark"');
    // A waiting turn's tick: the needs-you colour (review U3), as the chat list's waiting dot.
    const waiting = [...draw(marksOf(chat, { running: true, waiting: true, partial: false })).matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(waiting.at(-1)).toContain('class="chat-rail-mark is-waiting"');
    expect(links.some((a) => a.includes("aria-describedby"))).toBe(false);
  });

  test("older turns not loaded: three dots, hidden from screen readers, and the sentence for them", () => {
    const partial = draw(marks, true);
    expect(OLDER_NOT_LOADED).toBe("Older turns are not loaded.");
    expect(partial).toContain(`<nav class="chat-rail" aria-label="Turns" data-testid="turn-rail"><p class="visually-hidden">Older turns are not loaded.</p><ol class="chat-rail-list"><li class="chat-rail-more" aria-hidden="true"><i></i><i></i><i></i></li><li><a `);
    expect(html).not.toContain("chat-rail-more");
  });
});

describe("the preview card's text (DESIGN-U3 5)", () => {
  const body = (c: Parameters<typeof RailCardBody>[0]["card"]) => renderToStaticMarkup(createElement(RailCardBody, { card: c }));
  test("the prompt line, its quiet tag, then the answer lines", () => {
    expect(body({ prompt: "Try again, and test it in WebKit.", tag: "Failed", answer: "Safari dropped the blob URL.", first: false })).toBe(
      '<p class="chat-rail-prompt"><span class="chat-rail-prompt-text" dir="auto">Try again, and test it in WebKit.</span><span class="chat-tag">Failed</span></p><p class="chat-rail-answer" dir="auto">Safari dropped the blob URL.</p>',
    );
  });
  test("the user's own text keeps its own direction (dir=auto, as the bubble has it): a right-to-left prompt", () => {
    const html = body({ prompt: "תקן את הבדיקה של ההעלאה.", tag: "Failed", answer: "הבדיקה עוברת עכשיו.", first: false });
    expect(html).toContain('<span class="chat-rail-prompt-text" dir="auto">תקן את הבדיקה של ההעלאה.</span>');
    expect(html).toContain('<p class="chat-rail-answer" dir="auto">הבדיקה עוברת עכשיו.</p>');
    expect(src("chat", "items", "Text.tsx")).toContain('dir="auto"');
  });
  test("a turn with no input: the answer first, in the text colour", () => {
    expect(body({ prompt: null, tag: null, answer: "The background build finished.", first: true })).toBe('<p class="chat-rail-answer is-first" dir="auto">The background build finished.</p>');
  });
  test("plain text, never markup: the words of a reply with markup in it are escaped", () => {
    const c = live([start(), user("m1", "Show <b>this</b>"), reply("msg_1", "Use `<script>` **never**."), end()]);
    const calls = cardCalls(c.items, c.pending);
    const [t] = turnList(turnsOf(c.items, c.marks ?? [], { running: false, waiting: false, partial: false }));
    const words = railCard(railSpots([t!], (x) => turnLayout(x, "normal", undefined, calls))[0]!);
    expect(words).toEqual({ prompt: "Show <b>this</b>", tag: null, answer: "Use <script> never.", first: false });
    const html = body(words);
    expect(html).toContain("Show &lt;b&gt;this&lt;/b&gt;");
    expect(html).toContain("Use &lt;script&gt; never.");
    expect(html).not.toContain("<script>");
  });
  test("the card is a tooltip that the focused mark points to; it takes the pointer, and a click on it only closes it", () => {
    const rail = src("chat", "TurnRail.tsx");
    expect(rail).toContain('role="tooltip"');
    expect(rail).toContain("described={preview?.i === i && focusAt === i ? cardId : undefined}");
    // Review U3: a click on the card closes it and goes nowhere (a click meant for what it covers never jumps).
    expect(rail).not.toContain("markEls()[preview.i]?.click();");
    expect(rail).toMatch(/onClick=\{\(\) => \{[^}]*dismissed\.current = preview\.i;\s*cancelHide\(\);\s*over\.current\.card = false;\s*setPreview\(null\);/);
    // A click on a mark closes its card (its turn is then at the top), as Esc does.
    expect(rail).toMatch(/hooks\.current\.leave\(m, to\);\s*dismissed\.current = /);
    expect(rail).toContain("const GRACE_MS = 100;");
    // Esc hides the card first and is used up, before the composer's own Esc (which checks defaultPrevented).
    expect(rail).toContain('window.addEventListener("keydown", onKey, true);');
    expect(src("composer", "Composer.tsx")).toContain("if (e.defaultPrevented || document.querySelector(\".dialog\")) return;");
  });
});

describe("the styles (DESIGN-U3 4, 13, 15.4)", () => {
  const css = src("styles", "chat.css");
  const rules = css.slice(css.indexOf("/* ---- U3"));
  const rule = (sel: string) => {
    const at = rules.indexOf(`${sel} {`);
    return at < 0 ? "" : rules.slice(at, rules.indexOf("}", at) + 1);
  };

  test("tokens only, and no motion: no transition, animation or smooth scroll", () => {
    expect(rules.length).toBeGreaterThan(1000);
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(rules).not.toMatch(/transition|animation|scroll-behavior: smooth/);
  });

  test("the rail: 20 px wide, 12 px right of the text (--rail-x), centred in the band below the glass bar, at most 400 px", () => {
    expect(rule(".chat-rail")).toContain("left: var(--rail-x);");
    expect(rule(".chat-rail")).toContain("width: 20px;");
    // The glass look's conversation scrolls under the title bar (layout.css --under-bar): the band starts below it.
    expect(rule(".chat-rail")).toContain("top: calc(50% + var(--under-bar, 0px) / 2);");
    expect(rule(".chat-rail")).toContain("max-height: min(calc(100% - 64px - var(--under-bar, 0px)), 400px);");
    expect(src("styles", "layout.css")).toContain("--under-bar: calc(var(--header-h) + env(safe-area-inset-top));");
    expect(rule(".chat-rail")).toContain("scrollbar-width: none;");
  });

  test("the ticks: 2 px at a 10 px pitch; 8 px in --faint, 12 px in --dim, 14 px in --text; the state dots' colours while it runs or waits", () => {
    expect(rule(".chat-rail-mark")).toContain("height: 10px;");
    expect(rule(".chat-rail-mark::before")).toMatch(/width: 8px;\s*height: 2px;[\s\S]*background: var\(--faint\);/);
    expect(rules).toMatch(/\.chat-rail-mark:hover::before,\s*\.chat-rail-mark\.is-previewed::before \{\s*width: 12px;\s*background: var\(--dim\);/);
    expect(rule('.chat-rail-mark[aria-current="location"]::before')).toMatch(/width: 14px;\s*background: var\(--text\);/);
    // Review U3: --accent is the text's colour in Mono and Editor, so a running tick looked like a finished current
    // one there. The chat list's dots (base.css .dot.running, .dot.waiting) differ from the text in every look.
    expect(rule(".chat-rail-mark.is-running::before")).toContain("background: var(--ok-fill);");
    expect(rule(".chat-rail-mark.is-waiting::before")).toContain("background: var(--attn-dot);");
    expect(src("styles", "base.css")).toMatch(/\.dot\.running \{\s*background: var\(--ok-fill\);/);
    expect(src("styles", "base.css")).toMatch(/\.dot\.waiting \{\s*background: var\(--attn-dot\);/);
    // Later than the current mark's ink, so the state's colour shows on the current (14 px) tick too.
    expect(rules.indexOf(".chat-rail-mark.is-waiting::before")).toBeGreaterThan(rules.indexOf('.chat-rail-mark[aria-current="location"]::before'));
    expect(rules.indexOf(".chat-rail-mark.is-running::before")).toBeGreaterThan(rules.indexOf('.chat-rail-mark[aria-current="location"]::before'));
    const tokens = src("styles", "tokens.css");
    for (const look of ["glass", "paper", "mono", "editor"]) {
      const light = tokens.slice(tokens.indexOf(`[data-look="${look}"] {`));
      const block = light.slice(0, light.indexOf("}"));
      const val = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(block)?.[1];
      expect([look, val("--ok-fill")]).not.toEqual([look, val("--text")]);
      expect([look, val("--attn-dot")]).not.toEqual([look, val("--text")]);
    }
    expect(rule(".chat-rail-mark:focus-visible")).toContain("outline: 2px solid var(--ring);");
  });

  test("the three dots for older turns: 2 x 2 px, 3 px apart, with room for all three (border-box)", () => {
    const more = rule(".chat-rail-more");
    const px = (re: RegExp) => Number(re.exec(more)?.[1]);
    const height = px(/height: (\d+)px;/);
    const gap = px(/gap: (\d+)px;/);
    const bottom = px(/padding: 0 0 (\d+)px 7px;/);
    expect(src("styles", "base.css")).toMatch(/\*,\s*\*::before,\s*\*::after \{\s*box-sizing: border-box;/);
    expect(rule(".chat-rail-more i")).toMatch(/width: 2px;\s*height: 2px;/);
    expect(rule(".chat-rail-more i")).toContain("flex: none;");
    expect([gap, height - bottom]).toEqual([3, 3 * 2 + 2 * 3]);
  });

  test("the card: the menus' surface, the prose face for the answer, three lines at most", () => {
    const card = rule(".chat-rail-card");
    for (const v of ["background: var(--elevated);", "box-shadow: var(--shadow-2);", "border-radius: var(--r-menu);", "right: calc(100% - var(--rail-x) + 8px);"]) expect(card).toContain(v);
    expect(rule(".chat-rail-answer")).toContain("-webkit-line-clamp: 3;");
    expect(rule(".chat-rail-answer")).toContain("font-family: var(--font-prose);");
    expect(rule(".chat-rail-answer.is-first")).toContain("color: var(--text);");
  });
});

describe("the pointer and the wheel (review U3)", () => {
  const rail = src("chat", "TurnRail.tsx");
  test("the card waits for intent: the pointer rests on the rail 150 ms, or moves along it to another mark; the focus opens it at once", () => {
    expect(INTENT_MS).toBe(150);
    expect(rail).toContain("if (!shown.current && !wants(i, e.clientX, e.clientY)) return;");
    expect(rail).toContain("return i !== it.i && Math.abs(y - it.y) >= Math.abs(x - it.x);");
    // Leaving the rail (a crossing) ends the wait, so nothing shows.
    expect(rail).toMatch(/onPointerLeave=\{\(\) => \{\s*over\.current\.rail = false;\s*under\.current = null;\s*endIntent\(\);/);
    expect(rail).toMatch(/onFocus=\{\(e\) => \{[^}]*open\(i, "focus"\);/);
  });
  test("a wheel over the rail (its ladder at that end) or over the card goes to the conversation, by listeners that are not passive", () => {
    expect(rail.match(/addEventListener\("wheel", on, \{ passive: false \}\)/g)?.length).toBe(2);
    expect(rail).toContain("if (max > 1 && (e.deltaY < 0 ? el.scrollTop > 0.5 : el.scrollTop < max - 0.5)) return;");
    expect(rail).toContain("hooks.current.wheel(e.deltaY, e.deltaMode);");
    const view = src("chat", "ChatView.tsx");
    const hook = view.slice(view.indexOf("    wheel: (deltaY, deltaMode) => {"));
    // What the reader's own wheel over the text does: the pin and the kept place go, and up leaves the end.
    expect(hook.slice(0, hook.indexOf("\n    },"))).toMatch(/pinned\.current = null;\s*dropPlace\(\);\s*onWheel\(follow, px, el\.scrollTop\);\s*el\.scrollTop \+= px;/);
  });
});

describe("how ChatView mounts it (DESIGN-U3 8, 10)", () => {
  const view = src("chat", "ChatView.tsx");
  test("inside the scroller's wrap, after the scroller and before Jump to latest; only where railShows says", () => {
    const at = view.indexOf("<TurnRail ");
    expect(at).toBeGreaterThan(view.indexOf('className="chat-scroll"'));
    expect(at).toBeLessThan(view.indexOf('className="chat-jump"'));
    expect(view).toContain("const railOn = railShows(railList.length, railRoom, vp.touch);");
    expect(view).toContain("{railOn ? <TurnRail ");
  });
  test("a jump lands below the glass look's title bar: from the scroller's visible top (its scroll padding)", () => {
    expect(view).toContain("const d = at.getBoundingClientRect().top - visibleTop(el) - LAND_TOP;");
    expect(view).toContain("readingLine(el.clientHeight - underBar(el))");
    expect(src("chat", "TurnRail.tsx")).toContain("Math.max(bar + BAND_PAD,");
  });
  test("the marks are drawn again only on their key; no geometry is read while the view follows the end", () => {
    expect(view).toContain("const railList = useMemo(() => railMarks(spots), [railK]);");
    expect(view).toMatch(/if \(follow\.stick\) return setRailCurrent\(null\);\s*if \(railFrame\.current\) return;/);
    expect(view).toContain("if (wider) fitRail();");
  });
  test("the rail's place (--rail-x) is set on the rail and its card, never on the wrap: a pane's drag restyles no transcript", () => {
    // Integration (U3): on the wrap, the variable that changes with each move of a pane's handle restyled every row of
    // a long chat (ui-check panes: 6.5 ms a move, over its 4 ms).
    expect(view).not.toMatch(/style\.setProperty\("--rail-x"/);
    expect(view).toContain("railApi.current?.place(fit.x);");
    expect(view).toContain("if (railOn && railX.current !== null) railApi.current?.place(railX.current);");
    const rail = src("chat", "TurnRail.tsx");
    expect(rail).toContain('el.style.setProperty("--rail-x", `${railX.current}px`);');
    expect(rail).toMatch(/if \(railX\.current === x\) return;\s*railX\.current = x;\s*putX\(nav\.current\);\s*putX\(cardEl\.current\);/);
    expect(rail).toMatch(/if \(!card \|\| !wrap \|\| !a\) return;\s*putX\(card\);/);
  });
  test("a mark's link keeps the reader's place in the entry it leaves; `{` and `}` push no entry", () => {
    expect(view).toContain("history.replaceState({ ...((history.state as EntryState | null) ?? {}), place } satisfies EntryState, \"\");");
    const keys = view.slice(view.indexOf("const onKey = (e: KeyboardEvent) => {\n      const dir = turnStep(e);"));
    expect(keys.slice(0, keys.indexOf("window.addEventListener"))).not.toMatch(/navigate\(|pushState/);
  });
});
