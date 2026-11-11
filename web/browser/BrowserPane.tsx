// The Browser pane (DESIGN-B1 4; D-13 to D-20): one shared Chrome on this machine that the user and Claude both use,
// shown as a picture of the open tab. Shell.tsx places it (the side panel's seventh view kind beside a chat, over the
// chat where its column would be under 420 px, the phone's own page; BrowserScreen.tsx: /browser and /browser/<tab>).
// The browser's states replace the whole pane; a tab's states sit over its stage and keep the head and the bar.
//
// The tab on screen is the one the URL names; else the one this device showed last, else the newest. A tab that is
// gone gets 5.4's line. New tab opens a local draft at once and focuses the bar's address field inside the press (so
// iOS raises the keyboard); tab_new goes on Go with the address (and on a phone the Phone size), and the server's tab
// takes the draft's place with the same field element (F24). A `url` pre-fill only fills a new tab's field, and only an
// http or https address does (PAGE-B1 2.1; anything else gets 5.4's line). Showing a tab is a replace of the URL. Every
// request goes inside the user's own press.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BrowserTabView } from "../../shared/browser";
import { BROWSER_LIMITS, BROWSER_PHONE } from "../../shared/browser";
import { closeTo, href, navigate, type Route } from "../router";
import { getState, useStore } from "../state/store";
import type { Chat } from "../state/types";
import { useViewport } from "../layout/size";
import { halfClose } from "../layout/split";
import { IconClose, IconPageCrash } from "../ui/icons";
import { Modal } from "../dialogs/Modal";
import { escapeAddress, fieldUrl, pageRefusals, typedAddress } from "./address";
import { Bar } from "./Bar";
import { Chip } from "./Chip";
import { CHIP_WORDS, chipOf, claudeLit, claudeUsing } from "./claude";
import { DialogCard } from "./DialogCard";
import { DownloadLine } from "./Downloads";
import { onEscape } from "./escape";
import { useShowingTab } from "./dot";
import { FileCard } from "./FileCard";
import { FILE_LINES, fileIsClaudes } from "./fileWords";
import { TouchFoot } from "./Keyboard";
import { zoomIn, zoomOut, toFrame } from "./mapping";
import { More } from "./More";
import { chatLinks, isChatLink, keepLastTab, lastTab, PREFILL_REFUSED, prefillOf, routeTab, routeUrl, setChatLinks, tabHrefIn } from "./nav";
import { PickerLayer, pickerShows, type PickAnswer } from "./Pickers";
import { Stage } from "./Stage";
import { HostState } from "./states";
import { addNote, answerDialog, closeNote, dropPicker, followDone, holdLink, noteChooserAnswered, request, useBrowser, viewAgain, type Note } from "./store";
import { stripTabs, TabsSheet, TabStrip, tabTitle } from "./TabStrip";
import { COPY_LINES } from "./copy";
import { IS_MAC } from "../ui/shortcuts";

export type PaneMode = "column" | "pane" | "over" | "page" | "full";

export const GONE_LINE = "That tab is not open any more.";
export const FROM_LINK_LINE = "Address from an external link";
const DRAFT = "draft";

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);
const turnRuns = (chat: string) => {
  const c = getState().chats.find((x) => x.id === chat);
  return c?.state === "running" || c?.state === "waiting";
};

