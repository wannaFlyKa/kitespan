// The row menus (DESIGN-T1 2.1; DESIGN.md 7.7): a menu for a row or a title that has something to do, on Popup. A sheet
// on the phone, a menu at the row on a tablet and a laptop (DESIGN.md 7.6). Its first line names what it is for, whole:
// the sheet's title is the row's name and a mono line under it holds the full path or command; a menu's first line is
// that mono line, wrapping at its own punctuation first (breakable, T-31). That line is how touch reads what a tooltip
// holds (G-3).
// It opens by a long press on the row's head on touch (never on a tool's body, a message or a reply, whose text keeps
// the browser's own selection, 7.10 rule 1), by the row's visible "..." on touch (a 44 px opener, so nothing is only
// behind the hold, 7.7), and on a laptop by a right-click at the pointer, the ContextMenu key or Shift+F10; a right-
// click on a row that holds a text selection, or with Shift held, is the browser's own menu. A hold's target shows no
// iOS callout, word selection or link drag (rowmenu.css; Link's draggable).
// Each copy row writes inside its tap (ui/Copy.tsx writeClipboard), closes the menu and says "Copied" in a toast; a
// refused write opens "Copy failed", a sheet or a dialog with the exact text selected in a field, so a failed copy is
// never silent and the text is there to copy by hand (7.10 rule 4, T-29).
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { href, useRoute, type Route } from "../router";
import { act } from "../state/store";
import { usePopupFocus, usePopupRows } from "../screens/common";
import { viewUrl } from "../panels/format";
import { useViewport, type Viewport } from "../layout/size";
import { download, type DownloadKind } from "../panels/download";
import { breakable } from "./breakable";
import { COPY_HINT, writeClipboard } from "./Copy";
import type { RowItem, RowMenuSpec } from "./fileMenu";
import { IconMore } from "./icons";
import { Dialog, Link, Popup, useLongPress } from "./primitives";
import "../styles/rowmenu.css";

/** The toast a copy row raises. */
export const COPIED = "Copied";
/** Copy failed's title. */
export const COPY_FAILED_TITLE = "Copy failed";
/** How long the Copied toast shows. */
const COPIED_MS = 2000;

const LAPTOP: Viewport = { size: "laptop", touch: false, width: 1280, height: 800 };

/** The viewport, or a laptop's where the page has no window (markup rendered on the server, in tests). */
export function useRowViewport(): Viewport {
  // The page always has a window, so the hook is called, or not, on every render alike.
  return typeof matchMedia === "function" && typeof window !== "undefined" ? useViewport() : LAPTOP; // eslint-disable-line react-hooks/rules-of-hooks
}

/** True while the target holds a text selection that is not empty: a right-click there is the browser's own. */
function holdsSelection(el: Element): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== "" && sel.containsNode(el, true);
}

/**
 * What a menu's items read when they are made: the route (null before the menu opens: the items are made then only to
 * know whether the row has a menu, and the page's URL is read once it opens), a fine pointer, the page's origin.
 */
export interface MenuHere {
  route: Route | null;
  laptop: boolean;
  origin: string;
}

/** Open's URL for a file of a chat's folder: its page, or its pane, in the route's own view. */
export function fileOpener(chatId: string, route: Route | null): (rel: string) => string {
  return (rel) => (route ? viewUrl("files", chatId, route, { path: rel }) : href("files", { chat: chatId, path: rel }));
}

/** Where a menu opens: at the row (a long press, a key), at its opener, or at a right-click's pointer. */
type Opened = { from: "row" | "opener"; at: { x: number; y: number } | null };

