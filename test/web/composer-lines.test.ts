// FIX-C1 (DESIGN-C1; DESIGN.md 7.5): the phone's message box in two forms. While the draft takes one line, +, @, the
// field and the end key share one row; once it takes two lines or more in that row, the text gets the box's whole
// width and the keys keep one row under it, where they were. The switch is measured, never counted in characters, with
// a band of 2em so that one character typed and deleted at the edge never switches it twice; an empty field is always
// one row. It is one class on the root (`is-stacked`), and CSS grid areas place the row's children, whose order and
// elements never change, so the iOS keyboard, the focus, the caret and the selection stay (7.8). No browser here: the
// rule is tested with line counts (web/composer/stack.ts), the form's rules are read from composer.css, and the box is
// rendered with React's server renderer in a phone stand-in; the click-through measures the real page
// (scripts/ui-check.ts composer-lines).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../../web/composer/Composer";
import { STACK_BAND_EM, STACK_ROW_EM, fieldLines, lineRows, nextStacked, pinsEnd, type BoxText } from "../../web/composer/stack";
import { parse } from "../../web/router";
import { resetState, type ChatDraft } from "../../web/state/store";
import type { Chat, Project } from "../../web/state/types";
import { scripted } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
/** The source without its comments, so a pin reads the code only. */
const code = (...p: string[]) =>
  src(...p)
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
const css = (file: string) => src("styles", file).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule whose selector list is exactly `selector` (the first one), or null. */
function rule(sheet: string, selector: string): string | null {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(sheet); m; m = re.exec(sheet)) if (m[1]!.replace(/\s+/g, " ").trim() === selector) return m[2]!;
  return null;
}

// rowEm 12.5: the one-row line of the 390 px phone in Glass (212 px at 17 px).
const text = (over: Partial<BoxText> = {}): BoxText => ({ empty: false, hasBreak: false, lines: 1, rowEm: 12.5, narrower: () => 1, ...over });
/** A narrower measure that must not be taken (it costs a layout, and only the stacked form with one line needs it). */
const never = () => {
  throw new Error("the narrower one-row measure was taken");
};

describe("the rule (stack.ts nextStacked): measured lines, never characters", () => {
  test("an empty field is the one-row form in both forms, whatever its placeholder measures", () => {
    expect(nextStacked(false, text({ empty: true, lines: 3, narrower: never }))).toBe(false);
    expect(nextStacked(true, text({ empty: true, lines: 3, narrower: never }))).toBe(false);
  });

  test("one row to stacked: the field shows a second line in the one-row form", () => {
    expect(nextStacked(false, text({ lines: 1, narrower: never }))).toBe(false);
    for (const lines of [2, 3, 4, 8, 40]) expect(nextStacked(false, text({ lines, narrower: never }))).toBe(true);
  });

  test("stacked stays stacked while the text has a line break or the stacked field shows two lines, with no extra measure", () => {
    expect(nextStacked(true, text({ lines: 2, narrower: never }))).toBe(true);
    expect(nextStacked(true, text({ lines: 1, hasBreak: true, narrower: never }))).toBe(true);
    expect(nextStacked(true, text({ lines: 6, hasBreak: true, narrower: never }))).toBe(true);
  });

  test("stacked to one row only when the one-row form with the line 2em narrower still shows one line", () => {
    expect(STACK_BAND_EM).toBe(2);
    expect(nextStacked(true, text({ lines: 1, narrower: () => 1 }))).toBe(false);
    expect(nextStacked(true, text({ lines: 1, narrower: () => 2 }))).toBe(true);
  });

  test("a one-row line of 20em or more (a rotated phone) keeps one row whatever the draft, in both forms", () => {
    expect(STACK_ROW_EM).toBe(20);
    // 844 px wide: the one-row line is 546 px, 32em at 17 px. Two lines, a line break, the cap: one row.
    for (const over of [{ lines: 2 }, { lines: 4 }, { lines: 1, hasBreak: true }, { lines: 3, hasBreak: true }]) {
      expect(nextStacked(false, text({ ...over, rowEm: 32, narrower: never }))).toBe(false);
      // A box that was stacked (a rotation from portrait) goes back to one row, with no narrower measure.
      expect(nextStacked(true, text({ ...over, rowEm: 32, narrower: never }))).toBe(false);
    }
    expect(nextStacked(false, text({ lines: 2, rowEm: STACK_ROW_EM, narrower: never }))).toBe(false);
    // Under 20em the rule is the narrow column's: the largest portrait phones (480 px: 302 px, under 18em) stack.
    expect(nextStacked(false, text({ lines: 2, rowEm: 19.9, narrower: never }))).toBe(true);
    expect(nextStacked(false, text({ lines: 2, rowEm: 17.8, narrower: never }))).toBe(true);
    // A bad read of the width is the narrow column's rule, so it never switches the form by itself.
    expect(nextStacked(false, text({ lines: 2, rowEm: Number.NaN, narrower: never }))).toBe(true);
    expect(nextStacked(true, text({ lines: 2, rowEm: 0, narrower: never }))).toBe(true);
  });
});