export function BrowserPane({ route, chat, mode, lead }: { route: Route; chat?: Chat; mode: PaneMode; lead?: ReactNode }) {
  const vp = useViewport();
  const b = useBrowser();
  const phone = vp.size === "phone";
  const touch = vp.touch;
  useEffect(() => holdLink(), []);

  // ---- which tab shows
  const asked = routeTab(route);
  const pre = prefillOf(routeUrl(route));
  const prefill = pre && "url" in pre ? pre.url : null;
  const refusedPre = !!pre && "refused" in pre;
  // A chat link's address that waits for Go came from Claude's text here, not from an external link (links.tsx).
  const [draft, setDraft] = useState<{ fromLink: boolean } | null>(prefill ? { fromLink: !isChatLink(prefill) } : null);
  const [refused, setRefused] = useState(refusedPre);
  const known = (id: string | null) => (id ? b.tabs.find((t) => t.id === id) ?? null : null);
  const fallback = known(lastTab()) ?? b.tabs[b.tabs.length - 1] ?? null;
  const tab: BrowserTabView | null = draft ? null : (known(asked) ?? (asked && b.opened ? fallback : asked ? null : fallback));
  const [value, setValue] = useState(() => prefill ?? fieldUrl(tab?.url));
  const [line, setLine] = useState<string | null>(null);
  const gone = !!asked && b.opened && !known(asked) && !draft;
  const shown = draft ? DRAFT : (tab?.id ?? null);
  useEffect(() => {
    if (tab) keepLastTab(tab.id);
  }, [tab?.id]);
  useShowingTab(tab?.id ?? null);
  // A new pre-fill (another link) is a new draft; a refused one is 5.4's line.
  const preKey = prefill ?? (refusedPre ? routeUrl(route) : null);
  const lastPrefill = useRef(preKey);
  useEffect(() => {
    if (preKey === lastPrefill.current) return;
    lastPrefill.current = preKey;
    setRefused(refusedPre);
    if (prefill) {
      setDraft({ fromLink: !isChatLink(prefill) });
      setValue(prefill);
    }
  }, [preKey]);
  // The field shows the tab's address while the user is not typing in it.
  const editing = useRef(false);
  useEffect(() => {
    if (draft || editing.current) return;
    setValue(fieldUrl(tab?.url));
    setLine(null);
  }, [tab?.id, tab?.url, !!draft]);

  const field = useRef<HTMLInputElement>(null);
  const show = useCallback(
    (id: string) => {
      setDraft(null);
      setRefused(false);
      editing.current = false;
      if (id !== DRAFT) navigate(tabHrefIn(route, id), { replace: true });
    },
    [route],
  );
  // A tab that this page's tap opened takes the view (DESIGN-B1 4.9, follow).
  useEffect(() => {
    const f = b.follow;
    if (!f) return;
    followDone();
    if (b.tabs.some((t) => t.id === f.tab)) show(f.tab);
  }, [b.follow, b.tabs, show]);

  const host = b.host;
  const lit = claudeLit(host?.state);
  const strip = useMemo(() => stripTabs(b.tabs, lit ? b.acting : [], lit, draft ? { id: DRAFT } : null), [b.tabs, b.acting, lit, draft]);
  const frameId = `bp-frame-${mode}`;
  const chatUrl = chat ? (halfClose(route) ?? href("chat", { chat: chat.id }, { view: viewOf(route) })) : null;

  // ---- requests
  const newDraft = () => {
    setDraft({ fromLink: false });
    setValue("");
    setLine(null);
    setSheet(false);
    editing.current = true;
    field.current?.focus({ preventScroll: true }); // inside the press: the bar's own field (F24)
  };
  const phoneSize = () => ({ kind: "phone" as const, w: clampN(vp.width, BROWSER_LIMITS.phoneWMin, BROWSER_LIMITS.phoneWMax), h: clampN(vp.height - 44 - 45 - 61, BROWSER_LIMITS.phoneHMin, BROWSER_LIMITS.phoneHMax) });
  const go = async (newTab: boolean) => {
    const r = typedAddress(value, pageRefusals(host?.port ?? null));
    if (!r) return;
    if ("problem" in r) {
      setLine(r.problem);
      return;
    }
    setLine(null);
    editing.current = false;
    if (draft || newTab || !tab) {
      const ack = await request({ t: "tab_new", url: r.url, ...(phone ? { size: phoneSize() } : {}) });
      if (!ack.ok) return setLine(ack.code === "url_refused" ? "That address cannot open in the browser pane." : "The tab did not open. Try again.");
      if (ack.tab) show(ack.tab);
      else setDraft(null);
      field.current?.blur();
      return;
    }
    const ack = await request({ t: "navigate", tab: tab.id, url: r.url });
    if (!ack.ok && ack.code === "url_refused") setLine("That address cannot open in the browser pane.");
    field.current?.blur();
  };
  const [confirm, setConfirm] = useState<{ kind: "close"; tab: BrowserTabView } | { kind: "size"; tab: BrowserTabView; size: "desktop" | "phone" } | null>(null);
  const closeTab = (id: string) => {
    if (id === DRAFT) {
      setDraft(null);
      return;
    }
    const t = known(id);
    if (!t) return;
    if (claudeUsing(t, b.acting, turnRuns)) setConfirm({ kind: "close", tab: t });
    else void request({ t: "tab_close", tab: id });
  };
  const setSize = (kind: "desktop" | "phone", force = false) => {
    if (!tab) return;
    if (!force && claudeUsing(tab, b.acting, turnRuns)) return setConfirm({ kind: "size", tab, size: kind });
    const size = kind === "phone" ? (phone ? { w: phoneSize().w, h: phoneSize().h } : { w: BROWSER_PHONE.w, h: BROWSER_PHONE.h }) : {};
    void request({ t: "tab_size", tab: tab.id, kind, ...size, ...(force ? { force: true } : {}) });
  };
  const back = () => {
    if (!tab) return;
    if (!tab.canBack && tab.opener && known(tab.opener)) {
      const opener = tab.opener;
      void request({ t: "opener", tab: tab.id }).then((a) => a.ok && show(opener));
      return;
    }
    void request({ t: "back", tab: tab.id });
  };
  const backTo = tab && !tab.canBack && tab.opener && known(tab.opener) ? tabTitle(known(tab.opener)!) : null;

  // ---- the local zoom, Move, the keys, the keyboard
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const [moving, setMoving] = useState(false);
  const [keys, setKeys] = useState(false);
  const lastKey = useRef(0);
  const [kbUp, setKbUp] = useState(false);
  const [navInFoot, setNavInFoot] = useState(false);
  const [more, setMore] = useState(false);
  const [sheet, setSheet] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setZoom(null);
    setMoving(false);
  }, [shown]);
  useEffect(() => {
    if (!more) return;
    return onEscape(() => {
      setMore(false);
      return true;
    });
  }, [more]);
  // Esc in the address field over the chat (the layer asks first): Bar's own rule, so it puts the tab's address back
  // while the field holds other text, and is the layer's (it closes) when the field already shows it.
  const onValue = (v: string) => {
    editing.current = true;
    setValue(v);
    setLine(null);
    setRefused(false);
    if (draft?.fromLink) setDraft({ fromLink: false });
  };
  const fieldNow = useRef({ value, tabUrl: draft ? null : (tab?.url ?? null), onValue });
  fieldNow.current = { value, tabUrl: draft ? null : (tab?.url ?? null), onValue };
  useEffect(
    () =>
      onEscape(() => {
        const el = field.current;
        if (!el || document.activeElement !== el) return false;
        const back = escapeAddress(fieldNow.current.value, fieldNow.current.tabUrl);
        if (back === null) return false;
        fieldNow.current.onValue(back);
        requestAnimationFrame(() => el.select());
        return true;
      }),
    [],
  );
  const [links, setLinks] = useState(chatLinks() === "pane");
  const [hiddenAsk, setHiddenAsk] = useState(false);
  const [, bump] = useState(0);

  // ---- the chip
  const chip = chipOf({ acting: b.held, shown: tab?.id ?? null, besideChat: chat?.id ?? null, hostState: host?.state });
  const [said, setSaid] = useState("");
  useEffect(() => setSaid(chip ? CHIP_WORDS.said : ""), [!!chip]);
  const chipNode = (narrow: boolean) => (chip ? <Chip chip={chip} narrow={narrow} onShowTab={show} /> : null);
  const probes = chip ? (
    <>
      <Chip chip={chip} narrow={false} onShowTab={show} measure="long" />
      <Chip chip={chip} narrow onShowTab={show} measure="narrow" />
    </>
  ) : null;

  // ---- the head
  const closeBrowser =
    mode === "full" || mode === "page" ? null : (
      <button type="button" className="icon-btn bp-head-end" aria-label="Close browser" title={touch ? undefined : `Close browser (${IS_MAC ? "Cmd" : "Ctrl"}+Shift+B)`} onClick={() => closeTo(chatUrl ?? "/")} data-testid="browser-close">
        <IconClose />
      </button>
    );

  // ---- the states that replace the pane
  if (!b.opened || !host)
    return (
      <section className="bp" aria-label="Browser" data-testid="browser-pane" data-state="connecting">
        {mode === "over" ? <div className="bp-head">{closeBrowser}</div> : null}
        <div className="bp-empty">{b.link === "down" ? <span className="bp-pill" role="status">Reconnecting...</span> : null}</div>
      </section>
    );
  if (host.state !== "running") return <HostState host={host} head={mode === "over" ? <div className="bp-head">{closeBrowser}</div> : undefined} />;

  const notes = b.notes.filter((n) => n.tab === null || n.tab === tab?.id);
  const download = b.downloads[0] && !dismissed.has(b.downloads[0].id) && Date.parse(b.downloads[0].at) > bootAt ? b.downloads[0] : null;
  const dialog = tab ? b.dialogs[tab.id] : undefined;
  const chooser = tab ? b.choosers[tab.id] : undefined;
  const picker = tab ? b.pickers[tab.id] : undefined;
  const sibling = tab?.hidden ? (b.tabs.find((t) => t.opener === tab.id && !t.hidden) ?? known(tab.opener) ?? b.tabs.find((t) => t.id !== tab.id && !t.hidden) ?? null) : null;
  const reconnecting = b.link !== "open";

  const strips =
    phone ? null : (
      <TabStrip tabs={strip} open={shown} touch={touch} frameId={frameId} onShow={show} onClose={closeTab} onNew={newDraft} end={closeBrowser} lead={lead} />
    );
  const showHidden = () => {
    if (!tab) return;
    if (sibling && claudeUsing(sibling, b.acting, turnRuns)) setHiddenAsk(true);
    else viewAgain(tab.id);
  };

  const over: ReactNode[] = [];
  if (tab?.crashed)
    over.push(
      <div key="crash" className="bp-over is-solid" data-testid="browser-crashed">
        <span className="bp-empty-icon">
          <IconPageCrash size={28} />
        </span>
        <h2 className="bp-empty-title">This page crashed</h2>
        <button type="button" className="btn" onClick={() => void request({ t: "reload", tab: tab.id })}>
          Reload
        </button>
      </div>,
    );
  else if (tab && b.full === tab.id)
    over.push(
      <div key="full" className="bp-over is-solid" data-testid="browser-full-viewers">
        <p className="bp-empty-line">This tab shows on too many devices. Close it on one of them, then try again.</p>
        <button type="button" className="btn" onClick={() => viewAgain(tab.id)}>
          Try again
        </button>
      </div>,
    );
  else if (tab?.hidden)
    over.push(
      <div key="hidden" className="bp-over" data-testid="browser-hidden">
        <span className="bp-pill" role="status">
          This tab is behind {sibling ? tabTitle(sibling) : "another tab"}.
        </span>
        <button type="button" className="btn" onClick={showHidden}>
          Show
        </button>
      </div>,
    );
  else if (reconnecting)
    over.push(
      <div key="re" className="bp-over">
        <span className="bp-pill" role="status">
          Reconnecting...
        </span>
      </div>,
    );
  // A dialog or a chooser stays open in the browser while the socket reconnects, so its card stays (an answer waits).
  if (dialog)
    over.push(
      <DialogCard key={`d${dialog.id}`} d={dialog} phone={phone} touch={touch} frameHadKeys={keys} lastKeyAt={lastKey.current} onAnswer={(accept, text) => void answerDialog(dialog, accept, text)} />,
    );
  else if (chooser)
    over.push(
      <FileCard
        key={`c${chooser.id}`}
        c={chooser}
        chat={chat?.id ?? null}
        phone={phone}
        onCancel={() => (noteChooserAnswered(chooser), void request({ t: "chooser_cancel", tab: chooser.tab, id: chooser.id }))}
        onLeave={() => (noteChooserAnswered(chooser), void request({ t: "chooser_leave", tab: chooser.tab, id: chooser.id }))}
        onFiles={async (uploads) => {
          noteChooserAnswered(chooser);
          const a = await request({ t: "chooser_answer", tab: chooser.tab, id: chooser.id, uploads });
          if (a.ok && tab && (fileIsClaudes(chooser) || claudeUsing(tab, b.acting, turnRuns))) addNote(tab.id, FILE_LINES.told, 8_000);
          return a.ok;
        }}
      />,
    );
  if (notes.length || download || b.slow)
    over.push(
      <div key="notes" className="bp-notes">
        {download ? (
          <DownloadLine
            d={download}
            onClose={() => {
              dismissed.add(download.id);
              bump((x) => x + 1);
            }}
          />
        ) : null}
        {notes.map((n) => (
          <NoteLine key={n.id} n={n} />
        ))}
        {b.slow ? (
          <div className="bp-note" role="status" data-testid="browser-slow">
            <span className="bp-note-text">Slow connection</span>
          </div>
        ) : null}
      </div>,
    );

  const pick = (a: PickAnswer) => {
    if (!picker) return;
    dropPicker(picker.tab, picker.id);
    void request({ t: "pick", tab: picker.tab, id: picker.id, ...a } as Parameters<typeof request>[0]);
  };
  const cancelPick = () => {
    if (!picker) return;
    dropPicker(picker.tab, picker.id);
    void request({ t: "pick_cancel", tab: picker.tab, id: picker.id });
  };
  const focus = tab ? (b.focus[tab.id] ?? null) : null;

  return (
    <section className={`bp bp-mode-${mode}`} aria-label="Browser" data-testid="browser-pane" data-state="running" data-tab={shown ?? ""}>
      {strips}
      <Bar
        ref={field}
        url={fieldUrl(tab?.url)}
        value={value}
        onValue={onValue}
        onGo={(n) => void go(n)}
        canBack={!!tab?.canBack}
        canForward={!!tab?.canForward}
        backTo={backTo}
        loading={!!tab?.loading}
        idle={!tab}
        onBack={back}
        onForward={() => tab && void request({ t: "forward", tab: tab.id })}
        onReload={(nocache) => tab && void request({ t: "reload", tab: tab.id, ...(nocache ? { nocache: true } : {}) })}
        onStop={() => tab && void request({ t: "stop", tab: tab.id })}
        chip={chipNode}
        probes={probes}
        hasChip={!!chip && !phone}
        moreOpen={more}
        onMore={() => setMore((m) => !m)}
        moreRef={moreBtn}
        touch={touch}
        phone={phone}
        onNavInFoot={setNavInFoot}
        more={
          <More
            open={more}
            onClose={() => setMore(false)}
            anchor={moreBtn}
            tab={tab}
            onSize={(k) => setSize(k)}
            zoom={zoom}
            canZoomIn={zoomIn(zoom, fit) !== zoom}
            onZoomIn={() => setZoom(zoomIn(zoom, fit))}
            onZoomOut={() => setZoom(zoomOut(zoom, fit))}
            moving={moving}
            onMove={setMoving}
            fullHref={tab && mode !== "full" && mode !== "page" ? href("browserTab", { tab: tab.id }) : null}
            downloads={b.downloads}
            links={links}
            onLinks={(on) => {
              setChatLinks(on ? "pane" : "tab");
              setLinks(on);
            }}
          />
        }
      />
      {phone && chip ? <PhoneChip>{chipNode(false)}</PhoneChip> : null}
      {draft?.fromLink && value === prefill ? (
        <p className="bp-line" role="status" data-testid="browser-from-link">
          {FROM_LINK_LINE}
        </p>
      ) : null}
      {line || gone || refused ? (
        <p className="bp-line" role="status" data-testid="browser-line">
          {line ?? (gone ? GONE_LINE : PREFILL_REFUSED)}
        </p>
      ) : null}
      {tab ? (
        <Stage
          key={tab.id}
          tab={tab}
          size={vp.size}
          touch={touch}
          phone={phone}
          frameId={frameId}
          title={tabTitle(tab)}
          zoom={zoom}
          onZoom={setZoom}
          moving={moving}
          onMoving={setMoving}
          onKeys={setKeys}
          onKeySent={() => (lastKey.current = Date.now())}
          onLeave={() => field.current?.focus()}
          onFit={setFit}
          keyboardUp={kbUp}
          focus={focus}
          inert={reconnecting || !!tab.crashed || !!dialog}
          dim={reconnecting || !!tab.hidden}
          inFrame={(facts, boxW, stage) =>
            picker && pickerShows(picker, touch, true) ? (
              <PickerLayer p={picker} anchor={offset(toFrame(picker.box, boxW, facts), stage)} stage={stage} phone={phone} touch={touch} onPick={pick} onCancel={cancelPick} />
            ) : null
          }
          over={over}
        />
      ) : b.tabs.length || draft ? (
        <div className="bp-stage" data-testid="browser-stage" />
      ) : (
        <div className="bp-empty" data-testid="browser-no-tabs">
          <h2 className="bp-empty-title">No tabs are open</h2>
          <div className="bp-empty-actions">
            <button type="button" className="btn" onClick={newDraft}>
              New tab
            </button>
          </div>
        </div>
      )}
      {touch ? (
        <TouchFoot
          tab={tab?.id ?? null}
          phone={phone}
          nav={navInFoot}
          canBack={!!tab && (tab.canBack || !!backTo)}
          canForward={!!tab?.canForward}
          backName={backTo ? `Back to ${backTo}` : "Back"}
          onBack={back}
          onForward={() => tab && void request({ t: "forward", tab: tab.id })}
          tabs={b.tabs.length}
          onTabs={() => setSheet(true)}
          focus={focus}
          up={kbUp}
          onUp={setKbUp}
          onTyped={() => (lastKey.current = Date.now())}
        />
      ) : null}
      {phone ? <TabsSheet open={sheet} tabs={strip} shown={shown} onClose={() => setSheet(false)} onShow={(id) => (setSheet(false), show(id))} onCloseTab={closeTab} onNew={newDraft} /> : null}
      {confirm ? <Confirm c={confirm} onCancel={() => setConfirm(null)} onClose={(t) => (setConfirm(null), void request({ t: "tab_close", tab: t.id, force: true }))} onSize={(k) => (setConfirm(null), setSize(k, true))} /> : null}
      {hiddenAsk && tab && sibling ? (
        <Modal title={`Claude is using ${tabTitle(sibling)}. Show this tab anyway?`} testId="browser-show-confirm" onClose={() => setHiddenAsk(false)} confirm>
          <div className="dialog-actions">
            {!phone ? (
              <button type="button" className="btn" onClick={() => setHiddenAsk(false)}>
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setHiddenAsk(false);
                viewAgain(tab.id);
              }}
            >
              Show tab
            </button>
          </div>
        </Modal>
      ) : null}
      <span className="visually-hidden" role="status">
        {said}
      </span>
    </section>
  );
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
/** A box on the frame, moved to the stage's scrolled content (the frame's own place in it). */
const offset = (b: { x: number; y: number; w: number; h: number }, at: { left: number; top: number }) => ({ ...b, x: b.x + at.left, y: b.y + at.top });
/** The downloads the user closed the line of, on this page; and the page's start (older downloads show only in More). */
const dismissed = new Set<string>();
const bootAt = Date.now() - 60_000;

