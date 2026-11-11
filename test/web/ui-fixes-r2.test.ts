// The UI review's second round of fixes: a waiting card's field rides the on-screen keyboard as the composer does
// (7.8); the Terminal pane's hidden field is 16 px on touch, so iOS does not zoom (7.5, 7.9); the pane bar's Files pane
// has no title of its own and Details lists no Uploads row beside it (D51, M34, 7.3); the session menu does not repeat
// the pane bar's Details (6.2, principle 0); Stop and archive never starts with the focus (6.10); a running call's time
// shows once (M23, M25); the + menu draws the connectors' problem count as the Details card does (M18); the + menu's
// Plugins fold has a fold chevron (6.7); the session preview does not repeat its first prompt as its title.
// Rendered with React's server renderer where a part renders without a portal; the rest are pins on the source.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorInfo } from "../../shared/protocol";
import { parse } from "../../web/router";
import { resetState } from "../../web/state/store";
import type { Chat, Item, Project, ToolItem, Upload } from "../../web/state/types";
import { SummaryRow } from "../../web/chat/items/Tool";
import { TranscriptProvider, type Transcript } from "../../web/chat/items/context";
import { Cards } from "../../web/panels/cards";
import { ConnectorProblems } from "../../web/panels/problems";
import { SidePanel } from "../../web/panels/SidePanel";
import { titleRepeatsPrompt } from "../../web/screens/ProjectScreen";
import { scripted } from "./fixtures";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
/** The source without its comments, so a pin reads the code only. */
const code = (...p: string[]) => src(...p).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const url = (path: string) => parse(new URL(path, "http://127.0.0.1"));
const count = (s: string, part: string) => s.split(part).length - 1;

