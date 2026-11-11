// The Terminal pane (D38, the owner's "a side term pane there, similar to claude code app"): the chat's login shell in
// the chat's folder, over /ws/shell (session.ts, link.ts). Shell.tsx places it: the laptop's side column wherever the
// side panel docks (wider than the cards when there is room), over the chat where the panel goes over it too, the
// docked pane on a medium touch device, and a page of its own on the phone, with Back in the title bar. On every touch
// device a key bar sits at its foot (above the keyboard on the phone).
//
// One header (M28): the folder's name (its full path in the title), Copy the command (the copy dialog,
// /c/<chat>/terminal, the fallback for a terminal of the user's own) and Close; on the phone's page the folder and
// Copy the command go into the title bar beside "Chat" and "Terminal", so no second bar shows. The pane prints no
// greeting of its own: the real shell prints its prompt. Above the terminal, one line at a time and only while it
// holds: the fork line, "Then type /<command>.", the no-session line, the line that nothing was typed because the
// prompt was in use (until the next key), "Reconnecting...", or the server's reason when it opens no shell. The phone's page also shows the 5.4 line of a link that could not be read in full, under its
// title bar, because the chat that shows it at every other size is hidden under the page (route.ts pageLinkLine).
//
// xterm loads here, with a dynamic import, the first time a pane opens. /c/<chat>/shell?type=resume asks the server to
// type the chat's command once the shell's line editor waits (session.ts typeForEntry), once per history entry, so a
// remount, a Back or Forward, a reload or a restored tab types nothing more: never run, never recorded; only the
// user's Enter runs a line. When a terminal-only command's pick in the / menu opened the pane (D47), the line "Then
// type /<command>." shows too; the name comes from the history entry's state (route.ts thenTypeOf), never from the URL.
//
// U4: in the split side panel it always takes the lower half; its Close closes that half, and only as the URL's own
// view does it take the focus as it mounts (its route says, Route.half).
//
// When the pane closes (its Close, Ctrl+backtick, the pane bar's button, the title bar's, Back), the focus goes back to
// the control that opened it while that is on the page; else to the composer's field on a laptop, and on touch, where
// a field would raise the keyboard, to the control that opens the pane (useFocusBack).
//
// The pane is its fields' owner for the keyboard release (data-kb-owner): a tap on the key bar or the terminal while
// the keyboard settles closed keeps xterm's field.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { closeTo, href, parse, type Route } from "../router";
import { chatFolderIn, commandRowsOf, useStore } from "../state/store";
import type { Chat } from "../state/types";
import { useViewport } from "../layout/size";
import { Link } from "../ui/primitives";
import { IconClose } from "../ui/icons";
import { answersQueries, noteLines, sessionFor, setCtrl, subscribe, typeForEntry, userInput, viewHidden, viewResized, viewShown, wake, type TermSession } from "./session";
import { pageLinkLine, paneFolderName, thenTypeOf } from "./route";
import { halfClose, halvesOf, pairOf } from "../layout/split";
import { canStop } from "../chat/background";
import { COPY_FAILED, COPY_HINT, writeClipboard } from "../ui/Copy";
import { ARROW_KEYS, PASTE_FAILED, PINNED_KEYS, SCROLL_KEYS, moreKeys, selectAfter, type BarKey } from "./keybar";
// xterm's own sheet goes into the app's sheet from here: the bundler does not load a sheet a lazy chunk imports.
import "@xterm/xterm/css/xterm.css";

/** Where the pane is: the laptop's column, over the chat, the medium pane, or the phone's page. */
export type TermMode = "column" | "over" | "pane" | "page";

type XtermModule = typeof import("./xterm");
let loaded: XtermModule | null = null;
let loading: Promise<XtermModule> | null = null;
function loadXterm(): Promise<XtermModule> {
  loading ??= import("./xterm").then(
    (m) => (loaded = m),
    (e) => {
      loading = null; // a later open tries again
      throw e;
    },
  );
  return loading;
}

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);