describe("the caret's line after a measure (stack.ts pinsEnd)", () => {
  const at = (over: Partial<Parameters<typeof pinsEnd>[0]> = {}) => pinsEnd({ edited: true, focused: true, caretAtEnd: true, overCap: true, ...over });
  test("a pass that changed the text or the form scrolls a focused field past its cap to the caret at the end", () => {
    expect(at()).toBe(true);
  });
  test("a pass for anything else (a turn that ends, a hold, a rotation) keeps the field's scroll, so a reader keeps their place", () => {
    expect(at({ edited: false })).toBe(false);
  });
  test("a caret elsewhere, a field with no focus (Bring back on touch) and a draft under the cap keep their scroll", () => {
    expect(at({ caretAtEnd: false })).toBe(false);
    expect(at({ focused: false })).toBe(false);
    expect(at({ overCap: false })).toBe(false);
  });
});

describe("the measure (stack.ts fieldLines and lineRows)", () => {
  // The phone's field: 2 px of padding at the top and at the bottom, 17 px text at a line height of 1.5 (Glass).
  const pad = 4;
  const lh = 25.5;
  test("the field's lines with its height at auto: (scrollHeight - padding) / line height, rounded, at least 1", () => {
    expect(fieldLines({ scrollHeight: pad + lh, padding: pad, lineHeight: lh })).toBe(1);
    expect(fieldLines({ scrollHeight: pad + 2 * lh, padding: pad, lineHeight: lh })).toBe(2);
    expect(fieldLines({ scrollHeight: pad + 4 * lh + 1, padding: pad, lineHeight: lh })).toBe(4);
    // A pixel of rounding either way is the same line count.
    expect(fieldLines({ scrollHeight: 30, padding: pad, lineHeight: lh })).toBe(1);
    expect(fieldLines({ scrollHeight: 54, padding: pad, lineHeight: lh })).toBe(2);
    // A bad read counts as one line, so it never switches the form by itself.
    expect(fieldLines({ scrollHeight: 0, padding: pad, lineHeight: lh })).toBe(1);
    expect(fieldLines({ scrollHeight: 90, padding: pad, lineHeight: 0 })).toBe(1);
    expect(fieldLines({ scrollHeight: 90, padding: pad, lineHeight: Number.NaN })).toBe(1);
  });

  test("the line's rows: a mode chip on a row of its own above the field (row 76, a line under 12em) is a second line", () => {
    const field = { scrollHeight: pad + lh, offsetTop: 40 };
    expect(lineRows(field, null, pad, lh)).toBe(1);
    // The chip beside the field: its foot is under the field's top.
    expect(lineRows(field, { offsetTop: 48, offsetHeight: 28 }, pad, lh)).toBe(1);
    // The chip on the row above: the field starts under its foot (the line's row gap between them).
    expect(lineRows({ scrollHeight: pad + lh, offsetTop: 40 }, { offsetTop: 8, offsetHeight: 28 }, pad, lh)).toBe(2);
    expect(lineRows({ scrollHeight: pad + 3 * lh, offsetTop: 36 }, { offsetTop: 8, offsetHeight: 28 }, pad, lh)).toBe(4);
  });
});

