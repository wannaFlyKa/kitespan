// R131 (owner row 131; DESIGN-R131 6, 8): /c/<chat>/background/<id>, the read-only live view of a background session
// that a launch row of this chat printed, and /c/<chat>/background/<id>/stop, its Stop confirm over the view. A page
// over the chat at every size: on a laptop the sidebar stays and the bar holds Back "Chat"; on touch the bar adds the
// heading "Background session". Its head (it scrolls with the transcript, as the preview's): the session's name, then
// one dim line with its folder's last two segments (the full path its title), its permission mode in Desktop's words
// (Bypass permissions in the composer's own pill) and when it started. Its transcript is the session preview's reader
// (previewItems, ItemView read-only), the newest page; it stays at its end while the reader is there. The dock, in the
// message box's place, holds the live state (the line's dot and words) with Stop (while the session runs) and Open in
// terminal, both links: the missing box says the view is read-only, without a banner. It reads again about every 2 s,
// only while the page is visible and the view is mounted, and the server answers "same" from its lite read when the
// file did not change (chat/background.ts BgReader); the state comes from the chat's events, not from these reads. A
// session the chat did not print, that Claude Code no longer lists, or whose folder is outside the project gives the
// chat at its end with one 5.4 line instead (viewVerdict, or the read's own answer).
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { closeTo, href, parsePath, type Route } from "../router";
import { act, useStore } from "../state/store";
import { apiGet } from "../net/api";
import type { ChatEvent } from "../../shared/protocol";
import type { Chat, Item, ModeId } from "../state/types";
import { Shell } from "../layout/Shell";
import { Link } from "../ui/primitives";
import { ChatScreen } from "../chat/ChatScreen";
import { TranscriptProvider, type Transcript } from "../chat/items/context";
import { ItemView } from "../chat/items/ItemView";
import { Home } from "./Home";
import { CHAT_GONE } from "./common";
import { previewItems } from "./ProjectScreen";
import { BackgroundStopDialog } from "../dialogs/BackgroundStopDialog";
import {
  BG_NOT_IN_CHAT,
  BG_OUTSIDE,
  BG_WORDS,
  BgReader,
  OPEN_IN_TERMINAL,
  bgHref,
  bgName,
  bgStopHref,
  bgTerminalHref,
  canStop,
  dotOf,
  folderName,
  launchOf,
  modeWord,
  reasonOf,
  startedText,
  toneOf,
  viewVerdict,
  type BgReply,
  type BgWorker,
} from "../chat/background";

const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);

/** The chat's own route for a view route (its view key kept): what the chat draws when the view gives way to it. */
function chatRouteOf(route: Route): Route {
  return parsePath(href("chat", { chat: route.params.chat ?? "" }, { view: viewOf(route) }));
}

export function BackgroundScreen({ route }: { route: Route }) {
  const chat = useStore((s) => s.chats.find((c) => c.id === route.params.chat));
  const id = route.params.id ?? "";
  // The read's own answer: the server's book does not hold the id (404), or the folder is outside the project.
  const [read, setRead] = useState<{ chat: string; id: string; verdict: "gone" | "outside" } | null>(null);
  // The session this mount showed: while its Stop confirm stays open, a stop that Claude Code no longer lists keeps the
  // confirm with its answer's line (DESIGN-R131 8.2) until it closes, and the chat with 5.4's line follows then.
  const shown = useRef<string | null>(null);
  if (!chat) return <Home route={route} notice={CHAT_GONE} />;
  // Read on every render, so a state that changes (Claude Code no longer lists the session) shows at once.
  const stored = viewVerdict(chat, id);
  const verdict = read && read.chat === chat.id && read.id === id && stored !== "loading" ? read.verdict : stored;
  const key = `${chat.id} ${id}`;
  if (verdict === "view") shown.current = key;
  const keep = verdict === "gone" && route.name === "backgroundStop" && shown.current === key;
  if ((verdict === "gone" && !keep) || verdict === "outside") return <ChatScreen route={chatRouteOf(route)} gone={verdict === "gone" ? BG_NOT_IN_CHAT : BG_OUTSIDE} />;
  const view = viewOf(route);
  return (
    <Shell route={route}>
      <BackgroundView key={key} chat={chat} id={id} view={view} loading={verdict === "loading"} onGone={(v) => setRead({ chat: chat.id, id, verdict: v })} />
      {route.name === "backgroundStop" && (verdict === "view" || keep) ? <BackgroundStopDialog chat={chat} id={id} onClose={() => closeTo(bgHref(chat.id, id, view))} /> : null}
    </Shell>
  );
}

