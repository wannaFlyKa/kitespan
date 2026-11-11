// The Terminal pane's link and its rules (D38): /c/<chat>/shell and its one query value, the fallbacks, the command
// the copy dialog copies (the fork command while the chat's Claude Code is still open, the plain one while it sleeps,
// none before the first message; the same words as the command the server types, server/shell/command.ts), where
// the pane shows per size, Ctrl+backtick, and the view's rules. That opening the pane and typing the command record
// nothing, and only the user's Enter records one "shell" action, is in terminal.test.ts (the session) and
// terminal-live.test.ts (on a real shell).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANE_ROUTES, ROUTES } from "../../web/routes";
import { closeSteps, href, parse } from "../../web/router";
import { CHATS, PROJECTS, useScriptedCatalog } from "./fixtures";
import type { Chat } from "../../web/state/types";
import { FORK_LINE, NO_SESSION_LINE, processLives, resumeCommand, shellArg } from "../../web/terminal/command";
import { openInTerminalHref, pageLinkLine, paneFolderName, terminalToggleTarget } from "../../web/terminal/route";
import { resumeCommand as serverResumeCommand, shellWord } from "../../server/shell/command";
import { isTerminalToggle } from "../../web/terminal/keys";
import { CHAT_MIN, PANEL_W, SIDEBAR_W, TERM_MIN, shellLayout, terminalLayout } from "../../web/layout/size";

useScriptedCatalog();

const at = (u: string) => parse(new URL(u, "http://127.0.0.1:7941"));
const SRC = join(import.meta.dir, "..", "..", "web");

