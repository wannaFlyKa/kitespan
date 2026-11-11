// U1 (DESIGN-U1 6): the changed-files card under a finished turn's answer, the turn's last part (a folded turn keeps
// it: it is part of the answer, not the work). One hairline box with the look's card radius, no fill: the head ("3 files
// changed" in --dim, the turn's counts) opens the turn's list in the side panel, and each row (the path with its folder
// part dimmed, its counts in the diff's own colours) opens that file's diff. A row is an opener outside the panel
// (layout/split.ts openHref), so with the Terminal open the diff lands above it. More than five files: four rows and
// "N more files". One file: its row alone. While the panel shows this turn, the head or the open row is marked
// (--selected, aria-current). On the phone (row 115) the head alone, as plain text: no link, no rows, nothing opens;
// a changes route lands on it and marks it as a linked message is. No motion: it comes with its event. A row has the
// file's menu (DESIGN-T1 2.1: Open file, Attach as context, Copy path; on a laptop also Open in new tab and Copy link of
// its diff): a long press or its "..." on touch, a right-click on a laptop.
import { memo } from "react";
import type { Route } from "../router";
import { openHref } from "../layout/split";
import { PathLine } from "../panels/parts";
import { viewOf } from "../panels/format";
import { Link } from "../ui/primitives";
import { useTranscript } from "../chat/items/context";
import { useProjectFolder } from "../chat/items/Files";
import { fileMenu } from "../ui/fileMenu";
import { fileOpener, useRowMenu } from "../ui/RowMenu";
import { cardItemId, cardModel, countParts, countWord, rowLabel, type ChangedFile, type ChangesNote } from "./model";
import { changesHref } from "./nav";

/** The counts' two slots: +N in --ok and -N in --danger, a 0 left blank; read through the row's own name. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  const c = countParts(added, removed);
  return (
    <span className="chg-count" aria-hidden="true">
      <span className="is-add">{c.add}</span>
      <span className="is-del">{c.del}</span>
    </span>
  );
}

/**
 * A row's end: its counts, or Binary or Too large in their place; with `status` (the card, whose rows have no status
 * column), Renamed, New or Deleted for a file with no lines added or removed.
 */
export function RowEnd({ file, status = false }: { file: ChangedFile; status?: boolean }) {
  const word = countWord(file, status);
  return word ? (
    <span className="chg-word" aria-hidden="true">
      {word}
    </span>
  ) : (
    <Counts added={file.added} removed={file.removed} />
  );
}

/**
 * `open`: what the side panel shows of this turn now ("" its list, a path that file's diff, null nothing). `live`:
 * the split shows (layout/split.ts useSplitLive), so a row opens beside the view that shows.
 */
export const ChangesCard = memo(function ChangesCard({ note, chatId, route, live, phone, open }: { note: ChangesNote; chatId: string; route: Route; live: boolean; phone: boolean; open: string | null }) {
  const m = cardModel(note);
  const id = cardItemId(note.id);
  const marked = useTranscript()?.highlightId === id;
  const cls = `chat-item chat-compact chat-item-changes${marked ? " is-highlight" : ""}`;
  if (phone)
    return (
      <div className={cls} data-item-id={id} data-testid="changes-card" data-changes={note.id}>
        <p className="chg-line-phone">
          <span className="visually-hidden">{m.label}</span>
          <span className="chg-title" aria-hidden="true">
            {m.line}
          </span>
          <Counts added={note.added} removed={note.removed} />
        </p>
      </div>
    );
  const view = viewOf(route);
  const to = (path?: string) => openHref(route, changesHref(chatId, note.id, path, view), live);
  return (
    <div className={cls} data-item-id={id} data-testid="changes-card" data-changes={note.id}>
      <section className="chg-card" aria-label={m.label}>
        {m.head ? (
          <Link to={to()} className="chg-head" aria-current={open === "" ? "page" : undefined} aria-label={m.head.label} data-testid="changes-head">
            <span className="chg-title">{m.head.words}</span>
            <Counts added={m.head.added} removed={m.head.removed} />
          </Link>
        ) : null}
        <ul className="chg-rows">
          {m.rows.map((f) => (
            <CardRow key={f.path} file={f} chatId={chatId} to={to(f.path)} current={open === f.path} />
          ))}
          {m.more ? (
            <li>
              <Link to={to()} className="chg-row chg-more" data-testid="changes-more">
                {m.moreWords}
              </Link>
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
});

/** One changed file: its diff, and its menu. */
function CardRow({ file, chatId, to, current }: { file: ChangedFile; chatId: string; to: string; current: boolean }) {
  const folder = useProjectFolder(chatId);
  const menu = useRowMenu((here) => fileMenu({ place: "changes", chatId, path: file.path, folder, open: fileOpener(chatId, here.route), link: to, laptop: here.laptop, origin: here.origin }), { openerClass: "chg-row-more" });
  return (
    <li>
      <Link to={to} className="chg-row" aria-current={current ? "page" : undefined} aria-label={rowLabel(file)} data-testid="changes-row" draggable={menu.touch ? false : undefined} {...menu.target}>
        <PathLine path={file.path} />
        <RowEnd file={file} status />
      </Link>
      {menu.opener}
      {menu.menu}
    </li>
  );
}