/** Re-render when the session's status, line or note changes. */
function useSession(s: TermSession): number {
  const listen = useCallback((fn: () => void) => subscribe(s, fn), [s]);
  return useSyncExternalStore(
    listen,
    () => s.version,
    () => s.version,
  );
}

export function TerminalPane({ chat, route, mode }: { chat: Chat; route: Route; mode: TermMode }) {
  const vp = useViewport();
  const folder = useStore((s) => chatFolderIn(s, chat)) ?? "";
  const host = useRef<HTMLDivElement>(null);
  const [mod, setMod] = useState<XtermModule | null>(loaded);
  const [failed, setFailed] = useState(false);
  const [attached, setAttached] = useState(false);
  const session = sessionFor(chat.id);
  useSession(session);
  // The key bar's own line (a refused Paste or Copy): until the next key.
  const [keyLine, setKeyLine] = useState<KeyLine | null>(null);
  const lineOff = useRef(() => setKeyLine(null));
  const fontSize = vp.touch ? 14 : 13;
  // U4: as the other half of the split side panel (not the URL's own view) it takes no focus, also after a reload.
  const focus = !vp.touch && route.half?.path !== false;
  const first = useRef({ fontSize, focus });
  first.current = { fontSize, focus };
  useFocusBack(chat.id); // before the attach below, which moves the focus into the terminal

  useEffect(() => {
    if (mod) return;
    let live = true;
    loadXterm().then(
      (m) => live && setMod(m),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [mod]);

  // The session's terminal moves into this pane, and out again (kept in memory) when the pane closes; the first
  // attach opens the chat's shell over /ws/shell, and a socket that waits out its backoff dials when the page shows.
  useLayoutEffect(() => {
    if (!mod || !host.current) return;
    const io = { input: (data: string, binary?: boolean) => (lineOff.current(), userInput(session, data, binary)), resized: (cols: number, rows: number) => viewResized(session, cols, rows), answers: () => answersQueries(session) };
    const a = mod.attach(session, io, host.current, first.current);
    viewShown(session, a.view, a.fit);
    setAttached(true);
    const onShow = () => {
      if (document.visibilityState === "visible") wake(session);
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("online", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("online", onShow);
      setAttached(false);
      a.detach();
      viewHidden(session);
    };
  }, [mod, session]);

  useEffect(() => {
    if (mod && attached) mod.setFontSize(session, fontSize);
  }, [mod, attached, session, fontSize]);

  // ?type=resume: the server types the command at the prompt, once for this history entry (a remount, a Back or
  // Forward to it, a reload or a restored tab types nothing more). A prefill, not an action: nothing runs and nothing
  // is recorded.
  const type = route.name === "shell" ? route.query.type : undefined;
  const commands = chat.commands;
  useEffect(() => {
    if (!attached || type !== "resume") return;
    typeForEntry(session, thenTypeOf(history.state, commandRowsOf({ commands })));
  }, [attached, type, route, session]);
  // R127, Trust this folder's fallback (?type=trust&tool=<toolUse>): the server types `cd <folder> && claude` for that
  // refused row of the chat (the folder from its own match, never from the link), once for this history entry, as
  // ?type=resume does; the user's Enter runs it, and Claude Code's own trust question asks.
  const tool = route.name === "shell" && typeof route.query.tool === "string" ? route.query.tool : null;
  useEffect(() => {
    if (!attached || type !== "trust" || !tool) return;
    typeForEntry(session, null, tool);
  }, [attached, type, tool, route, session]);
  // R131, Open in terminal for a background session (?type=attach&bg=<id>): the server types `claude attach <id>` for
  // an id that a launch row of the chat printed (else it answers `none`), once for this history entry, never run; the
  // user's Enter opens the session in Claude Code's own UI, which asks its prompts there (or opens one that ended
  // again: the pane's line says which, from the session's state when it was asked).
  const bg = route.name === "shell" && typeof route.query.bg === "string" ? route.query.bg : null;
  const bgOf = useRef(bg ? chat.background?.[bg] : undefined);
  bgOf.current = bg ? chat.background?.[bg] : undefined;
  useEffect(() => {
    if (!attached || type !== "attach" || !bg) return;
    const w = bgOf.current;
    typeForEntry(session, null, null, bg, !!w && !canStop(w.state));
  }, [attached, type, bg, route, session]);

  const view = viewOf(route);
  // U4: in a half, Close gives the whole pane to the other view, and the copy dialog keeps the pair under it.
  const chatUrl = halfClose(route) ?? href("chat", { chat: chat.id }, { view });
  const pair = route.half ? pairOf(route) : null;
  const copy = (
    <Link to={href("terminal", { chat: chat.id }, { view, above: pair ? halvesOf(pair)[0].value : undefined })} className="btn ghost term-copy">
      Copy the command
    </Link>
  );
  const folderName = folder ? (
    <span className="term-folder" title={folder}>
      <bdi>{paneFolderName(folder)}</bdi>
    </span>
  ) : null;
  const linkLine = pageLinkLine(route, mode === "page");
  const lines = noteLines(session);
  return (
    <section className={`term-pane term-mode-${mode}`} data-kb-owner="" data-testid="terminal-pane" data-mode={mode} data-status={session.status} aria-label="Terminal">
      {mode === "page" ? (
        <BarTools>
          {folderName}
          {copy}
        </BarTools>
      ) : (
        <div className="term-head">
          {folderName ?? <span className="term-folder" />}
          {copy}
          <button type="button" className="icon-btn term-close" aria-label="Close terminal" title="Close terminal" data-testid="terminal-close" onClick={() => closeTo(chatUrl)}>
            <IconClose size={16} />
          </button>
        </div>
      )}
      {linkLine ? (
        <div className="term-link">
          <p className="notice" data-testid="link-notice" role="status">
            {linkLine}
          </p>
        </div>
      ) : null}
      {lines.length ? (
        <div className={`term-note${session.status === "refused" ? " term-note-problem" : ""}`} data-testid="terminal-note">
          {lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      ) : null}
      {keyLine ? <KeyLineNote line={keyLine} /> : null}
      <div className="term-body">
        <div className="term-host" ref={host} data-testid="terminal" />
        {!mod && !failed ? <p className="term-wait">Starting the terminal…</p> : null}
        {failed ? (
          <p className="term-wait" role="alert">
            The terminal could not load. Reload the page to try again.
          </p>
        ) : null}
      </div>
      {vp.touch ? <KeyBar session={session} xterm={attached ? mod : null} onLine={setKeyLine} /> : null}
      <span className="visually-hidden" role="status">
        {session.said}
      </span>
    </section>
  );
}

/**
 * The phone's page has one header, the title bar (TopBar.tsx: Back "Chat" and "Terminal"): the folder and Copy the
 * command go into it, at its right, so no second bar shows under it (M28).
 */
function BarTools({ children }: { children: ReactNode }) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const probe = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const shell = probe.current?.closest(".shell");
    setBar(shell?.querySelector<HTMLElement>(':scope > [data-testid="topbar"]') ?? null);
  }, []);
  return (
    <>
      <span ref={probe} hidden />
      {bar ? createPortal(<div className="term-bar">{children}</div>, bar) : null}
    </>
  );
}

// ---- the focus when the pane closes

// The control the pointer pressed last: Safari focuses no button or link on a click, so a recent press is the opener.
// A key after it (Ctrl+backtick in the composer's field, say) makes the focused element the opener again.
let pressed: { el: HTMLElement; at: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest("a[href], button") : null;
      pressed = el instanceof HTMLElement ? { el, at: Date.now() } : null;
    },
    true,
  );
  document.addEventListener("keydown", () => (pressed = null), true);
}

