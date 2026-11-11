// The head of the pane (DESIGN-B1 4.2, 4.18; PAGE 3.1): the tab strip, New tab and Close browser. Every tab of the
// shared browser shows, in the server's order, with one mark (tabMark) and its title (the host while it has none, "New
// tab" before a first address). Each tab's Close is a button beside its tab, in a presentation wrapper, so screen
// readers expose it and VoiceOver on iOS reaches it; on touch it is 44 x 44 px. The strip is a tab list with manual
// activation: Left, Right, Home and End move between tabs, Enter and Space show one, Delete closes the focused one. A
// middle click closes a tab. Closing a tab that Claude uses during a turn asks first ("Close tab" sends force).
// On the phone there is no strip: the foot's Tabs button opens the Tabs sheet (TabsSheet below).
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { BrowserActing, BrowserTabView } from "../../shared/browser";
import { IconCheck, IconClose, IconPlus, IconPointer } from "../ui/icons";
import { Popup } from "../ui/primitives";
import { tabMark, tabNameOf, type TabMark } from "./claude";
import { addressShown } from "./address";

export interface StripTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  mark: TabMark;
  /** A local draft that New tab opened (nothing sent yet). */
  draft?: boolean;
}

/** A tab's title as the strip shows it: the page's title, else the address's host, else "New tab". */
export function tabTitle(t: Pick<BrowserTabView, "title" | "url">): string {
  const title = t.title.trim();
  if (title && title !== "about:blank") return title;
  const host = addressShown(t.url).host;
  return host || "New tab";
}

export function stripTabs(tabs: readonly BrowserTabView[], running: readonly BrowserActing[], lit: boolean, draft: { id: string } | null): StripTab[] {
  const out: StripTab[] = tabs.map((t) => ({ id: t.id, title: tabTitle(t), url: t.url, loading: t.loading, mark: tabMark(t, running, lit) }));
  if (draft) out.push({ id: draft.id, title: "New tab", url: "", loading: false, mark: null, draft: true });
  return out;
}

const spin = (label: string) => (
  <span className="chat-spin" role="img" aria-label={label}>
    <span className="chat-spin-still">{label}</span>
  </span>
);

export function MarkIcon({ mark }: { mark: TabMark }) {
  if (mark === "dot") return <span className="dot waiting" aria-hidden="true" />;
  if (mark === "working") return <span className="bp-mark" aria-hidden="true">{spin("Claude is acting")}</span>;
  if (mark === "pointer")
    return (
      <span className="bp-mark" aria-hidden="true">
        <IconPointer size={13} />
      </span>
    );
  return null;
}

export function TabStrip(props: { tabs: StripTab[]; open: string | null; touch: boolean; frameId: string; onShow: (id: string) => void; onClose: (id: string) => void; onNew: () => void; end?: ReactNode; lead?: ReactNode }) {
  const { tabs, open, touch, frameId, onShow, onClose, onNew, end, lead } = props;
  const list = useRef<HTMLDivElement>(null);
  // The open tab stays in view as the strip scrolls sideways.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [open, tabs.length]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
    if (to !== null) {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
      return;
    }
    const id = items[at]?.dataset.tab;
    if (!id) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onShow(id);
    } else if (e.key === "Delete") {
      e.preventDefault();
      onClose(id);
    }
  };
  return (
    <div className="bp-head" data-testid="browser-head">
      {lead}
      <div className="bp-tabs" role="tablist" aria-label="Tabs" ref={list} onKeyDown={onKey} data-testid="browser-tabs">
        {tabs.map((t) => {
          const on = t.id === open;
          return (
            <div key={t.id} className={`bp-tab-wrap${on ? " is-open" : ""}`} role="presentation">
              <button
                type="button"
                role="tab"
                className="bp-tab"
                aria-selected={on}
                aria-controls={on ? frameId : undefined}
                aria-label={tabNameOf(t, t.title, t.mark)}
                title={t.title}
                tabIndex={on || (!open && t === tabs[0]) ? 0 : -1}
                data-tab={t.id}
                data-testid="browser-tab"
                onClick={() => onShow(t.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(t.id);
                  }
                }}
              >
                <MarkIcon mark={t.mark} />
                <span className="bp-tab-title">{t.title}</span>
              </button>
              <button type="button" className="icon-btn bp-tab-x" aria-label={`Close ${t.title}`} title={touch ? undefined : `Close ${t.title}`} tabIndex={-1} data-testid="browser-tab-close" onClick={() => onClose(t.id)}>
                <IconClose size={touch ? 16 : 13} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-btn bp-new" aria-label="New tab" title={touch ? undefined : "New tab"} data-testid="browser-new" onClick={onNew}>
        <IconPlus />
      </button>
      {end}
    </div>
  );
}

/**
 * The phone's Tabs sheet (PAGE 3.1, P4): one 56 px row per tab, the open one ticked, its marks in words, Close per row,
 * New tab. A plain list (DESIGN-B1 4.18): each row's button shows its tab, the open tab's is current, and Close is its
 * sibling, so a screen reader reads every row and which tab is open (a listbox of rows that hold two buttons is not
 * one: the browser drops its options).
 */
export function TabsSheet(props: { open: boolean; tabs: StripTab[]; shown: string | null; onClose: () => void; onShow: (id: string) => void; onCloseTab: (id: string) => void; onNew: () => void }) {
  const { open, tabs, shown, onClose, onShow, onCloseTab, onNew } = props;
  return (
    <Popup open={open} onClose={onClose} title="Tabs" testId="browser-tabs-sheet">
      <TabRows tabs={tabs} shown={shown} onShow={onShow} onCloseTab={onCloseTab} />
      <div className="bp-sheet-actions">
        <button type="button" className="btn" onClick={onNew} data-testid="browser-new">
          <IconPlus />
          New tab
        </button>
      </div>
    </Popup>
  );
}

/** The Tabs sheet's rows. */
export function TabRows(props: { tabs: StripTab[]; shown: string | null; onShow: (id: string) => void; onCloseTab: (id: string) => void }) {
  const { tabs, shown, onShow, onCloseTab } = props;
  return (
    <ul className="bp-tab-rows" aria-label="Tabs">
      {tabs.map((t) => {
        const words = [t.mark === "dot" ? "Needs an answer" : null, t.mark === "working" || t.mark === "pointer" ? "Claude's tab" : null].filter(Boolean);
        const where = addressShown(t.url);
        return (
          <li key={t.id} className="bp-tab-row">
            <button type="button" className="bp-tab-row-pick" aria-current={t.id === shown ? "true" : undefined} onClick={() => onShow(t.id)}>
              <span className="menu-check">
                <IconCheck />
              </span>
              {t.mark === "dot" ? <span className="dot waiting" aria-hidden="true" /> : null}
              <span className="bp-tab-row-text">
                <span className="bp-tab-row-title">{t.title}</span>
                <span className="bp-tab-row-url">
                  {words.map((w) => (
                    <span key={w} className={w === "Needs an answer" ? "bp-attn" : undefined}>
                      {w} ·{" "}
                    </span>
                  ))}
                  {where.host}
                  {where.rest}
                </span>
              </span>
            </button>
            <button type="button" className="icon-btn" aria-label={`Close ${t.title}`} onClick={() => onCloseTab(t.id)}>
              <IconClose />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