describe("the route", () => {
  test("/c/<chat>/shell is a v0.1 core view with an example that types the resume command", () => {
    const def = ROUTES.find((r) => r.name === "shell")!;
    expect(def).toMatchObject({ path: "/c/:chat/shell", kind: "view", milestone: "v0.1 core" });
    // R127: `tool` names the refused row whose folder type=trust types `cd <folder> && claude` for; R131: `bg` names
    // the background session whose `claude attach <id>` type=attach types.
    // U4: `above` names the view over the Terminal in the split side panel (route-pair.test.ts); `below` is refused.
    expect(Object.keys(def.query).sort()).toEqual(["above", "below", "bg", "tool", "type", "view"]);
    const r = at(def.example);
    expect(r).toMatchObject({ name: "shell", params: { chat: "k3m7q2x4abk3m7q2x4ab" }, query: { type: "resume" } });
    expect(r.fallbackFrom).toBeUndefined();
  });
  test("type has one value; any other value is dropped and the route says part of the link was not read", () => {
    expect(at("/c/demoolxxxxxxxxxxxxxx/shell").query).toEqual({});
    for (const bad of ["other", "Resume", "resume%20", "cd%20~%20%26%26%20rm", ""]) {
      const r = at(`/c/demoolxxxxxxxxxxxxxx/shell?type=${bad}`);
      expect(r.name).toBe("shell");
      expect(r.query).toEqual({});
      expect(r.dropped).toBe(true);
    }
    expect(at("/c/demoolxxxxxxxxxxxxxx/shell?type=resume&view=verbose").query).toEqual({ type: "resume", view: "verbose" });
  });
  test("only a multi key repeats: type given two different values is dropped, the same value twice is read once", () => {
    for (const q of ["type=resume&type=x", "type=x&type=resume", "type=resume&type="]) {
      const r = at(`/c/demoolxxxxxxxxxxxxxx/shell?${q}`);
      expect([q, r.query, r.dropped]).toEqual([q, {}, true]);
    }
    expect(at("/c/demoolxxxxxxxxxxxxxx/shell?type=resume&type=resume").query).toEqual({ type: "resume" });
    // The rest of the link is still read.
    expect(at("/c/demoolxxxxxxxxxxxxxx/shell?type=resume&type=x&view=verbose").query).toEqual({ view: "verbose" });
  });
  test("no other key reaches the pane: a command in the link is not even read", () => {
    const r = at("/c/demoolxxxxxxxxxxxxxx/shell?type=resume&cmd=rm%20-rf%20~&text=x&line=1");
    expect(r.query).toEqual({ type: "resume" });
  });
  test("a bad chat id falls back to Home; an unknown chat id opens the chat screen, which shows Home with its line", () => {
    const bad = at("/c/BAD!/shell?type=resume");
    expect(bad.name).toBe("home");
    expect(bad.fallbackFrom).toBe("/c/BAD!/shell?type=resume");
    const unknown = at("/c/nopexxxxxxxxxxxxxxxx/shell?type=resume");
    expect(unknown).toMatchObject({ name: "shell", params: { chat: "nopexxxxxxxxxxxxxxxx" } });
    expect(CHATS.some((c) => c.id === "nopexxxxxxxxxxxxxxxx")).toBe(false);
    // App.tsx gives the shell route to the chat screen, whose missing chat shows Home with DESIGN.md 5.4's line.
    expect(readFileSync(join(SRC, "App.tsx"), "utf8")).toMatch(/CHAT_ROUTES = new Set\(\[[\s\S]*"shell"[\s\S]*\]\)/);
    expect(readFileSync(join(SRC, "chat", "ChatScreen.tsx"), "utf8")).toContain('if (!chat) return <Home route={route} notice="That chat is not here. It may have been deleted." />');
  });
  test("Open in terminal links to the pane with the resume command typed", () => {
    expect(openInTerminalHref("demoolxxxxxxxxxxxxxx")).toBe("/c/demoolxxxxxxxxxxxxxx/shell?type=resume");
    expect(openInTerminalHref("demoolxxxxxxxxxxxxxx", "verbose")).toBe("/c/demoolxxxxxxxxxxxxxx/shell?type=resume&view=verbose");
    expect(at(href("shell", { chat: "oldo5xxxxxxxxxxxxxxx" }, { type: "resume" })).query.type).toBe("resume");
  });
  test("the Terminal pane is one of the side panes: closing it steps back over the panes the pane bar opened", () => {
    expect(PANE_ROUTES.has("shell")).toBe(true);
    const back = ["/c/demoolxxxxxxxxxxxxxx/details", "/c/demoolxxxxxxxxxxxxxx"];
    // Entries this document pushed (doc, inDoc): the close goes back over them.
    expect(closeSteps({ from: back[0], back, doc: "doc1", inDoc: 2 }, "/c/demoolxxxxxxxxxxxxxx/shell", "/c/demoolxxxxxxxxxxxxxx", null, "doc1")).toBe(2);
    expect(closeSteps({ from: "/c/demoolxxxxxxxxxxxxxx", back: ["/c/demoolxxxxxxxxxxxxxx"], doc: "doc1", inDoc: 1 }, "/c/demoolxxxxxxxxxxxxxx/shell?type=resume", "/c/demoolxxxxxxxxxxxxxx", null, "doc1")).toBe(1);
  });
});

const live = (state: Chat["state"], items = 1): Pick<Chat, "state" | "sessionId" | "items"> => ({
  state,
  sessionId: "4f6d2a90-1c3e-4b8f-9a51-7e2d0c6b8a13",
  items: Array.from({ length: items }, (_, i) => ({ kind: "user", id: `m${i}`, text: "hi" }) as Chat["items"][number]),
});