/** The pane's opener, per chat; `moving` is the chat whose pane unmounted in this commit (a pane that mounts in the
 * same commit is that pane in its new place, after a resize: it keeps the opener). */
let opener: { chatId: string; el: HTMLElement | null } | null = null;
let moving: string | null = null;

const outsidePane = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && el.isConnected && el !== document.body && !el.closest(".term-pane");
const onPage = (el: HTMLElement | null | undefined): el is HTMLElement =>
  !!el && el.isConnected && el.getClientRects().length > 0 && !el.closest("[inert]") && !(el as HTMLButtonElement).disabled;
const isField = (el: Element) => el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

function openerNow(): HTMLElement | null {
  if (pressed && Date.now() - pressed.at < 1500 && outsidePane(pressed.el)) return pressed.el;
  return outsidePane(document.activeElement) ? document.activeElement : null;
}

/**
 * Where the focus goes once chat `chatId`'s pane has closed, when it was in the pane or is lost (a click elsewhere
 * keeps it there): the opener while it is on the page (on touch, not a field); else the composer's field on a laptop;
 * else the control that opens the pane here (data-terminal-home: the pane bar's Terminal, the title bar's Open in
 * terminal, the phone's session menu), which raises no keyboard on touch. Nothing while a pane is still open (another
 * chat's) or the page is no longer this chat's.
 */
