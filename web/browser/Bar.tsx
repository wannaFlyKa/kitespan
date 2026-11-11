// The bar (DESIGN-B1 4.2, PAGE 3.2): Back (or "Back to <the opener's title>" on a tab a page opened), Forward, Reload
// (Stop loading while the page loads, with the loading line; Shift+click reloads without the cache), the address field,
// the chip while Claude acts, and More. The field is one element for every tab and the draft (a new tab keeps it, so
// the iOS keyboard that New tab raised stays up): at rest it shows the host in --text and the rest in --dim; a click or
// a tap selects the whole address; Enter or Go opens it in this tab, Alt+Enter in a new tab, Esc puts the tab's address
// back. It is at least 44 px tall on touch (F2). The fit rule (F5) keeps the field at least 160 px wide: the chip takes
// its narrow form, then on touch Back and Forward move to the foot. On the phone the bar holds the field, Reload and More.
import { forwardRef, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { IconBack, IconClose, IconForward, IconMore, IconReload } from "../ui/icons";
import { addressShown, escapeAddress } from "./address";
import { barFit } from "./layout";

export interface BarProps {
  /** The address the tab shows (the draft's: the empty string). */
  url: string;
  value: string;
  onValue: (v: string) => void;
  /** Open what the field holds: in this tab, or with Alt+Enter in a new one. */
  onGo: (newTab: boolean) => void;
  canBack: boolean;
  canForward: boolean;
  /** The opener's title on a tab that a page opened and that has no history of its own. */
  backTo: string | null;
  loading: boolean;
  /** No page to act on (a draft). */
  idle: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: (nocache: boolean) => void;
  onStop: () => void;
  /** The chip in its two forms (null: none), and its two probes for the fit rule. */
  chip: (narrow: boolean) => ReactNode;
  probes: ReactNode;
  hasChip: boolean;
  more: ReactNode;
  moreOpen: boolean;
  onMore: () => void;
  moreRef: RefObject<HTMLButtonElement | null>;
  touch: boolean;
  phone: boolean;
  /** The fit rule moved Back and Forward to the foot (touch beside the chat). */
  onNavInFoot: (inFoot: boolean) => void;
}

const nav = (s: number) => ({ size: s });

export const Bar = forwardRef<HTMLInputElement, BarProps>(function Bar(p, inputRef) {
  const bar = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [fit, setFit] = useState<{ chip: "long" | "narrow" | null; navInFoot: boolean }>({ chip: p.hasChip ? "long" : null, navInFoot: false });
  const differs = p.value.trim() !== "" && p.value !== p.url;
  const rest = !focused && !differs && !!p.url;
  const shown = addressShown(p.url);
  const icon = p.touch ? 18 : 16;

  // The fit rule (F5): measured on every size change of the bar and when the chip comes or goes.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => {
      const w = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)].reduce((s, x) => s + x.getBoundingClientRect().width, 0);
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const fixed = w("[data-fixed]");
      const navW = p.phone ? 0 : w("[data-nav]") || (p.touch ? 88 : 56);
      const long = p.hasChip ? w('[data-chip-measure="long"]') + 4 : 0;
      const narrow = p.hasChip ? w('[data-chip-measure="narrow"]') + 4 : 0;
      const room = el.clientWidth - pad - fixed - 16;
      const next = barFit({ room, chipLong: long, chipNarrow: narrow, nav: navW, touch: p.touch && !p.phone });
      setFit((f) => (f.chip === next.chip && f.navInFoot === next.navInFoot ? f : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p.hasChip, p.touch, p.phone]);
  const onNavInFoot = useRef(p.onNavInFoot);
  onNavInFoot.current = p.onNavInFoot;
  useLayoutEffect(() => onNavInFoot.current(fit.navInFoot), [fit.navInFoot]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      p.onGo(e.altKey);
    } else if (e.key === "Escape") {
      const back = escapeAddress(p.value, p.url);
      if (back === null) return;
      e.preventDefault();
      e.stopPropagation();
      p.onValue(back);
      requestAnimationFrame(() => (inputRef as RefObject<HTMLInputElement | null>)?.current?.select());
    }
  };
  const reload = (e: MouseEvent) => (p.loading ? p.onStop() : p.onReload(e.shiftKey));
  const showNav = !p.phone && !fit.navInFoot;
  const backName = p.backTo ? `Back to ${p.backTo}` : "Back";
  return (
    <div className="bp-bar" role="toolbar" aria-label="Page" ref={bar} data-testid="browser-bar">
      {showNav ? (
        <>
          <button type="button" className="icon-btn" aria-label={backName} title={p.touch ? undefined : backName} disabled={p.idle || (!p.canBack && !p.backTo)} onClick={p.onBack} data-nav="" data-testid="browser-back">
            <IconBack {...nav(icon)} />
          </button>
          <button type="button" className="icon-btn" aria-label="Forward" title={p.touch ? undefined : "Forward"} disabled={p.idle || !p.canForward} onClick={p.onForward} data-nav="" data-testid="browser-forward">
            <IconForward {...nav(icon)} />
          </button>
        </>
      ) : null}
      {!p.phone ? <ReloadButton {...p} icon={icon} onClick={reload} /> : null}
      <div className={`bp-url${rest ? " is-rest" : ""}`}>
        <input
          ref={inputRef}
          className="bp-url-input"
          aria-label="Address"
          placeholder="Type an address"
          value={p.value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          inputMode="url"
          enterKeyHint="go"
          data-testid="browser-address"
          onChange={(e) => p.onValue(e.target.value)}
          onKeyDown={onKey}
          onFocus={(e) => {
            setFocused(true);
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onBlur={() => setFocused(false)}
        />
        {rest ? (
          <span className="bp-url-show" aria-hidden="true">
            <span className="bp-url-host">{shown.host}</span>
            <span className="bp-url-rest">{shown.rest}</span>
          </span>
        ) : null}
        {differs ? (
          <button type="button" className="bp-url-go" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onGo(false)} data-testid="browser-go">
            Go
          </button>
        ) : null}
      </div>
      {p.phone ? <ReloadButton {...p} icon={icon} onClick={reload} /> : null}
      {p.hasChip && fit.chip ? p.chip(fit.chip === "narrow") : null}
      <button
        ref={p.moreRef}
        type="button"
        className="icon-btn"
        aria-label="More"
        title={p.touch ? undefined : "More"}
        aria-haspopup="dialog"
        aria-expanded={p.moreOpen}
        onClick={p.onMore}
        onKeyDown={(e) => {
          // Esc closes More with the focus on its button too (the popover's own Esc has it inside); the focus stays.
          if (e.key !== "Escape" || !p.moreOpen) return;
          e.preventDefault();
          e.stopPropagation();
          p.onMore();
        }}
        data-fixed=""
        data-testid="browser-more"
      >
        <IconMore size={p.phone ? 18 : 16} />
      </button>
      {p.loading ? <span className="bp-progress" aria-hidden="true" /> : null}
      {p.hasChip ? <span className="bp-chip-probes">{p.probes}</span> : null}
      {p.more}
    </div>
  );
});

function ReloadButton(p: BarProps & { icon: number; onClick: (e: MouseEvent) => void }) {
  const name = p.loading ? "Stop loading" : "Reload";
  return (
    <button type="button" className="icon-btn" aria-label={name} title={p.touch ? undefined : name} disabled={p.idle} onClick={p.onClick} data-fixed="" data-testid="browser-reload">
      {p.loading ? <IconClose size={p.icon} /> : <IconReload size={p.icon} />}
    </button>
  );
}
