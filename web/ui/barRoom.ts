// A bar's room for its named tools (DESIGN-T1 2.4 and 2.6; T-5, T-11, T-28). On touch a bar's tools that open a place
// show their names, and a list head holds its tools in a row of their own under the brand, each named under its icon.
// The words grow with the user's text size and the icons do not, so no container query fits every size: the bar
// measures itself as laid out with the words, and where they would cut its heading or its title, or a name is wider
// than its tool, it is data-tight and its tools drop their words (screens.css), each staying a 44 px icon whose words
// are still its name for a screen reader. A laptop's list head (icons, one line) is data-tight where its tools have no
// room beside "kitespan": they take a row under it. The rules are plain functions, so a unit test checks them;
// useBarRoom measures and sets the mark.
import { useLayoutEffect, type RefObject } from "react";

/** The title keeps its whole width or this share of its band, whichever is less (T-28). */
export const TITLE_SHARE = 0.4;

/**
 * A bar with a heading (the phone's /chats bar; a laptop's list head, whose heading is the brand's words): tight when
 * its side padding, the heading's whole words, its tools as named and a gap before each tool need more than its width.
 */
export function barTight(m: { width: number; pad: number; gap: number; heading: number; tools: readonly number[] }): boolean {
  const need = m.pad + m.heading + m.tools.reduce((a, w) => a + w + m.gap, 0);
  return need > m.width + 0.5;
}

/**
 * A chat's title band (the large tablet's column form): tight when the named tools leave the title less than its whole
 * width or 40% of the band, whichever is less, or a tool runs past the band's end.
 */
export function titleTight(m: { band: number; title: number; titleNow: number; past: boolean }): boolean {
  return m.past || m.titleNow + 1 < Math.min(m.title, TITLE_SHARE * m.band);
}

/** A touch list head: tight when one name, set as it is (it may take two lines), is still wider than its tool. */
export function headTight(names: readonly { name: number; box: number }[]): boolean {
  return names.some((n) => n.name > n.box + 0.5);
}

/** Which rule a bar takes. */
export type RoomKind = "bar" | "title" | "head";

const shown = (el: Element) => el.getClientRects().length > 0;
const px = (v: string) => parseFloat(v) || 0;

/** The bar's need, read as it is laid out now (without data-tight). */
function measure(el: HTMLElement, kind: RoomKind): boolean {
  const s = getComputedStyle(el);
  const pad = px(s.paddingLeft) + px(s.paddingRight);
  const gap = px(s.columnGap);
  if (kind === "title") {
    const title = el.querySelector<HTMLElement>(".scr-bar-title");
    const end = el.getBoundingClientRect().right;
    const past = [...el.querySelectorAll(".scr-bar-tools > *")].some((t) => shown(t) && t.getBoundingClientRect().right > end + 0.5);
    return titleTight({ band: el.clientWidth, title: title?.scrollWidth ?? 0, titleNow: title?.clientWidth ?? 0, past });
  }
  if (kind === "head") {
    const names = [...el.querySelectorAll<HTMLElement>(".scr-head-name")].filter(shown);
    if (names.length) return headTight(names.map((n) => ({ name: n.scrollWidth, box: n.parentElement?.clientWidth ?? 0 })));
    const brand = el.querySelector<HTMLElement>(".scr-brand");
    const words = document.createRange();
    if (brand) words.selectNodeContents(brand);
    const tools = [...el.querySelectorAll<HTMLElement>(".scr-head-tools")].filter(shown).map((t) => t.getBoundingClientRect().width);
    return barTight({ width: el.clientWidth, pad, gap, heading: brand ? words.getBoundingClientRect().width : 0, tools });
  }
  const heading = el.querySelector<HTMLElement>(".scr-bar-heading");
  const tools = [...el.children].filter((c) => c !== heading && shown(c)).map((c) => c.getBoundingClientRect().width);
  return barTight({ width: el.clientWidth, pad, gap, heading: heading?.scrollWidth ?? 0, tools });
}

/**
 * Keep `data-tight` on the bar at `ref` while `on`: measured with the words (the mark taken off and put back in one
 * frame, so nothing paints between), after the first layout and again whenever the bar or one of its parts resizes (a
 * turned tablet, a text size, a tool that comes or goes). The measure runs in a frame of its own, never inside the
 * resize callback, so a mark that resizes the tools starts no resize loop. `key` measures again when it changes.
 */
export function useBarRoom(ref: RefObject<HTMLElement | null>, kind: RoomKind, on: boolean, key?: unknown): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!on || typeof ResizeObserver === "undefined") {
      el.removeAttribute("data-tight");
      return;
    }
    let frame = 0;
    const run = () => {
      frame = 0;
      el.removeAttribute("data-tight");
      if (measure(el, kind)) el.setAttribute("data-tight", "");
    };
    run();
    const ro = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(run);
    });
    ro.observe(el);
    for (const c of el.querySelectorAll(":scope > *, :scope > * > *")) ro.observe(c);
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, kind, on, key]);
}
