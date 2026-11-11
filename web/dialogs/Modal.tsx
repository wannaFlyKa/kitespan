// The dialogs' one frame (DESIGN.md 5.3): a centred dialog on a laptop and a medium touch device, a bottom sheet on a
// phone; a `full` dialog (New environment) is the sheet on every touch size. Both trap the focus while they are open and give it back to the control that opened them (ui/primitives).
// The sheet (plan v3, 7.6) has the grabber, the title centred and Done at the top right, which closes it; so a dialog
// in a sheet shows only the button that names its action, full width (useModalSheet), and no Cancel beside Done. A
// confirm sheet (Archive, Delete, Stop) says Cancel there instead of Done (E5), because "Done" beside "Delete" could
// read as "delete it"; the rename and New environment sheets do too (CancelSheet), as the top-right word drops what
// was typed or browsed. Those two hold a field: while it has the focus and the on-screen keyboard is up, the sheet
// rides the visual viewport as the composer does (7.8), its foot on the keyboard and at most as tall as what shows, so
// the field and Save or Use this folder stay in view. Styles only, never a change of the element tree: a remount would
// close the iOS keyboard. A `full` sheet (New environment, D54) takes the full height, so a long folder list scrolls
// inside it under its field; it is the sheet on a tablet too (600 px wide there, base.css), because a centred dialog
// stays where it is under a tablet's keyboard (iPadOS does not shrink the layout for it), and its Cancel at the foot
// with it. The dialog then gets no first focus but a [data-autofocus] element, so a touch device's keyboard stays down
// until the user taps the field.
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useViewport } from "../layout/size";
import { useFocusInside, useSoftKeyboard } from "../composer/keyboard";
import { Dialog, Popup, Scrim, useLayer } from "../ui/primitives";

/** True where Modal draws a bottom sheet (the phone; a `full` one on every touch size): its top-right word closes it,
 *  so leave Cancel out. */
export function useModalSheet(full = false): boolean {
  const vp = useViewport();
  return vp.size === "phone" || (full && vp.touch);
}

/** The word at the top right of a sheet: Done, or Cancel on a confirm sheet (DESIGN.md 7.6). */
export function sheetCloseWord(confirm: boolean): "Done" | "Cancel" {
  return confirm ? "Cancel" : "Done";
}

/**
 * `cancelFirst` (R127, the Trust this folder confirm): Cancel takes the first focus, as Claude Code's own trust dialog
 * focuses "No": on the phone's confirm sheet its Cancel at the top right (the dialog marks its own Cancel with
 * data-autofocus). `closeWord` (R127): the confirm sheet's top-right word now, for a confirm whose action can go while
 * it is open (Done once there is nothing to cancel); the sheet stays the same element, so it does not rise again and
 * its top-right button keeps the focus. `className`: the body's own class beside scr-dlg.
 */
export function Modal({ title, testId, onClose, confirm = false, full = false, cancelFirst = false, closeWord, className, children }: { title: string; testId: string; onClose: () => void; confirm?: boolean; full?: boolean; cancelFirst?: boolean; closeWord?: "Done" | "Cancel"; className?: string; children: ReactNode }) {
  const sheet = useModalSheet(full);
  const body = (base: string) => (className ? `${base} ${className}` : base);
  if (sheet && (confirm || full))
    return (
      <CancelSheet title={title} testId={testId} onClose={onClose} full={full} cancelFirst={cancelFirst} word={closeWord}>
        <div className={body("scr-dlg scr-dlg-sheet")}>{children}</div>
      </CancelSheet>
    );
  if (sheet)
    return (
      <Popup open onClose={onClose} title={title} testId={testId}>
        <div className={body("scr-dlg scr-dlg-sheet")}>{children}</div>
      </Popup>
    );
  return (
    <Dialog open onClose={onClose} title={title} testId={testId} initial={full ? (box) => box.querySelector<HTMLElement>("[data-autofocus]") : undefined}>
      <div className={body("scr-dlg")}>{children}</div>
    </Dialog>
  );
}

/** The phone's sheet with Cancel at the top right in Done's place: a confirm (Modal's `confirm`), the rename form, and
 *  New environment (on every touch size), which is `full`: the full height, and the visual viewport's while it rides.
 *  `word`: the top-right word, when the caller says (Done once a confirm has nothing to cancel); else Cancel. */
export function CancelSheet({ title, testId, onClose, full = false, cancelFirst = false, word = sheetCloseWord(true), children }: { title: string; testId: string; onClose: () => void; full?: boolean; cancelFirst?: boolean; word?: "Done" | "Cancel"; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer({ active: true, box: ref, onClose, modal: true, initial: () => ref.current?.querySelector<HTMLElement>("[data-autofocus]") });
  // A bottom: 0 sheet would sit behind the iOS keyboard: while it is up and the focus is in the sheet, the sheet's
  // bottom goes to the visual viewport's (its offsetTop plus its height), as the composer's wrapper does (7.8).
  const touch = useViewport().touch;
  const kb = useSoftKeyboard(touch);
  const focusIn = useFocusInside(ref, touch);
  const riding = kb.up && focusIn;
  const style = riding ? { maxHeight: kb.visualHeight, height: full ? kb.visualHeight : undefined, transform: `translateY(calc(${kb.offsetTop + kb.visualHeight}px - 100%))` } : undefined;
  return createPortal(
    <>
      <Scrim onClick={onClose} />
      <div className={`sheet${full ? " sheet-full" : ""}${riding ? " is-riding" : ""}`} style={style} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId} ref={ref} tabIndex={-1}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h2 className="sheet-title" id={titleId} dir="auto">
            {title}
          </h2>
          <button type="button" className={`btn plain sheet-done${word === "Cancel" ? " scr-sheet-cancel" : ""}`} data-testid="sheet-cancel" data-autofocus={cancelFirst || undefined} onClick={onClose}>
            {word}
          </button>
        </div>
        {children}
      </div>
    </>,
    document.body,
  );
}
