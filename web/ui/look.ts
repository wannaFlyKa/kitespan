// The look and the theme on the page (prototype design plan v3). tokens.css reads two attributes of the root element:
// data-look ("paper", "mono" or "editor"; absent for glass, the default) and data-theme ("light" or "dark";
// absent for System, which follows the device). index.html's inline script sets them before the first paint from the
// stored settings; main.tsx and App.tsx call applyLook to keep them in step with settings.look and settings.theme.
// It also keeps the page's two theme-color metas (index.html) on the look's title bar colour (FIX-U6), so the status
// bar of a home-screen app and an installed app's window bar match the page: dimmed with the page while a scrim shows
// (dimThemeColor, which ui/primitives.tsx's Scrim calls as it shows and goes).
import { themeColorMetas } from "../../shared/home-screen";
import type { AppSettings } from "../state/types";

/** The parts of an element applyLook touches, so a test can hand it a stand-in. */
export type LookTarget = Pick<Element, "getAttribute" | "setAttribute" | "removeAttribute">;
/** The parts of a theme-color meta applyLook touches: its media says which device theme it is for. */
export type MetaTarget = Pick<Element, "getAttribute" | "setAttribute">;

const themeMetas = (): ArrayLike<MetaTarget> => (typeof document === "undefined" ? [] : document.querySelectorAll('meta[name="theme-color"]'));

/** The look and theme applyLook last put on the page (null before its first call), and how many scrims show now. */
let worn: Pick<AppSettings, "look" | "theme"> | null = null;
let scrims = 0;

/** The look and theme on the page: applyLook's, or before it runs the root's attributes (index.html's script). */
function wornNow(): Pick<AppSettings, "look" | "theme"> {
  if (worn) return worn;
  const root = typeof document === "undefined" ? null : document.documentElement;
  const look = root?.getAttribute("data-look");
  const theme = root?.getAttribute("data-theme");
  return { look: look === "paper" || look === "mono" || look === "editor" ? look : "glass", theme: theme === "light" || theme === "dark" ? theme : "system" };
}

function paintMetas(metas: ArrayLike<MetaTarget>) {
  const { look, theme } = wornNow();
  const colors = themeColorMetas(look, theme, scrims);
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i]!;
    m.setAttribute("content", /dark/.test(m.getAttribute("media") ?? "") ? colors.dark : colors.light);
  }
}

/**
 * A scrim shows (true) or goes (false). While any shows, the metas hold the look's --bg under the scrims (Glass light
 * #bfbfbf, dark #0e0e0f under one), since the scrim dims the title bar too; when the last goes, the --bg again. At
 * once, with no transition, as a look's switch.
 */
export function dimThemeColor(on: boolean, metas: ArrayLike<MetaTarget> = themeMetas()) {
  scrims = Math.max(0, scrims + (on ? 1 : -1));
  paintMetas(metas);
}

/** The attribute values a look and a theme give: null means the attribute is absent. */
export function lookAttributes(settings: Pick<AppSettings, "look" | "theme">): { look: string | null; theme: string | null } {
  return { look: settings.look === "glass" ? null : settings.look, theme: settings.theme === "system" ? null : settings.theme };
}

/**
 * Put the look and the theme on the root element (or `el`), and the look's colours in the theme-color metas (or
 * `metas`): with the System theme the light and the dark meta each its own, with a chosen theme its colour in both
 * (dimmed while a scrim shows).
 * A change repaints at once: data-switching turns every transition off for one frame (base.css), so no colour animates
 * half-way (DESIGN.md 6.13). Returns true when an attribute of the root changed. A view effect, not an action: it
 * records nothing.
 */
export function applyLook(settings: Pick<AppSettings, "look" | "theme">, el: LookTarget = document.documentElement, metas: ArrayLike<MetaTarget> = themeMetas()): boolean {
  worn = { look: settings.look, theme: settings.theme };
  paintMetas(metas);
  const { look, theme } = lookAttributes(settings);
  if (el.getAttribute("data-look") === look && el.getAttribute("data-theme") === theme) return false;
  el.setAttribute("data-switching", "");
  if (look) el.setAttribute("data-look", look);
  else el.removeAttribute("data-look");
  if (theme) el.setAttribute("data-theme", theme);
  else el.removeAttribute("data-theme");
  const done = () => el.removeAttribute("data-switching");
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(done));
  else done();
  return true;
}