describe("the hysteresis on a model of the phone's box (390 px, Glass's sizes)", () => {
  // A stand-in layout: each character as wide as a Latin letter at 17 px, the one-row column 212 px, the stacked column
  // 332 px, the band 2em of 17 px. A line break starts a line.
  const CH = 8.6;
  const EM = 17;
  const ONE_ROW = 212;
  const STACKED = 332;
  const linesAt = (s: string, width: number) => s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * CH) / width)), 0);
  /** The box's columns at a width: 390 px (portrait), or 844 px (the phone rotated: 546 px in one row, 666 stacked). */
  type Box = { oneRow: number; stacked: number };
  const PORTRAIT: Box = { oneRow: ONE_ROW, stacked: STACKED };
  const LANDSCAPE: Box = { oneRow: 546, stacked: 666 };
  /** The layout effect: measure in the form shown, switch, and measure again in the new form; the passes it took. */
  function settle(stacked: boolean, s: string, box: Box = PORTRAIT): { stacked: boolean; passes: number } {
    let now = stacked;
    for (let passes = 1; passes <= 3; passes++) {
      const next = nextStacked(now, { empty: s === "", hasBreak: s.includes("\n"), lines: linesAt(s, now ? box.stacked : box.oneRow), rowEm: box.oneRow / EM, narrower: () => linesAt(s, box.oneRow - STACK_BAND_EM * EM) });
      if (next === now) return { stacked: now, passes };
      now = next;
    }
    throw new Error(`the form flips back and forth on ${JSON.stringify(s)}`);
  }
  const SENTENCE = "Run the upload test 20 times and tell me which runs fail.";

  test("typed key by key it stacks at the character that wraps the one-row column, and deleted back it returns 2em earlier", () => {
    let stacked = false;
    let stackedAt = 0;
    for (let i = 1; i <= SENTENCE.length; i++) {
      const r = settle(stacked, SENTENCE.slice(0, i));
      // A switch settles in the next pass: it never flips back in the same layout effect.
      expect(r.passes).toBeLessThanOrEqual(2);
      if (r.stacked && !stacked) stackedAt = i;
      stacked = r.stacked;
    }
    expect(stackedAt).toBe(SENTENCE.split("").findIndex((_, i) => linesAt(SENTENCE.slice(0, i + 1), ONE_ROW) >= 2) + 1);
    expect(stacked).toBe(true);
    let backAt = -1;
    for (let n = SENTENCE.length - 1; n >= 0 && backAt < 0; n--) {
      const r = settle(stacked, SENTENCE.slice(0, n));
      expect(r.passes).toBeLessThanOrEqual(2);
      if (!r.stacked) backAt = n;
      stacked = r.stacked;
    }
    // It comes back where the text fits the one-row column with 2em to spare, not at the character that stacked it.
    expect(backAt).toBe(Math.floor((ONE_ROW - 2 * EM) / CH));
    expect(backAt).toBeLessThan(stackedAt - 1);
    // Typed again, it stacks at the same character as the first time.
    let again = 0;
    for (let i = backAt + 1; i <= SENTENCE.length && !again; i++) {
      stacked = settle(stacked, SENTENCE.slice(0, i)).stacked;
      if (stacked) again = i;
    }
    expect(again).toBe(stackedAt);
  });

  test("one character deleted and typed again at the edge, six times, never switches the form", () => {
    let stacked = false;
    let edge = 0;
    for (let i = 1; i <= SENTENCE.length && !stacked; i++) {
      stacked = settle(stacked, SENTENCE.slice(0, i)).stacked;
      edge = i;
    }
    expect(stacked).toBe(true);
    let flips = 0;
    for (let k = 0; k < 6; k++)
      for (const n of [edge - 1, edge]) {
        const next = settle(stacked, SENTENCE.slice(0, n)).stacked;
        if (next !== stacked) flips++;
        stacked = next;
      }
    expect(flips).toBe(0);
    // The band is wider than any one character: a Latin letter, a CJK character (1em) or an emoji (about 1.25em).
    expect(STACK_BAND_EM * EM).toBeGreaterThan(1.25 * EM);
  });

  test("a paste of several lines stacks at once, and emptying the box puts it back in one row", () => {
    const paste = "line one\nline two\nline three";
    expect(settle(false, paste).stacked).toBe(true);
    // A short text with a line break stays stacked: the break is a line of its own.
    expect(settle(true, "ok\n").stacked).toBe(true);
    expect(settle(true, "").stacked).toBe(false);
    expect(settle(false, "").stacked).toBe(false);
    // Bring back's quote (R130) has line breaks: it lands stacked.
    expect(settle(false, "> The fake server sends the event first.\n>\n> Add the listener first.\n\n").stacked).toBe(true);
  });

  test("the phone rotated keeps one row for every draft, and a stacked draft goes back to one row there and stacks again upright", () => {
    const LONG = "Run the upload test 20 times with the fake server, and when a run fails, keep its log and the server's events in order.";
    let stacked = false;
    for (let i = 1; i <= LONG.length; i++) {
      stacked = settle(stacked, LONG.slice(0, i), LANDSCAPE).stacked;
      expect([i, stacked]).toEqual([i, false]);
    }
    expect(settle(false, "line one\nline two\nline three", LANDSCAPE).stacked).toBe(false);
    // Upright the same draft is stacked; rotated it is one row, in one pass; upright again it stacks.
    expect(settle(false, LONG).stacked).toBe(true);
    expect(settle(true, LONG, LANDSCAPE)).toEqual({ stacked: false, passes: 2 });
    expect(settle(false, LONG).stacked).toBe(true);
  });
});

