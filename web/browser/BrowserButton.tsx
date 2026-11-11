// The Browser button outside a chat (DESIGN-B1 4.1, PAGE 2.3): in the sidebar's head beside Search and New, in the
// medium drawer's head, and in the phone's chat list title bar, so Cmd+Shift+B has a visible control everywhere (DESIGN
// 7.7). It opens /browser; on /browser it is lit and goes back. It wears the needs-you dot while a page waits for an
// answer in a tab that no view shows (dot.ts), and its name says so. Iteration 8 (T-5, T-11): on touch it shows its
// name as Search beside it does (layout/SearchButton.tsx toolForm), and a list head never drops it.
import { href, type Route } from "../router";
import { useViewport } from "../layout/size";
import { IconGlobe } from "../ui/icons";
import { Link } from "../ui/primitives";
import { IS_MAC } from "../ui/shortcuts";
import { NEEDS_WORDS, useBrowserDot } from "./dot";
import { toolForm, type ToolNamed } from "../layout/SearchButton";

export function BrowserButton({ route, className = "", size = 18, named }: { route: Route; className?: string; size?: number; named?: ToolNamed }) {
  const touch = useViewport().touch;
  const dot = useBrowserDot();
  const open = route.name === "browser" || route.name === "browserTab";
  const name = open ? "Close browser" : `Browser${dot ? NEEDS_WORDS : ""}`;
  const title = touch ? undefined : open ? "Close browser" : dot ? "Browser: the browser needs an answer" : `Browser (${IS_MAC ? "Cmd" : "Ctrl"}+Shift+B)`;
  const form = toolForm(named, `scr-browser${dot ? " bp-has-dot" : ""} ${className}`.trim());
  return (
    <Link to={open ? "/" : href("browser")} close={open} className={form.className} aria-label={name} title={title} aria-current={open ? "page" : undefined} data-testid="browser-button">
      <IconGlobe size={size} />
      {dot ? <span className="dot waiting bp-tool-dot" aria-hidden="true" /> : null}
      {form.name(open ? "Close browser" : "Browser")}
    </Link>
  );
}
