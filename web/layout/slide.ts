// Row 93 (the owner, after row 82): Hide sidebar and Show sidebar, and the docked pane on the right as it opens and
// closes, slide: 200 ms on the look's ease-out (tokens.css --t-toggle and --ease). The shell's columns change at once,
// as before, and the slide shows the way there. The pane keeps its own width and moves by a transform (the right one is
// clipped at its column's edge too, so it never shows under the pane bar): nothing in it wraps or lays out again. The
// chat column's margin on that side holds the room the pane has not taken yet (or not given back yet), so the chat
// column's edge rides with the pane's. The chat itself (the shell's main) keeps one width for the whole slide, the
// narrower of its two, centred in the column: a long chat lays out once (as the pane opens, or after it has closed),
// and between those frames only the column and the title bar lay out; nothing restyles the page. A pane that closes
// leaves React at once, as before, so the focus and the keys go where they went; what slides out is its last box, put
// back where it was, inert and hidden from assistive tech, without its ids and test ids, and taken out at the end. A
// toggle during a slide turns it round from where it is. No slide on the first paint or a reload, while a handle drags,
// when the window's width changed (a resize, a turned tablet), with Reduce motion (Settings or the system's), or on the
// phone, whose panes are sheets.
// G-31 (iteration 8): where the pane bar comes or goes in the same change as the pane on the right (the large tablet's
// Show sidebar and Hide sidebar: the side column gives way to the pane bar), the bar takes or gives its room at once,
// so the right side's margin holds the pane's width less that change: the chat column starts the slide as wide as it
// was and never gets narrower than the chat in it. A pane that closes so slides out from where it was, over the bar.
import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotion } from "../ui/motion";

export const SLIDE_MS = 200;
/** tokens.css --ease. */
export const SLIDE_EASE = "cubic-bezier(0.2, 0, 0, 1)";

export type SlideSide = "left" | "right";
const SIDES: SlideSide[] = ["left", "right"];
/** The shell's data-slide word while that side slides (layout.css hides its width handle meanwhile). */
const MARK: Record<SlideSide, string> = { left: "sidebar", right: "side" };

/** A docked pane as Shell lays it out now. */
export interface SlidePane {
  open: boolean;
  /** Its width in px. */
  width: number;
  /** Its element's id (a direct child of the shell). */
  id: string;
  /** The right pane's distance from the shell's right edge (the pane bar's width), as CSS. */
  edge?: string;
  /** That distance in px (0 with no pane bar): what the bar takes or gives at once when it comes or goes. */
  bar?: number;
}

/**
 * The keyframes of a slide from `from` to `to` open (0 shut, 1 open) of a pane `w` px wide on `side`: the pane's
 * transform (and on the right its clip), and the chat column's margin on that side. `inGrid`: the pane has its column
 * (it opens), so the margin gives back the room the pane has not taken yet; else its column is gone (it closes), and
 * the margin keeps the room the pane has not given back. `room` is that room when it is not the pane's width (slideRoom).
 */
export function slideFrames(side: SlideSide, w: number, from: number, to: number, inGrid: boolean, room: number = w): { pane: Keyframe[]; main: Keyframe[] } {
  const away = (f: number) => w * (1 - f);
  const pane = (f: number): Keyframe => (side === "left" ? { transform: `translateX(${-away(f)}px)` } : { transform: `translateX(${away(f)}px)`, clipPath: `inset(0px ${away(f)}px 0px 0px)` });
  const main = (f: number): Keyframe => ({ [side === "left" ? "marginLeft" : "marginRight"]: `${inGrid ? -room * (1 - f) : room * f}px` });
  return { pane: [pane(from), pane(to)], main: [main(from), main(to)] };
}

/**
 * The room the right side's margin holds while a pane `w` px wide opens or closes there, the pane bar `before` px wide
 * before the change and `now` px after: the pane's width, less what the bar takes at once as it comes (a pane that
 * closes) or gives at once as it goes (a pane that opens). Never under 0.
 */
export function slideRoom(w: number, open: boolean, before: number, now: number): number {
  return Math.max(0, open ? w + now - before : w - (now - before));
}

/**
 * Whether a pane that opens or closes now slides: not where nothing slides (`on` false: the phone), not on the shell's
 * first paint (a load, a reload, another screen), not when the window's width changed, not with Reduce motion, and not
 * while a handle drags.
 */
export function slides(o: { on: boolean; first: boolean; resized: boolean; reduced: boolean; dragging: boolean }): boolean {
  return o.on && !o.first && !o.resized && !o.reduced && !o.dragging;
}

interface Run {
  anims: Animation[];
  from: number;
  to: number;
  ghost: HTMLElement | null;
}

interface PaneState {
  open: boolean;
  /** The pane's element while it is open, and its last one after. */
  node: HTMLElement | null;
  width: number;
  /** Where the pane's scrollers were (a box put back in the page starts at the top). */
  scrolls: Map<Element, number>;
  run: Run | null;
}

interface SlideState {
  first: boolean;
  width: number;
  /** The pane bar's width as the last commit laid it out (0 with none). */
  bar: number;
  /** The chat column's width as the last commit laid it out. */
  mainWidth: number;
  /** The chat's one width while a slide runs (the shell's main), or null. */
  pin: number | null;
  panes: Record<SlideSide, PaneState>;
}

const blank = (): PaneState => ({ open: false, node: null, width: 0, scrolls: new Map(), run: null });

function mark(host: HTMLElement, side: SlideSide, on: boolean) {
  const words = new Set((host.dataset.slide ?? "").split(" ").filter(Boolean));
  if (on) words.add(MARK[side]);
  else words.delete(MARK[side]);
  if (words.size) host.dataset.slide = [...words].join(" ");
  else delete host.dataset.slide;
}

