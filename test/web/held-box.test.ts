// Row 80 (the owner's answer of 2026-11-02 on row 78): while another app has the chat's session open, the message box
// cannot be used. The field shows the draft and takes no typing, paste or drop (read-only, so it stays readable and
// selectable; it is not removed); +, @, the / menu, the mode, model and effort pickers and a chip's Remove are off,
// shown as off and not hidden, so the box keeps its shape; Continue in a copy works, and so does Stop while kitespan's
// own turn finishes. The composer's routes (send, bash, the / menu and a command row, mention, add, model, effort,
// mode) on a held chat fill nothing and open nothing: the held line is the box's one line. Everything comes back when
// the hold ends, with the draft as it was. Rendered with React's server renderer in a laptop window and a phone
// stand-in; the parts a render cannot reach (keys, paste, the link and focus effects) are pins on the source.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import { resetState, type ChatDraft } from "../../web/state/store";
import type { Chat, Project, Upload } from "../../web/state/types";
import { Composer } from "../../web/composer/Composer";
import { heldLine } from "../../web/composer/HeldLine";
import { AtButton } from "../../web/composer/MentionMenu";
import { scripted } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
/** The source without its comments, so a pin reads the code only. */
const code = (...p: string[]) =>
  readFileSync(join(WEB, ...p), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
const url = (path: string) => parse(new URL(path, "http://127.0.0.1"));
const count = (s: string, part: string) => s.split(part).length - 1;

const SID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const P: Project = { id: "kitespanxx", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {} };
const CHAT = "demoolxxxxxxxxxxxxxx";
const DRAFT_TEXT = "Keep this for later";
const UPLOAD: Upload = { id: "abc123", chatId: CHAT, name: "notes.txt", size: 12, type: "text/plain", path: `/tmp/kitespan-uploads-dev/u-abc123/notes.txt`, folder: "temp", dir: "/tmp/kitespan-uploads-dev/u-abc123", at: "", state: "done", progress: 1 };

function chatWith(p: Partial<Chat> = {}): Chat {
  return {
    ...scripted({
      id: CHAT,
      projectId: P.id,
      title: "Fix the flaky upload test",
      titleSource: "first-prompt",
      state: "idle",
      updatedAt: "2026-10-31T08:00:00.000Z",
      sessionId: SID,
      model: "default",
      effort: "default",
      mode: "default",
      items: [],
      pending: [],
      context: { usedPct: 0, usedTokens: 0, windowTokens: 0, parts: [] },
      connectors: [],
      outputs: [],
    }),
    ...p,
  };
}
const HELD = { held: { app: "terminal" as const, session: SID } };
const draft = (over: Partial<ChatDraft> = {}): ChatDraft => ({ mode: "chat", command: null, text: DRAFT_TEXT, link: false, uploads: [], ...over });

// The viewport the composer reads (layout/size.ts, composer/keyboard.ts): a laptop window with a mouse, or a phone.
const g = globalThis as unknown as { matchMedia?: unknown; window?: unknown };
const was = { mm: g.matchMedia, win: g.window, hadMm: "matchMedia" in g, hadWin: "window" in g };
function device(kind: "laptop" | "phone") {
  const coarse = kind === "phone";
  g.matchMedia = (q: string) => ({ matches: coarse && q.includes("coarse"), addEventListener() {}, removeEventListener() {} });
  g.window = kind === "phone" ? { innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} } : { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
}
beforeAll(() => device("laptop"));
afterAll(() => {
  if (was.hadMm) g.matchMedia = was.mm;
  else delete g.matchMedia;
  if (was.hadWin) g.window = was.win;
  else delete g.window;
  resetState();
});

// The composer keeps each chat's field and the last link it applied in memory, per page (Composer.tsx DRAFTS and
// APPLIED): every render here is a chat of its own, as a fresh page would be.
let serial = 0;
function freshId(): string {
  let n = serial++;
  let s = "";
  for (let i = 0; i < 8; i++) {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return `heldboxchata${s}`;
}

/** The composer of a chat of its own at `/c/<chat><rest>`. */
function render(over: Partial<Chat>, rest: string, d: ChatDraft = draft(), kind: "laptop" | "phone" = "laptop"): string {
  const chat = chatWith({ ...over, id: freshId() });
  const path = `/c/${chat.id}${rest}`;
  expect(url(path).params.chat).toBe(chat.id);
  device(kind);
  resetState({ projects: [P], chats: [chat], draft: { [chat.id]: d }, uploads: { [chat.id]: [{ ...UPLOAD, chatId: chat.id }] }, ready: true });
  try {
    return renderToStaticMarkup(createElement(Composer, { chat, route: url(path) }));
  } finally {
    device("laptop");
  }
}
/** The opening tag of the first element with this test id (or this attribute text), or null. */
function tag(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}
const fieldOf = (html: string) => {
  const m = /<textarea([^>]*)>([^<]*)<\/textarea>/.exec(html);
  return m ? { attrs: m[1]!, value: m[2]! } : null;
};
const off = (t: string | null) => !!t && /\sdisabled=""/.test(t);
const linesOf = (html: string) => html.slice(html.indexOf('<div class="cmp-lines">'), html.indexOf("</div>", html.indexOf('<div class="cmp-lines">')));
const PLUS = 'data-testid="composer-plus"';
const MODE = 'aria-label="Permission mode:';
const MODEL = 'aria-label="Model:';
const AT = 'data-testid="composer-at"';
const COPY = 'data-testid="composer-copy"';
const STOP = 'data-testid="composer-stop"';

describe("the held box (row 80)", () => {
  test("the field shows the draft, read-only: it stays readable and selectable, and is not removed", () => {
    const html = render(HELD, "");
    const f = fieldOf(html);
    expect(f).not.toBeNull();
    expect(f!.value).toBe(DRAFT_TEXT);
    expect(f!.attrs).toContain('readOnly=""');
    expect(f!.attrs).not.toContain("disabled");
    expect(html).toContain('class="cmp is-held"');
  });

  test("+, the mode and model pickers (the model's effort too) are off on a laptop, shown and not hidden; Continue in a copy works", () => {
    const html = render(HELD, "");
    for (const b of [PLUS, MODE, MODEL]) {
      expect(tag(html, b)).not.toBeNull();
      expect(off(tag(html, b))).toBe(true);
    }
    expect(off(tag(html, COPY))).toBe(false);
    expect(html).not.toContain('data-testid="composer-send"');
    // The context ring is a read: it stays a link.
    expect(tag(html, 'data-testid="composer-context"')).toStartWith("<a ");
  });

  test("on a phone: the picker row, + and @ are off; Stop while kitespan's own turn finishes, then Continue in a copy", () => {
    const running = render({ ...HELD, state: "running", turn: 12 }, "", draft(), "phone");
    expect(running).toContain('class="cmp is-phone is-held"');
    for (const b of [PLUS, MODE, MODEL]) expect(off(tag(running, b))).toBe(true);
    expect(off(tag(running, STOP))).toBe(false);
    expect(running).not.toContain(COPY);
    const done = render(HELD, "", draft(), "phone");
    expect(off(tag(done, COPY))).toBe(false);
    expect(done).not.toContain(STOP);
    // The `@` button shows on a coarse pointer only, which the server renderer never reports (keyboard.ts useCoarse):
    // the button itself, and the composer's use of it.
    expect(off(tag(renderToStaticMarkup(createElement(AtButton, { open: false, off: true, onOpen: () => {}, onClose: () => {} })), AT))).toBe(true);
    expect(off(tag(renderToStaticMarkup(createElement(AtButton, { open: false, onOpen: () => {}, onClose: () => {} })), AT))).toBe(false);
    expect(code("composer", "Composer.tsx")).toContain('const atButton = coarse && d.mode === "chat" ? <AtButton open={mentionShown} off={isHeld} onOpen={openAt} onClose={closeAtPicker} /> : null;');
  });

  test("Stop stays on a laptop while kitespan's own turn finishes, beside Continue in a copy", () => {
    const html = render({ ...HELD, state: "running", turn: 12 }, "");
    expect(off(tag(html, STOP))).toBe(false);
    expect(off(tag(html, COPY))).toBe(false);
  });

  test("while kitespan's own orphan finishes its turn: one Stop on every size, and Esc ends the orphan too (R16)", () => {
    const FINISHING = { held: { app: "other" as const, session: SID, kind: "finishing" as const } };
    for (const kind of ["laptop", "phone"] as const) {
      const html = render({ ...FINISHING, state: "sleeping", serverState: "sleeping", turn: null }, "", draft(), kind);
      expect(count(html, STOP)).toBe(1);
      expect(html).not.toContain(COPY);
      expect(html).not.toContain('data-testid="composer-send"');
    }
    // Esc acts while canStop, which the finishing hold sets as a running turn does.
    expect(code("composer", "Composer.tsx")).toMatch(/const canStop = chat\.turn !== null \|\| held\?\.kind === "finishing";/);
  });

  test("a chip's Remove is off too (an upload's would delete the file); a tap on a chip still shows its path", () => {
    const html = render(HELD, "", draft({ uploads: [UPLOAD.id], mentions: ["src/app.ts"] }));
    expect(off(tag(html, 'data-testid="attach-remove"'))).toBe(true);
    expect(off(tag(html, 'data-testid="mention-remove"'))).toBe(true);
    expect(count(html, 'class="cmp-chip-body" aria-expanded="false"')).toBe(2);
    expect(html).not.toMatch(/class="cmp-chip-body"[^>]*disabled/);
  });

  test("an empty held field shows no placeholder (it would invite typing); the placeholder comes back with the box", () => {
    const empty = fieldOf(render(HELD, "", draft({ text: "" })))!;
    expect(empty.value).toBe("");
    expect(empty.attrs).not.toMatch(/placeholder="[^"]+"/);
    expect(fieldOf(render({}, "", draft({ text: "" })))!.attrs).toContain('placeholder="Ask Claude to work in kitespan"');
    // A chat with items: the composer reads only that it has some.
    const items = [{ kind: "user", id: "u1", text: "hello", at: "2026-10-31T08:00:00.000Z" }] as unknown as Chat["items"];
    expect(fieldOf(render({ ...HELD, items }, "", draft({ text: "" })))!.attrs).not.toMatch(/placeholder="[^"]+"/);
    expect(fieldOf(render({ items }, "", draft({ text: "" })))!.attrs).toContain('placeholder="Reply to Claude…"');
  });

  test("a / command draft shows as it is: its chip and its arguments, read-only", () => {
    const html = render(HELD, "", draft({ mode: "slash", command: "compact", text: "keep the plan" }));
    expect(html).toContain('data-mode="slash"');
    expect(html).toContain('<span class="cmp-chip-name">/compact</span>');
    expect(fieldOf(html)!.value).toBe("keep the plan");
    expect(fieldOf(html)!.attrs).toContain('readOnly=""');
  });
});

describe("the composer's routes on a held chat show the held line only (row 80)", () => {
  const ROUTES: [string, string][] = [
    ["send", `/send?text=${encodeURIComponent("Run the tests again")}`],
    ["bash", `/bash?cmd=${encodeURIComponent("git status")}`],
    ["slashMenu", "/slash"],
    ["slash", `/slash/compact?args=${encodeURIComponent("keep the test plan")}`],
    ["mention", "/mention?q=upl"],
    ["add", "/add"],
    ["model", "/model?pick=claude-haiku-5-5"],
    ["effort", "/effort?pick=high"],
    ["mode", "/mode?pick=acceptEdits"],
  ];
  for (const [name, rest] of ROUTES)
    test(`${name}: nothing fills, nothing opens; the field keeps the draft`, () => {
      expect(url(`/c/${CHAT}${rest}`).name).toBe(name);
      const html = render(HELD, rest);
      const f = fieldOf(html)!;
      expect(f.value).toBe(DRAFT_TEXT);
      expect(f.attrs).toContain('readOnly=""');
      expect(html).toContain('data-mode="chat"');
      // No menu over the box, no picker, no + menu, nothing marked open.
      expect(html).not.toContain('role="listbox"');
      expect(html).not.toContain('role="dialog"');
      expect(html).not.toContain('aria-expanded="true"');
      // The held line is the box's one line: no link line, no over-cap or dropped line, no external-link line.
      const lines = linesOf(html);
      expect(lines).toContain(`data-testid="composer-held" role="status">${heldLine("terminal")}</p>`);
      expect(count(lines, "<p ")).toBe(1);
      expect(html).not.toContain("link-notice");
      expect(html).not.toContain("external-link-line");
    });

  test("a composer link with a part that cannot be read adds no line above the chat while held (ChatView, 5.4)", () => {
    const view = code("chat", "ChatView.tsx");
    expect(view).toContain("chatLinkLine(route, line, (chat.archived && archivedLinePath(route)) || (!!chat.held && COMPOSER_ROUTES.has(route.name)) || (!!requestId && !routedCard))");
  });
  test("a draft that came from a link shows read-only with the held line alone (its link line comes back with the box)", () => {
    const held = render(HELD, "", draft({ link: true }));
    expect(count(linesOf(held), "<p ")).toBe(1);
    expect(held).not.toContain("external-link-line");
    expect(render({}, "", draft({ link: true }))).toContain("external-link-line");
  });
});

describe("everything comes back when the hold ends (row 80)", () => {
  test("the same chat with no hold: the field takes typing, Send is back, + and the pickers work", () => {
    const html = render({}, "");
    const f = fieldOf(html)!;
    expect(f.value).toBe(DRAFT_TEXT);
    expect(f.attrs).not.toContain("readOnly");
    expect(html).toContain('class="cmp"');
    for (const b of [PLUS, MODE, MODEL]) expect(off(tag(html, b))).toBe(false);
    expect(off(tag(html, 'data-testid="composer-send"'))).toBe(false);
    expect(html).not.toContain(COPY);
    expect(html).not.toContain('data-testid="composer-held"');
    const chips = render({}, "", draft({ uploads: [UPLOAD.id], mentions: ["src/app.ts"] }));
    expect(off(tag(chips, 'data-testid="attach-remove"'))).toBe(false);
    expect(off(tag(chips, 'data-testid="mention-remove"'))).toBe(false);
  });

  test("on a chat with no hold, a composer link fills the box as before", () => {
    const send = render({}, `/send?text=${encodeURIComponent("Run the tests again")}`);
    expect(fieldOf(send)!.value).toBe("Run the tests again");
    const bash = render({}, `/bash?cmd=${encodeURIComponent("git status")}`);
    expect(bash).toContain('data-mode="bash"');
    expect(fieldOf(bash)!.value).toBe("git status");
  });

  test("a link that came while the chat was held fills once the hold ends; one applied before the hold is not applied again", () => {
    const composer = code("composer", "Composer.tsx");
    expect(composer).toContain("const linkPre = prefillOf(route);");
    expect(composer).toContain("const pre = held ? null : linkPre;");
    const effect = composer.slice(composer.indexOf("useLayoutEffect(() => {\n    if (held) return;"));
    expect(effect.length).toBeGreaterThan(0);
    // The effect runs when the hold ends too, and compares the link with the one applied last (APPLIED), which the
    // hold left as it was.
    expect(effect.slice(0, effect.indexOf("}, [preKey, isHeld]);"))).toContain("const was = APPLIED.get(chat.id);");
    // The focus follows the link only: a hold that begins or ends moves no focus, and a held field is not focused.
    const focus = composer.slice(composer.indexOf("useEffect(() => {\n    if (held) return;\n    if (pre) {"));
    expect(focus.slice(0, focus.indexOf("}, [linkKey]);")).length).toBeGreaterThan(0);
  });

  test("the / menu, the @ picker and the mid-line / menu are hidden while held, not closed, so they come back as they were", () => {
    const composer = code("composer", "Composer.tsx");
    expect(composer).toContain('const menuVisible = d.mode === "slash" && menuOpen && !held;');
    expect(composer).toContain('const mentionShown = mention !== null && d.mode === "chat" && !held;');
    expect(composer).toContain("const slashOpen = slash !== null && slashField(d) && !menuVisible && !mentionShown && !held;");
  });
});

describe("no typing, paste, key or shortcut acts while held (row 80)", () => {
  const composer = code("composer", "Composer.tsx");
  test("the field's keys are the browser's own while held: no chip taken away, no menu key, no Enter", () => {
    const keys = composer.slice(composer.indexOf("const onKeyDown = "), composer.indexOf("// ---- files (D37, D50)"));
    expect(keys).toMatch(/^const onKeyDown = \(e: KeyboardEvent<HTMLTextAreaElement>\) => \{\s*if \(held\) return;/);
    const select = composer.slice(composer.indexOf("const onSelect = "), composer.indexOf("const onChange = "));
    expect(select).toMatch(/^const onSelect = \(\) => \{\s*if \(held\) return;/);
  });
  test("a paste of files uploads nothing while held (a text paste does nothing in a read-only field)", () => {
    const paste = composer.slice(composer.indexOf("const onPasteCapture = "), composer.indexOf("// Add files or photos"));
    expect(paste).toMatch(/^const onPasteCapture = \(e: ClipboardEvent<HTMLDivElement>\) => \{\s*if \(held\) return;/);
  });
  test("a file picked while held uploads nothing: a picker opened before the hold began hands its files to no one", () => {
    // Every way in (paste, the file picker's change, a drop that reached the box) goes through attach, which takes
    // nothing while held; the picker's input is still cleared and its + menu entry left.
    const attach = composer.slice(composer.indexOf("const attach = "), composer.indexOf("const removeChip = "));
    expect(attach).toMatch(/^const attach = \(files: FileFacts\[\]\) => \{\s*if \(held \|\| !files\.length\) return;/);
    const pick = composer.slice(composer.indexOf("const onPickFiles = "), composer.indexOf("// A mode change that rewrote the field"));
    expect(pick).toContain('e.currentTarget.value = "";');
    expect(pick).toContain("attach(files);");
    expect(pick).toContain("leaveAdd();");
  });
  test("a file dropped on a held chat uploads nothing: the chat screen's drop zone is off while held", () => {
    // The zone takes a drop in the capture phase, before the composer sees it; off, the window's guard refuses it.
    const screen = code("chat", "ChatScreen.tsx");
    expect(screen).toMatch(/const drop = useFileDrop\([\s\S]*?\}, !!chatId && !chat\?\.held\);/);
  });
  test("Cmd or Ctrl+Shift+M, I and E open no picker while held; Esc still stops kitespan's own turn", () => {
    const onKey = composer.slice(composer.indexOf("const onKey = (e: globalThis.KeyboardEvent) => {"), composer.indexOf('window.addEventListener("keydown", onKey);'));
    expect(onKey).toMatch(/if \(name\) \{\s*e\.preventDefault\(\);\s*if \(!k\.held\) k\.openPopup\(name\);\s*\}/);
    expect(onKey).toContain('e.key === "Escape" && k.canStop && !k.menuVisible && !k.popupOpen');
  });
  test("the pickers and the + menu open only while the box can be used", () => {
    expect(composer).toContain('const addOpen = !held && route.name === "add";');
    expect(composer).toContain('const modelOpen = !held && (route.name === "model" || route.name === "effort");');
    expect(composer).toContain('const modeOpen = !held && route.name === "mode";');
    expect(composer).toContain("open={addOpen && !picking}");
    expect(composer).toContain("open={modelOpen}");
    expect(composer).toContain("open={modeOpen}");
  });
  test("on touch, a hold that comes while the user types takes the keyboard down", () => {
    expect(composer).toMatch(/if \(held && coarse && document\.activeElement === field\.current\) field\.current\?\.blur\(\);/);
  });
});

describe("the off look (composer.css)", () => {
  const css = code("styles", "composer.css");
  test("the held field reads in --dim with no focus halo; the pickers' pills and a chip's Remove draw as off", () => {
    expect(css).toMatch(/\.cmp\.is-held \.cmp-input \{[^}]*color: var\(--dim\);[^}]*cursor: default;/);
    expect(css).toMatch(/\.cmp\.is-held\[data-mode="chat"\] \.cmp-slab:has\(\.cmp-input:focus\) \{[^}]*box-shadow: var\(--composer-shadow\);/);
    expect(css).toMatch(/\.cmp\.is-held \.cmp-slab:has\(\.cmp-input:focus:not\(:focus-visible\)\) \{[^}]*box-shadow: var\(--composer-shadow\);/);
    expect(css).toMatch(/\.cmp\.is-held\[data-mode="chat"\] \.cmp-slab:has\(\.cmp-input:focus:not\(:focus-visible\)\) \{[^}]*border-color: var\(--composer-border\);/);
    expect(css).toMatch(/\.cmp-pick:disabled \{[^}]*opacity: 0\.4;[^}]*cursor: default;/);
    expect(css).toMatch(/\.cmp-pick:disabled:hover \{[^}]*background-image: none;/);
    expect(css).toMatch(/\.attach-remove:disabled \{[^}]*opacity: 0\.4;[^}]*cursor: default;/);
    // The held rules come after the mode morph's focus rules, which they override.
    expect(css.indexOf(".cmp.is-held .cmp-slab:has(.cmp-input:focus")).toBeGreaterThan(css.indexOf('.cmp[data-mode="bash"] .cmp-slab:has(.cmp-input:focus)'));
  });
  test("keyboard focus on a held field still shows: no held rule takes the rim away from a :focus-visible field", () => {
    // The field stays a Tab stop (it is read-only, so it can be read and copied); the field's own outline is off, so
    // the slab's rim is the only mark. A held rule may quiet a pointer's focus (:not(:focus-visible)), never the
    // keyboard's. (Chrome counts a click in a text field as :focus-visible too, so there the quiet rim shows on a
    // click as well.)
    expect(css).toMatch(/\.cmp-input:focus-visible \{[^}]*outline: none;/);
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
    const rim = rules.filter((r) => /\.cmp\.is-held/.test(r.sel) && /:focus/.test(r.sel) && /border-color/.test(r.body));
    expect(rim.length).toBeGreaterThan(0);
    for (const r of rim) expect([r.sel, r.sel.includes(":focus:not(:focus-visible)")]).toEqual([r.sel, true]);
    // In the / and ! modes the rim is the mode's colour, focused or not, so their halo is the keyboard's mark: a held
    // rule that takes a halo away from any mode is scoped to a pointer's focus.
    const halo = rules.filter((r) => /\.cmp\.is-held/.test(r.sel) && /:focus/.test(r.sel) && /box-shadow/.test(r.body) && !r.sel.includes('[data-mode="chat"]'));
    for (const r of halo) expect([r.sel, r.sel.includes(":focus:not(:focus-visible)")]).toEqual([r.sel, true]);
  });
});
