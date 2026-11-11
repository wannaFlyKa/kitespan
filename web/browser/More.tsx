// More (DESIGN-B1 4.2, 4.11, 4.18; F21, F25): a non-modal popover, role dialog, named "More", with ordinary controls;
// on the phone a sheet titled "Browser". Page size, for everyone on this tab (Desktop or Phone; neither lit while
// another client's size holds: "<w> x <h>, set by Claude" or "set elsewhere"); Zoom, on this device (Zoom out, the
// zoom, Zoom in, and Move while zoomed); on touch Select text (selectText.ts: a finger's drag selects the page's text,
// and the foot's Copy writes it; turning it on closes More, so the next drag is on the page); Open full size (a side
// view only); Copy address (written in the click, Copy failed on a refusal: DESIGN 7.10); Downloads; and Open chat links
// here (the same preference as Settings > Browser). Esc, a click outside it, or the More button again closes it.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { BrowserDownloadView, BrowserTabView } from "../../shared/browser";
import { useViewport } from "../layout/size";
import { COPY_FAILED, writeClipboard } from "../ui/Copy";
import { IconMinus, IconPlus } from "../ui/icons";
import { Link, Popup, Switch } from "../ui/primitives";
import { Segmented } from "../ui/Segmented";
import { DownloadList } from "./Downloads";
import { zoomWords } from "./mapping";
import { setSelectingText, useSelectingText } from "./selectText";

export interface MoreProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLButtonElement | null>;
  tab: BrowserTabView | null;
  onSize: (kind: "desktop" | "phone") => void;
  zoom: number | null;
  canZoomIn: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  moving: boolean;
  onMove: (on: boolean) => void;
  /** The full-size page of this tab, from a side view; null on the full-size page and the phone's. */
  fullHref: string | null;
  downloads: readonly BrowserDownloadView[];
  links: boolean;
  onLinks: (on: boolean) => void;
}

/** The size row's words when another client's size holds (DESIGN-B1 4.11). */
export function sizeNote(t: Pick<BrowserTabView, "size"> | null): string | null {
  if (!t || t.size.kind !== "other") return null;
  return `${t.size.w} x ${t.size.h}, ${t.size.by === "claude" ? "set by Claude" : "set elsewhere"}`;
}

export function More(p: MoreProps) {
  const phone = useViewport().size === "phone";
  if (!p.open) return null;
  if (phone)
    return (
      <Popup open onClose={p.onClose} title="Browser" testId="browser-more-sheet">
        <MoreBody {...p} />
      </Popup>
    );
  return <MorePop {...p} />;
}

function MorePop(p: MoreProps) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || p.anchor.current?.contains(t)) return;
      close.current();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [p.anchor]);
  return (
    <div
      ref={box}
      className="menu bp-more"
      role="dialog"
      aria-label="More"
      data-testid="browser-more-pop"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        p.onClose();
        p.anchor.current?.focus();
      }}
    >
      <MoreBody {...p} />
    </div>
  );
}

function MoreBody(p: MoreProps) {
  const touch = useViewport().touch;
  const selecting = useSelectingText();
  const [downloads, setDownloads] = useState(false);
  const [copy, setCopy] = useState<"idle" | "failed">("idle");
  const note = sizeNote(p.tab);
  const value = p.tab && p.tab.size.kind !== "other" ? p.tab.size.kind : null;
  if (downloads)
    return (
      <div className="bp-more-body">
        <button type="button" className="menu-row" onClick={() => setDownloads(false)}>
          Back
        </button>
        <hr className="menu-sep" />
        <DownloadList downloads={p.downloads} />
      </div>
    );
  const row = (label: string, onClick: () => void, testId: string, extra?: ReactNode) => (
    <button type="button" className="menu-row" onClick={onClick} data-testid={testId}>
      {label}
      {extra}
    </button>
  );
  return (
    <div className="bp-more-body">
      {p.tab ? (
        <>
          <h3 className="bp-more-label" id="bp-size-label">
            Page size, for everyone on this tab
          </h3>
          <div className="bp-more-size">
            <Segmented
              label="Page size"
              block
              value={value}
              onChange={(v) => p.onSize(v)}
              options={[
                { value: "desktop", label: "Desktop", testId: "browser-size-desktop" },
                { value: "phone", label: "Phone", testId: "browser-size-phone" },
              ]}
              testId="browser-size"
            />
          </div>
          {note ? <p className="bp-more-size-note">{note}</p> : null}
        </>
      ) : null}
      <h3 className="bp-more-label">Zoom, on this device</h3>
      <div className="bp-zoom">
        <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out" disabled={p.zoom === null} onClick={p.onZoomOut} data-testid="browser-zoom-out">
          <IconMinus />
        </button>
        <span className="bp-zoom-now" role="status" data-testid="browser-zoom">
          {zoomWords(p.zoom)}
        </span>
        <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in" disabled={!p.canZoomIn} onClick={p.onZoomIn} data-testid="browser-zoom-in">
          <IconPlus />
        </button>
      </div>
      {p.zoom !== null ? (
        <label className="menu-row bp-more-switch">
          <span>Move</span>
          <Switch
            checked={p.moving}
            onChange={(on) => {
              if (on) setSelectingText(false);
              p.onMove(on);
            }}
            label="Move"
          />
        </label>
      ) : null}
      {touch ? (
        <label className="menu-row bp-more-switch">
          <span>Select text</span>
          <Switch
            checked={selecting}
            onChange={(on) => {
              setSelectingText(on);
              if (on) {
                p.onMove(false);
                p.onClose();
              }
            }}
            label="Select text"
            testId="browser-select-text"
          />
        </label>
      ) : null}
      <hr className="menu-sep" />
      {p.fullHref ? (
        <Link to={p.fullHref} className="menu-row" data-testid="browser-full">
          Open full size
        </Link>
      ) : null}
      {p.tab
        ? row(
            copy === "failed" ? COPY_FAILED : "Copy address",
            () => {
              const url = p.tab!.url;
              writeClipboard(url).then((ok) => setCopy(ok ? "idle" : "failed"));
            },
            "browser-copy-address",
          )
        : null}
      {row("Downloads", () => setDownloads(true), "browser-downloads")}
      <label className="menu-row bp-more-switch">
        <span>Open chat links here</span>
        <Switch checked={p.links} onChange={p.onLinks} label="Open chat links here" />
      </label>
    </div>
  );
}