describe("the command a link types", () => {
  const plain = "cd ~/src/kitespan && claude --resume 4f6d2a90-1c3e-4b8f-9a51-7e2d0c6b8a13";
  test("while the chat's Claude Code process lives (running, waiting, idle, starting, failed): the fork command, with the fork line", () => {
    for (const state of ["running", "waiting", "idle", "starting", "failed"] as const)
      expect(resumeCommand(live(state), "~/src/kitespan")).toEqual({ case: "fork", command: `${plain} --fork-session`, note: FORK_LINE });
    // Words true in each of those states: the title bar says Idle, Starting or Failed for some of them.
    expect(FORK_LINE).toBe("This chat's Claude Code is still open, so this is a fork command: it opens a copy and leaves this chat as it is.");
    expect(FORK_LINE).not.toContain("running");
  });
  test("a failed chat whose process died gets the plain command; the process flag changes no other state", () => {
    expect(resumeCommand({ ...live("failed"), processAlive: false }, "~/src/kitespan")).toEqual({ case: "plain", command: plain, note: null });
    expect(resumeCommand({ ...live("failed"), processAlive: true }, "~/src/kitespan").case).toBe("fork");
    // Starting, idle and the rest have a process (or one on its way): never the plain command.
    for (const state of ["running", "waiting", "idle", "starting"] as const) expect(processLives({ ...live(state), processAlive: false })).toBe(true);
    expect(processLives({ ...live("sleeping"), processAlive: true })).toBe(false);
  });
  test("while it sleeps: the plain resume command, no line", () => {
    expect(resumeCommand(live("sleeping"), "~/src/kitespan")).toEqual({ case: "plain", command: plain, note: null });
  });
  test("with no message yet: no command, and the dialog's line", () => {
    expect(resumeCommand(live("idle", 0), "~/src/kitespan")).toEqual({ case: "none", command: null, note: NO_SESSION_LINE });
    expect(NO_SESSION_LINE).toBe("This chat gets a session id with its first message.");
    expect(resumeCommand({ ...live("sleeping"), sessionId: "x; rm -rf ~" }, "~/src/kitespan").command).toBeNull();
  });
  test("a folder with spaces or quotes is quoted, the ~/ kept outside the quotes", () => {
    expect(shellArg("~/src/kitespan")).toBe("~/src/kitespan");
    expect(shellArg("~/My Work/it's")).toBe(`~/'My Work/it'\\''s'`);
    expect(shellArg("/srv/a b")).toBe("'/srv/a b'");
    expect(resumeCommand(live("sleeping"), "~/My Work").command).toStartWith("cd ~/'My Work' && claude --resume ");
  });
  test("an absolute folder is quoted as the server quotes it, so the dialog copies what the pane types", () => {
    for (const folder of ["/srv/kitespan", "/srv/a b", "/srv/it's", "/srv/a~b", "/srv/$(touch x)", "/srv/a;b"]) {
      expect([folder, shellArg(folder)]).toEqual([folder, shellWord(folder)]);
      for (const processOpen of [false, true]) {
        const page = resumeCommand({ ...live(processOpen ? "idle" : "sleeping"), serverState: processOpen ? "idle" : "sleeping" }, folder);
        const server = serverResumeCommand({ cwd: folder, sessionId: live("idle").sessionId, processOpen });
        expect([folder, processOpen, page.case, page.command]).toEqual([folder, processOpen, server.case, server.command]);
      }
    }
  });
  test("the server's state decides when it is known: an ending chat still has its process (the list says sleeping)", () => {
    expect(resumeCommand({ ...live("sleeping"), serverState: "ending" }, "/srv/x").case).toBe("fork");
    expect(resumeCommand({ ...live("idle"), serverState: "sleeping" }, "/srv/x").case).toBe("plain");
    for (const st of ["starting", "idle", "running", "waiting", "ending"] as const) expect(processLives({ ...live("sleeping"), serverState: st })).toBe(true);
  });
  test("a chat whose history is not drawn yet still has its command; a drawn chat with no message has none", () => {
    expect(resumeCommand({ ...live("sleeping", 0), loaded: false }, "/srv/x").case).toBe("plain");
    expect(resumeCommand({ ...live("sleeping", 0), loaded: true }, "/srv/x").case).toBe("none");
  });
  test("the scripted chats: demoolxxxxxxxxxxxxxx waits (fork), oldo5xxxxxxxxxxxxxxx sleeps (plain), the idle, starting and failed ones fork", () => {
    const folder = (c: Chat) => PROJECTS.find((p) => p.id === c.projectId)!.folder;
    const chat = (id: string) => CHATS.find((c) => c.id === id)!;
    const old = chat("oldo5xxxxxxxxxxxxxxx");
    expect(resumeCommand(chat("demoolxxxxxxxxxxxxxx"), folder(chat("demoolxxxxxxxxxxxxxx"))).case).toBe("fork");
    expect(resumeCommand(old, folder(old))).toMatchObject({ case: "plain", command: `cd ~/scratch/demo && claude --resume ${old.sessionId}` });
    // failloxxxxxxxxxxxxxx's turn ended in an API error: its process lives on, so it forks.
    for (const id of ["idleo6xxxxxxxxxxxxxx", "startogxxxxxxxxxxxxx", "failloxxxxxxxxxxxxxx"]) expect([id, resumeCommand(chat(id), folder(chat(id))).case]).toEqual([id, "fork"]);
  });
});

