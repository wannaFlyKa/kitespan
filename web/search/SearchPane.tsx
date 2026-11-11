// The search pane (DESIGN.md 9.3, 6.7 "The search pane", 7.2, 7.3; BUILD-CHECKLIST C4, D3), which is also the plan's
// palette: one field that filters as the user types and one list of rows under it. In a chat (`/c/<chat>/search`) the
// rows are in three groups: the chats by title, the files (the chat folder's files, then the chat's uploads) and its
// `/` commands; with no chat open (`/search`) the chats by title only. Where it shows is Shell's: the side panel's
// column on a laptop (over the chat as a layer from 1,000 to 1,087 px), the docked pane on a tablet, its own screen
// over the chat on the phone, and a page in the main column for `/search`.
//
// The field (`type="text"`, so no browser clears it on Esc) is a combobox over a listbox: Up and Down move the active
// row, which scrolls into view; Enter picks it once the list answers the field's query (a fast Enter waits for that
// list, and picks when it lands); Esc closes the pane back to where the user was, and gives the focus back to the
// element that opened the pane (else, on a laptop, the composer's field). The active row goes back to the first on
// each new query. While an input method composes (with a fine pointer) its keys are its own. The list draws the
// deferred query (useDeferredValue), so the field's echo never waits for the rows, while the server (over the page's
// limit) is asked for the field's own value at once; the list's root carries the query its rows answer (`data-q`) and
// their true count (`data-count`), set in the same render, and (U5) the Messages group's state for the field's value
// (`data-messages`: off, wait, done or failed).
// Typing writes `q` into the URL with replaceState once the typing pauses (and before a pick, so Back returns to the
// results), never on open. A pick is a navigation and sends nothing (5.5): a chat opens it, a file its page in the
// chat's folder, an upload the chat's uploads, a command the composer with its chip (Send runs it).
//
// Principle 0: rows only. No count, no helper line, no key-hint footer; a group's heading only when two groups have
// rows; the scope control only when the chat has rows of two kinds; one line, "Nothing matches <q>.", only once the
// file list came and the query matches nothing; the matched letters in bold, in the row's own colour (as the `@`
// picker draws them; 6.13 gives the accent's text colour to links and the Needs input word only).
//
// U5 (DESIGN-U5 8): the last group, Messages, the server's matches in the chats' messages, asked 250 ms after the
// field's own value last changed (web/search/messages.ts). A chat's first row is two lines: its title, Archived for an
// archived chat and when, then one line of the message around the match with the matched words in bold in --text; a
// later row of the same chat is that line alone. The user's own line starts with a quiet "You: " in the line's --dim
// (Claude's replies, most rows, have none), so a question and an answer that share their words are told apart; the
// row's name says it too. The project is in the row's name (and its tooltip on a laptop). With no answer 1,000 ms after
// the ask, "Searching messages…" shows in the list after the groups (hidden there, since a listbox holds options; a
// status outside the list says it). "Nothing matches <q>." waits for the Messages answer; "Messages could not be
// searched." takes its place when the ask failed and nothing else shows. A pick opens the chat at the message with the
// query as `mark` (nav.ts); Enter never waits for Messages. U4: in a half of the split side panel, typing makes it the
// URL's own view (the places stay), a pick of a file opens in that half, Close gives the whole pane to the other half,
// and as the other half it opens plain: no focus, and the field keeps what it holds and the scope the one it showed.
// A file hit has the file's menu (DESIGN-T1 2.1: Attach as context and Copy path; on a laptop also Open in new tab and
// Copy link): a long press or its "..." on touch, a right-click on a laptop. The menu is drawn beside the row, never
// inside the option, so its taps pick nothing.
import { memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { closeTo, docReach, navigate, type EntryState, type Route } from "../router";
import { useStore } from "../state/store";
import type { Chat, Project } from "../state/types";
import { useViewport } from "../layout/size";
import { Segmented, relTime } from "../ui/primitives";
import { linkNoticeLine } from "../ui/LinkNotice";
import { IconClose, IconFile, IconImage } from "../ui/icons";
import { MARKED, STATE_WORD, StateDot, TOO_LONG, overCap } from "../screens/common";
import { scrollWithin } from "../composer/labels";
import { SEARCH_SCOPES } from "../../shared/route";
import { usePaneData } from "./useSearch";
import { closeHref, pickHref, searchHref } from "./nav";
import { SEARCH_FIELD_ID, focusBackTo, takeKeyOpened } from "./focus";
import { halfClose, halfLink } from "../layout/split";
import { SCOPE_LABEL, SECTION_TITLE, activeFor, enterPick, flatRows, moveActive, paneKey, pieces, scopesHere, type MessageRowHit, type SearchHit, type SearchScope, type Selection } from "./sections";
import { useProjectFolder } from "../chat/items/Files";
import { fileMenu } from "../ui/fileMenu";
import { fileOpener, useRowMenu } from "../ui/RowMenu";
import "../styles/search.css";

/** Where the pane is drawn: Shell's side places, the phone's screen over the chat, or the `/search` page. */
export type SearchPlace = "column" | "pane" | "over" | "page" | "screen";

/** How long the typing pauses before `q` is written into the URL. */
export const Q_WRITE_MS = 300;
/** The query's cap in the URL (5.1 rule 7): a longer one fills nothing and shows 5.4's line. */
const Q_CAP = 5000;

export const NOTHING_MATCHES = (q: string) => `Nothing matches ${q}.`;
/** U5: no Messages answer a second after the ask. */
export const SEARCHING_MESSAGES = "Searching messages…";
/** U5: the ask failed and no other row shows. */
export const MESSAGES_FAILED = "Messages could not be searched.";
/** U5: the field's name in a chat (its placeholder is "Search": the long form is cut in the 320 px pane). */
const FIELD_NAME_CHAT = "Search chats, messages, files and commands";
/** U5: the field's name and placeholder on /search. */
const FIELD_NAME_PAGE = "Search chats and messages";
/** U5: the word before the user's own line in a Messages row and in its name (Claude's replies have none). */
export const YOU_PREFIX = "You: ";

const coarseNow = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const COMPOSER_FIELD = '[data-testid="composer"] [data-testid="composer-input"]';
const viewOf = (route: Route) => (typeof route.query.view === "string" ? route.query.view : undefined);
const scopeOf = (route: Route): SearchScope | null => {
  const s = route.query.scope;
  return typeof s === "string" && (SEARCH_SCOPES as readonly string[]).includes(s) ? (s as SearchScope) : null;
};

/**
 * The scope the pane shows: the URL's. U4: as the other half of the split side panel, whose URL holds none of its keys,
 * the scope it showed before (`kept`), as its field keeps its text; opened as the other half, none (every kind).
 */
export function shownScope(route: Route, kept: SearchScope | null): SearchScope | null {
  return route.half?.path === false ? kept : scopeOf(route);
}

/** Where Esc and Close take this pane now (nav.ts closeHref, with the entry's history state). */
export function searchCloseTarget(chat: string | null, route: Route): string {
  const st = (typeof history !== "undefined" ? history.state : null) as EntryState | null;
  return closeHref(chat, viewOf(route), typeof st?.from === "string" ? st.from : undefined, docReach(st) > 0);
}

export function SearchPane({ route, chat, place }: { route: Route; chat: Chat | null; place: SearchPlace }) {
  const vp = useViewport();
  const chatId = chat?.id ?? null;
  const view = viewOf(route);
  // U4: as the other half of the split side panel the URL holds none of its keys, so the field keeps what it has, and
  // the scope the one it showed (shownScope).
  const other = route.half?.path === false;
  const keptScope = useRef<SearchScope | null>(null);
  const scope = chat ? shownScope(route, keptScope.current) : null;
  keptScope.current = scope;
  const routeQ = typeof route.query.q === "string" ? route.query.q : "";
  const [q, setQ] = useState(routeQ);
  const routeNow = useRef(route);
  routeNow.current = route;
  const shown = useDeferredValue(q);
  const { result, settled, has, messages } = usePaneData(chat, shown, scope, q);
  const rows = useMemo(() => flatRows(result), [result]);
  const listId = useId();
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // The active row, for the query it was moved under: a new query starts at the first row again.
  const [sel, setSel] = useState<Selection>({ q: "", i: 0 });
  const active = activeFor(sel, result.q, rows.length);
  // The field's query an Enter waits for (enterPick), or null.
  const waiting = useRef<string | null>(null);

  // ---- the URL: q is written with replaceState after the typing pauses, never on open ----
  const written = useRef(routeQ);
  const pending = useRef<{ q: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const write = useCallback(
    (next: string, nextScope: SearchScope | null = scope) => {
      written.current = next;
      // U4: typing in a half makes it the URL's own view; the places stay (layout/split.ts halfLink).
      navigate(halfLink(routeNow.current, searchHref(chatId, next, nextScope, view)), { replace: true });
    },
    [chatId, scope, view],
  );
  const flush = () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    write(p.q);
  };
  const drop = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  };
  const writeRef = useRef(write);
  writeRef.current = write;
  // A link, Back or Forward that changes q under the open pane fills the field with it.
  useEffect(() => {
    if (other || routeQ === written.current) return;
    written.current = routeQ;
    drop();
    setQ(routeQ);
  }, [routeQ, other]);
  useEffect(() => {
    // A reload while the typing pauses keeps the last letters; leaving the pane any other way drops the write.
    const hide = () => {
      const p = pending.current;
      if (!p) return;
      clearTimeout(p.timer);
      pending.current = null;
      writeRef.current(p.q);
    };
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      drop();
    };
  }, []);

  const typed = (next: string) => {
    waiting.current = null;
    setQ(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { q: next, timer: setTimeout(() => {
      pending.current = null;
      writeRef.current(next);
    }, Q_WRITE_MS) };
  };

  // ---- focus: on a laptop the field, on touch none until the user taps it (unless the key opened the pane) ----
  // The element that had the focus as the pane opened (the composer's field for Ctrl+K from it, the Search button that
  // a click focused) gets it back when Esc or Close closes the pane, while the focus is in the pane; with none (a
  // reload, a link), the composer's field on a laptop. Over the chat (1,000 to 1,087 px) the pane is a layer, which
  // gives the focus back itself (ui/primitives useLayer).
  const opener = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const ownFocus = place !== "over";
  useLayoutEffect(() => {
    const at = typeof document !== "undefined" ? document.activeElement : null;
    if (!opener.current && at instanceof HTMLElement && at !== document.body && !root.current?.contains(at)) opener.current = at;
    const byKey = takeKeyOpened();
    // U4: only the URL's own view takes the focus (the other half of a pair opens plain, also after a reload).
    if ((!vp.touch || byKey) && !other) field.current?.focus({ preventScroll: true });
    const box = root.current;
    return () => {
      if (!closing.current || !ownFocus) return;
      closing.current = false;
      const now = document.activeElement;
      if (now && now !== document.body && !box?.contains(now)) return;
      const inPane = (el: HTMLElement) => !!box?.contains(el);
      focusBackTo(opener.current, document.querySelector<HTMLElement>(COMPOSER_FIELD), inPane, vp.touch)?.focus({ preventScroll: true });
    };
    // Once, as the pane opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The active row stays in view as the arrows move it.
  useEffect(() => {
    const box = list.current;
    scrollWithin(box, box?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${active}`)}`));
  }, [active, listId]);

  const close = () => {
    drop();
    waiting.current = null;
    closing.current = true;
    closeTo(halfClose(route) ?? searchCloseTarget(chatId, route));
  };
  const pickNow = (hit: SearchHit) => {
    flush();
    // U4: from a half, a file or the uploads open in that half (or in the other one, when it shows their kind).
    navigate(halfLink(routeNow.current, pickHref(hit, chatId, view, q)));
  };
  const pickRef = useRef(pickNow);
  pickRef.current = pickNow;
  const pick = useCallback((hit: SearchHit) => pickRef.current(hit), []);
  const setScope = (next: SearchScope | null) => {
    drop();
    write(q, next);
  };

  // Enter on a list that answers an older query (the server's files lag the field for a moment) or before the file
  // list came waits for the list of the field's query (`waiting`), and picks its active row when it lands; a new
  // letter or a close drops the wait.
  useEffect(() => {
    if (waiting.current === null) return;
    if (waiting.current !== q) {
      waiting.current = null;
      return;
    }
    const hit = enterPick(rows, active, result.q, q, settled);
    if (hit === "wait") return;
    waiting.current = null;
    if (hit) pick(hit);
  }, [rows, active, result.q, q, settled, pick]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const k = paneKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, coarseNow());
    if (!k) return;
    e.preventDefault();
    if (k === "close") return close();
    if (k === "pick") {
      const hit = enterPick(rows, active, result.q, q, settled);
      if (hit === "wait") waiting.current = q;
      else if (hit) pick(hit);
      return;
    }
    if (rows.length) setSel({ q: result.q, i: moveActive(active, rows.length, k === "down" ? 1 : -1) });
  };

  // 5.4's one line. Beside the chat (the column, the docked pane, the layer) the conversation shows the router's line
  // for this route, so the pane adds only its own field's line (an over-cap q); on a screen of its own it shows both.
  const overQ = !("q" in route.query) && overCap("q", Q_CAP);
  const routerLine = linkNoticeLine(route);
  const ownLine = overQ && !routerLine ? TOO_LONG : null;
  const line = place === "column" || place === "pane" || place === "over" ? ownLine : (routerLine ?? ownLine);
  const scopes = chat ? scopesHere(has) : [];
  const heads = result.sections.length > 1;
  // U5: the empty line also waits for the Messages answer for q (or no ask was due); a failed ask with nothing else
  // shown says that instead.
  const listDone = settled && rows.length === 0 && q.trim() !== "" && result.q === q;
  const empty = listDone && messages.done && !messages.failed;
  const failed = listDone && messages.failed;
  const slow = messages.slow && !(messages.hits?.length);
  const closable = place === "column" || place === "pane" || place === "over";
  const projects = useStore((s) => s.projects);
  const folder = useProjectFolder(chatId ?? undefined);
  const mixed = useMemo(() => new Set(result.sections.find((s) => s.kind === "chats")?.rows.map((r) => (r.kind === "chats" ? r.chat.projectId : ""))).size > 1, [result]);
  // One hover handler for the pane's life, so a row whose hit did not change is not drawn again (Row is memoized).
  const listQ = useRef(result.q);
  listQ.current = result.q;
  const hover = useCallback((i: number) => setSel({ q: listQ.current, i }), []);
  let n = 0;

  return (
    <div ref={root} className={`srch srch-at-${place}`} data-testid="search" data-place={place} role="search" aria-label="Search">
      <div className="srch-head">
        <input
          ref={field}
          className="field srch-field"
          type="text"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
          aria-label={chat ? FIELD_NAME_CHAT : FIELD_NAME_PAGE}
          placeholder={chat ? "Search" : FIELD_NAME_PAGE}
          value={q}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          data-testid={SEARCH_FIELD_ID}
          onChange={(e) => typed(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {closable ? (
          <button type="button" className="icon-btn srch-close" aria-label="Close search" title="Close search" data-testid="search-close" onClick={close}>
            <IconClose size={16} />
          </button>
        ) : null}
      </div>
      {line ? (
        <p className="notice srch-line" data-testid="link-notice">
          {line}
        </p>
      ) : null}
      {scopes.length ? (
        // The scope control: no segment on shows every kind; a segment shows that kind only, and a second click or tap
        // on it (or Space) shows every kind again.
        <div
          className="srch-scope"
          onClickCapture={(e) => {
            const seg = (e.target as Element).closest('[role="radio"]');
            if (seg?.getAttribute("aria-checked") !== "true") return;
            e.stopPropagation();
            setScope(null);
          }}
        >
          <Segmented label="Show only" value={scope} options={scopes.map((s) => ({ value: s, label: SCOPE_LABEL[s], testId: `search-scope-${s}` }))} onChange={setScope} block small={!vp.touch} />
        </div>
      ) : null}
      <div
        ref={list}
        className="srch-list"
        id={listId}
        role="listbox"
        aria-label="Results"
        data-testid="search-results"
        data-q={result.q}
        data-count={result.count}
        data-messages={messages.due ? (messages.failed ? "failed" : messages.done ? "done" : "wait") : "off"}
      >
        {result.sections.map((s) => (
          <div key={s.kind} className="srch-group" role="group" aria-label={SECTION_TITLE[s.kind]} data-kind={s.kind} data-count={s.count}>
            {heads ? (
              <div className="srch-group-title" role="presentation" aria-hidden="true">
                {SECTION_TITLE[s.kind]}
              </div>
            ) : null}
            {s.rows.map((hit) => {
              const i = n++;
              return <Row key={hit.key} hit={hit} id={`${listId}-${i}`} index={i} active={i === active} mixed={mixed} projects={projects} touch={vp.touch} chatId={chatId} folder={folder} onPick={pick} onHover={hover} />;
            })}
          </div>
        ))}
        {slow ? (
          <div className="srch-wait" aria-hidden="true">
            {SEARCHING_MESSAGES}
          </div>
        ) : null}
      </div>
      {slow ? (
        <p className="visually-hidden" role="status">
          {SEARCHING_MESSAGES}
        </p>
      ) : null}
      {empty ? (
        <p className="srch-empty" data-testid="search-empty" role="status">
          {NOTHING_MATCHES(q)}
        </p>
      ) : failed ? (
        <p className="srch-empty" data-testid="search-failed" role="status">
          {MESSAGES_FAILED}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A name with its matched letters in bold, as text children (never HTML). `lead` (U5: "You: ") goes before the text in a
 * left-to-right span of its own, which dir="auto" passes over, so the text still sets the span's direction.
 */
function Marked({ text, ranges, className, lead }: { text: string; ranges: SearchHit["ranges"]; className?: string; lead?: string }) {
  return (
    <span className={className} dir="auto">
      {lead ? (
        <span className="srch-who" dir="ltr">
          {lead}
        </span>
      ) : null}
      {pieces(text, ranges).map((p, i) =>
        p.hit ? (
          <strong key={i} className="srch-hit">
            {p.text}
          </strong>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

/** A path on one line: the folder part dimmed before the name, cut from its start when the row is narrow. */
function PathParts({ path, nameStart, ranges }: { path: string; nameStart: number; ranges: SearchHit["ranges"] }) {
  const dir = path.slice(0, nameStart);
  return (
    <span className="srch-path" title={path}>
      {dir ? (
        <span className="srch-dir">
          <bdi>{dir}</bdi>
        </span>
      ) : null}
      <Marked text={path.slice(nameStart)} ranges={ranges} className="srch-name" />
    </span>
  );
}

/**
 * U5: a Messages row's name, its aria-label. A chat's first row: its title, its project (when known), Archived (for an
 * archived chat), when, then the line, with a comma between each; a later row of the same chat: the title, a colon,
 * the line. The user's own line starts with "You: ", as the row shows it. Named from its content, Chrome read the first
 * row as "Title , project 3 min Line…": each part is a box of its own, so a space came before the hidden comma and
 * nothing parted the time from the line.
 */
export function messageRowName(title: string, line: string, by: MessageRowHit["by"], first: { project: string | undefined; archived: boolean; when: string } | null): string {
  const said = by === "user" ? `${YOU_PREFIX}${line}` : line;
  if (!first) return `${title}: ${said}`;
  return [title, first.project, first.archived ? "Archived" : null, first.when, said].filter((x): x is string => !!x).join(", ");
}

const Row = memo(function Row(props: {
  hit: SearchHit;
  id: string;
  index: number;
  active: boolean;
  mixed: boolean;
  projects: readonly Project[];
  touch: boolean;
  /** The chat whose folder a file hit is in (its menu), or null on /search. */
  chatId: string | null;
  folder: string | undefined;
  onPick: (hit: SearchHit) => void;
  onHover: (i: number) => void;
}) {
  const { hit, id, index, active, mixed, projects, touch, chatId, folder, onPick, onHover } = props;
  const menu = useRowMenu((here) => (hit.kind === "files" && chatId ? fileMenu({ place: "hit", chatId, path: hit.path, folder, open: fileOpener(chatId, here.route), laptop: here.laptop, origin: here.origin }) : null), { openerClass: "srch-more" });
  let body: ReactNode;
  let extra = "";
  let tip: string | undefined;
  let label: string | undefined;
  switch (hit.kind) {
    case "chats": {
      const c = hit.chat;
      const project = mixed ? projects.find((p) => p.id === c.projectId)?.name : undefined;
      body = (
        <>
          {MARKED.has(c.state) ? <StateDot state={c.state} /> : null}
          <Marked text={c.title} ranges={hit.ranges} className="srch-title" />
          {MARKED.has(c.state) ? <span className="visually-hidden">, {STATE_WORD[c.state]}</span> : null}
          {project ? <span className="srch-project">{project}</span> : null}
        </>
      );
      break;
    }
    case "files":
      body = (
        <>
          <IconFile size={16} className="srch-icon" aria-hidden="true" />
          <PathParts path={hit.path} nameStart={hit.nameStart} ranges={hit.ranges} />
        </>
      );
      break;
    case "uploads":
      body = (
        <>
          {hit.upload.type.startsWith("image/") ? <IconImage size={16} className="srch-icon" aria-hidden="true" /> : <IconFile size={16} className="srch-icon" aria-hidden="true" />}
          <PathParts path={hit.path} nameStart={hit.nameStart} ranges={hit.ranges} />
        </>
      );
      break;
    case "messages": {
      // U5: the chat's first row: its title, Archived and when, then the line ("You: " first for the user's own); a
      // later row: the line alone. Its name (messageRowName) holds the project too, which only the name and, on a
      // laptop, the tooltip carry.
      const c = hit.chat;
      const line = <Marked text={hit.snippet} ranges={hit.ranges} className="srch-snippet" lead={hit.by === "user" ? YOU_PREFIX : undefined} />;
      if (!hit.first) {
        extra = " srch-more";
        label = messageRowName(c.title, hit.snippet, hit.by, null);
        body = line;
        break;
      }
      const project = projects.find((p) => p.id === c.projectId)?.name;
      const when = relTime(c.updatedAt, Date.now());
      if (project && !touch) tip = `${c.title}, ${project}`;
      label = messageRowName(c.title, hit.snippet, hit.by, { project, archived: !!c.archived, when });
      body = (
        <>
          <span className="srch-msg-head">
            <span className="srch-title">{c.title}</span>
            {c.archived ? <span className="srch-tag">Archived</span> : null}
            <span className="srch-when">{when}</span>
          </span>
          {line}
        </>
      );
      break;
    }
    case "commands": {
      const c = hit.command;
      extra = " cmp-slash-row";
      body = (
        <>
          <span className="cmp-slash-name">
            /<Marked text={c.name} ranges={hit.ranges} />
          </span>
          {c.args ? <span className="cmp-slash-args">{c.args}</span> : null}
          <span className="cmp-slash-hint">{c.hint}</span>
          {c.terminalOnly ? <span className="cmp-tag">Open in terminal</span> : c.source !== "built-in" ? <span className="cmp-tag">yours</span> : null}
        </>
      );
      break;
    }
  }
  return (
    <>
      <div
        id={id}
        role="option"
        aria-selected={active}
        aria-disabled={hit.kind === "commands" && hit.command.terminalOnly ? true : undefined}
        data-active={active ? "true" : undefined}
        data-kind={hit.kind}
        data-testid="search-row"
        className={`menu-row srch-row srch-${hit.kind}${extra}`}
        title={tip}
        aria-label={label}
        onClick={() => onPick(hit)}
        {...menu.target}
        onPointerMove={(e) => {
          menu.target.onPointerMove(e);
          if (e.pointerType === "mouse" && !active) onHover(index);
        }}
      >
        {body}
        {menu.opener}
      </div>
      {menu.menu}
    </>
  );
});