export interface RowMenuParts {
  /** Spread on the target (a row's head, a link row): its ref and its press, key and context menu handlers. */
  target: {
    ref: RefObject<never>;
    /** Marks the target for rowmenu.css: no callout, selection or drag on touch, and the pressed wash. */
    "data-row-press"?: "";
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerMove: (e?: React.PointerEvent) => void;
    onClickCapture: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
  /** The visible opener, a 44 px "..." on touch (null on a laptop and for a row with no menu). */
  opener: ReactNode;
  /** The menu itself, and Copy failed after a refused copy: render it in the row. */
  menu: ReactNode;
  touch: boolean;
  open: boolean;
}

const NO_TARGET: RowMenuParts["target"] = {
  ref: { current: null as never },
  onPointerDown: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
  onPointerMove: () => {},
  onClickCapture: () => {},
  onContextMenu: () => {},
  onKeyDown: () => {},
};

/**
 * A row's menu: `build` makes its items (null: the row has none, and nothing binds). `name` names the opener ("Menu
 * for <name>"; the menu's title when not given). `onRun` runs a row's own act (an upload's Remove). `openerClass`
 * places the "..." in the row's own style; `openerAlways` draws it on a laptop too (a row whose style shows it only
 * where the row's own buttons have no room).
 */
export function useRowMenu(build: (here: MenuHere) => RowMenuSpec | null, opts: { name?: string; onRun?: (id: string) => void; openerClass?: string; openerAlways?: boolean } = {}): RowMenuParts {
  const vp = useRowViewport();
  const spec = build({ route: null, laptop: !vp.touch, origin: "" });
  const [opened, setOpened] = useState<Opened | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const row = useRef<HTMLElement | null>(null);
  const more = useRef<HTMLButtonElement | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const keyAt = useRef(0);
  const openAt = (from: Opened["from"], at: Opened["at"] = null) => {
    anchor.current = from === "opener" ? more.current : row.current;
    setOpened({ from, at });
  };
  const press = useLongPress(() => openAt("row"));
  const close = () => setOpened(null);
  const has = !!spec && spec.groups.length > 0;
  const name = opts.name ?? spec?.title ?? "";
  const testId = `row-menu-${spec?.kind ?? "none"}`;

  const target: RowMenuParts["target"] = has
    ? {
        ref: row as RefObject<never>,
        "data-row-press": "",
        onPointerDown: press.onPointerDown,
        onPointerUp: press.onPointerUp,
        onPointerCancel: press.onPointerCancel,
        onPointerMove: press.onPointerMove,
        onClickCapture: press.onClickCapture,
        onContextMenu: (e) => {
          if (press.fired() || Date.now() - keyAt.current < 1000) {
            e.preventDefault(); // the long press or the key opened it already (Android sends contextmenu too)
            return;
          }
          if (e.shiftKey || holdsSelection(e.currentTarget)) return; // the browser's own menu
          e.preventDefault();
          press.onPointerCancel(); // a touch's context menu (Android) that came before the hold's own time
          // A context menu from the keyboard has no pointer: it opens at the row.
          openAt("row", e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY });
        },
        onKeyDown: (e) => {
          if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
          e.preventDefault();
          keyAt.current = Date.now();
          openAt("row");
        },
      }
    : NO_TARGET;