describe("where the pane shows", () => {
  const laptop = (width: number) => terminalLayout({ size: "laptop", width });
  test("a wide laptop: the side column, 40% of the window from 420 to 720 px, keeping the chat column at 520 px", () => {
    expect(laptop(1280)).toEqual({ form: "column", width: 512 });
    expect(1280 - SIDEBAR_W - 512).toBe(CHAT_MIN);
    expect(laptop(1200)).toEqual({ form: "column", width: 1200 - SIDEBAR_W - CHAT_MIN });
    expect(laptop(1188)).toEqual({ form: "column", width: TERM_MIN });
    expect(laptop(1920)).toEqual({ form: "column", width: 720 });
    expect(laptop(2560)).toEqual({ form: "column", width: 720 });
  });
  test("a narrower laptop: still the side column wherever the side panel docks, down to the cards' 320 px", () => {
    expect(laptop(1100)).toEqual({ form: "column", width: 1100 - SIDEBAR_W - CHAT_MIN });
    expect(laptop(1180)).toEqual({ form: "column", width: 412 });
    expect(laptop(1088)).toEqual({ form: "column", width: PANEL_W });
  });
  test("where the side panel opens over the chat (1,000 to 1,087 px), the terminal does too", () => {
    expect(laptop(1087)).toEqual({ form: "over", width: 435 });
    expect(laptop(1050)).toEqual({ form: "over", width: 420 });
    expect(laptop(1000).form).toBe("over");
  });
  test("under 1,000 px the sidebar is a drawer, so the column fits again", () => {
    expect(laptop(999)).toEqual({ form: "column", width: 420 });
    expect(laptop(940)).toEqual({ form: "column", width: 420 });
    expect(laptop(939)).toEqual({ form: "column", width: 419 });
    expect(laptop(860)).toEqual({ form: "column", width: 340 });
  });
  test("on every laptop width the terminal is a column exactly where the side panel is one", () => {
    for (let width = 841; width <= 2600; width++) {
      const panel = shellLayout({ size: "laptop", width }).side;
      expect([width, terminalLayout({ size: "laptop", width }).form]).toEqual([width, panel === "column" ? "column" : "over"]);
    }
  });
  test("medium touch: the docked pane; the phone: a page", () => {
    expect(terminalLayout({ size: "medium", width: 834 })).toEqual({ form: "pane", width: 320 });
    expect(terminalLayout({ size: "phone", width: 390 })).toEqual({ form: "page", width: 390 });
  });
});