/**
 * The chat (the shell's main) at one width, centred in its column and never wider, on a layer of its own (so a move
 * paints nothing in it again); null lets it follow the column.
 */
function pin(col: HTMLElement | null, s: SlideState, width: number | null) {
  const main = col?.querySelector<HTMLElement>(":scope > main");
  s.pin = width;
  if (!main) return;
  if (width === null) for (const p of ["width", "max-width", "justify-self", "will-change"]) main.style.removeProperty(p);
  else Object.assign(main.style, { width: `${width}px`, maxWidth: "100%", justifySelf: "center", willChange: "transform" });
}

/** End a pane's slide where it is (its animations and its box that slides out go); how far open it was, or null. */
function stop(host: HTMLElement | null, col: HTMLElement | null, s: SlideState, side: SlideSide): number | null {
  const p = s.panes[side];
  const r = p.run;
  if (!r) return null;
  p.run = null;
  const t = r.anims[0]?.effect?.getComputedTiming().progress;
  for (const a of r.anims) a.cancel();
  r.ghost?.remove();
  if (host) mark(host, side, false);
  if (!SIDES.some((x) => s.panes[x].run)) pin(col, s, null);
  return typeof t === "number" ? r.from + (r.to - r.from) * t : null;
}

/** The pane's last box, back in the shell where it was, as a picture of itself. */
function ghostOf(host: HTMLElement, p: PaneState, side: SlideSide, edge: string | undefined): HTMLElement {
  const g = p.node!;
  for (const el of [g, ...g.querySelectorAll("[id], [data-testid]")]) {
    el.removeAttribute("id");
    el.removeAttribute("data-testid");
  }
  g.inert = true;
  g.setAttribute("aria-hidden", "true");
  Object.assign(g.style, { position: "absolute", top: "0", bottom: "0", width: `${p.width}px`, left: side === "left" ? "0" : "auto", right: side === "left" ? "auto" : (edge ?? "0") });
  host.appendChild(g);
  for (const [el, top] of p.scrolls) if (g.contains(el)) el.scrollTop = top;
  return g;
}

function watchScrolls(node: HTMLElement): Map<Element, number> {
  const at = new Map<Element, number>();
  node.addEventListener(
    "scroll",
    (e) => {
      if (e.target instanceof Element) at.set(e.target, e.target.scrollTop);
    },
    { capture: true, passive: true },
  );
  return at;
}

/**
 * Slide the shell's docked panes as they open and close (row 93). `shell` is the shell's element, `main` its chat
 * column, `mainWidth` the column's width in this layout; `on` is false where nothing slides (the phone); `width` is the
 * window's.
 */
export function usePaneSlides(shell: RefObject<HTMLElement | null>, main: RefObject<HTMLElement | null>, panes: Record<SlideSide, SlidePane>, mainWidth: number, on: boolean, width: number) {
  const reduced = useReducedMotion();
  const st = useRef<SlideState | null>(null);
  useLayoutEffect(() => {
    const host = shell.current;
    const col = main.current;
    const bar = panes.right.bar ?? 0;
    const s = (st.current ??= { first: true, width, bar, mainWidth, pin: null, panes: { left: blank(), right: blank() } });
    const may = !!host && !!col && slides({ on, first: s.first, resized: width !== s.width, reduced, dragging: host.hasAttribute("data-resizing") });
    let started = false;
    for (const side of SIDES) {
      const p = s.panes[side];
      const now = panes[side];
      const open = on && now.open;
      const node = open && host ? host.querySelector<HTMLElement>(`:scope > #${now.id}`) : null;
      // A pane that opens anew while it slides in (the cards' column becoming the Terminal's) slides on from there.
      if (open !== p.open || (open && p.run && node !== p.node)) {
        const at = stop(host, col, s, side) ?? (p.open ? 1 : 0);
        const to = open ? 1 : 0;
        // The bar came or went with this pane: a pane that closes slides out from where it was, over the bar.
        const barMoved = side === "right" && bar !== s.bar;
        const target = !may ? null : open ? node : p.node && ghostOf(host!, p, side, barMoved ? `${s.bar}px` : now.edge);
        if (target && at !== to) {
          const w = open ? now.width : p.width;
          const frames = slideFrames(side, w, at, to, open, side === "right" ? slideRoom(w, open, s.bar, bar) : w);
          const timing: KeyframeAnimationOptions = { duration: SLIDE_MS * Math.abs(to - at), easing: SLIDE_EASE, fill: "forwards" };
          const run: Run = { anims: [col!.animate(frames.main, timing), target.animate(frames.pane, timing)], from: at, to, ghost: open ? null : target };
          p.run = run;
          started = true;
          mark(host!, side, true);
          run.anims[0]!.finished.then(
            () => {
              if (p.run === run) stop(host, col, s, side);
            },
            () => {},
          );
        } else if (target && !open) target.remove();
      }
      if (node && node !== p.node) p.scrolls = watchScrolls(node);
      if (open) {
        p.node = node;
        p.width = now.width;
      }
      p.open = open;
    }
    if (started) pin(col, s, Math.min(s.pin ?? Infinity, s.mainWidth, mainWidth));
    s.first = false;
    s.width = width;
    s.bar = bar;
    s.mainWidth = mainWidth;
  });
  useLayoutEffect(
    () => () => {
      const s = st.current;
      if (s) for (const side of SIDES) stop(shell.current, main.current, s, side);
    },
    [shell, main],
  );
}
