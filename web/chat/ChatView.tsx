// The conversation (DESIGN.md 6.2 and 6.3): the column of messages, blocks and records in the chosen transcript view,
// and below it the waiting card, which takes the composer's place. Every block route opens its block in place and
// scrolls to it; /m/<message> highlights one row; a card route focuses the card. Opening a block pushes its route,
// closing it goes back to the chat path, and Ctrl+O cycles the view in place (replaceState). A link never acts.
// While a card waits, Esc stops the turn, which answers every waiting card as dismissed (6.3, 6.11). On touch, a card
// whose field has the focus rides the on-screen keyboard, as the composer does (7.8). U2 (DESIGN-U2): a finished
// turn folds to one line above its answer (chat/turns.ts), drawn folded and kept open where this page watched it end
// (chat/turnOpen.ts); a link into a folded turn opens it; the reader's place stays put (chat/anchor.ts). U3
// (DESIGN-U3): on a laptop with room beside the text, the turn rail (chat/TurnRail.tsx, chat/rail.ts), one mark per
// turn; a /m/ route to a turn's target row lands the turn's top near the scroller's top, Back after a mark's link puts
// the reader's place back, and the CLI's `{` and `}` go to the turn before or after. U5 (DESIGN-U5 9): a /m/ route
// with `mark` (a Messages pick) marks the query's words in that row as Find marks them (chat/marks.ts), centring the
// first mark of a row taller than the view; a /m/ row older than the loaded pages reads the older pages until it is
// there (chat/older.ts), with "Loading earlier messages…" meanwhile.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cameByHistory, closeSteps, closeTo, currentUrl, href, navigate, type EntryState, type Route } from "../router";
import { useViewport } from "../layout/size";
import { useFocusInside, useSoftKeyboard } from "../composer/keyboard";
import { act, commandRowsOf, restartHoldsQueue, useStore } from "../state/store";
import { sendNowPlace } from "../state/sendNow";
import type { AgentItem, Chat, Item } from "../state/types";
import { CARD_ROUTES, COMPOSER_ROUTES, WaitingCard, archivedLinePath, routedCardOf } from "./cards/WaitingCard";
import { LINE_GONE, answerFirstLine, cardLinkLine } from "./cards/labels";
import { VIEWS, VIEW_LABEL, cardCalls, cardCallsKey, cardStandsFor, findItem, findRouteRow, foldItems, hasThinking, hiddenIn, nextView, type CardCalls, type Entry, type View } from "./fold";
import { ROW_PARAM, carryRows, chatRowsKey, entryTrail, isRowRoute, openRowsKey } from "./openRows";
import { ConversationShownProvider, TranscriptProvider, type BlockRoute, type Transcript } from "./items/context";
import { entryNode } from "./items/Entries";
import { TurnLine, TurnWork } from "./items/Turn";
import { drawnParts, layoutCache, shareBlocks, turnList, turnsOf, type Block, type Turn, type TurnLayout } from "./turns";
import { foldNow, newWatch, noteRunsOn, readChoices, sessionStore, turnOpen, watchedOpen, writeChoice, type Watch } from "./turnOpen";
import { anchorElement, anchorShift, readAnchor, type Anchor, type AnchorRoot } from "./anchor";
import { LAND_TOP, currentTurn, keptPlace, railCard, railFit, railJump, railKey, railMarks, railShows, railSpots, readingLine, stepTo, turnStep, turnsOpenedBy, type RailMark, type RailTop } from "./rail";
import { TurnRail, type RailApi, type RailHooks } from "./TurnRail";
import { composingKey, ownScroll } from "../ui/primitives";
import { IconDown } from "./items/icons";
import { WorkingMark } from "./items/Text";
import { chatLinkLine } from "../ui/LinkNotice";
import { useArrivals } from "./arrivals";
import { refusedRow, trustRows } from "./trust";
import { TrustLines } from "./items/TrustLine";
import { bgRows } from "./background";
import { BackgroundLines } from "./items/BackgroundLine";
import { NEAR_BOTTOM, followedTo, newFollow, onKey, onScrolled, onTouchEnd, onTouchMove, onTouchStart, onWheel } from "./follow";
import { leaveAfter, leaveBy, onOwnSend, sendLeaves } from "./ownSend";
import { conversationShows } from "./seen";
import { canMark, centreDelta, clearMarks, markRow, showMarks } from "./marks";
import { LOADING_EARLIER, olderStep } from "./older";
import { ChangesCard } from "../changes/ChangesCard";
import { CHANGES_WORDS, cardItemId, changesByTurn } from "../changes/model";
import { CHANGES_ROUTES, changesLanding, changesShown } from "../changes/nav";
import { useSplitLive } from "../layout/split";

const BLOCK_PARAM: Record<BlockRoute, "toolUse" | "message"> = { tool: "toolUse", agent: "toolUse", workflow: "toolUse", thinking: "message" };

// What the reader opened or closed beyond the URL's own block, per openRowsKey: each row route's path, so Back and
// Forward bring each entry's open rows back with it, and the chat's path for every other route of the chat (with the
// row route a closed picker or menu came from, so its carried rows leave the chat's earlier entry alone). View state
// only: nothing here reaches the store.
const SNAPSHOTS = new Map<string, ReadonlyMap<string, boolean>>();
const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();
const NONE: ReadonlySet<string> = new Set();
const NO_MARKS: NonNullable<Chat["marks"]> = [];

/** U2: a turn's key among the open rows (ChatView's forced set and the entry's snapshot): never a row's id. */
const turnKey = (id: string) => `turn:${id}`;
/** A row whose control can hold the keyboard focus (a row by its id, a summary row by its test id), and those controls. */
const FOCUS_ROW = '[data-item-id], [data-testid^="summary-"]';
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function viewOf(route: Route): View {
  const v = route.query.view;
  return typeof v === "string" && (VIEWS as readonly string[]).includes(v) ? (v as View) : "normal";
}

/**
 * U3: the scroller's visible top and its scroll padding there: in the glass look the conversation scrolls under the
 * title bar, and the scroller's padding and scroll padding are the bar's height (layout.css --under-bar), so a jump
 * lands below the bar, not under it.
 */
function underBar(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).scrollPaddingTop) || 0;
}
const visibleTop = (el: HTMLElement): number => el.getBoundingClientRect().top + underBar(el);

/** U3: whether the scroller's gutters are on both sides (chat.css), for the room beside the text (rail.ts railFit). */
const BOTH_GUTTERS = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("scrollbar-gutter", "stable both-edges");

/** U3: the place this entry of the tab's history keeps for Back (EntryState.place), if any. */
function entryPlace(): Anchor | "end" | null {
  const st = typeof history !== "undefined" ? (history.state as EntryState | null) : null;
  return st?.place === undefined ? null : keptPlace(st.place);
}

/** U3: the entry forgets its place (the reader moved from it, so Back or a reload must not put an old one back). */
function dropPlace() {
  const st = typeof history !== "undefined" ? (history.state as EntryState | null) : null;
  if (!st || st.place === undefined) return;
  const { place: _gone, ...rest } = st;
  history.replaceState(rest, "");
}

/** Scroll a row into the scroller only (scrollIntoView could also move the shell's hidden-overflow ancestors). */
function scrollRow(scroller: HTMLElement, el: HTMLElement, center: boolean) {
  const s = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (center) scroller.scrollTop += r.top - s.top - Math.max(0, (s.height - r.height) / 2);
  else if (r.top < s.top) scroller.scrollTop += r.top - s.top - 12;
  else if (r.bottom > s.bottom) scroller.scrollTop += Math.min(r.bottom - s.bottom + 12, r.top - s.top - 12);
}