const composerCss = css("composer.css");
const STACK = ".cmp.is-phone.is-stacked";

describe("the stacked form's rules (composer.css)", () => {
  test("the field row becomes a grid: the line over the whole width, then +, @, the room and the end key on one row", () => {
    const grid = rule(composerCss, `${STACK} .cmp-field`);
    expect(grid).not.toBeNull();
    expect(grid).toMatch(/display:\s*grid;/);
    expect(grid).toMatch(/grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto;/);
    expect(grid).toMatch(/grid-template-areas:\s*"line line line line" "plus at \. key";/);
    expect(grid).toMatch(/align-items:\s*end;/);
    expect(grid).toMatch(/column-gap:\s*var\(--s1\);/);
    expect(grid).toMatch(/row-gap:\s*0;/);
  });

  test("each child of the row has its area, the end key in each of its kinds; the line is inset --s3", () => {
    const line = rule(composerCss, `${STACK} .cmp-field > .cmp-line`);
    expect(line).toMatch(/grid-area:\s*line;/);
    expect(line).toMatch(/padding-inline:\s*var\(--s3\);/);
    expect(rule(composerCss, `${STACK} .cmp-field > .cmp-plus-btn`)).toMatch(/grid-area:\s*plus;/);
    expect(rule(composerCss, `${STACK} .cmp-field > .cmp-at-btn`)).toMatch(/grid-area:\s*at;/);
    expect(rule(composerCss, `${STACK} .cmp-field > .cmp-key, ${STACK} .cmp-field > .btn.cmp-copy`)).toMatch(/grid-area:\s*key;/);
    // The end keys the phone draws: Send, Run and Stop are .cmp-key; Continue in a copy and Send again are .btn.cmp-copy.
    const composer = code("composer", "Composer.tsx");
    expect(composer).toContain('className="cmp-key cmp-stop"');
    expect(composer).toContain('className="cmp-key cmp-send cmp-run"');
    expect(composer).toContain('className="cmp-key cmp-send"');
    expect(composer).toContain('className="icon-btn cmp-plus-btn"');
    expect(code("composer", "HeldLine.tsx").match(/className="btn cmp-copy"/g)?.length).toBe(2);
    expect(code("composer", "MentionMenu.tsx")).toContain('className="icon-btn cmp-at-btn"');
  });

  test("the mode chip sits on the text's first line (in Bash mode on its 1.6 line height)", () => {
    const chip = rule(composerCss, `${STACK} .cmp-line > .cmp-chip`);
    expect(chip).toMatch(/align-self:\s*flex-start;/);
    // The line's 8 px of padding is outside its content box; the field's own 2 px, then the first line's half leading.
    expect(chip).toMatch(/margin-top:\s*calc\(2px \+ \(1\.5 \* var\(--fs-input\) - 28px\) \/ 2\);/);
    expect(rule(composerCss, `${STACK}[data-mode="bash"] .cmp-line > .cmp-chip`)).toMatch(/margin-top:\s*calc\(2px \+ \(1\.6 \* var\(--fs-input\) - 28px\) \/ 2\);/);
  });

  test("the phone's field keeps the laptop's 2 px inside its scroll box, and its line holds the rest of the row's room", () => {
    // A draft past the cap, scrolled to its end, shows no cut half line at the field's top edge: the clip sits 2 px
    // from the text (under the line's half leading), as on the laptop (.touch .cmp-field's rule); the 8 px above and
    // under it are the line's, so the one-row field row keeps its 44 px and the box its height.
    expect(rule(composerCss, ".cmp.is-phone .cmp-input")).toMatch(/padding:\s*2px 0;/);
    expect(rule(composerCss, ".cmp.is-phone .cmp-field > .cmp-line")).toMatch(/padding-block:\s*8px;/);
    expect(rule(composerCss, ".cmp-input")).toMatch(/padding:\s*2px 0;/);
  });

  test("the rules come after the phone's own, are the phone's only, touch the field's line only, and use tokens with no motion", () => {
    const blocks = [...composerCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.includes("is-stacked"));
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    const phoneEnd = composerCss.indexOf(".cmp.is-phone .cmp-lines");
    expect(phoneEnd).toBeGreaterThan(0);
    for (const m of blocks) {
      for (const sel of m[1]!.split(",")) {
        // The phone only: the tablet and the laptop keep their bar under the field.
        expect(sel.trim()).toStartWith(STACK);
        // p.cmp-line is also the class of the lines under the slab (HeldLine.tsx, Composer.tsx): only the field's line.
        if (/\.cmp-line\b/.test(sel) && !/\.cmp-line > /.test(sel)) expect(sel).toContain(".cmp-field > .cmp-line");
      }
      expect(m.index!).toBeGreaterThan(phoneEnd);
      const body = m[2]!;
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      expect(body).not.toMatch(/transition|animation/);
    }
    // The field keeps the phone's own padding: the stacked form sets none of its own.
    expect(blocks.some((m) => m[1]!.includes(".cmp-input"))).toBe(false);
  });

  test("the side chat's box keeps its one row: one key and no + or @, so its text has most of the width already", () => {
    expect(css("side.css")).not.toContain("is-stacked");
    expect(code("side", "SideChat.tsx")).not.toContain("is-stacked");
  });
});

