// U1 (DESIGN-U1 7): the changes view, the side panel's sixth kind: a turn's list of changed files, and one file's diff.
// It takes the side panel's place where the panel docks (the laptop's column, wider for code by the Terminal's width
// rule; the tablet's docked pane), over the chat where the panel opens over it, and a half of U4's split, the Terminal
// below it. Its head, at the look's --header-h with a hairline under it: on the list "Changes", the turn's counts and
// Close changes; on a file "< Changes" and Close changes. Esc with the focus inside closes it too, and the focus goes
// back to what opened it (a card's row), else the message box.
// The list: every file of the summary with New, Deleted or Renamed where it applies and its counts, each a link to its
// diff in the same half; a foot line for the changes left out (4.2). One file: its name as the title, its counts, its
// folder in --dim, one line for New file, Deleted or Renamed from; then the diff, unified on --code-bg, both line
// numbers, the sign and the text, the Edit row's tints, long lines wrapping under their own text, a dashed seam between
// hunks with git's context line. No side by side, no syntax colour, and nothing here acts on the files: it only shows.
// A row of the list has the file's menu, as the card's rows (DESIGN-T1 2.1).
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { closeTo, href, type Route } from "../router";
import type { Chat } from "../state/types";
import { halfBack, halfClose, halfLink } from "../layout/split";
import { useViewport } from "../layout/size";
import { BackRow } from "../panels/details";
import { PathLine } from "../panels/parts";
import { baseName, dirName, viewOf } from "../panels/format";
import { focusBackTo } from "../search/focus";
import { IconClose } from "../ui/icons";
import { Link, composingKey } from "../ui/primitives";
import { imeHolds } from "../composer/composition";
import { Counts, RowEnd } from "./ChangesCard";
import { useDiff, useSlow, useSummary, type DiffState } from "./api";
import { CHANGES_WORDS, diffRows, elsewhereFoot, fallbackLine, fileNote, listFoot, moreFiles, moreLines, noLines, numberWidth, rowLabel, statusWord, tooLarge, type ChangedFile, type ChangesNote, type ChangesSummary, type DiffHunk, type FileDiff } from "./model";
import { changesHref } from "./nav";
import { useProjectFolder } from "../chat/items/Files";
import { fileMenu } from "../ui/fileMenu";
import { fileOpener, useRowMenu } from "../ui/RowMenu";

/** Where the view sits: the laptop's column, the tablet's docked pane, or over the chat (a narrow laptop). */
export type ChangesPlace = "column" | "pane" | "over";

const COMPOSER_FIELD = '[data-testid="composer"] [data-testid="composer-input"]';

