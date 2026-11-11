// The demo frame's last module (frame.tsx imports it after web/main.tsx; DESIGN-W1 4.2, 4.3 and 4.6): the app is
// running, so its own store and router take what the landing page asks.
//
// - The landing page's theme: the frame's tokens follow the browser's light or dark, not the page's choice, so each
//   theme message is the app's own setting (a device setting: no request).
// - A link opened with Ctrl, Cmd, Shift or Alt, or with the middle button: the frame's URL is a path at the origin's
//   root, which is not this site, so a new tab or window there would land on another page. It opens in place.

import { navigate } from "../../web/router";
import { act, getState } from "../../web/state/store";
import { link } from "./shim";

link.onTheme((theme) => {
  if (getState().settings.theme !== theme) act.setSetting("theme", theme);
});

/** The in-app path of a click's link, or null (another origin, the API, no link). */
function appPath(e: MouseEvent): string | null {
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!(a instanceof HTMLAnchorElement)) return null;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || u.pathname.startsWith("/api/")) return null;
  return u.pathname + u.search + u.hash;
}

document.addEventListener(
  "click",
  (e) => {
    if (e.button !== 0 || !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
    const to = appPath(e);
    if (to === null) return;
    e.preventDefault();
    navigate(to);
  },
  true,
);

document.addEventListener(
  "auxclick",
  (e) => {
    if (e.button !== 1) return;
    const to = appPath(e);
    if (to === null) return;
    e.preventDefault();
    navigate(to);
  },
  true,
);