// ---- the composer: the class, the measure, and an element tree that never changes ----

const P: Project = { id: "kitespanxx", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {} };
let serial = 0;
function chatWith(text: string): { chat: Chat; draft: ChatDraft } {
  const id = `composerlinesxx${String.fromCharCode(97 + (serial % 26))}${String.fromCharCode(97 + Math.floor(serial / 26))}xxx`;
  serial++;
  const chat = scripted({
    id,
    projectId: P.id,
    title: "Fix the flaky upload test",
    titleSource: "first-prompt",
    state: "idle",
    updatedAt: "2026-11-06T08:00:00.000Z",
    sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    model: "default",
    effort: "default",
    mode: "default",
    items: [],
    pending: [],
    context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
    connectors: [],
    outputs: [],
  });
  return { chat, draft: { mode: "chat", command: null, text, link: false, uploads: [] } };
}
const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const was = { mm: g.matchMedia, win: g.window, hadMm: "matchMedia" in g, hadWin: "window" in g };
function device(kind: "laptop" | "phone") {
  g.matchMedia = (q: string) => ({ matches: kind === "phone" && q.includes("coarse"), addEventListener() {}, removeEventListener() {} });
  g.window = kind === "phone" ? { innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} } : { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
}
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  resetState();
});
function render(kind: "laptop" | "phone", text: string): string {
  const { chat, draft } = chatWith(text);
  device(kind);
  resetState({ projects: [P], chats: [chat], draft: { [chat.id]: draft }, ready: true });
  try {
    return renderToStaticMarkup(createElement(Composer, { chat, route: parse(new URL(`/c/${chat.id}`, "http://127.0.0.1")) }));
  } finally {
    device("laptop");
  }
}
/** The field row's children, in order, by their test id or class. */
function rowOf(html: string): string[] {
  const at = html.indexOf('<div class="cmp-field">');
  expect(at).toBeGreaterThan(-1);
  const VOID = new Set(["input", "br", "img", "hr", "meta", "link"]);
  const out: string[] = [];
  let depth = 0;
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  re.lastIndex = at;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const [, close, tag, attrs, self] = m;
    if (close) {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) out.push(/data-testid="([^"]+)"/.exec(attrs!)?.[1] ?? /class="([^"]+)"/.exec(attrs!)?.[1] ?? tag!);
    if (!self && !VOID.has(tag!)) depth++;
  }
  return out;
}