/** U2: what the column draws, in order: a run of rows outside every turn, or a turn as the view lays it out. */
type Unit = { k: "rows"; entries: Entry[] } | { k: "turn"; l: TurnLayout };

function drawUnits(blocks: readonly Block[], view: View, reveal: ReadonlySet<string>, calls: CardCalls, layoutOf: (t: Turn, view: View, reveal: ReadonlySet<string>, calls: CardCalls) => TurnLayout): Unit[] {
  const out: Unit[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length) out.push({ k: "rows", entries: foldItems(run, view, reveal, calls) });
    run = [];
  };
  for (const b of blocks) {
    if (b.k === "row") {
      run.push(b.item);
      continue;
    }
    flush();
    out.push({ k: "turn", l: layoutOf(b.turn, view, reveal, calls) });
  }
  flush();
  return out;
}

export function ChatView({ chat, route, gone = null }: { chat: Chat; route: Route; gone?: string | null }) {
  // S1: the store's chat, whose reply grows piece by piece; the screen around it keeps the one it drew (state/steady.ts).
  const live = useStore((s) => s.chats.find((c) => c.id === chat.id)) ?? chat;
  // Each chat starts with its own scroll, open rows and notes.
  return <Conversation key={chat.id} chat={live} route={route} gone={gone} />;
}

