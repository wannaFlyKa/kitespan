// The side panel (DESIGN.md 6.7, 5.3): the session details cards and their detail views, in three forms, drawn as
// grouped lists on the look's grouped background (plan v3).
//   column: the laptop's right column (Hide session rail hides it); a detail route shows that detail in it
//   pane:   the docked pane of a medium touch device, or the pane over the chat of a narrow laptop, open on the
//           details and card routes
//   sheet:  the Details sheet on the phone, over the chat
// The chat's uploads (/c/<chat>/uploads, D37) and a file's download view (/c/<chat>/files/<path>) take the panel's
// place too. A view below the cards has one header row (D51): "< Context" at the left, which closes it to
// /c/<chat>/details; in the pane the close button stays at the right with no title beside the lit pane bar button
// (M34), and in the phone's sheet Done sits at the right with no second title row (M27). In the pane, the chat's
// uploads and a file are the pane bar's Files pane, not a view of Details: they have the close button only, and the
// cards list no Uploads row there, so the lit bar button and the pane always agree (7.3, D51); the column and the
// phone's sheet keep "< Uploads", where the uploads are a detail of Details.
// U4: a view in a half of the split side panel keeps its form (the column's has no head, the pane's its head with
// Close, but for a head that would hold only Close: the lit pane bar button closes that half); its links keep the other
// half (format.ts viewUrl), its back row goes back in its own place (backUrl), and its Close gives the whole pane to
// the other half.
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { closeTo, type Route } from "../router";
import type { Chat } from "../state/types";
import type { SideMode } from "../layout/Shell";
import { Scrim, useLayer } from "../ui/primitives";
import { IconClose } from "../ui/icons";
import { Cards } from "./cards";
import { BackRow, DETAIL_LABEL, DETAIL_NAMES, Detail, type DetailName } from "./details";
import { UploadsView } from "./uploads";
import { FileView } from "./file";
import { backUrl, cleanRel, viewUrl } from "./format";
import { usePanelReads } from "./parts";
import { halfClose } from "../layout/split";

export function SidePanel({ chat, route, mode, reads = true }: { chat: Chat; route: Route; mode: SideMode; reads?: boolean }) {
  // U4: where both halves of the split are side panel views, one of them reads the cards' facts (Shell.tsx).
  usePanelReads(chat, reads);
  const uploads = route.name === "uploads";
  const file = route.name === "files";
  const detail = DETAIL_NAMES.has(route.name) ? (route.name as DetailName) : null;
  const view = uploads ? "uploads" : file ? "file" : (detail ?? "cards");
  const body = uploads ? (
    <UploadsView chat={chat} route={route} place={mode} />
  ) : file ? (
    <FileView key={route.params.path} chat={chat} route={route} place={mode} />
  ) : detail ? (
    <Detail key={detail} name={detail} chat={chat} route={route} />
  ) : (
    <Cards chat={chat} route={route} paneBar={mode === "pane"} />
  );
  const title = uploads ? "Uploads" : file ? "Files" : detail ? DETAIL_LABEL[detail] : "Details";
  const back = mode === "pane" && (uploads || file) ? null : backRow(chat, route, view, detail);
  // U4: in a half of the split, Close gives the whole pane to the other view (layout/split.ts halfClose).
  const close = () => closeTo(halfClose(route) ?? viewUrl("chat", chat.id, route));
  // U4: in a half of the tablet's pane, a head that would hold only Close (the cards, Uploads, a file) is left out: the
  // lit pane bar button beside it closes the half (DESIGN-U4 4.3). A head with a back row ("< Context") stays.
  const head = mode === "pane" && !(route.half && !back);

  if (mode === "sheet")
    return (
      <PanelSheet title={title} back={back} onClose={close}>
        <div className="side-panel side-mode-sheet" data-mode="sheet" data-view={view}>
          {body}
        </div>
      </PanelSheet>
    );

  return (
    <div className={`side-panel side-mode-${mode}${mode === "pane" && !head ? " side-no-head" : ""}`} data-testid="side-panel" data-mode={mode} data-view={view} role="region" aria-label={title}>
      {head ? (
        <div className="side-pane-head">
          {back ?? <span />}
          <button type="button" className="icon-btn" aria-label={`Close ${title}`} title={`Close ${title}`} onClick={close}>
            <IconClose size={16} />
          </button>
        </div>
      ) : (
        back
      )}
      {body}
    </div>
  );
}

/**
 * The header row of a view below the cards: back to Details, or for a file that Claude edited, back to Outputs. U4:
 * in a half it goes back in that half, or to its target alone when the other half shows the target's kind (format.ts
 * backUrl).
 */
function backRow(chat: Chat, route: Route, view: string, detail: DetailName | null): ReactNode {
  if (view === "cards") return null;
  const details = backUrl("details", chat.id, route);
  if (detail) return <BackRow label={DETAIL_LABEL[detail]} to={details} />;
  if (view === "uploads") return <BackRow label="Uploads" to={details} />;
  const path = cleanRel(route.params.path ?? "");
  const output = chat.outputs.some((o) => cleanRel(o.path) === path || cleanRel(o.path).startsWith(`${path}/`));
  return output ? <BackRow label="Outputs" to={backUrl("outputs", chat.id, route)} aria="Back to Outputs" /> : <BackRow label="Details" to={details} aria="Back to Details" />;
}

/**
 * The phone's Details sheet (7.6): the grip, then one header row, the title and Done on the cards, "< Context" and
 * Done on a view below them. A modal layer: it takes the focus, keeps Tab inside, and Esc or Done closes it.
 */
function PanelSheet({ title, back, onClose, children }: { title: string; back: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer({ active: true, box: ref, onClose, modal: true });
  return createPortal(
    <>
      <Scrim onClick={onClose} />
      <div className="sheet side-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="side-panel" ref={ref} tabIndex={-1}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          {back ? <span className="side-sheet-back">{back}</span> : null}
          <h2 className={back ? "visually-hidden" : "sheet-title"} id={titleId} dir="auto">
            {title}
          </h2>
          <button type="button" className="btn plain sheet-done" data-testid="sheet-done" onClick={onClose}>
            Done
          </button>
        </div>
        {children}
      </div>
    </>,
    document.body,
  );
}