  const opener =
    has && (vp.touch || opts.openerAlways) ? (
      <button
        ref={more}
        type="button"
        className={`icon-btn row-more${opts.openerClass ? ` ${opts.openerClass}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={!!opened}
        aria-label={`Menu for ${name}`}
        data-testid="row-more"
        onClick={(e) => {
          e.stopPropagation(); // a row that is itself a control (a search hit) does not take the tap
          if (opened) close();
          else openAt("opener");
        }}
      >
        <IconMore size={18} />
      </button>
    ) : null;

  const menu = (
    <>
      {has && opened ? <RowMenuPopup build={build} laptop={!vp.touch} testId={testId} anchor={anchor} at={opened.at} onClose={close} onFailed={setFailed} onRun={opts.onRun} /> : null}
      {failed !== null ? <CopyFailed text={failed} name={name} onClose={() => setFailed(null)} /> : null}
    </>
  );
  return { target, opener, menu, touch: vp.touch, open: !!opened };
}

/** Copy inside the tap; say Copied in a toast, or hand the text to Copy failed. */
function copyRow(text: string, onFailed: (text: string) => void) {
  void writeClipboard(text).then((ok) => {
    if (ok) act.showToast({ key: "row-copied", text: COPIED, priority: "low", timeoutMs: COPIED_MS });
    else onFailed(text);
  });
}

/** A download by the existence probe, then the browser's own; a refused probe says its 5.4 line. */
function saveRow(url: string, what: DownloadKind) {
  void download(url, what).then((r) => {
    if (!r.ok) act.setNotice(r.line);
  });
}

function RowMenuPopup(props: { build: (here: MenuHere) => RowMenuSpec | null; laptop: boolean; testId: string; anchor: RefObject<HTMLElement | null>; at: { x: number; y: number } | null; onClose: () => void; onFailed: (text: string) => void; onRun?: (id: string) => void }) {
  const { build, laptop, testId, anchor, at, onClose, onFailed, onRun } = props;
  const route = useRoute();
  const k = usePopupRows();
  usePopupFocus(true, testId, anchor);
  const spec = build({ route, laptop, origin: location.origin });
  const row = (i: RowItem) => {
    const cls = `${k.row} row-menu-row${i.danger ? (k.sheet ? " danger" : " danger scr-menu-delete") : ""}`;
    const id = `row-${i.id}`;
    const a = i.act;
    switch (a.do) {
      case "go":
        return (
          <Link key={i.id} to={a.to} className={cls} data-testid={id} onNavigate={onClose}>
            {i.label}
          </Link>
        );
      case "tab":
        return (
          <a key={i.id} href={a.to} target="_blank" rel="noopener noreferrer" className={cls} data-testid={id} onClick={onClose}>
            {i.label}
          </a>
        );
      default:
        return (
          <button
            key={i.id}
            type="button"
            className={cls}
            data-testid={id}
            onClick={() => {
              // A copy writes first, inside the tap; then the menu closes.
              if (a.do === "copy") copyRow(a.text, onFailed);
              onClose();
              if (a.do === "save") saveRow(a.url, a.what);
              else if (a.do === "attach") act.addMention(a.chat, a.rel);
              else if (a.do === "run") onRun?.(i.id);
            }}
          >
            {i.label}
          </button>
        );
    }
  };
  if (!spec) return null;
  return (
    <Popup open onClose={onClose} anchor={anchor} at={at} title={spec.title} testId={testId}>
      <div className={`${k.box} scr-menu row-menu`}>
        <p className={`row-menu-head mono${k.sheet ? "" : " scr-pick-head"}`} dir="auto">
          {breakable(spec.head)}
        </p>
        {spec.note ? <p className={`row-menu-note${k.sheet ? "" : " scr-pick-head"}`}>{spec.note}</p> : null}
        {spec.groups.map((g, n) => (
          <RowGroup key={n} sep={n > 0 && !k.sheet} list={k.list}>
            {g.map(row)}
          </RowGroup>
        ))}
      </div>
    </Popup>
  );
}

function RowGroup({ sep, list, children }: { sep: boolean; list: string; children: ReactNode }) {
  return (
    <>
      {sep ? <hr className="menu-sep" /> : null}
      <div className={list}>{children}</div>
    </>
  );
}

/**
 * T-29: a copy the browser refused, from a menu row (the menu is closed, so its text has nowhere else to be selected):
 * a sheet on the phone, a dialog elsewhere, titled "Copy failed", COPY_HINT under the title, then the exact text in a
 * read-only mono field, selected, and Done.
 */
export function CopyFailed({ text, name, onClose }: { text: string; name: string; onClose: () => void }) {
  const vp = useRowViewport();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.select();
    });
    return () => cancelAnimationFrame(id);
  }, [text]);
  const body = (
    <div className="row-copy">
      <p className="row-copy-hint">{COPY_HINT}</p>
      <textarea ref={field} className="row-copy-text mono" readOnly rows={8} value={text} aria-label={name ? `The text to copy, from ${name}` : "The text to copy"} data-testid="copy-failed-text" data-autofocus="" />
    </div>
  );
  if (vp.size === "phone")
    return (
      <Popup open onClose={onClose} title={COPY_FAILED_TITLE} testId="copy-failed">
        {body}
      </Popup>
    );
  return (
    <Dialog open onClose={onClose} title={COPY_FAILED_TITLE} testId="copy-failed" initial={() => field.current}>
      {body}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