function Conversation({ chat, route, gone }: { chat: Chat; route: Route; gone: string | null }) {
  const project = useStore((s) => s.projects.find((p) => p.id === chat.projectId)?.name ?? "this project");
  const rawView = typeof route.query.view === "string" ? route.query.view : undefined;
  const view = viewOf(route);
  // Row 79: before the rows draw, whether this draw is a load (its text shows at once) or live events (a reply's words
  // reveal, a message that came enters).
  useArrivals(chat.id, chat.items, chat.loaded);

  // ---- the row a route names ----
  const rowRoute = isRowRoute(route);
  const param = rowRoute ? ROW_PARAM[route.name] : undefined;
  const targetId = param ? route.params[param] : undefined;
  const found = useMemo(() => (targetId ? findRouteRow(chat.items, route.name, targetId) : null), [chat.items, route.name, targetId]);
  const onMessage = route.name === "message";
  const openId = found && !onMessage ? found.item.id : undefined;
  // The row this route showed at the last render: when it leaves the chat while the route still names it (Take back
  // on a queued message), the reader's own action removed it, so the link is simply stale, not a link to a gone row.
  const rowBefore = useRef<string | undefined>(undefined);
  const rowLeft = !!targetId && !found && rowBefore.current === targetId;
  // U5: a /m/ row that is not in the loaded pages: the older pages, one after another (chat/older.ts).
  // U1 (DESIGN-U1 8.4): on the phone a changes route is the chat at that turn's card line, looked for in the older pages
  // first, as a /m/ row is (U5's rule); "These changes are no longer kept." once none is left. U1 review: on the laptop
  // and the tablet a changes route entered from outside the page (its first load, a reload, Back or Forward, a link
  // from another screen) also brings its card into view, unmarked, so the panel's list or diff is next to its turn; one
  // that the card's own row or the panel's list opened keeps the reader's place.
  const phone = useViewport().size === "phone";
  const changesAt = CHANGES_ROUTES.has(route.name) ? `${route.params.turn ?? ""}/${route.params.path ?? ""}` : "";
  const entered = useRef<{ at: string; outside: boolean } | null>(null);
  if (entered.current === null || entered.current.at !== changesAt) entered.current = { at: changesAt, outside: entered.current === null || cameByHistory() };
  const enteredFromOutside = entered.current.outside;
  const landing = changesLanding(route, phone, enteredFromOutside);
  const landed = !!landing && !!chat.changes?.some((c) => c.id === landing);
  const want = onMessage && targetId ? targetId : landing ? `changes:${landing}` : "";
  const [olderRun, setOlderRun] = useState({ target: "", pages: 0, busy: false, failed: false });
  const run = olderRun.target === want ? olderRun : { target: want, pages: 0, busy: false, failed: false };
  const older = olderStep({ onMessage: onMessage || !!landing, target: !!targetId || !!landing, found: landing ? landed : !!found, loaded: chat.loaded, more: chat.more, pages: run.pages, busy: run.busy, failed: run.failed });
  const earlier = older === "load" || older === "loading";
  useEffect(() => {
    if (older !== "load") return;
    setOlderRun({ ...run, busy: true });
    void act.loadOlder(chat.id).then((ok) => setOlderRun((o) => (o.target === want ? { ...o, busy: false, pages: o.pages + 1, failed: o.failed || !ok } : o)));
    // A new step after each page (`pages`), or for another row (`want`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [older, want, run.pages]);

  // ---- the waiting card, and the 5.4 lines for a card link that no longer waits ----
  const requestId = CARD_ROUTES.has(route.name) ? route.params.request : undefined;
  const routedCard = routedCardOf(chat, route);
  // The card this route showed waiting at the last render: when it leaves the queue while the route still names it
  // (the reader answered it, or a stop dismissed it), the link is simply stale, not a link to something gone.
  const routedBefore = useRef<string | undefined>(undefined);
  const justAnswered = !!requestId && !routedCard && routedBefore.current === requestId;
  // Else 5.4's line (labels.ts cardLinkLine): a request id of another kind (/question/ on a permission request) is a
  // path that does not parse, an answered one scrolls to its record, a lost one says so, and any other id names no
  // cause. No card is focused or pre-filled by such a path.
  const stale = requestId && !routedCard && !justAnswered ? cardLinkLine(chat, route.name, requestId) : null;
  const record = stale?.record;
  const card = routedCard ?? chat.pending[0];
  // R127: the Trust this folder confirm's path names a refused row of the chat; one that is not there, or whose result
  // holds no refusal, gives the chat at its end with 5.4's line (once the history is drawn). On an archived chat the
  // composer's place says "This chat is archived." instead (archivedLinePath).
  const trustGone = route.name === "trust" && !chat.archived && chat.loaded && !refusedRow(chat.items, route.params.toolUse ?? "");
  // On an archived chat the composer's place says "This chat is archived." for a card path (5.4): one line only.
  // R131: a background session's view route that gave way to the chat brings its own line (BackgroundScreen).
  const line = gone ?? (phone && landing && !landed && older === "gone" ? CHANGES_WORDS.notKept : earlier ? LOADING_EARLIER : older === "wait" ? null : (targetId && !found && !rowLeft) || trustGone ? LINE_GONE : chat.archived && requestId ? null : (stale?.line ?? null));
  // The one 5.4 line above the conversation (principle 0): the line about the path's own target alone, none when the
  // archived composer says it, a held chat's composer says the session is open elsewhere (row 80), or the card path's
  // card does not wait, else the router's line for a link not read in full.
  const linkLine = chatLinkLine(route, line, (chat.archived && archivedLinePath(route)) || (!!chat.held && COMPOSER_ROUTES.has(route.name)) || (!!requestId && !routedCard));
  const highlightId = (found && onMessage ? found.item.id : record?.id) ?? (phone && landed ? cardItemId(landing!) : undefined);
  const scrollId = found?.item.id ?? record?.id ?? (landed ? cardItemId(landing!) : undefined);
  // Row 111: Send now shows under the last queued message only, and after this page's press keeps its place (sendNow.ts).
  const pressed = useStore((s) => s.sendNowPressed[chat.id]);
  const restartWaits = useStore(restartHoldsQueue);
  const nowAt = sendNowPlace(chat, pressed, restartWaits);
  const sendNowId = nowAt?.id;
  const sendNowPressed = !!nowAt?.pressed;

  // The calls a card stands for: no row repeats the card, and none says it runs while the card waits. The same sets
  // while only text streams, so the rows that did not change do not draw again.
  const freshCalls = cardCalls(chat.items, chat.pending);
  const callsKey = cardCallsKey(freshCalls);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const calls = useMemo(() => freshCalls, [callsKey]);

  // A row that a link names shows in any view: a thinking block in Normal, a hook row or an info-level line outside
  // Verbose, a call that a card stands for.
  const revealId = found && (hiddenIn(found.item, "normal") || hiddenIn(found.item, "thinking") || cardStandsFor(found.item, calls)) ? found.item.id : "";
  const reveal = useMemo(() => (revealId ? new Set([revealId]) : NONE), [revealId]);
  // U2: the conversation as turns, and each turn as this view draws it (its line, its work, its answer).
  const marks = chat.marks ?? NO_MARKS;
  const runsTurn = chat.turn !== null || chat.serverState === "running" || chat.serverState === "waiting" || chat.held?.kind === "finishing";
  const cardWaits = chat.pending.length > 0;
  const partial = chat.more !== null;
  // S1: a turn that did not change keeps its object and its layout (turns.ts shareBlocks, layoutCache), so it is drawn once.
  const sharedBlocks = useRef<Block[] | null>(null);
  const layoutFor = useRef(layoutCache()).current;
  const blocks = useMemo(() => (sharedBlocks.current = shareBlocks(sharedBlocks.current, turnsOf(chat.items, marks, { running: runsTurn, waiting: cardWaits, partial }))), [chat.items, marks, runsTurn, cardWaits, partial]);
  const units = useMemo(() => drawUnits(blocks, view, reveal, calls, layoutFor), [blocks, view, reveal, calls, layoutFor]);
  // R127: the rows that carry the Trust this folder line: the newest refused row of each folder in the last turn; none
  // in an archived chat, which is read-only. The same map while only text streams, so the rows do not draw again.
  const freshTrust = useMemo(() => (chat.archived ? null : trustRows(blocks)), [blocks, chat.archived]);
  const trustKey = freshTrust ? [...freshTrust.values()].map((r) => `${r.id} ${r.root ?? ""} ${r.path}`).join("\n") : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trust = useMemo(() => (freshTrust?.size ? freshTrust : undefined), [trustKey]);
  // R131: the rows that carry a background session's line: the newest launch row of each id, in every turn (a live
  // fact); none in an archived chat, which is read-only. The same map while only text streams.
  const freshBg = useMemo(() => (chat.archived ? null : bgRows(chat.items)), [chat.items, chat.archived]);
  const bgKey = freshBg ? [...freshBg.values()].flat().map((r) => `${r.toolUse} ${r.id} ${r.idle ? 1 : 0} ${r.name ?? ""}`).join("\n") : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const background = useMemo(() => (freshBg?.size ? freshBg : undefined), [bgKey]);

  // ---- U2's turns, and U3's turn rail marks (rail.ts): the turns as this view lays them out. Drawn again only when a
  // turn, its state, its target or `partial` changes, never for a streamed reply's text; the names are worked out
  // then. The marks' targets also say where a /m/ route lands (at the top) on every size, rail or none. ----
  const turns = useMemo(() => turnList(blocks), [blocks]);
  // U1 (DESIGN-U1 6): each turn's changes card, under its answer; the head or the row whose view the side panel shows
  // is marked (where the split shows, either half; over the chat, the URL's own view).
  const cards = useMemo(() => changesByTurn(turns, chat.changes), [turns, chat.changes]);
  const splitLive = useSplitLive();
  const shownChanges = phone ? null : changesShown(route, splitLive);
  const layoutOf = useMemo(() => new Map(units.flatMap((u) => (u.k === "turn" ? [[u.l.turn.id, u.l] as const] : []))), [units]);
  const spots = useMemo(() => railSpots(turns, (t) => layoutOf.get(t.id)), [turns, layoutOf]);
  /** The mark whose jump this /m/ route is: it lands its turn at the top, and on a folded turn's line opens nothing. */
  const railHit = found ? railJump(spots, found.item.id, onMessage) : undefined;

  // The containers around the named row: its subagent blocks, the summary row that folds it in this view, and the
  // folded turn whose work holds it. Review U3: none for a mark's jump onto a folded turn's line (FIX-U3 1).
  const forcedKey = useMemo(() => {
    if (!found) return "";
    // Not even a summary inside the folded work: the turn's line stands for the row.
    if (railHit && railHit.top.attr === "data-turn-id") return "";
    const ids = [...found.parents];
    const parent = found.parents.length ? findItem(chat.items, found.parents[found.parents.length - 1]!)?.item : undefined;
    const entries = parent ? foldItems((parent as AgentItem).rows, view, reveal, calls) : units.flatMap((u) => (u.k === "rows" ? u.entries : u.l.parts.flatMap((p) => p.entries)));
    for (const e of entries) if (e.type === "summary" && e.items.some((i) => i.id === found.item.id)) ids.push(e.id);
    for (const id of turnsOpenedBy(layoutOf.values(), found.parents[0] ?? found.item.id, railHit)) ids.push(turnKey(id));
    return ids.join(" ");
  }, [found, chat.items, view, reveal, calls, units, layoutOf, railHit]);
  const forced = useMemo(() => (forcedKey ? new Set(forcedKey.split(" ")) : NONE), [forcedKey]);

  // ---- open state that follows the URL ----
  const [, bump] = useState(0);
  const pathKey = openRowsKey(route, chat.id, entryTrail(history.state));
  const chatUrl = href("chat", { chat: chat.id }, { view: rawView });
  const ownNav = useRef(false);
  // Rows open because of the URL stay open when the URL moves on: when the reader closes the URL's block, opens
  // another block, or opens a picker, a menu, a dialog or a side detail over a row route (those share the chat's key).
  const urlOpen = useMemo(() => [openId, ...forced].filter((x): x is string => !!x), [openId, forced]);
  // The row route of the last render, if any; read when the next route is one of those over it (not the chat
  // itself: going back to the chat closes what the row route's URL opened, as Back should).
  const rowTrail = useRef<{ key: string; urlOpen: string[] } | null>(null);
  const leaving = !rowRoute && route.name !== "chat" ? rowTrail.current : null;
  const carried = useMemo(() => (leaving ? carryRows(SNAPSHOTS.get(leaving.key), leaving.urlOpen) : null), [leaving]);
  const overrides = carried ?? SNAPSHOTS.get(pathKey) ?? NO_OVERRIDES;
  useLayoutEffect(() => {
    if (carried) SNAPSHOTS.set(pathKey, carried);
    rowTrail.current = rowRoute ? { key: pathKey, urlOpen } : null;
  });

  const ctx = useMemo<Transcript>(() => {
    const isOpen = (id: string, byDefault: boolean) => {
      if (id === openId) return true;
      const o = overrides.get(id);
      return o ?? (forced.has(id) || byDefault);
    };
    const toggle = (id: string, block: BlockRoute | null, open: boolean) => {
      // From the newest snapshot, so two toggles before the next render both count.
      const now = SNAPSHOTS.get(pathKey) ?? overrides;
      if (!open && block) {
        const next = carryRows(now, urlOpen);
        next.delete(id);
        const params = { chat: chat.id, [BLOCK_PARAM[block]]: id };
        SNAPSHOTS.set(href(block, params), next);
        ownNav.current = true;
        navigate(href(block, params, { view: rawView }));
        return;
      }
      if (open && id === openId) {
        const next = carryRows(now, urlOpen);
        next.set(id, false);
        // Under the key of the entry closeTo lands on: one it goes back to keeps the trail behind it, a replace this one's.
        const trail = entryTrail(history.state);
        const steps = closeSteps(history.state as EntryState | null, currentUrl(), chatUrl);
        SNAPSHOTS.set(chatRowsKey(chat.id, steps > 0 ? trail.slice(steps) : trail), next);
        ownNav.current = true;
        closeTo(chatUrl);
        return;
      }
      const next = new Map(now);
      next.set(id, !open);
      SNAPSHOTS.set(pathKey, next);
      bump((n) => n + 1);
    };
    return {
      chatId: chat.id,
      view,
      readOnly: false,
      openId,
      highlightId,
      sendNowId,
      sendNowPressed,
      reveal,
      calls,
      trust,
      background,
      isOpen,
      toggle,
    };
  }, [chat.id, view, rawView, openId, highlightId, sendNowId, sendNowPressed, reveal, calls, trust, background, forced, urlOpen, overrides, pathKey, chatUrl]);

  // ---- scrolling: follow the end while the reader is at it, else offer Jump to latest (follow.ts: any move toward
  // the start leaves the end at once; a move back near it follows again) ----
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(newFollow()).current;
  const [jump, setJump] = useState(false);

  // ---- U2: each finished turn folded or open (turnOpen.ts): the entry's own toggle, a link into the turn, the
  // reader's choice on this device, then the timing rule (drawn folded; open where this page watched it end, until a
  // later turn starts while the view follows the end and the focus is not in its work) ----
  const turnsNow = useRef(turns);
  turnsNow.current = turns;

  // ---- U3: the turn rail's marks (the spots above), named when their key changes ----
  const railK = railKey(spots, partial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const railList = useMemo(() => railMarks(spots), [railK]);
  const spotsNow = useRef(spots);
  spotsNow.current = spots;
  const railNow = useRef(railList);
  railNow.current = railList;
  /** Each mark's top element, found once per key (a row keeps its element). */
  const railEls = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => railEls.current.clear(), [railK]);
  const topEl = (t: RailTop): HTMLElement | null => {
    const k = `${t.attr}=${t.id}`;
    const had = railEls.current.get(k);
    if (had?.isConnected) return had;
    const el = scroller.current?.querySelector<HTMLElement>(`[${t.attr}="${CSS.escape(t.id)}"]`) ?? null;
    if (el) railEls.current.set(k, el);
    else railEls.current.delete(k);
    return el;
  };
  /** Each mark's top, in px from the scroller's visible top (a mark whose element is not drawn counts as below every other). */
  const topsOf = (list: readonly RailMark[]) => {
    const base = scroller.current ? visibleTop(scroller.current) : 0;
    return (k: number) => (topEl(list[k]!.top)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY) - base;
  };
  /** Put a turn's top LAND_TOP px below the scroller's visible top, at once; false when it is not drawn. */
  const landAt = (t: RailTop): boolean => {
    const el = scroller.current;
    const at = topEl(t);
    if (!el || !at || !at.getClientRects().length) return false;
    const d = at.getBoundingClientRect().top - visibleTop(el) - LAND_TOP;
    if (Math.abs(d) >= 0.5) el.scrollTop += d;
    return true;
  };

  const watch = useRef<Watch | null>(null);
  watch.current ??= newWatch(chat.marks);
  // A turn whose background work ended since the last draw waits as a watched turn does (never under the reader).
  noteRunsOn(watch.current, units.flatMap((u) => (u.k === "turn" ? [u.l] : [])));
  const [choices, setChoices] = useState(() => readChoices(sessionStore(), chat.id));
  const isTurnOpen = (l: TurnLayout): boolean =>
    l.folds && turnOpen({ entry: overrides.get(turnKey(l.turn.id)), forced: forced.has(turnKey(l.turn.id)), choice: choices.get(l.turn.id), watched: watchedOpen(watch.current!, l.turn) });
  /** The turn whose line the reader pressed last: only its chevron turns. */
  const turning = useRef<string | null>(null);
  /** The reader opened or closed a turn (its line, or the browser's Find in its work): kept on this device. */
  const setTurn = (id: string, open: boolean) => {
    setChoices(writeChoice(sessionStore(), chat.id, id, open));
    // A link into the turn opens it on its entry: the reader's own toggle there beats it, as a row's does.
    const key = turnKey(id);
    const now = SNAPSHOTS.get(pathKey) ?? overrides;
    if (forced.has(key) || now.has(key)) SNAPSHOTS.set(pathKey, new Map(now).set(key, open));
    bump((n) => n + 1);
  };
  // The reader's place (anchor.ts): read at each scroll while the view does not follow the end, kept at each change.
  const anchor = useRef<Anchor | null>(null);
  const toggled = useRef(false);
  const column = () => (scroller.current?.querySelector(".chat-col") ?? null) as (Element & AnchorRoot) | null;
  const readPlace = () => {
    const el = scroller.current;
    const col = column();
    anchor.current = el && col && !follow.stick ? readAnchor(col, el.getBoundingClientRect().top) : null;
  };
  const keepPlace = () => {
    const el = scroller.current;
    const col = column();
    const a = anchor.current;
    if (!el || !col || !a) return;
    const top = el.getBoundingClientRect().top;
    const d = anchorShift(col, a, top);
    if (d) el.scrollTop += d;
    anchor.current = readAnchor(col, top) ?? a;
    // U3: the place itself moved with its rows, so a place kept for Back still holds.
    if (heldTop.current !== null) heldTop.current = el.scrollTop;
  };
  /** A click or a tap on a turn's line: the line is the anchor, so nothing above it moves. */
  const toggleTurn = (id: string, open: boolean, button: HTMLElement) => {
    const el = scroller.current;
    const line = button.closest("[data-turn-id]");
    if (el && line) {
      anchor.current = [{ attr: "data-turn-id", id, top: line.getBoundingClientRect().top - el.getBoundingClientRect().top }];
      // The end is followed again only if the change leaves the view at the end (measured after it).
      follow.stick = false;
      toggled.current = true;
      pinned.current = null;
    }
    turning.current = id;
    setTurn(id, !open);
  };
  // The keyboard focus on a control of a row: a turn's work moves into its line's containers when the turn ends (or its
  // background work ends), which draws those rows again, and the focus comes back to the same control of the same row.
  const focused = useRef<{ el: Element; attr: string; id: string; index: number } | null>(null);
  const onFocusIn = (target: EventTarget) => {
    const el = target instanceof Element ? target : null;
    const row = el?.closest(FOCUS_ROW);
    const attr = row?.hasAttribute("data-item-id") ? "data-item-id" : "data-testid";
    const id = row?.getAttribute(attr);
    focused.current = el && row && id ? { el, attr, id, index: el === row ? -1 : [...row.querySelectorAll(FOCUSABLE)].indexOf(el) } : null;
  };
  const onFocusOut = (target: EventTarget) => {
    // A focus that moved on, not one whose element the draw took away.
    queueMicrotask(() => {
      if (target instanceof Element && target.isConnected && focused.current?.el === target) focused.current = null;
    });
  };
  useLayoutEffect(() => {
    const f = focused.current;
    if (!f || f.el.isConnected) return;
    const now = document.activeElement;
    if (now && now !== document.body) return;
    const row = scroller.current?.querySelector(`[${f.attr}="${CSS.escape(f.id)}"]`);
    const el = row && (f.index < 0 ? row : row.querySelectorAll(FOCUSABLE)[f.index]);
    if (!(el instanceof HTMLElement) || el.closest("[hidden]")) return;
    el.focus({ preventScroll: true });
    focused.current = { ...f, el };
  });
  /** The timing rule's automatic folds, which wait while the reader is scrolled up or the focus is in the work. */
  const settleWatched = () => {
    const focusIn = (id: string) => !!(document.activeElement as Element | null)?.closest?.(`[data-turn-work="${CSS.escape(id)}"]`);
    if (foldNow(watch.current!, turnsNow.current, follow.stick, focusIn).length) bump((n) => n + 1);
  };
  useLayoutEffect(settleWatched);
  /** After a scroll the view made to a linked row: it follows the end only when that row is near it. */
  const measure = () => {
    const el = scroller.current;
    if (!el) return true;
    follow.stick = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    follow.autoTop = null;
    follow.lastTop = el.scrollTop;
    return follow.stick;
  };
  // Where the view itself last scrolled to follow the end. Its scroll event comes a frame later, and by then more may
  // have come (a code box, a table row: row 79's reveal draws on every frame), so that event never counts as the
  // reader leaving the end.
  const toEnd = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    followedTo(follow, el.scrollTop);
    ownScroll(el);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // U3: a place kept for Back that waited for its rows (a reload) goes back first.
    if (pendingPlace.current && restorePlace()) return;
    if (follow.stick) toEnd(el);
    else setJump(true);
  }, [chat.items, chat.pending.length]);

  // U3 (DESIGN-U3 6): Back into an entry that a turn rail's link left puts the reader's place back instead of that
  // entry's own row scroll, each time until the reader moves from it (then the entry forgets it); on a reload it waits
  // for the rows it names (and is dropped if they never come).
  const pendingPlace = useRef<Anchor | "end" | null>(null);
  const restorePlace = (): boolean => {
    const p = pendingPlace.current;
    const el = scroller.current;
    const col = column();
    if (!p || !el || !col) return false;
    if (p === "end") {
      pendingPlace.current = null;
      pinned.current = null;
      follow.stick = true;
      toEnd(el);
      setJump(false);
      return true;
    }
    if (!p.some((r) => anchorElement(col, r))) {
      if (chat.loaded) pendingPlace.current = null;
      return false;
    }
    pendingPlace.current = null;
    pinned.current = null;
    const top = el.getBoundingClientRect().top;
    const d = anchorShift(col, p, top);
    if (d) el.scrollTop += d;
    anchor.current = readAnchor(col, top) ?? p;
    heldTop.current = el.scrollTop;
    measure();
    return true;
  };
  /** Where a restored place put the scroll: a scroll away from it is the reader's, and the entry forgets the place. */
  const heldTop = useRef<number | null>(null);

  // ---- U5 (DESIGN-U5 9): the query's words marked in the linked row, as Find marks them: found again when the row
  // draws again, and gone when the route leaves the row. Before the row's scroll below, which centres the first mark
  // of a row taller than the view (placeRow). ----
  const mark = onMessage && typeof route.query.mark === "string" ? route.query.mark : "";
  const markId = mark && found ? found.item.id : "";
  const firstMark = useRef<Range | null>(null);
  useLayoutEffect(() => {
    firstMark.current = null;
    const el = scroller.current;
    if (!markId || !el || !canMark()) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const row = el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(markId)}"]`);
      const ranges = row ? markRow(row, mark) : [];
      firstMark.current = ranges[0] ?? null;
      showMarks(ranges);
    };
    paint();
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(paint);
    });
    const col = el.querySelector(".chat-col");
    if (col) mo.observe(col, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
      firstMark.current = null;
      clearMarks();
    };
  }, [markId, mark]);
  /** Centre the linked row, or, when it is taller than the view, its first mark (U5); else scrollRow's least move. */
  const placeRow = (el: HTMLElement, row: HTMLElement, center: boolean) => {
    const m = center ? firstMark.current : null;
    const box = m?.getClientRects().length ? m.getBoundingClientRect() : null;
    if (box && row.getBoundingClientRect().height > el.clientHeight) {
      const s = el.getBoundingClientRect();
      el.scrollTop += centreDelta({ top: s.top, height: s.height }, { top: box.top, height: box.height });
    } else scrollRow(el, row, center);
  };

  // A route that names a row scrolls to it: centred when the page opens on it, the least move after a click. U3: a
  // /m/ route to a turn's target row (rail.ts) lands that turn's top LAND_TOP px below the scroller's top instead.
  const firstScroll = useRef(true);
  const pinned = useRef<{ id: string; center: boolean; land?: RailTop } | null>(null);
  /** Q1 review: a send went back to the chat's own entry (its own send, above): that arrival follows the end. */
  const sentBack = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    // The entry keeps its place until the reader moves (Back, Forward and Back again put it back each time). Review U3:
    // only Back or Forward puts it back (router.ts cameByHistory); a reload, a link or a replace opens the route, and
    // a place that still waited for its rows from an earlier Back waits no more. The Back that a send made is the
    // reader going on at the end: the place that a rail's jump kept in that entry goes, and is not put back.
    const sent = sentBack.current;
    sentBack.current = false;
    if (sent) dropPlace();
    pendingPlace.current = !sent && cameByHistory() ? entryPlace() : null;
    if (el && pendingPlace.current && (restorePlace() || pendingPlace.current)) {
      firstScroll.current = false;
      ownNav.current = false;
      return;
    }
    const row = scrollId && el ? el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(scrollId)}"]`) : null;
    if (el && row) {
      const mark = onMessage ? railNow.current.find((m) => m.target === scrollId) : undefined;
      if (mark && landAt(mark.top)) pinned.current = { id: scrollId!, center: false, land: mark.top };
      else {
        const center = firstScroll.current || !ownNav.current || onMessage;
        placeRow(el, row, center);
        pinned.current = { id: scrollId!, center };
      }
      if (highlightId === scrollId) {
        // Review U3: a jump onto a folded turn's line names a row folded away under it: the line takes the focus.
        const line = mark?.top.attr === "data-turn-id" && row.closest("[hidden]") ? topEl(mark.top)?.querySelector<HTMLElement>("button.chat-turn-line") : null;
        if (line) line.focus({ preventScroll: true });
        else {
          row.tabIndex = -1;
          row.focus({ preventScroll: true });
        }
      }
      // Row 116: a linked row far above the end of a chat whose last end nobody has seen offers Jump to latest, as new
      // output does; the chat's bar draws no unread dot, and on the phone no list shows (DESIGN-R116 9).
      if (!measure() && chat.unseen) setJump(true);
    } else pinned.current = null;
    firstScroll.current = false;
    ownNav.current = false;
  }, [scrollId, route.name, view]);

  // The layout can still move after that (the size class, fonts, a block that opens, a card that comes or goes):
  // keep the linked row in place until the reader scrolls, else keep the end of the chat in view while they are there.
  useEffect(() => {
    const el = scroller.current;
    const col = el?.firstElementChild;
    if (!el || !col) return;
    // U3: the widths last seen, so the rail's room is measured again only when a width changed (not as a reply grows).
    const widths = new Map<Element, number>();
    const ro = new ResizeObserver((entries) => {
      const p = pinned.current;
      const row = p ? el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(p.id)}"]`) : null;
      if (p && row) {
        if (!(p.land && landAt(p.land))) placeRow(el, row, p.center);
        measure();
        report();
      } else if (follow.stick) toEnd(el);
      else keepPlace();
      if (toggled.current) {
        toggled.current = false;
        measure();
        report();
      }
      let wider = false;
      for (const e of entries) {
        if (widths.get(e.target) === e.contentRect.width) continue;
        widths.set(e.target, e.contentRect.width);
        wider = true;
      }
      if (wider) fitRail();
    });
    ro.observe(el);
    ro.observe(col);
    const unpin = () => {
      pinned.current = null;
      dropPlace();
    };
    const events = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    for (const e of events) el.addEventListener(e, unpin, { passive: true });
    // The reader's moves toward the start leave the end before their scroll comes (follow.ts).
    const wheel = (e: WheelEvent) => onWheel(follow, e.deltaY, el.scrollTop);
    const touchStart = (e: TouchEvent) => onTouchStart(follow, e.touches[0]?.clientY ?? 0);
    const touchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) onTouchMove(follow, t.clientY, el.scrollTop);
    };
    const touchEnd = () => onTouchEnd(follow);
    const key = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      onKey(follow, e.key, e.shiftKey, el.scrollTop);
    };
    const down = (e: PointerEvent) => {
      if (e.target === el) follow.dragging = true;
    };
    const up = () => {
      follow.dragging = false;
    };
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", touchMove, { passive: true });
    el.addEventListener("touchend", touchEnd, { passive: true });
    el.addEventListener("touchcancel", touchEnd, { passive: true });
    el.addEventListener("keydown", key);
    el.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointerup", up, { passive: true });
    window.addEventListener("pointercancel", up, { passive: true });
    return () => {
      ro.disconnect();
      for (const e of events) el.removeEventListener(e, unpin);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("touchend", touchEnd);
      el.removeEventListener("touchcancel", touchEnd);
      el.removeEventListener("keydown", key);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  // ---- FIX-Q1: this page's own send (ownSend.ts) is the reader going on with the chat: the linked row's pin, a place
  // kept for Back and Jump to latest go, and the view follows the end, at the press. A route that only names a row (a
  // /m/ link; a changes route on the phone; a card route whose card no longer waits) becomes the chat's own once the
  // send went out (a refused one leaves the link), so its mark goes: back to the chat's entry when this page pushed the
  // link from it (a rail's jump), so no dead entry stays, else by replace, so Back returns where it did (Q1 review). ----
  const leavesNow = useRef(false);
  leavesNow.current = sendLeaves(route, phone, !!requestId && !routedCard);
  const chatUrlNow = useRef(chatUrl);
  chatUrlNow.current = chatUrl;
  useEffect(
    () =>
      onOwnSend(chat.id, (done) => {
        pinned.current = null;
        pendingPlace.current = null;
        heldTop.current = null;
        anchor.current = null;
        dropPlace();
        follow.stick = true;
        const el = scroller.current;
        if (el) toEnd(el);
        setJump(false);
        if (!leavesNow.current) return;
        const from = currentUrl();
        void leaveAfter(done, from, currentUrl, () => {
          if (leaveBy(history.state as EntryState | null, from, chatUrlNow.current) === "back") {
            sentBack.current = true;
            history.back();
          } else navigate(chatUrlNow.current, { replace: true });
        });
      }),
    [chat.id],
  );

  // ---- after an answer (or a Take back on the routed message): the link becomes the chat path, and focus goes to
  // the next card or the composer ----
  const vp = useViewport();
  const dock = useRef<HTMLDivElement>(null);
  const shownCard = useRef<string | undefined>(card?.id);
  useLayoutEffect(() => {
    routedBefore.current = routedCard ? requestId : undefined;
    rowBefore.current = found ? targetId : undefined;
    const before = shownCard.current;
    shownCard.current = card?.id;
    if (justAnswered || rowLeft) navigate(chatUrl, { replace: true });
    if (!before || before === card?.id || chat.pending.some((k) => k.id === before)) return;
    const next = dock.current?.querySelector<HTMLElement>(".chat-card");
    if (next) next.focus({ preventScroll: true });
    else if (!vp.touch) document.querySelector<HTMLElement>('[data-testid="composer-input"]')?.focus({ preventScroll: true });
  });

  // ---- row 116, the seen report (net/onScreen.ts): this route shows the conversation, its newest history is drawn
  // and the view follows its end (Jump to latest does not show); the store adds the page's visibility, and holds the
  // on back until the chat's attach on this socket is drawn (a page that reconnects, or opens it again). After each
  // render (here, after the scroll effects above have placed the view) and at each scroll; the store sends only a
  // change, and off when the view goes. ----
  const viewShows = useRef(false);
  // R131: rules 2 and 3 alone, for a background session's line, which judges its own place (it is seen while in view,
  // not because the chat is at its end).
  const shownNow = conversationShows(route, vp.size === "phone") && chat.loaded;
  viewShows.current = shownNow && !jump;
  const report = () => act.onScreen(chat.id, viewShows.current && follow.stick);
  useLayoutEffect(report);
  useEffect(() => () => act.onScreen(chat.id, false, true), [chat.id]);

  // ---- U3, the turn rail (DESIGN-U3 3 to 10): on a laptop (no touch) for 5 loaded turns or more, where 32 px are free
  // between the text's right edge and the scroller's (measured at mount and when a width changes; its place is the
  // rail's own --rail-x, TurnRail's place(), written only on a change). The current turn is the last while the view
  // follows the end (no geometry read), else found by halves at most once a frame as the reader scrolls. ----
  const [railRoom, setRailRoom] = useState(false);
  const railX = useRef<number | null>(null);
  const fitRail = () => {
    const el = scroller.current;
    const col = column();
    const wrap = el?.parentElement;
    if (!el || !col || !wrap) return;
    const s = el.getBoundingClientRect();
    const fit = railFit({ scrollerLeft: s.left, scrollerWidth: s.width, clientWidth: el.clientWidth, bothGutters: BOTH_GUTTERS, colRight: col.getBoundingClientRect().right, padRight: parseFloat(getComputedStyle(col).paddingRight) || 0, wrapLeft: wrap.getBoundingClientRect().left });
    // Integration: never on the wrap, where a variable that changes as a pane's handle drags restyles the whole
    // transcript (row 82's panes flow: a move restyles the shell and its handle only); the rail sets it on itself.
    railX.current = fit.x;
    railApi.current?.place(fit.x);
    setRailRoom(fit.room);
  };
  useLayoutEffect(fitRail, []);
  const railOn = railShows(railList.length, railRoom, vp.touch);
  const railOnNow = useRef(railOn);
  railOnNow.current = railOn;
  const railApi = useRef<RailApi | null>(null);
  const railFrame = useRef(0);
  /** The current mark that the rail was told last (undefined: none yet; null: the last, while following). */
  const railCur = useRef<string | null | undefined>(undefined);
  const setRailCurrent = (turn: string | null) => {
    if (railCur.current === turn) return;
    railCur.current = turn;
    railApi.current?.setCurrent(turn);
  };
  /** The current mark, read now: in a frame's callbacks (a scroll's work, S1), or from trackRail's frame. */
  const readRail = () => {
    const el = scroller.current;
    if (!el || !railOnNow.current) return;
    if (follow.stick) return setRailCurrent(null);
    const ms = railNow.current;
    const i = currentTurn(ms.length, topsOf(ms), readingLine(el.clientHeight - underBar(el)), false);
    setRailCurrent(i >= 0 ? ms[i]!.turn : null);
  };
  const trackRail = () => {
    if (!railOnNow.current) return;
    if (follow.stick) return setRailCurrent(null);
    if (railFrame.current) return;
    railFrame.current = requestAnimationFrame(() => {
      railFrame.current = 0;
      readRail();
    });
  };
  useEffect(() => () => cancelAnimationFrame(railFrame.current), []);
  useLayoutEffect(() => {
    // A rail that has just come is told its place (it skips the one it has).
    if (railOn && railX.current !== null) railApi.current?.place(railX.current);
    railCur.current = undefined;
    trackRail();
  }, [railOn, railK]);
  /** `{`, `}` and a mark whose URL is open already: the turn's top at LAND_TOP, at once; no URL, focus or highlight. */
  const landMark = (m: RailMark) => {
    if (!landAt(m.top)) return;
    pinned.current = null;
    dropPlace();
    measure();
    readPlace();
    trackRail();
    report();
  };
  const railHooks = useRef<RailHooks>({ card: () => null, leave: () => {}, wheel: () => {} });
  railHooks.current = {
    card: (turn) => {
      const s = spotsNow.current.find((x) => x.turn.id === turn);
      return s ? railCard(s) : null;
    },
    leave: (m, to) => {
      if (to === currentUrl()) return landMark(m);
      // The entry this link leaves keeps the reader's place, for Back (router.ts EntryState.place).
      const el = scroller.current;
      const col = column();
      const place = follow.stick ? "end" : el && col ? readAnchor(col, el.getBoundingClientRect().top) : null;
      if (place) history.replaceState({ ...((history.state as EntryState | null) ?? {}), place } satisfies EntryState, "");
    },
    // Review U3: the rail and its card sit beside the scroller, so a wheel over them reaches no scroller; the rail
    // passes it here and the conversation scrolls by it, doing what the reader's wheel over the text does (the
    // listeners above): the pin and the kept place go, and a move toward the start leaves the end (follow.ts).
    wheel: (deltaY, deltaMode) => {
      const el = scroller.current;
      if (!el) return;
      const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * el.clientHeight : deltaY;
      pinned.current = null;
      dropPlace();
      onWheel(follow, px, el.scrollTop);
      el.scrollTop += px;
    },
  };
  // The CLI's `{` and `}` (transcript mode, 2.1.139): the turn before or after, landing as a jump does, outside a field,
  // the Terminal pane, an open dialog, sheet or menu, and while no input method composes; they push no history entry.
  const keyLand = useRef(landMark);
  keyLand.current = landMark;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = turnStep(e);
      if (dir === null || e.defaultPrevented || composingKey(e, false)) return;
      if (document.querySelector('[aria-modal="true"], .menu, .sheet, .dialog')) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest(".term-pane, .xterm"))) return;
      const el = scroller.current;
      if (!el || !el.getClientRects().length) return;
      const ms = railNow.current;
      const to = stepTo(ms.length, topsOf(ms), LAND_TOP, dir);
      if (to < 0) return;
      e.preventDefault();
      keyLand.current(ms[to]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- a scroll: once a frame, in that frame's callbacks after a reply's reveal has drawn (S1: read in the event, at
  // the frame's start, its scroll and size ran style and layout once more before the frame's own). The rail's current
  // mark is read here, in this frame, not in trackRail's next one. The gap is the one now, that frame's growth
  // included: a height kept from the column's observer was stale after the view's own placement of a linked row (a
  // layout effect, before the observer saw the rows), and read the reader as at the end (row 116's Jump to latest). ----
  const scrollFrame = useRef(0);
  const jumpNow = useRef(jump);
  jumpNow.current = jump;
  const scrolledNow = useRef(() => {});
  scrolledNow.current = () => {
    scrollFrame.current = 0;
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    if (onScrolled(follow, top, el.scrollHeight - top - el.clientHeight) && jumpNow.current) setJump(false);
    readPlace();
    settleWatched();
    report();
    readRail();
    if (heldTop.current !== null && Math.abs(top - heldTop.current) > 4) {
      heldTop.current = null;
      dropPlace();
    }
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  // ---- the on-screen keyboard (DESIGN.md 7.8): a card with a field (an elicitation form, Other, the Deny note) has
  // the composer's place, so it rides the keyboard as the composer does. While the keyboard is up and the focus is in
  // the card, the dock is fixed at the visual viewport's bottom (a bottom: offset would land behind the iOS keyboard),
  // at most as tall as what shows; the card's body scrolls inside it, so the field and the buttons stay in view. The
  // chat keeps the dock's place plus the part of the layout viewport that the keyboard covers, so its end stays in
  // view above the card. Styles only, never the element tree: a remount of the focused field closes the iOS keyboard.
  const kb = useSoftKeyboard(vp.touch);
  const cardFocus = useFocusInside(dock, vp.touch && !!card);
  const cardRides = kb.up && cardFocus;
  const [cardRide, setCardRide] = useState<{ left: number; width: number; keep: number } | null>(null);
  useLayoutEffect(() => {
    if (!cardRides) {
      setCardRide(null);
      return;
    }
    const measure = () => {
      const box = dock.current;
      const view = box?.parentElement;
      if (!box || !view) return;
      const r = view.getBoundingClientRect();
      const covered = Math.max(0, r.bottom - (kb.offsetTop + kb.visualHeight));
      const next = { left: r.left, width: r.width, keep: covered + Math.min(box.offsetHeight, kb.visualHeight) };
      setCardRide((p) => (p && Math.abs(p.left - next.left) < 1 && Math.abs(p.width - next.width) < 1 && Math.abs(p.keep - next.keep) < 1 ? p : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (dock.current) ro.observe(dock.current);
    return () => ro.disconnect();
  }, [cardRides, kb.offsetTop, kb.visualHeight, vp.width]);
  // The field that has the focus stays in view inside the card's body as the card shrinks to what shows.
  useLayoutEffect(() => {
    if (!cardRide) return;
    const at = document.activeElement;
    const body = at instanceof HTMLElement ? at.closest<HTMLElement>(".chat-card-body") : null;
    if (!at || !body) return;
    const b = body.getBoundingClientRect();
    const f = at.getBoundingClientRect();
    const ring = 8; // px: the field's focus ring shows too
    if (f.bottom + ring > b.bottom) body.scrollTop += f.bottom + ring - b.bottom;
    else if (f.top - ring < b.top) body.scrollTop -= b.top - (f.top - ring);
  }, [cardRide, kb.visualHeight]);
  const cardRideStyle = cardRide ? { left: cardRide.left, width: cardRide.width, maxHeight: kb.visualHeight, transform: `translateY(calc(${kb.offsetTop + kb.visualHeight}px - 100%))` } : undefined;

  // ---- Ctrl+O cycles the transcript view (Normal, Thinking once there is thinking, Verbose) ----
  const routeRef = useRef(route);
  routeRef.current = route;
  const thinking = hasThinking(chat.items);
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "o") return;
      e.preventDefault();
      const r = routeRef.current;
      const next = nextView(viewOf(r), thinkingRef.current);
      navigate(href(r.name, r.params, { ...r.query, view: next === "normal" ? undefined : next }), { replace: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Esc while a card waits: stop the turn (DESIGN.md 6.3, 6.11). act.stop answers every waiting card as
  // dismissed: a permission, plan or question card with a denial, an elicitation with Cancel, a dialog as cancelled.
  // What is open on top takes Esc first: a popup, a sheet, a dialog or the inline rename handle it in the capture
  // phase, and a handler that used it (the Deny field closing, a pane over the chat) prevents it or stops it. A field
  // outside the card keeps its own Esc. The composer, hidden while a card waits, has its own Esc for a running turn.
  const waiting = chat.pending.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (document.querySelector('[aria-modal="true"], .menu, .sheet, .dialog')) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const field = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (field && !dock.current?.contains(t)) return;
      e.preventDefault();
      act.stop(chat.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [waiting, chat.id]);

  // A short line confirms a view change; the end of a turn is announced to screen readers.
  const [viewNote, setViewNote] = useState<string | null>(null);
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    setViewNote(`Transcript view: ${VIEW_LABEL[view]}`);
    const t = setTimeout(() => setViewNote(null), 1600);
    return () => clearTimeout(t);
  }, [view]);
  const [said, setSaid] = useState("");
  const lastState = useRef(chat.state);
  useEffect(() => {
    if (lastState.current === "running" && chat.state !== "running") setSaid(chat.state === "waiting" ? "Claude is waiting for your answer." : "Claude finished.");
    lastState.current = chat.state;
  }, [chat.state]);

  const streaming = chat.items.some((i) => i.kind === "assistant" && i.streaming);
  const working = chat.state === "running" && !streaming;

  // ---- U2: the column. Inputs and answers are the column's own rows, keyed by their ids, so they keep their elements
  // when a turn gets its line; only the work goes into the line's containers. S1: each unit's elements are kept while
  // the unit (shareBlocks, layoutCache) and what they show are the same, so React skips a finished turn when a reply
  // grows; their handlers call this draw's own (turnActs). ----
  const turnActs = useRef({ toggleTurn, setTurn });
  turnActs.current = { toggleTurn, setTurn };
  const drawnOf = useRef(new WeakMap<object, { deps: readonly unknown[]; nodes: ReactNode[] }>()).current;
  const keep = (unit: object, deps: readonly unknown[], make: () => ReactNode[]): ReactNode[] => {
    const had = drawnOf.get(unit);
    if (had && had.deps.length === deps.length && had.deps.every((d, i) => d === deps[i])) return had.nodes;
    const nodes = make();
    drawnOf.set(unit, { deps, nodes });
    return nodes;
  };
  const drawn: ReactNode[] = [];
  /** U1: a turn's changes card, its last part (part of the answer, so a folded turn keeps it), and what it shows. */
  const cardOf = (l: TurnLayout) => {
    const note = cards.get(l.turn.id);
    if (!note) return { deps: [null], node: () => null };
    const open = shownChanges?.turn === note.id ? (shownChanges.path ?? "") : null;
    return { deps: [note, open, splitLive, phone, route], node: () => <ChangesCard key={cardItemId(note.id)} note={note} chatId={chat.id} route={route} live={splitLive} phone={phone} open={open} /> };
  };
  for (const u of units) {
    if (u.k === "rows") {
      drawn.push(...keep(u, [], () => u.entries.map((e) => entryNode(e, chat.id))));
      continue;
    }
    const l = u.l;
    const card = cardOf(l);
    if (!l.folds) {
      drawn.push(...keep(l, card.deps, () => [...l.parts.flatMap((p) => p.entries).map((e) => entryNode(e, chat.id)), card.node()]));
      continue;
    }
    const id = l.turn.id;
    const open = isTurnOpen(l);
    const turningNow = turning.current === id;
    drawn.push(
      ...keep(l, [open, turningNow, ...card.deps], () => {
        const out: ReactNode[] = [];
        const parts = drawnParts(l, open);
        const works = parts.filter((p) => p.role === "work").length;
        const found = () => turnActs.current.setTurn(id, true);
        let line = false;
        let n = 0;
        for (const p of parts) {
          if (p.role === "input" && !line) {
            for (const e of p.entries) out.push(entryNode(e, chat.id));
            continue;
          }
          if (!line) {
            line = true;
            const first =
              p.role === "work" ? (
                <TurnWork key="work" turnId={id} n={0} open={open} found={found}>
                  {p.entries.map((e) => entryNode(e, chat.id))}
                </TurnWork>
              ) : null;
            // R127: folded, the turn's line is the first line that holds its refused rows: their lines go under it; R131:
            // so do its launch rows' background sessions' lines.
            const note = open ? null : (
              <>
                <TrustLines items={l.turn.rows} />
                <BackgroundLines items={l.turn.rows} />
              </>
            );
            out.push(
              <TurnLine key={`turn-${id}`} turnId={id} label={l.label} tag={l.tag} open={open} works={works} turning={turningNow} toggle={(button) => turnActs.current.toggleTurn(id, open, button)} note={note}>
                {first}
              </TurnLine>,
            );
            if (first) {
              n = 1;
              continue;
            }
          }
          if (p.role === "work") {
            out.push(
              <TurnWork key={`work-${id}-${n}`} turnId={id} n={n} open={open} found={found}>
                {p.entries.map((e) => entryNode(e, chat.id))}
              </TurnWork>,
            );
            n++;
            continue;
          }
          for (const e of p.entries) out.push(entryNode(e, chat.id));
        }
        out.push(card.node());
        return out;
      }),
    );
  }

  return (
    <TranscriptProvider value={ctx}>
      <ConversationShownProvider value={shownNow}>
        <div className="chat-view" data-testid="conversation" data-view={view} style={cardRide ? { paddingBottom: cardRide.keep } : undefined}>
          {linkLine ? (
            <div className="chat-gone">
              <div className="chat-measure">
                <p className="notice" data-testid="link-notice" role="status">
                  {linkLine}
                </p>
              </div>
            </div>
          ) : null}
          <div className="chat-scroll-wrap">
            <div
              className="chat-scroll"
              ref={scroller}
              onFocus={(e) => onFocusIn(e.target)}
              onBlur={(e) => onFocusOut(e.target)}
              onScroll={() => {
                if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(() => scrolledNow.current());
              }}
            >
              <section className="chat-col" aria-label="Conversation">
                {chat.items.length ? (
                  drawn
                ) : (
                  <div className="chat-greeting">
                    <h2>What should we work on in {project}?</h2>
                  </div>
                )}
                {working ? (
                  <div className="chat-item chat-working-row">
                    <WorkingMark />
                  </div>
                ) : null}
                {/* DESIGN.md 6.9: until Claude Code answers, the user's bubble shows, then this line. */}
                {chat.state === "starting" ? (
                  <div className="chat-item chat-foot-line" role="status" data-testid="chat-starting">
                    Starting Claude Code...
                  </div>
                ) : null}
              </section>
            </div>
            {railOn ? <TurnRail marks={railList} partial={partial} chatId={chat.id} view={rawView} api={railApi} hooks={railHooks} /> : null}
            {jump ? (
              <button
                type="button"
                className="chat-jump"
                onClick={() => {
                  const el = scroller.current;
                  if (el) toEnd(el);
                  pinned.current = null;
                  follow.stick = true;
                  setJump(false);
                }}
              >
                <IconDown size={14} />
                Jump to latest
              </button>
            ) : null}
            {viewNote ? (
              <div className="chat-view-note" role="status">
                {viewNote}
              </div>
            ) : null}
          </div>
          {card ? (
            <div className={`chat-dock${cardRide ? " is-riding" : ""}`} ref={dock} style={cardRideStyle}>
              <div className="chat-measure">
                {COMPOSER_ROUTES.has(route.name) ? (
                  <p className="notice chat-dock-line" role="status" data-testid="composer-waits">
                    {answerFirstLine(route, commandRowsOf(chat))}
                  </p>
                ) : null}
                <WaitingCard chat={chat} card={card} index={chat.pending.indexOf(card)} route={route} />
              </div>
            </div>
          ) : null}
          <div className="visually-hidden" aria-live="polite">
            {said}
          </div>
        </div>
      </ConversationShownProvider>
    </TranscriptProvider>
  );
}