export function ChangesView({ chat, route, place }: { chat: Chat; route: Route; place: ChangesPlace }) {
  const vp = useViewport();
  const turn = route.params.turn ?? "";
  const path = route.name === "changesFile" ? (route.params.path ?? "") : null;
  const [attempt, setAttempt] = useState(0);
  const summary = useSummary(chat.id, turn, attempt);
  const note = chat.changes?.find((c) => c.id === turn) ?? null;
  const view = viewOf(route);
  const chatUrl = href("chat", { chat: chat.id }, { view });
  const root = useRef<HTMLElement>(null);

  // ---- focus: the region as it opens and at each of its views (only the URL's own view, U4); Close and Esc give it
  // back to what opened it, else the message box on a laptop. Over the chat the layer gives it back. ----
  const opener = useRef<HTMLElement | null>(null);
  const closing = useRef(false);
  const own = route.half?.path !== false;
  const at = route.name === "changesFile" ? `${turn}/${path}` : turn;
  useLayoutEffect(() => {
    const box = root.current;
    const now = typeof document !== "undefined" ? document.activeElement : null;
    if (now instanceof HTMLElement && now !== document.body && !box?.contains(now)) opener.current = now;
    if (own && box && (!now || now === document.body || !now.matches("input, textarea, [contenteditable]") || box.contains(now))) box.focus({ preventScroll: true });
    // At each of its views: a row of the list, a card's row, Back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  useLayoutEffect(() => {
    const box = root.current;
    return () => {
      if (!closing.current || place === "over") return;
      closing.current = false;
      const now = document.activeElement;
      if (now && now !== document.body && !box?.contains(now)) return;
      const inside = (el: HTMLElement) => !!box?.contains(el);
      focusBackTo(opener.current, document.querySelector<HTMLElement>(COMPOSER_FIELD), inside, vp.touch)?.focus({ preventScroll: true });
    };
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    closing.current = true;
    // U4: in a half of the split side panel, the other view takes the whole pane.
    closeTo(halfClose(route) ?? chatUrl);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || composingKey(e.nativeEvent, vp.touch) || imeHolds() || place === "over") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const s = summary.phase === "ok" ? summary.summary : null;
  const file = path === null ? null : (s?.files.find((f) => f.path === path) ?? note?.files.find((f) => f.path === path) ?? null);
  const name = path === null ? CHANGES_WORDS.title : baseName(path) || path;
  const totals = s ?? note;
  const head =
    path === null ? (
      <>
        <h2 className="chg-view-title">{CHANGES_WORDS.title}</h2>
        {totals ? <Counts added={totals.added} removed={totals.removed} /> : null}
      </>
    ) : (
      <BackRow label={CHANGES_WORDS.title} to={halfBack(route, changesHref(chat.id, turn, undefined, view))} aria={CHANGES_WORDS.back} />
    );
  return (
    <section ref={root} className={`chg-view chg-place-${place}`} role="region" aria-label={name} tabIndex={-1} data-testid="changes-view" data-view={path === null ? "list" : "file"} onKeyDown={onKeyDown}>
      <div className="chg-view-head">
        {head}
        <button type="button" className="icon-btn chg-close" aria-label={CHANGES_WORDS.close} title={CHANGES_WORDS.close} onClick={close} data-testid="changes-close">
          <IconClose size={16} />
        </button>
      </div>
      <div className="chg-scroll">
        {summary.phase === "gone" ? (
          <Say line={CHANGES_WORDS.notKept} />
        ) : path === null ? (
          <ListPart summary={summary.phase === "ok" ? summary.summary : null} failed={summary.phase === "failed"} note={note} chatId={chat.id} link={(p) => halfLink(route, changesHref(chat.id, turn, p, view))} retry={() => setAttempt((n) => n + 1)} />
        ) : (
          <FilePart key={path} chat={chat.id} turn={turn} path={path} file={file} summary={s} />
        )}
      </div>
    </section>
  );
}

/** One quiet line of the view (a state, a fallback, a foot). */
function Say({ line, status = false }: { line: string; status?: boolean }) {
  return (
    <p className="chg-say" data-testid="changes-line" role={status ? "status" : undefined}>
      {line}
    </p>
  );
}

/** A read that failed: its line and Try again (a read again). */
function Failed({ line, retry }: { line: string; retry: () => void }) {
  return (
    <div className="chg-failed">
      <Say line={line} />
      <button type="button" className="btn plain chg-retry" onClick={retry} data-testid="changes-retry">
        {CHANGES_WORDS.tryAgain}
      </button>
    </div>
  );
}

function ListPart({ summary, failed, note, chatId, link, retry }: { summary: ChangesSummary | null; failed: boolean; note: ChangesNote | null; chatId: string; link: (path: string) => string; retry: () => void }) {
  if (failed && !note) return <Failed line={CHANGES_WORDS.listFailed} retry={retry} />;
  // While the summary comes, the card's own files (all of them when the turn changed five or fewer).
  const shown = summary ?? (note && note.files.length === note.total ? { ...note, others: 0 } : null);
  if (!shown) return failed ? <Failed line={CHANGES_WORDS.listFailed} retry={retry} /> : null;
  return (
    <>
      {shown.how === "edits" ? <Say line={fallbackLine(shown.why)} /> : null}
      <ListBody summary={shown} link={link} chatId={chatId} />
      {failed ? <Failed line={CHANGES_WORDS.listFailed} retry={retry} /> : null}
    </>
  );
}

/**
 * The turn's files, each a link to its diff, and the foot lines (DESIGN-U1 7.2). Each row's status word has a cell of
 * its own (empty for an edit), so the words and the counts stand in two columns (the list's grid, changes.css).
 */
export function ListBody({ summary, link, chatId }: { summary: ChangesSummary; link: (path: string) => string; chatId?: string }) {
  const foot = listFoot(summary.others);
  const theirs = elsewhereFoot(summary.elsewhere);
  const past = summary.total - summary.files.length;
  return (
    <>
      <ul className="group side-group chg-list">
        {summary.files.map((f) => (
          <ListRow key={f.path} file={f} to={link(f.path)} chatId={chatId} />
        ))}
      </ul>
      {past > 0 ? <p className="chg-foot">{moreFiles(past)}</p> : null}
      {foot ? <p className="chg-foot">{foot}</p> : null}
      {theirs ? <p className="chg-foot">{theirs}</p> : null}
    </>
  );
}

/** One file of the list: its diff, and its menu (none outside a chat). */
function ListRow({ file, to, chatId }: { file: ChangedFile; to: string; chatId?: string }) {
  const word = statusWord(file.status);
  const folder = useProjectFolder(chatId);
  const menu = useRowMenu((here) => (chatId ? fileMenu({ place: "changes", chatId, path: file.path, folder, open: fileOpener(chatId, here.route), link: to, laptop: here.laptop, origin: here.origin }) : null), { openerClass: "chg-row-more" });
  return (
    <li>
      <Link to={to} className="group-row chg-list-row" aria-label={rowLabel(file, word)} data-testid="changes-list-row" draggable={menu.touch ? false : undefined} {...menu.target}>
        <PathLine path={file.path} />
        <span className="chg-word chg-status" aria-hidden="true">
          {word ?? ""}
        </span>
        <RowEnd file={file} />
      </Link>
      {menu.opener}
      {menu.menu}
    </li>
  );
}

/** One file's head: its name as the title, its counts (or Binary, Too large), its folder, its one line. */
export function FileHead({ file }: { file: ChangedFile }) {
  const dir = dirName(file.path);
  const line = fileNote(file);
  return (
    <div className="chg-file">
      <div className="chg-file-line">
        <h2 className="side-page-title chg-file-name">{baseName(file.path) || file.path}</h2>
        <RowEnd file={file} />
      </div>
      {dir ? (
        <p className="chg-file-dir">
          <bdi>{dir}</bdi>
        </p>
      ) : null}
      {line ? <p className="chg-file-note">{line}</p> : null}
    </div>
  );
}

function FilePart({ chat, turn, path, file, summary }: { chat: string; turn: string; path: string; file: ChangedFile | null; summary: ChangesSummary | null }) {
  const [attempt, setAttempt] = useState(0);
  const diff = useDiff(chat, turn, path, attempt);
  const slow = useSlow(diff.phase === "loading");
  const known = file ?? (diff.phase === "ok" ? fileOfDiff(diff.diff) : null);
  return (
    <>
      {known && diff.phase !== "missing" && diff.phase !== "notKept" ? <FileHead file={known} /> : null}
      {summary?.how === "edits" && diff.phase !== "missing" ? <Say line={fallbackLine(summary.why)} /> : null}
      <DiffPart state={diff} slow={slow} retry={() => setAttempt((n) => n + 1)} />
    </>
  );
}

/** A diff's own facts as a row of the list has them (a file past the summary's 1,000, or before the summary came). */
function fileOfDiff(d: FileDiff): ChangedFile {
  return { path: d.path, status: d.status, added: d.added, removed: d.removed, ...(d.from ? { from: d.from } : {}), ...(d.binary ? { binary: true as const } : {}), ...(d.large ? { large: true as const } : {}) };
}

function DiffPart({ state, slow, retry }: { state: DiffState; slow: boolean; retry: () => void }) {
  switch (state.phase) {
    case "loading":
      return slow ? <Say line={CHANGES_WORDS.reading} status /> : null;
    case "gone":
      return <Say line={CHANGES_WORDS.gone} />;
    case "missing":
      return <Say line={CHANGES_WORDS.notInTurn} />;
    case "notKept":
      return <Say line={CHANGES_WORDS.notKept} />;
    case "failed":
      return <Failed line={CHANGES_WORDS.failed} retry={retry} />;
    case "ok":
      return <DiffOf diff={state.diff} />;
  }
}

/** One file's diff, or its one line: binary, too large, a notebook, or no lines to show (a pure rename, an empty file). */
export function DiffOf({ diff }: { diff: FileDiff }) {
  if (diff.binary) return <Say line={CHANGES_WORDS.binaryLine} />;
  if (diff.large) return <Say line={tooLarge(diff.large.bytes)} />;
  if (diff.notebook) return <Say line={CHANGES_WORDS.notebook} />;
  const none = noLines(diff);
  if (none) return <Say line={none} />;
  if (!diff.hunks.length) return null;
  return <DiffBody hunks={diff.hunks} cut={diff.cut} />;
}

/**
 * The diff: unified, three lines of context, each line its old number, its new number, its sign and its text (a hidden
 * word says added or removed and its line). The number columns are as wide as the file's widest number; a new or a
 * deleted file has one side only, so one column (the critique's removal: an empty column is code's room lost).
 */
export function DiffBody({ hunks, cut }: { hunks: readonly DiffHunk[]; cut?: { shown: number; more: number } }) {
  const rows = diffRows(hunks);
  const lines = rows.filter((r) => r.k === "line");
  const hasOld = lines.some((r) => r.old !== null);
  const hasNew = lines.some((r) => r.new !== null);
  const both = (hasOld && hasNew) || (!hasOld && !hasNew);
  const style = { "--ln-w": `${numberWidth(hunks)}ch`, "--ln-n": both ? 2 : 1 } as CSSProperties;
  const nums = (old: number | null, next: number | null) =>
    both ? (
      <>
        <span className="chg-ln">{old ?? ""}</span>
        <span className="chg-ln">{next ?? ""}</span>
      </>
    ) : (
      <span className="chg-ln">{(hasOld ? old : next) ?? ""}</span>
    );
  return (
    <>
      <div className="chg-diff" style={style} data-testid="changes-diff">
        {rows.map((r, i) =>
          r.k === "hunk" ? (
            <div key={i} className={`chg-hunk${r.seam ? " is-seam" : ""}`} role="separator" aria-label={r.context || undefined}>
              <span>{r.context}</span>
            </div>
          ) : r.k === "note" ? (
            <div key={i} className="chg-dl is-note">
              {nums(null, null)}
              <span className="chg-sign" aria-hidden="true" />
              <span className="chg-lt">{r.text}</span>
            </div>
          ) : (
            <div key={i} className={`chg-dl${r.sign === "+" ? " is-add" : r.sign === "-" ? " is-del" : ""}`}>
              {nums(r.old, r.new)}
              <span className="chg-sign" aria-hidden="true">
                {r.sign === " " ? "" : r.sign}
              </span>
              <span className="chg-lt">
                {r.sign === "+" ? <span className="visually-hidden">{`Added, line ${r.new} `}</span> : r.sign === "-" ? <span className="visually-hidden">{`Removed, line ${r.old} `}</span> : null}
                {r.text || " "}
              </span>
            </div>
          ),
        )}
      </div>
      {cut ? <p className="chg-say">{moreLines(cut.more)}</p> : null}
    </>
  );
}
