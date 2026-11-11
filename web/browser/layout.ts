// Where the Browser shows and how wide (DESIGN-B1 4.1, D-13), and the bar's fit rule (F5), as plain numbers so a unit
// test checks them; Shell.tsx and Bar.tsx use them.
//   - Its width rule: clamp(480 px, 50% of the window, 960 px), narrowed so that the chat keeps 520 px (CHAT_MIN). On
//     medium touch the docked pane is the window less the pane bar and the chat's 520 px.
//   - It docks beside the chat only where that column is at least 420 px; anywhere narrower it opens over the chat: on
//     a laptop as a layer at min(the rule, the chat column's width), on medium touch at the whole width beside the
//     pane bar. On the phone it is a page of its own.
import { BROWSER_PANE_MAX, BROWSER_PANE_MIN, PANE_BAR_W, PANE_BAR_W_TOUCH, SIDEBAR_W } from "../layout/panes";
import { CHAT_MIN, SIDEBAR_DOCK_MIN, type LayoutPrefs, type Viewport } from "../layout/size";

/** The Browser docks only where its column is at least this wide; a drag never narrows it under this either. */
export const BROWSER_MIN = BROWSER_PANE_MIN;
export const BROWSER_MAX = BROWSER_PANE_MAX;
export const BROWSER_RULE_MIN = 480;
export const BROWSER_SHARE = 0.5;

export interface BrowserLayout {
  /** column: the laptop's side column; pane: the tablet's docked pane; over: a layer over the chat; page: the phone's. */
  form: "column" | "pane" | "over" | "page";
  width: number;
}

/**
 * The Browser's place beside a chat. `bar`: a pane bar shows on this laptop (the side panel opens over the chat, from
 * 1,000 to 1,087 px with the sidebar docked), so the layer sits beside it and the chat column is narrower by it.
 */
export function browserLayout(vp: Pick<Viewport, "size" | "width">, prefs: LayoutPrefs, bar = false): BrowserLayout {
  if (vp.size === "phone") return { form: "page", width: vp.width };
  if (vp.size === "medium") {
    const docked = Math.min(BROWSER_MAX, vp.width - PANE_BAR_W_TOUCH - CHAT_MIN);
    return docked >= BROWSER_MIN ? { form: "pane", width: docked } : { form: "over", width: vp.width - PANE_BAR_W_TOUCH };
  }
  const room = vp.width - (vp.width >= SIDEBAR_DOCK_MIN && prefs.sidebarHidden !== true ? SIDEBAR_W : 0);
  const rule = Math.round(Math.min(BROWSER_MAX, Math.max(BROWSER_RULE_MIN, vp.width * BROWSER_SHARE)));
  const beside = Math.min(rule, room - CHAT_MIN);
  if (beside >= BROWSER_MIN) return { form: "column", width: beside };
  return { form: "over", width: Math.min(rule, room - (bar ? PANE_BAR_W : 0)) };
}

/** The address field keeps at least this much of the bar (F5). */
export const FIELD_MIN = 160;

/**
 * The bar's fit rule (F5): `room` is what the bar has for the address field, the chip and Back and Forward (`nav`)
 * together; `chipLong` and `chipNarrow` are the chip's two widths (0 with no chip). As room runs out: the chip takes its
 * narrow form, then on touch Back and Forward move to the foot (the phone has them there always).
 */
export function barFit(i: { room: number; chipLong: number; chipNarrow: number; nav: number; touch: boolean }): { chip: "long" | "narrow" | null; navInFoot: boolean } {
  const fits = (chip: number, nav: number) => i.room - chip - nav >= FIELD_MIN;
  if (!i.chipLong) return { chip: null, navInFoot: i.touch && !fits(0, i.nav) };
  if (fits(i.chipLong, i.nav)) return { chip: "long", navInFoot: false };
  if (fits(i.chipNarrow, i.nav)) return { chip: "narrow", navInFoot: false };
  return { chip: "narrow", navInFoot: i.touch };
}