describe("the composer (Composer.tsx)", () => {
  const LONG = "Run the upload test 20 times with the fake server, and when a run fails, keep its log and the server's events in order.";

  test("the phone's row is the same element tree for a short and a long draft: +, the line, the end key, with no second row", () => {
    const short = render("phone", "Run it again");
    const long = render("phone", LONG);
    for (const html of [short, long]) {
      expect(html).toContain('class="cmp is-phone"');
      expect(rowOf(html)).toEqual(["composer-plus", "cmp-line", "composer-send"]);
      expect(html).not.toContain("cmp-bar");
    }
    // The form is measured in the page, never guessed from the text's length on the server's render.
    expect(long).not.toContain("is-stacked");
  });

  test("the laptop keeps its field over its bar and has no stacked form", () => {
    const html = render("laptop", LONG);
    expect(html).toContain('class="cmp"');
    expect(html).toContain('class="cmp-bar"');
    expect(html).not.toContain("is-stacked");
  });

  test("one class on the root, next to is-phone, from one state that the phone's measure sets", () => {
    const c = code("composer", "Composer.tsx");
    expect(c).toContain('className={`cmp${phone ? " is-phone" : ""}${stacked ? " is-stacked" : ""}${riding ? " is-kb" : ""}${held ? " is-held" : ""}`}');
    expect(c).toMatch(/const \[stackedState, setStacked\] = useState\(false\);/);
    expect(c).toMatch(/const stacked = phone && stackedState;/);
    // The JSX of the row keeps its order: +, @, the line (the chip and the field), then the one end key.
    const row = c.slice(c.indexOf('<div className="cmp-field">'), c.indexOf('{phone ? null : (\n              <div className="cmp-bar">'));
    const order = ["{phone ? plusButton : null}", "{phone ? atButton : null}", '<div className="cmp-line">', "{chip}", "<textarea", "{phone ? (held ? (canStop ? stopButton : copyButton) : stopShared ? stopButton : sendButton) : null}"];
    let last = -1;
    for (const part of order) {
      const i = row.indexOf(part);
      expect([part, i > last]).toEqual([part, true]);
      last = i;
    }
  });

  test("the measure runs in the grow layout effect, before the paint, and measures again in the new form", () => {
    const c = code("composer", "Composer.tsx");
    const at = c.indexOf("const maxLines = phone ?");
    const effect = c.slice(c.indexOf("useLayoutEffect(() => {", at), c.indexOf("const notice = pre?.notAvailable", at));
    expect(effect).toContain("nextStacked(stackedState, {");
    expect(effect).toContain('empty: d.text === ""');
    expect(effect).toContain('hasBreak: d.text.includes("\\n")');
    // The new form goes on the root at once, so the height is the new form's, and React's render follows.
    const toggle = effect.indexOf('cmp.classList.toggle("is-stacked", form)');
    const height = effect.indexOf("el.style.height = `${Math.min(el.scrollHeight, max)}px`");
    expect(toggle).toBeGreaterThan(-1);
    expect(height).toBeGreaterThan(toggle);
    expect(effect.indexOf("if (form !== stackedState) setStacked(form);")).toBeGreaterThan(height);
    // The root keeps its height while the field is measured (its height at auto, rule 3's one-row form), so the chat
    // above it never grows for that layout and its scroll is never clamped away from the end; then it is let go.
    const pin = effect.indexOf("if (cmp) cmp.style.height = `${cmp.getBoundingClientRect().height}px`;");
    const auto = effect.indexOf('el.style.height = "auto";');
    const unpin = effect.indexOf("if (cmp) cmp.style.height = pin;");
    expect(pin).toBeGreaterThan(-1);
    expect(auto).toBeGreaterThan(pin);
    expect(effect.indexOf("nextStacked(")).toBeGreaterThan(auto);
    expect(unpin).toBeGreaterThan(height);
    // No way out between the pin and its release.
    expect(effect.slice(pin, unpin)).not.toMatch(/\breturn\b/);
    // A focused caret at the end of a draft past the cap stays in view after the text wraps again (a paste that
    // stacks the box), only in a pass that changed the text or the form (stack.ts pinsEnd): a pass for a turn that
    // ends, a hold or a rotation keeps the field's scroll. A field with no focus (Bring back on touch) keeps the scroll
    // that its own code gives it.
    const edited = effect.indexOf("const edited = form !== stackedState || d.text !== measured.current;");
    const end = effect.indexOf("if (phone && pinsEnd({ edited, focused: document.activeElement === el, caretAtEnd: el.selectionStart === el.value.length, overCap: el.scrollHeight > max })) el.scrollTop = el.scrollHeight;");
    expect(edited).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(Math.max(height, edited));
    expect(end).toBeLessThan(unpin);
    expect(effect.indexOf("measured.current = d.text;")).toBeGreaterThan(edited);
    expect(effect).not.toMatch(/el\.scrollTop = el\.scrollHeight;[\s\S]*el\.scrollTop = el\.scrollHeight;/);
    // The one-row line's width goes into the rule (a rotated phone keeps one row).
    expect(effect).toContain("rowEm: oneRowWidth(el) / parseFloat(cs.fontSize)");
    // While the box rides the keyboard, its dock takes the box's new height in this same layout effect (a state set
    // here is drawn in the same frame), so the chat shrinks with the box and keeps its end before the paint, and the
    // box never covers the conversation's last line for a frame; the ResizeObserver's later read changes nothing.
    const ride = effect.indexOf("rideMeasure.current?.();");
    expect(ride).toBeGreaterThan(unpin);
    expect(c).toMatch(/const rideMeasure = useRef<\(\(\) => void\) \| null>\(null\);/);
    const rideEffect = c.slice(c.indexOf("const [ride, setRide] = useState"), c.indexOf("// Keep the draft: local state"));
    expect(rideEffect).toContain("rideMeasure.current = measure;");
    expect(rideEffect).toContain("rideMeasure.current = null;");
    // The state is in the effect's dependencies, so the height is measured again in the new form; so are the keys that
    // change the one-row column: the @ button (coarse, and the mode) and the held end key's kinds (Stop, Continue in a
    // copy, Send again, none). Stop in Send's place (stopShared) shows only with an empty field, which is one row.
    const deps = /\}, \[([^\]]*)\]\);\s*$/.exec(effect)?.[1]?.split(",").map((s) => s.trim()) ?? [];
    for (const dep of ["d.text", "d.mode", "d.command", "placeholder", "maxLines", "vp.width", "vp.size", "phone", "coarse", "stackedState", "held?.kind", "canStop", "handing"]) expect([dep, deps.includes(dep)]).toEqual([dep, true]);
    // No frame or timer in between: the switch lands in the commit that changed the text.
    expect(effect).not.toMatch(/requestAnimationFrame|setTimeout/);
  });

  test("the narrower one-row measure changes styles only, and puts them back: no element moves", () => {
    const c = code("composer", "Composer.tsx");
    const fn = c.slice(c.indexOf("function oneRowNarrower("), c.indexOf("\n}\n", c.indexOf("function oneRowNarrower(")));
    expect(fn).toContain('cmp.classList.remove("is-stacked")');
    expect(fn).toContain('cmp.classList.add("is-stacked")');
    expect(fn).toContain("line.style.marginInlineEnd = `${band}px`");
    expect(fn).toMatch(/finally \{[^}]*line\.style\.marginInlineEnd = was;[^}]*\}/);
    expect(fn).not.toMatch(/appendChild|insertBefore|removeChild|remove\(\)|focus\(|blur\(/);
    // The band is 2em of the field's own font size.
    expect(c).toContain("STACK_BAND_EM * parseFloat(cs.fontSize)");
  });
});