describe("Ctrl+backtick toggles the pane (DESIGN.md 6.11)", () => {
  const key = (k: Partial<KeyboardEvent>) => isTerminalToggle({ key: "`", code: "Backquote", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...k });
  test("Ctrl and the backtick key, with no other modifier", () => {
    expect(key({})).toBe(true);
    expect(key({ code: "IntlBackslash" })).toBe(true); // a layout that types the backtick elsewhere
    expect(key({ key: "^" })).toBe(true); // the key under Esc on a layout where it types another character
    for (const k of [{ ctrlKey: false }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { key: "a", code: "KeyA" }]) expect(key(k)).toBe(false);
  });
  test("from the chat or a side panel view it opens the pane with nothing typed; from the pane it closes to the chat", () => {
    expect(terminalToggleTarget(at("/c/demoolxxxxxxxxxxxxxx"), "demoolxxxxxxxxxxxxxx")).toEqual({ to: "/c/demoolxxxxxxxxxxxxxx/shell", close: false });
    expect(terminalToggleTarget(at("/c/demoolxxxxxxxxxxxxxx?view=verbose"), "demoolxxxxxxxxxxxxxx")).toEqual({ to: "/c/demoolxxxxxxxxxxxxxx/shell?view=verbose", close: false });
    expect(terminalToggleTarget(at("/c/demoolxxxxxxxxxxxxxx/details"), "demoolxxxxxxxxxxxxxx")).toEqual({ to: "/c/demoolxxxxxxxxxxxxxx/shell", close: false });
    expect(terminalToggleTarget(at("/c/demoolxxxxxxxxxxxxxx/uploads"), "demoolxxxxxxxxxxxxxx")).toEqual({ to: "/c/demoolxxxxxxxxxxxxxx/shell", close: false });
    expect(terminalToggleTarget(at("/c/demoolxxxxxxxxxxxxxx/shell?type=resume&view=verbose"), "demoolxxxxxxxxxxxxxx")).toEqual({ to: "/c/demoolxxxxxxxxxxxxxx?view=verbose", close: true });
    expect(terminalToggleTarget(at("/c/demoolxxxxxxxxxxxxxx/shell"), "demoolxxxxxxxxxxxxxx")).toEqual({ to: "/c/demoolxxxxxxxxxxxxxx", close: true });
  });
  test("nowhere from a dialog, an action route that waits for its click, or another chat's route", () => {
    for (const u of ["/c/demoolxxxxxxxxxxxxxx/terminal", "/c/demoolxxxxxxxxxxxxxx/rename", "/c/demoolxxxxxxxxxxxxxx/send?text=hi", "/c/demoolxxxxxxxxxxxxxx/bash?cmd=ls"]) expect([u, terminalToggleTarget(at(u), "demoolxxxxxxxxxxxxxx")]).toEqual([u, null]);
    expect(terminalToggleTarget(at("/c/oldo5xxxxxxxxxxxxxxx"), "demoolxxxxxxxxxxxxxx")).toBeNull();
    expect(terminalToggleTarget(at("/c/demoolxxxxxxxxxxxxxx/nope"), "demoolxxxxxxxxxxxxxx")).toBeNull(); // a fallback: the link was not the chat
  });
  test("Shell.tsx binds it on the window inside the key press, and the terminal passes the key on", () => {
    const shell = readFileSync(join(SRC, "layout", "Shell.tsx"), "utf8");
    expect(shell).toMatch(/window\.addEventListener\("keydown", onKey\)/);
    expect(shell).toContain("isTerminalToggle(e)");
    expect(shell).toContain("useTerminalToggle(route, panel && chat ? chat.id : null)");
    const xterm = readFileSync(join(SRC, "terminal", "xterm.ts"), "utf8");
    expect(xterm).toMatch(/attachCustomKeyEventHandler\(\(e\) => \{\s*\/\/[^\n]*\n\s*if \(isTerminalToggle\(e\)\) return false;/);
  });
});

describe("the view (xterm.ts and TerminalPane.tsx)", () => {
  const xterm = readFileSync(join(SRC, "terminal", "xterm.ts"), "utf8");
  test("every paste is caught before xterm's own listeners and cleaned, then pasted as one paste", () => {
    expect(xterm).toMatch(/el\.addEventListener\(\s*"paste",[\s\S]*?term\.paste\(cleanPaste\(text\)\)[\s\S]*?true,\s*\)/);
    expect(xterm).toContain("e.stopPropagation()");
  });
  test("the cursor shows before the first focus (a touch device opens the pane without it)", () => {
    expect(xterm).toMatch(/v\.term\.open\(el\);[\s\S]{0,400}v\.term\.write\("\\x1b\[\?47l"\)/);
  });
  test("the terminal's ground is --bg, and xterm lifts a program's own colours to AA", () => {
    expect(xterm).toContain('const bg = t("--bg");');
    expect(xterm).not.toContain("--code-bg");
    expect(xterm).toContain("minimumContrastRatio: 4.5");
  });
  test("the key bar shows on every touch device, not only on the phone's page", () => {
    // The bar's Select, Copy and Paste act in the view once it is attached (xterm.ts); its own line shows above the terminal.
    expect(readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8")).toContain("{vp.touch ? <KeyBar session={session} xterm={attached ? mod : null} onLine={setKeyLine} /> : null}");
  });
  test("the real shell prints its own prompt: no scripted shell and no greeting of the pane's own (M28)", () => {
    const pane = readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8");
    const session = readFileSync(join(SRC, "terminal", "session.ts"), "utf8");
    for (const src of [pane, session, xterm]) {
      expect(src).not.toMatch(/scripted shell|Type help|ScriptedShell/);
      expect(src).not.toContain('from "./shell"');
    }
  });
  test("one header (M28): on the phone's page the folder and Copy the command go into the title bar, no bar under it", () => {
    const pane = readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8");
    expect(pane).toMatch(/\{mode === "page" \? \(\s*<BarTools>\s*\{folderName\}\s*\{copy\}\s*<\/BarTools>\s*\) : \(\s*<div className="term-head">/);
    expect(pane).toContain('createPortal(<div className="term-bar">{children}</div>, bar)');
    expect(pane).toContain(':scope > [data-testid="topbar"]');
    // Close is in the header except on the phone's page, where Back closes.
    expect(pane.match(/data-testid="terminal-close"/g)).toHaveLength(1);
  });
  test("the header names the folder by its own name, the full path in its title, never a path cut at its start", () => {
    expect(paneFolderName("~/src/kitespan")).toBe("kitespan");
    expect(paneFolderName("/tmp/kitespan-demo-a1b2c3/work/kitespan")).toBe("kitespan");
    expect(paneFolderName("/srv/my project/")).toBe("my project");
    expect(paneFolderName("/")).toBe("/");
    expect(paneFolderName("")).toBe("");
    const pane = readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8");
    expect(pane).toMatch(/<span className="term-folder" title=\{folder\}>\s*<bdi>\{paneFolderName\(folder\)\}<\/bdi>\s*<\/span>/);
    const css = readFileSync(join(SRC, "styles", "terminal.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\.term-folder \{([^}]*)\}/.exec(css)?.[1]).not.toContain("direction");
  });
  test("the phone's page shows the 5.4 line of a link it could not read in full, once; elsewhere the chat shows it", () => {
    const route = (path: string) => parse(new URL(`http://127.0.0.1${path}`));
    expect(pageLinkLine(route(`/c/${CHATS[0]!.id}/shell?type=bogus`), true)).toBe("Part of that link could not be read.");
    expect(pageLinkLine(route(`/c/${CHATS[0]!.id}/shell?view=bogus`), true)).toBe("Part of that link could not be read.");
    expect(pageLinkLine(route(`/c/${CHATS[0]!.id}/shell/extra`), true)).toBe("That link could not be read.");
    expect(pageLinkLine(route(`/c/${CHATS[0]!.id}/shell?type=resume`), true)).toBeNull();
    // At the other sizes the chat beside the pane shows the line (ChatScreen.tsx): the pane adds none.
    expect(pageLinkLine(route(`/c/${CHATS[0]!.id}/shell?type=bogus`), false)).toBeNull();
    const pane = readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8");
    expect(pane).toContain('const linkLine = pageLinkLine(route, mode === "page");');
    expect(pane).toMatch(/\{linkLine \? \(\s*<div className="term-link">\s*<p className="notice" data-testid="link-notice" role="status">\s*\{linkLine\}/);
    // The phone's page hides the chat, and with it the chat's own line, so the line shows once.
    const css = readFileSync(join(SRC, "styles", "terminal.css"), "utf8");
    expect(css).toMatch(/\.shell-phone\[data-terminal="page"\] > \.main > \.chat-screen \{\s*display: none;/);
    expect(readFileSync(join(SRC, "layout", "Shell.tsx"), "utf8")).toContain('{termPage ? <TerminalPane chat={chat!} route={route} mode="page" /> : null}');
  });
  test("the view answers a terminal query only when the session says so (no answer from a replayed ring)", () => {
    expect(xterm).toMatch(/function guardQueries\(term: Terminal, io: TermIO\) \{\s*const skip = \(\) => !io\.answers\(\);/);
    for (const id of ['{ final: "c" }', '{ prefix: ">", final: "c" }', '{ final: "n" }', '{ prefix: "?", intermediates: "$", final: "p" }']) expect(xterm).toContain(id);
    expect(xterm).toContain('term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, skip);');
    expect(xterm).not.toContain("reflowCursorLine");
  });
});

// The terminal's palette (xterm.ts themeFrom) on its ground, in every look and theme: WCAG AA for text.
describe("the terminal's colours on its ground", () => {
  const tokens = readFileSync(join(SRC, "styles", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** The declarations of the top-level block whose selector list holds `selector` (not inside @media). */
  const block = (selector: string): Map<string, string> => {
    const top = tokens.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    for (const m of top.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[1]!.split(",").map((x) => x.trim().replace(/\s+/g, " ")).includes(selector)) continue;
      return new Map([...m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()]));
    }
    throw new Error(`no block ${selector}`);
  };
  const rgb = (v: string | undefined) => {
    const m = /^#([0-9a-f]{6})$/i.exec(v ?? "");
    if (!m) throw new Error(`not #rrggbb: ${v}`);
    return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16));
  };
  const lum = (v: string | undefined) => {
    const [r, g, b] = rgb(v).map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string | undefined, b: string | undefined) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  for (const look of ["glass", "paper", "mono", "editor"])
    for (const theme of ["light", "dark"] as const)
      test(`${look} ${theme}: --text, --dim, --accent-text, --ok, --warn and --danger are 4.5:1 on --bg`, () => {
        const p = block(`[data-look="${look}"]`);
        if (theme === "dark") for (const [k, v] of block(`[data-look="${look}"][data-theme="dark"]`)) p.set(k, v);
        const low: string[] = [];
        for (const t of ["--text", "--dim", "--accent-text", "--ok", "--warn", "--danger"]) if (ratio(p.get(t), p.get("--bg")) < 4.5) low.push(`${t} ${ratio(p.get(t), p.get("--bg")).toFixed(2)}`);
        expect(low).toEqual([]);
      });
});

describe("the style sheet", () => {
  const css = readFileSync(join(SRC, "styles", "terminal.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  test("tokens only: no literal colour, radius, font or font size", () => {
    const bad: string[] = [];
    for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
      const [prop, value] = [m[1]!, m[2]!.trim()];
      const v = value.replace(/var\([^)]*\)/g, "");
      if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b/i.test(v)) bad.push(`${prop}: ${value}`);
      if (/radius/.test(prop) && !/var\(--r-/.test(value)) bad.push(`${prop}: ${value}`);
      if ((prop === "font-family" || prop === "font") && !/^var\(--font-/.test(value)) bad.push(`${prop}: ${value}`);
      if (prop === "font-size" && /\d(px|rem)\b/.test(v)) bad.push(`${prop}: ${value}`);
    }
    expect(bad).toEqual([]);
  });
  test("the pane wears the look's ground, and the word being composed is --text on --elevated with a hairline, not xterm's black box", () => {
    expect(css).toMatch(/\.term-pane \{[^}]*background: var\(--bg\);/);
    expect(css).toMatch(/\.term-host \.xterm \.composition-view \{[^}]*background: var\(--elevated\);[^}]*box-shadow: 0 0 0 1px var\(--hairline\);[^}]*color: var\(--text\);/);
    expect(css).not.toContain("--code-bg");
  });
  test("the one scroll bar is xterm 6's slider, a --fill-strong pill in every state; the empty viewport shows none; the helper field has no ground", () => {
    const rule = (sel: RegExp) => new RegExp(`${sel.source}[^{]*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    const slider = rule(/\.term-host \.xterm \.xterm-scrollable-element > \.scrollbar > \.slider,/);
    expect(slider).toContain("background: var(--fill-strong);");
    expect(slider).toContain("border-radius: var(--r-pill);");
    expect(css).toMatch(/> \.slider:hover,\s*\.term-host[^{]*> \.slider\.active \{/);
    // xterm 6's viewport never scrolls: a browser bar there would only draw its arrows at the pane's foot.
    expect(rule(/\.term-host \.xterm \.xterm-viewport /)).toMatch(/background-color: transparent;[^}]*scrollbar-width: none;/);
    expect(rule(/\.term-host \.xterm \.xterm-viewport::-webkit-scrollbar /)).toContain("display: none;");
    expect(rule(/\.term-host \.xterm \.xterm-helper-textarea /)).toContain("background: transparent;");
    // One source: the theme no longer sets the slider's colours.
    expect(readFileSync(join(SRC, "terminal", "xterm.ts"), "utf8")).not.toMatch(/scrollbarSlider\w*:/);
  });
  // Iteration 2 wrapped the bar so that every key showed (3ffe723). Iteration 8 makes it one row (DESIGN-T1 T-12, the
  // default of owner question Q12): with Select, Copy and Paste the wrap took two to four rows of a pane that the
  // keyboard already shortens, and the copy keys must stay in view. So Copy and Paste are pinned at the row's end and
  // the keys before them scroll sideways. The browser pane's key row (Keyboard.tsx) still wraps.
  test("the Terminal's key bar is one row: the keys scroll sideways before Copy and Paste, pinned; each key is 44 px high and at least 44 px wide", () => {
    const keys = /\.term-keys \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(keys).toContain("flex-wrap: wrap;");
    const row = /\.term-keys\.is-one-row \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(row).toContain("flex-wrap: nowrap;");
    expect(row).toContain("overflow: hidden;");
    const scroll = /\.term-keys-scroll \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(scroll).toContain("overflow-x: auto;");
    expect(scroll).toContain("min-width: 0;");
    expect(scroll).toContain("scrollbar-width: none;");
    expect(css).toMatch(/\.term-keys-scroll::-webkit-scrollbar \{\s*display: none;/);
    expect(css).toMatch(/\.term-keys-scroll > \.term-key,\s*\.term-keys-scroll > \.term-arrows \{\s*flex: 0 0 auto;/);
    const pin = /\.term-keys-pin \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(pin).toContain("flex: none;");
    expect(pin).toContain("border-left: 1px solid var(--hairline);");
    const key = /\.term-key \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(key).toContain("height: var(--touch);");
    expect(key).toContain("min-width: var(--touch);");
    expect(css).toMatch(/\.term-arrows \{[^}]*flex: 4 0 calc\(4 \* var\(--touch\) \+ 3 \* var\(--s1\)\);/);
    const pane = readFileSync(join(SRC, "terminal", "TerminalPane.tsx"), "utf8");
    expect(pane).toMatch(/<div className="term-keys is-one-row" role="toolbar" aria-label="Terminal keys" data-testid="terminal-keys">\s*<div className="term-keys-scroll" ref=\{scroll\}>/);
    expect(pane).toMatch(/<div className="term-arrows" role="group" aria-label="Arrow keys">\s*\{ARROW_KEYS\.map\(send\)\}\s*<\/div>\s*<\/div>\s*<div className="term-keys-pin" role="group" aria-label="Clipboard">/);
  });
  test("app.css imports it", () => {
    expect(readFileSync(join(SRC, "styles", "app.css"), "utf8")).toContain('@import "./terminal.css";');
  });
});
