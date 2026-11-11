// Composition on touch (DESIGN.md 7.5; DESIGN-T1 T-18). On a touch device Return waits only while an input method
// shows marked text in the focused field (from compositionstart to compositionend), and 100 ms after it ends, for an
// input method that ends the composition before the keydown of the Return that takes the word; dictation fires no
// composition events, so a dictated message sends. A key's own marks (isComposing, key code 229) say nothing on
// touch: iOS dictation and some keyboards mark every key so. With a fine pointer the marks decide, as
// ui/primitives composingKey says.
//
// One tracker at the document, in the capture phase, installed once at the app's root (App.tsx), so every field takes
// the same test: the message box and its `@` and mid-line `/` menus, the new-chat box, the side chat, the cards'
// fields and the search pane's field (search/sections.ts paneKey), and the Esc of a layer.

/** How long after compositionend a Return still belongs to the input method. */
export const IME_TAIL_MS = 100;

export interface CompositionTracker {
  start(field: unknown, at: number): void;
  end(field: unknown, at: number): void;
  /** The field lost the focus: its composition, and its tail, are over. */
  leave(field: unknown): void;
  holds(focused: unknown, at: number): boolean;
}

/** The field with marked text, and the field and time of the last end (pure: the caller gives the times). */
export function createCompositionTracker(tailMs: number = IME_TAIL_MS): CompositionTracker {
  let open: unknown = null;
  let ended: { field: unknown; at: number } | null = null;
  return {
    start(field) {
      open = field;
      if (ended?.field === field) ended = null;
    },
    end(field, at) {
      if (open === field) open = null;
      ended = { field, at };
    },
    leave(field) {
      if (open === field) open = null;
      if (ended?.field === field) ended = null;
    },
    holds(focused, at) {
      if (focused === null || focused === undefined) return false;
      if (open === focused) return true;
      return !!ended && ended.field === focused && at >= ended.at && at - ended.at < tailMs;
    },
  };
}

type Doc = Pick<Document, "addEventListener" | "removeEventListener"> & { readonly activeElement: unknown };

let tracker = createCompositionTracker();
let doc: Doc | null = null;
let clock: () => number = () => performance.now();

/** Follow the document's compositions (App.tsx, once). The stand-down for a test, or a page that unmounts it. */
export function installComposition(d: Doc = document, now: () => number = () => performance.now()): () => void {
  const t = createCompositionTracker();
  const start = (e: Event) => t.start(e.target, now());
  const end = (e: Event) => t.end(e.target, now());
  const leave = (e: Event) => t.leave(e.target);
  d.addEventListener("compositionstart", start, true);
  d.addEventListener("compositionend", end, true);
  d.addEventListener("focusout", leave, true);
  tracker = t;
  doc = d;
  clock = now;
  return () => {
    d.removeEventListener("compositionstart", start, true);
    d.removeEventListener("compositionend", end, true);
    d.removeEventListener("focusout", leave, true);
    if (doc !== d) return;
    doc = null;
    tracker = createCompositionTracker();
  };
}

/** True while an input method shows marked text in the focused field, or ended it under IME_TAIL_MS ago. */
export function imeHolds(): boolean {
  return !!doc && tracker.holds(doc.activeElement, clock());
}

const coarseNow = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * Whether a key belongs to an input method, so it neither sends, picks nor closes: on touch while imeHolds(); with a
 * fine pointer while the key says it composes (composingKey's rule). `coarse` is (pointer: coarse), now by default.
 */
export function imeKey(e: { isComposing?: boolean; keyCode?: number }, coarse: boolean = coarseNow()): boolean {
  return coarse ? imeHolds() : !!e.isComposing || e.keyCode === 229;
}