function focusBack(chatId: string, from: HTMLElement | null) {
  const now = document.activeElement;
  if (now && now !== document.body && now.isConnected) return;
  // A pane that slides out (layout/slide.ts) is inert: it is not open.
  if ([...document.querySelectorAll(".term-pane")].some((el) => !el.closest("[inert]"))) return;
  if (parse(new URL(location.href)).params.chat !== chatId) return;
  const touch = document.body.classList.contains("touch");
  const field = touch ? null : document.querySelector<HTMLElement>('[data-testid="composer-input"]');
  const home = [...document.querySelectorAll<HTMLElement>("[data-terminal-home]")].find(onPage);
  [from && !(touch && isField(from)) ? from : null, field, home].find(onPage)?.focus({ preventScroll: true });
}

/** Keep the pane's opener while it is open, and give the focus back when it closes (after the commit that closed it). */
function useFocusBack(chatId: string) {
  useLayoutEffect(() => {
    if (moving === chatId) moving = null;
    else opener = { chatId, el: openerNow() };
    return () => {
      moving = chatId;
      const from = opener?.chatId === chatId ? opener.el : null;
      queueMicrotask(() => {
        if (moving !== chatId) return; // the pane mounted again: it moved
        moving = null;
        focusBack(chatId, from);
      });
    };
  }, [chatId]);
}

// ---- the key bar of a touch device (DESIGN.md 7.7: a control for every key; keybar.ts): 44 px keys, above the
// keyboard on the phone and at the foot of the pane elsewhere, so a tablet with no keyboard still has Esc, Ctrl, the
// arrows and Tab, and every touch device has the terminal's copy and paste. One row (DESIGN-T1 T-12): the keys before
// Copy and Paste scroll sideways, and fade at the end while more lie past it.

const arrow = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** The key bar's own line above the terminal: a refused Paste, or a refused Copy with its text to copy by hand. */
export type KeyLine = { kind: "paste" } | { kind: "copy"; text: string };

function KeyLineNote({ line }: { line: KeyLine }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const text = line.kind === "copy" ? line.text : null;
  useEffect(() => {
    if (text !== null) field.current?.select();
  }, [text]);
  return (
    <div className="term-note term-note-problem" role="status" data-testid="terminal-key-line">
      {line.kind === "paste" ? (
        <p>{PASTE_FAILED}</p>
      ) : (
        <>
          <p>{COPY_FAILED}</p>
          <textarea ref={field} className="field term-copy-field" readOnly rows={2} value={line.text} aria-label="The text to copy" />
          <p>{COPY_HINT}</p>
        </>
      )}
    </div>
  );
}