function NoteLine({ n }: { n: Note }) {
  const touch = useViewport().touch;
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (n.kind === "copy") field.current?.select();
  }, [n.id, n.kind]);
  return (
    <div className={`bp-note${n.kind === "copy" ? " is-copy" : ""}`} role="status" data-testid={`browser-note-${n.kind}`}>
      <span className="bp-note-text">{n.text}</span>
      {n.kind === "copy" ? (
        <>
          <input ref={field} className="field" readOnly value={n.held ?? ""} aria-label="The text to copy" />
          <span className="bp-note-text dim">{COPY_LINES.again(IS_MAC, touch)}</span>
        </>
      ) : null}
      <button type="button" className="icon-btn" aria-label="Close" onClick={() => closeNote(n.id)}>
        <IconClose size={14} />
      </button>
    </div>
  );
}

function Confirm({ c, onCancel, onClose, onSize }: { c: { kind: "close"; tab: BrowserTabView } | { kind: "size"; tab: BrowserTabView; size: "desktop" | "phone" }; onCancel: () => void; onClose: (t: BrowserTabView) => void; onSize: (k: "desktop" | "phone") => void }) {
  const phone = useViewport().size === "phone";
  const title = c.kind === "close" ? "Claude is using this tab. Close it anyway?" : "Claude is using this tab. Change its size for Claude too?";
  return (
    <Modal title={title} testId="browser-confirm" onClose={onCancel} confirm>
      <div className="dialog-actions">
        {!phone ? (
          <button type="button" className="btn" onClick={onCancel} data-autofocus>
            Cancel
          </button>
        ) : null}
        <button type="button" className="btn primary" onClick={() => (c.kind === "close" ? onClose(c.tab) : onSize(c.size))} data-testid="browser-confirm-go">
          {c.kind === "close" ? "Close tab" : "Change size"}
        </button>
      </div>
    </Modal>
  );
}

/** The phone's chip sits in its title bar, at the right (PAGE 2.2, P1). */
function PhoneChip({ children }: { children: ReactNode }) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const probe = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const shell = probe.current?.closest(".shell");
    setBar(shell?.querySelector<HTMLElement>(':scope > [data-testid="topbar"]') ?? null);
  }, []);
  return (
    <>
      <span ref={probe} hidden />
      {bar ? createPortal(children, bar) : null}
    </>
  );
}