const P: Project = { id: "kitespanxx", name: "kitespan", folder: "/work/kitespan", branch: "", picks: {} };
function chatWith(p: Partial<Chat> = {}): Chat {
  return {
    ...scripted({
      id: "demoolxxxxxxxxxxxxxx",
      projectId: P.id,
      title: "Fix the flaky upload test",
      titleSource: "first-prompt",
      state: "idle",
      updatedAt: "2026-10-31T08:00:00.000Z",
      sessionId: "",
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
const conn = (name: string, status: ConnectorInfo["status"]): ConnectorInfo => ({ name, status, error: null, tools: status === "connected" ? 3 : 0, scope: "user", hasView: false });
const upload = (id: string, name: string): Upload => ({ id, chatId: "demoolxxxxxxxxxxxxxx", name, size: 12, type: "text/plain", path: `/tmp/kitespan-uploads-dev/u-${id}/${name}`, folder: "temp", dir: `/tmp/kitespan-uploads-dev/u-${id}`, at: "", state: "done", progress: 1 });

beforeEach(() => resetState());

describe("a waiting card's field rides the on-screen keyboard (7.8, 7.2: the card takes the composer's place)", () => {
  test("the card dock reads the keyboard and the focus in it, and moves with styles only", () => {
    const view = code("chat", "ChatView.tsx");
    expect(view).toContain('import { useFocusInside, useSoftKeyboard } from "../composer/keyboard";');
    expect(view).toContain("const kb = useSoftKeyboard(vp.touch);");
    expect(view).toContain("const cardFocus = useFocusInside(dock, vp.touch && !!card);");
    // The same element tree with the keyboard up or down: one dock, its class and style change.
    expect(view).toMatch(/<div className=\{`chat-dock\$\{cardRide \? " is-riding" : ""\}`\} ref=\{dock\} style=\{cardRideStyle\}>/);
    expect(view).toContain("transform: `translateY(calc(${kb.offsetTop + kb.visualHeight}px - 100%))`");
    expect(view).toContain("maxHeight: kb.visualHeight");
    const css = src("styles", "chat.css");
    expect(css).toMatch(/\.chat-dock\.is-riding \{\s*position: fixed;\s*z-index: 35;\s*top: 0;/);
    // The card shrinks to what shows: its body scrolls, its buttons stay in view.
    expect(css).toMatch(/\.chat-dock\.is-riding \.chat-card \{\s*min-height: 0;\s*max-height: none;/);
  });
});

describe("the Terminal pane's hidden field is 16 px on touch, so iOS does not zoom the page (7.5, 7.9)", () => {
  test("xterm's helper textarea takes --fs-input on touch, as every other touch field does", () => {
    const css = src("styles", "terminal.css");
    expect(css).toMatch(/\.touch \.term-host \.xterm \.xterm-helper-textarea \{\s*font-size: var\(--fs-input\);\s*\}/);
    // --fs-input is at least 16 px in every look (tokens.css), at every text size.
    const tokens = src("styles", "tokens.css");
    const values = [...tokens.matchAll(/--fs-input: ([^;]+);/g)].map((m) => m[1]!);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^calc\((1[6-9])px \* max\(1, var\(--text-scale\)\)\)$/);
  });
});

describe("the pane bar's Files pane (7.3, D51, M34): no title of its own, no second way to the same list", () => {
  const chat = chatWith({ connectorInfo: [conn("github", "connected")] });
  const files = [upload("abc123", "notes.txt")];
  const panel = (path: string, mode: "column" | "pane" | "sheet") => {
    resetState({ projects: [P], chats: [chat], uploads: { [chat.id]: files }, ready: true });
    return renderToStaticMarkup(createElement(SidePanel, { chat, route: url(path), mode }));
  };

  test("in the pane, Uploads and a file have only the close button: no Back to Details beside the lit Files button", () => {
    const up = panel(`/c/${chat.id}/uploads`, "pane");
    expect(up).not.toContain("side-back");
    expect(up).toContain('aria-label="Close Uploads"');
    const file = panel(`/c/${chat.id}/files/src/upload.ts`, "pane");
    expect(file).not.toContain("side-back");
    expect(file).toContain('aria-label="Close Files"');
    // A detail of Details keeps its Back row: the Details button stays lit.
    expect(panel(`/c/${chat.id}/connectors`, "pane")).toContain("side-back");
  });

  test("the laptop's column keeps '< Uploads': there Uploads is a detail of Details", () => {
    expect(panel(`/c/${chat.id}/uploads`, "column")).toMatch(/<a href="\/c\/demoolxxxxxxxxxxxxxx\/details" class="side-back"[^>]*aria-label="Back to Details from Uploads"/);
  });

  test("Details lists no Uploads row where the pane bar's Files button opens the list; the column and the sheet keep it", () => {
    resetState({ projects: [P], chats: [chat], uploads: { [chat.id]: files }, ready: true });
    const route = url(`/c/${chat.id}/details`);
    expect(renderToStaticMarkup(createElement(Cards, { chat, route, paneBar: true }))).not.toContain("side-uploads");
    expect(renderToStaticMarkup(createElement(Cards, { chat, route }))).toContain("side-uploads");
    expect(panel(`/c/${chat.id}/details`, "pane")).not.toContain("side-uploads");
    expect(panel(`/c/${chat.id}/details`, "column")).toContain("side-uploads");
  });
});

describe("the session menu does not repeat the pane bar's Details (6.2, principle 0)", () => {
  test("Details shows only where neither a side column nor a pane bar opens it (the phone)", () => {
    const menu = code("dialogs", "SessionMenu.tsx");
    expect(menu).toContain("const layout = useShellLayout();");
    expect(menu).toMatch(/\{rail \|\| layout\.paneBar \? null : \(\s*<Link to=\{chatHref\("details", chat\.id, route\)\} className=\{k\.row\} onNavigate=\{onClose\}>\s*Details/);
    // v0.3 search (7.2): the phone's Search item sits beside Details under the same rule.
    expect(menu).toMatch(/\{rail \|\| layout\.paneBar \? null : \(\s*<Link to=\{chatHref\("chatSearch", chat\.id, route\)\} className=\{k\.row\} onNavigate=\{onClose\}>\s*Search/);
  });
});

describe("Stop and archive never starts with the focus (6.10)", () => {
  test("a busy chat's archive dialog focuses the dialog itself, so an Enter cannot stop a running turn", () => {
    const dlg = code("dialogs", "ChatDialogs.tsx");
    // The button is autofocused only when it does not stop a turn.
    expect(dlg).toContain("data-autofocus={stops ? undefined : true}");
    expect(dlg).toContain('const stops = item.testId === "confirm-stop-and-archive";');
    expect(dlg).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!stops\) return;/);
    expect(dlg).toContain('closest<HTMLElement>(\'[role="dialog"]\')');
  });
});

describe("a running call's time shows once (M23, M25)", () => {
  const running: ToolItem = { kind: "tool", id: "toolu_run", name: "Bash", summary: "bun test test/upload --coverage", input: "bun test test/upload --coverage", status: "running", elapsedSeconds: 4 };
  const read: ToolItem = { kind: "tool", id: "toolu_read", name: "Read", summary: "src/upload.ts", output: "a\nb\nc", status: "ok" };
  const items: Item[] = [read, running];
  const row = (open: boolean) => {
    resetState({ chats: [], projects: [], ready: true });
    const ctx: Transcript = { chatId: "demoolxxxxxxxxxxxxxx", view: "normal", readOnly: false, isOpen: (id, byDefault) => (id === "sum" ? open : byDefault), toggle: () => {} };
    return renderToStaticMarkup(createElement(TranscriptProvider, { value: ctx }, createElement(SummaryRow, { id: "sum", items })));
  };

  test("folded, the summary row carries the time and the spinner", () => {
    const html = row(false);
    expect(count(html, "chat-elapsed")).toBe(1);
    expect(count(html, 'class="chat-spin"')).toBe(1);
  });

  test("open, the running call's own row carries them, and the summary row does not", () => {
    const html = row(true);
    expect(count(html, "chat-elapsed")).toBe(1);
    expect(count(html, 'class="chat-spin"')).toBe(1);
    const head = html.slice(0, html.indexOf('class="chat-row-body chat-summary-body"'));
    expect(head).not.toContain("chat-elapsed");
    expect(head).not.toContain("chat-spin");
  });
});

describe("the connectors' problem count looks the same in the + menu and on the Details card (M18)", () => {
  const draw = (list: Pick<ConnectorInfo, "status">[]) => renderToStaticMarkup(createElement(ConnectorProblems, { list }));

  test("one renderer: nothing while every connector works; failed in --danger, sign-in in --warn", () => {
    expect(draw([])).toBe("");
    expect(draw([{ status: "connected" }, { status: "pending" }, { status: "disabled" }])).toBe("");
    expect(draw([{ status: "connected" }, { status: "failed" }])).toBe('<span class="side-bad">1 failed</span>');
    expect(draw([{ status: "failed" }, { status: "needs-auth" }])).toBe('<span class="side-bad">1 failed</span>, <span class="side-warn">1 needs sign-in</span>');
    expect(text(draw([{ status: "needs-auth" }, { status: "needs-auth" }]))).toBe("2 need sign-in");
  });

  test("the + menu and the card both use it, with the same list (the chat's connectors as the card reads them)", () => {
    expect(code("composer", "PlusMenu.tsx")).toContain("value={problems.failed || problems.signIn ? <ConnectorProblems list={props.connectors} /> : undefined}");
    expect(code("composer", "PlusMenu.tsx")).not.toContain("connectorsValue");
    expect(code("composer", "Composer.tsx")).toContain("connectors={connectorsOf(chat) ?? NO_CONNECTORS}");
    expect(code("panels", "cards.tsx")).toContain("<ConnectorProblems list={list} />");
    // On a laptop's menu row the hover fill is the accent: the coloured words take the row's text colour there.
    expect(src("styles", "composer.css")).toMatch(/\.menu-row:hover \.row-hint \.side-bad,[\s\S]*?\{\s*color: inherit;\s*\}/);
  });
});

describe("the + menu's Plugins opens in place, so it has a fold chevron (6.7: a down chevron folds, a right one opens a view)", () => {
  test("Plugins draws the down chevron, turned up while open; Uploads and Connectors keep the right chevron", () => {
    const menu = code("composer", "PlusMenu.tsx");
    expect(menu).toMatch(/label="Plugins"[\s\S]*?fold[\s\S]*?expanded=\{plugins\}/);
    expect(menu).toContain('{fold ? <IconChevron className="group-chevron cmp-fold-chevron" /> : more ? <IconRight className="group-chevron" /> : null}');
    expect(menu).toMatch(/label="Uploads" more /);
    expect(menu).toMatch(/label="Connectors"[^\n]*more /);
    const css = src("styles", "composer.css");
    expect(css).toMatch(/\.cmp-plus-row\.is-expanded \.cmp-fold-chevron \{\s*transform: rotate\(180deg\);/);
    expect(css).not.toContain(".cmp-plus-row.is-expanded .group-chevron {\n  transform: rotate(90deg);");
  });
});

describe("the session preview does not repeat its first prompt as its title (principle 0)", () => {
  const user = (id: string, t: string): Item => ({ kind: "user", id, text: t });
  const prompt = "Bump the Agent SDK to the next patch and rerun the options gate.";

  test("a title that is the first prompt, or its first 120 characters, repeats it", () => {
    expect(titleRepeatsPrompt(prompt, [user("u1", prompt)])).toBe(true);
    expect(titleRepeatsPrompt(prompt, [user("u1", `  ${prompt.replace(/ /g, "\n ")}  `)])).toBe(true);
    const long = "Read the upload module and its tests. ".repeat(6).trim();
    expect(titleRepeatsPrompt(long.slice(0, 120).trim(), [user("u1", long)])).toBe(true);
  });

  test("a title of its own, a page that starts later, or no title at all does not", () => {
    expect(titleRepeatsPrompt("SDK bump", [user("u1", prompt)])).toBe(false);
    expect(titleRepeatsPrompt(prompt, [user("u9", "Now run the gate again.")])).toBe(false);
    expect(titleRepeatsPrompt(prompt, [])).toBe(false);
    expect(titleRepeatsPrompt("", [user("u1", prompt)])).toBe(true);
  });

  test("the heading stays for screen readers and leaves the screen when it repeats", () => {
    const screen = code("screens", "ProjectScreen.tsx");
    expect(screen).toContain('<h1 className={repeats ? "visually-hidden" : "scr-h1"} dir="auto">');
    expect(screen).toContain('const repeats = preview.state === "ready" && titleRepeatsPrompt(title, preview.items);');
  });
});