/** Keep the focus (and the on-screen keyboard) in the terminal while a key is pressed. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function KeyBar({ session, xterm, onLine }: { session: TermSession; xterm: XtermModule | null; onLine: (line: KeyLine | null) => void }) {
  const [ctrl, setCtrlShown] = useState(session.ctrl);
  const [selecting, setSelecting] = useState(false);
  const [has, setHas] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    session.onCtrl = setCtrlShown;
    setCtrlShown(session.ctrl);
    return () => {
      if (session.onCtrl === setCtrlShown) session.onCtrl = null;
    };
  }, [session]);
  // Select acts in the view; the pane closing (or the view going) turns it off.
  useEffect(() => {
    if (!xterm) return;
    xterm.setSelecting(session, selecting);
  }, [xterm, session, selecting]);
  useEffect(() => {
    if (!xterm) return;
    return () => {
      xterm.setSelecting(session, selectAfter(true, "close"));
    };
  }, [xterm, session]);
  // Copy is off while nothing is selected.
  useEffect(() => {
    if (!xterm) return setHas(false);
    setHas(xterm.selectionOf(session) !== "");
    return xterm.onSelection(session, setHas);
  }, [xterm, session]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  // The fade: data-more while keys lie past the scrolling part's end (at rest, on a scroll, on a resize, after a render).
  const mark = useRef(() => {});
  mark.current = () => {
    const el = scroll.current;
    if (el) el.toggleAttribute("data-more", moreKeys(el.scrollLeft, el.clientWidth, el.scrollWidth));
  };
  useLayoutEffect(() => mark.current());
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const on = () => mark.current();
    el.addEventListener("scroll", on, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(on);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", on);
      ro?.disconnect();
    };
  }, []);

  const pressed = () => onLine(null);
  const send = (k: BarKey) => (
    <button
      key={k.name}
      type="button"
      className={`term-key${k.sign ? " mono" : ""}`}
      aria-label={k.sign || k.path ? k.name : undefined}
      onMouseDown={keepFocus}
      onClick={() => {
        pressed();
        userInput(session, k.data ?? "");
      }}
    >
      {k.path ? arrow(k.path) : (k.sign ?? k.name)}
    </button>
  );
  const toggle = (k: BarKey) =>
    k.name === "Ctrl" ? (
      <button
        key={k.name}
        type="button"
        className="term-key"
        aria-pressed={ctrl}
        onMouseDown={keepFocus}
        onClick={() => {
          pressed();
          setCtrl(session, !session.ctrl);
        }}
      >
        Ctrl
      </button>
    ) : (
      <button
        key={k.name}
        type="button"
        className="term-key term-key-word"
        aria-pressed={selecting}
        data-testid="term-key-select"
        disabled={!xterm}
        onMouseDown={keepFocus}
        onClick={() => {
          pressed();
          setSelecting((on) => selectAfter(on, "tap"));
        }}
      >
        Select
      </button>
    );
  // Copy and Paste act inside the tap: the clipboard's write and read need the user's own gesture.
  const copy = () => {
    pressed();
    if (!xterm) return;
    const text = xterm.selectionOf(session);
    if (!text) return;
    void writeClipboard(text).then((ok) => {
      setCopied(ok);
      if (!ok) onLine({ kind: "copy", text });
    });
  };
  const paste = () => {
    pressed();
    if (!xterm) return;
    const failed = () => onLine({ kind: "paste" });
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip?.readText) return failed();
    // A latched Ctrl must not turn a pasted letter into a control key.
    setCtrl(session, false);
    clip.readText().then(
      (t) => {
        if (t) xterm.pasteInto(session, t);
      },
      () => failed(),
    );
  };
  return (
    <div className="term-keys is-one-row" role="toolbar" aria-label="Terminal keys" data-testid="terminal-keys">
      <div className="term-keys-scroll" ref={scroll}>
        {SCROLL_KEYS.map((k) => (k.toggle ? toggle(k) : send(k)))}
        <div className="term-arrows" role="group" aria-label="Arrow keys">
          {ARROW_KEYS.map(send)}
        </div>
      </div>
      <div className="term-keys-pin" role="group" aria-label="Clipboard">
        <button type="button" className="term-key term-key-word" data-testid="term-key-copy" disabled={!has} onMouseDown={keepFocus} onClick={copy}>
          <span className="term-key-face">{copied ? "Copied" : PINNED_KEYS[0]!.name}</span>
          <span className="term-key-room" aria-hidden="true">
            Copied
          </span>
        </button>
        <button type="button" className="term-key term-key-word" data-testid="term-key-paste" disabled={!xterm} onMouseDown={keepFocus} onClick={paste}>
          {PINNED_KEYS[1]!.name}
        </button>
      </div>
    </div>
  );
}