/** The running calls among `items` (deep): while the session does not work, none of them runs, so none spins. */
function openCalls(items: readonly Item[], out = new Set<string>()): Set<string> {
  for (const it of items) {
    if (it.kind === "tool" && it.status === "running") out.add(it.id);
    else if (it.kind === "agent") openCalls(it.rows, out);
  }
  return out;
}

const NO_CALLS: ReadonlySet<string> = new Set();

interface Page {
  items: Item[];
  mode: ModeId | null;
  /** The first read came (the reader shows its rows, or that the session has none yet). */
  read: boolean;
}

function BackgroundView(props: { chat: Chat; id: string; view: string | undefined; loading: boolean; onGone: (v: "gone" | "outside") => void }) {
  const { chat, id, view, loading, onGone } = props;
  const worker = chat.background?.[id];
  const row = launchOf(chat.items, id);
  const name = bgName(worker, row, id);
  const folder = worker?.folder ?? null;
  const [page, setPage] = useState<Page>({ items: [], mode: null, read: false });
  const gone = useRef(onGone);
  gone.current = onGone;
  const cwd = useRef(folder);
  cwd.current = folder;

  // The reads: one at once, then about every 2 s while the page is visible and this view is mounted.
  useEffect(() => {
    if (loading) return;
    const reader = new BgReader({
      get: (since) => apiGet<unknown>(`/api/chats/${chat.id}/background/${id}${since ? `?since=${encodeURIComponent(since)}` : ""}`),
      visible: () => document.visibilityState === "visible",
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      answer: (a: BgReply) => {
        if (a.kind === "page") setPage({ items: previewItems({ history: a.history as ChatEvent[] }, cwd.current), mode: a.mode, read: true });
        else if (a.kind === "outside" || a.kind === "gone") gone.current(a.kind);
      },
    });
    reader.start();
    const onVisible = () => reader.visibility();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      reader.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [chat.id, id, loading]);

  // The seen report: this session's view is on screen while it is mounted with its state drawn (R116's rule for a
  // session's end, DESIGN-R131 9.5); the chat itself is not on screen here.
  const shows = !!worker && !loading;
  useEffect(() => {
    act.bgOnScreen(chat.id, id, shows);
  }, [chat.id, id, shows]);
  useEffect(() => () => act.bgOnScreen(chat.id, id, false, true), [chat.id, id]);

  // The view follows its end while the reader is there; a reader who scrolled up is not moved.
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [page.items]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // While the session does not work (it needs input, is idle or has ended), its open calls do not run: no spinner.
  const works = worker?.state === "working" || worker?.state === "starting";
  const waiting = useMemo(() => (works ? NO_CALLS : openCalls(page.items)), [works, page.items]);
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const transcript = useMemo<Transcript>(
    () => ({
      chatId: "",
      view: "verbose",
      readOnly: true,
      calls: { waiting, recorded: NO_CALLS },
      isOpen: (rowId, byDefault) => opened.get(rowId) ?? byDefault,
      toggle: (rowId, _route, open) => setOpened((m) => new Map(m).set(rowId, !open)),
    }),
    [waiting, opened],
  );

  return (
    <div className="scr-preview bg-view" data-testid="background-view">
      <div className="scr-page" ref={scroller} onScroll={onScroll}>
        <div className="scr-col scr-preview-col">
          <BgHead name={name} folder={folder} mode={page.mode} startedAt={worker?.startedAt ?? null} now={Date.now()} />
          <div className="scr-preview-items" aria-busy={!page.read || undefined}>
            <TranscriptProvider value={transcript}>
              {page.items.map((item) => (
                <ItemView key={item.id} item={item} chatId="" readOnly />
              ))}
            </TranscriptProvider>
          </div>
        </div>
      </div>
      <BgDock chatId={chat.id} id={id} worker={worker} view={view} />
    </div>
  );
}

/**
 * The view's head (exported for the tests): the name, then one dim line: the folder's last two segments (its full path
 * as the title), the permission mode in Desktop's words (Bypass permissions in the composer's pill), and the start,
 * joined by commas (by a space on each side of the pill). A part that is not known is left out, and with none the line
 * goes.
 */
export function BgHead({ name, folder, mode, startedAt, now }: { name: string; folder: string | null; mode: ModeId | null; startedAt: number | null; now: number }) {
  // Each part, and whether it is the Bypass pill: no comma goes next to the pill (its shape parts it from its
  // neighbours, and a comma after it sat apart from it, or alone at a line's end on the phone), only a space.
  const parts: { node: ReactNode; pill: boolean }[] = [];
  if (folder)
    parts.push({
      node: (
        <span key="folder" className="bg-folder" title={folder}>
          {folderName(folder)}
        </span>
      ),
      pill: false,
    });
  const word = modeWord(mode);
  if (word)
    parts.push(
      mode === "bypassPermissions"
        ? {
            node: (
              <span key="mode" className="chip bg-mode is-warn">
                {word}
              </span>
            ),
            pill: true,
          }
        : { node: <span key="mode">{word}</span>, pill: false },
    );
  const started = startedText(startedAt, now);
  if (started) parts.push({ node: <span key="started">{started}</span>, pill: false });
  return (
    <header className="scr-preview-head bg-head">
      <h1 className="scr-h1" dir="auto">
        {name}
      </h1>
      {parts.length ? (
        <p className="scr-dim bg-meta">
          {parts.map((p, i) => (
            <Fragment key={i}>
              {i ? (p.pill || parts[i - 1]!.pill ? " " : ", ") : null}
              {p.node}
            </Fragment>
          ))}
        </p>
      ) : null}
    </header>
  );
}

/**
 * The dock in the message box's place (exported for the tests): the session's live state, as the line says it (the dot,
 * the state word in its colour, the reason), then Stop while the session runs and Open in terminal (the primary while
 * it runs, a plain button once it ended). Both are links: Stop opens the confirm, whose own Stop sends; Open in terminal
 * opens the Terminal pane with `claude attach <id>` typed.
 */
export function BgDock({ chatId, id, worker, view }: { chatId: string; id: string; worker: BgWorker | undefined; view: string | undefined }) {
  const dot = worker ? dotOf(worker) : "";
  const tone = worker ? toneOf(worker.state) : null;
  const why = worker ? reasonOf(worker) : null;
  return (
    <div className="scr-preview-dock">
      <div className="scr-col scr-preview-dock-in bg-dock">
        <p className="bg-state" role="status" data-testid="bg-state">
          {/* The dock holds one state alone: no empty place for a dot (the lines keep one so that their names line up). */}
          {dot ? <span className={`dot ${dot}`} aria-hidden="true" /> : null}
          {worker ? (
            <span className="bg-state-text">
              <span className={`bg-state-word${tone ? ` ${tone}` : ""}`}>{BG_WORDS[worker.state]}</span>
              {why ? <span className="bg-state-why">{`: ${why}`}</span> : null}
            </span>
          ) : null}
        </p>
        <div className="bg-dock-actions">
          {worker && canStop(worker.state) ? (
            <Link to={bgStopHref(chatId, id, view)} className="btn" data-testid="bg-stop">
              Stop
            </Link>
          ) : null}
          {/* Primary while the session runs (it may wait for the user there); plain once it ended: nothing waits. */}
          <Link to={bgTerminalHref(chatId, id, view)} className={!worker || canStop(worker.state) ? "btn primary" : "btn"} data-testid="bg-terminal">
            {OPEN_IN_TERMINAL}
          </Link>
        </div>
      </div>
    </div>
  );
}
