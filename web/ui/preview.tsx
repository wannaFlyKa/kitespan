// A picture's preview: its thumbnail, and the picture larger in a modal layer. The bytes come from this page's own
// file while the store holds it (state/store.ts localFile), else from the download route that the page already uses
// (panels/download.ts), with the existence probe first, so a file that is gone makes no failed request. They show
// through a blob URL of the picture's own type: the route answers application/octet-stream as an attachment, and
// nothing is loaded from another origin. Only PNG, JPEG, GIF and WebP draw: an SVG can hold script and can load from
// elsewhere. A picture loads once its box comes near the viewport, and its URL is revoked when the box unmounts. A
// file over PREVIEW_MAX_BYTES, one that is gone and one that does not draw keep the icon they have today.
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { probe, uploadUrl, type ProbeResult } from "../panels/download";
import { localFile } from "../state/store";
import type { Upload } from "../state/types";
import { IconClose } from "./icons";
import { Scrim, useLayer } from "./primitives";

const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const NAME_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A picture over this size keeps its icon: 10 MB, which a full-screen screenshot stays well under. */
export const PREVIEW_MAX_BYTES = 10_000_000;

/** The type when it is one that draws, else null. */
export function previewType(type: string): string | null {
  const t = type.trim().toLowerCase();
  return TYPES.includes(t) ? t : null;
}

/** The type that a file's name ends as (a file of the chat's folder has no type of its own) when it draws, else null. */
export function previewTypeOfName(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && NAME_TYPES[ext]) || null;
}

/** Where a picture's bytes come from: this page's own file, or a download route. `type` is one of previewType's. */
export type PreviewSource = { file: Blob; type: string } | { url: string; what: "file" | "upload"; type: string };

/**
 * What draws an upload's picture: this page's own file while it holds it, else the upload's route once the upload is
 * done. Null: no preview (not a picture that draws, too large, or failed).
 */
export function uploadPreview(u: Upload): PreviewSource | null {
  const type = previewType(u.type);
  if (!type || u.size > PREVIEW_MAX_BYTES || u.state === "failed") return null;
  const file = localFile(u.id);
  if (file) return { file, type };
  return u.state === "done" && u.chatId ? { url: uploadUrl(u.chatId, u.id), what: "upload", type } : null;
}

/** What a load needs of the page; a test passes stand-ins. */
export interface PreviewEnv {
  probe(url: string, what: "file" | "upload"): Promise<ProbeResult>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  make(blob: Blob): string;
  revoke(url: string): void;
}
const PAGE: PreviewEnv = {
  probe: (url, what) => probe(url, what),
  fetch: (url, init) => fetch(url, init),
  make: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

/** The picture's bytes as a blob of its own type. Null: the file is gone, too large, or could not be read. */
export async function readPreview(source: PreviewSource, env: PreviewEnv = PAGE): Promise<Blob | null> {
  if ("file" in source) return source.file.size > PREVIEW_MAX_BYTES ? null : new Blob([source.file], { type: source.type });
  const p = await env.probe(source.url, source.what);
  if (!p.ok || p.probe.kind !== "file" || p.probe.size > PREVIEW_MAX_BYTES) return null;
  try {
    const res = await env.fetch(source.url, { method: "GET", cache: "no-store" });
    return res.ok ? new Blob([await res.blob()], { type: source.type }) : null;
  } catch {
    return null;
  }
}

/** What a preview shows now: the picture's blob URL; `failed`, and the icon stays; or neither while it waits. */
export interface PreviewShot {
  url: string | null;
  failed: boolean;
}
const WAITING: PreviewShot = { url: null, failed: false };
const FAILED: PreviewShot = { url: null, failed: true };

/**
 * One box's load, apart from React so a test can drive it: `near` (the box came near the viewport) reads the picture
 * once and makes its blob URL, `fail` drops a picture that did not draw, and `end` (the box unmounts) revokes the URL.
 * A read that ends after `end` makes no URL.
 */
export class PreviewLoad {
  private url: string | null = null;
  private asked = false;
  private ended = false;
  constructor(
    private readonly source: PreviewSource,
    private readonly show: (shot: PreviewShot) => void,
    private readonly env: PreviewEnv = PAGE,
  ) {}
  async near(): Promise<void> {
    if (this.asked || this.ended) return;
    this.asked = true;
    const blob = await readPreview(this.source, this.env);
    if (this.ended) return;
    if (!blob) return this.show(FAILED);
    this.url = this.env.make(blob);
    this.show({ url: this.url, failed: false });
  }
  fail(): void {
    if (this.ended) return;
    this.drop();
    this.show(FAILED);
  }
  end(): void {
    this.ended = true;
    this.drop();
  }
  private drop(): void {
    if (this.url) this.env.revoke(this.url);
    this.url = null;
  }
}

/** How near the viewport a box comes before its picture loads. */
const NEAR = "300px";

/**
 * A picture for the element that `box` is on: it loads when the element comes near the viewport (at once where the
 * browser cannot tell), and its URL is revoked when the element unmounts or the source changes. `onError` is the
 * `<img>`'s: bytes that do not draw.
 */
export function usePreview(source: PreviewSource | null): { box: RefObject<HTMLSpanElement | null>; shot: PreviewShot; onError: () => void } {
  const box = useRef<HTMLSpanElement>(null);
  const load = useRef<PreviewLoad | null>(null);
  const [shot, setShot] = useState(WAITING);
  const from = source ? ("file" in source ? source.file : source.url) : null;
  const type = source?.type;
  useEffect(() => {
    if (!source) return;
    setShot(WAITING);
    const job = new PreviewLoad(source, setShot);
    load.current = job;
    const el = box.current;
    let seen: IntersectionObserver | null = null;
    if (el && typeof IntersectionObserver === "function") {
      // scrollMargin, where the browser has it, counts a box just past the edge of the chat's own scroller as near.
      seen = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          seen?.disconnect();
          void job.near();
        },
        { rootMargin: NEAR, scrollMargin: NEAR } as IntersectionObserverInit,
      );
      seen.observe(el);
    } else void job.near();
    return () => {
      seen?.disconnect();
      job.end();
    };
  }, [from, type]); // eslint-disable-line react-hooks/exhaustive-deps
  return { box, shot: source ? shot : WAITING, onError: () => load.current?.fail() };
}

/** The thumbnail's box (chat.css .chat-shot-thumb): the picture's place has this size before the picture comes. */
const THUMB = { width: 160, height: 120 };

/**
 * A picture's thumbnail over its tile (`children`). Its box has its full size from the start, so the transcript does
 * not move when the picture comes. A press shows the picture larger. With no picture (gone, too large, or bytes that
 * do not draw) the tile stands alone, as it does today.
 */
export function Preview({ testId, name, source, onDownload, children }: { testId: string; name: string; source: PreviewSource; onDownload: () => void; children: ReactNode }) {
  const { box, shot, onError } = usePreview(source);
  const [open, setOpen] = useState(false);
  return (
    <span className="chat-shot" ref={box}>
      {shot.url ? (
        <button type="button" className="chat-shot-thumb" aria-label={`View ${name}`} data-testid={testId} onClick={() => setOpen(true)}>
          <img src={shot.url} alt={name} width={THUMB.width} height={THUMB.height} draggable={false} onError={onError} />
        </button>
      ) : shot.failed ? null : (
        <span className="chat-shot-thumb" aria-hidden="true" />
      )}
      {children}
      {open && shot.url ? <PictureViewer name={name} url={shot.url} onClose={() => setOpen(false)} onDownload={onDownload} /> : null}
    </span>
  );
}

/** The picture larger, in a modal layer: its name, Download and Close. Esc and a press outside close it too. */
function PictureViewer({ name, url, onClose, onDownload }: { name: string; url: string; onClose: () => void; onDownload: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLayer({ active: true, box, onClose, modal: true, initial: () => box.current?.querySelector<HTMLElement>("[data-autofocus]") });
  return createPortal(
    <>
      <Scrim onClick={onClose} />
      <div className="dialog shot-view" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="picture-viewer" ref={box} tabIndex={-1}>
        <div className="shot-view-head">
          <h2 id={titleId} dir="auto">
            {name}
          </h2>
          <button type="button" className="btn" data-testid="picture-download" onClick={onDownload}>
            Download
          </button>
          <button type="button" className="icon-btn" aria-label="Close" data-testid="picture-close" data-autofocus="" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <img className="shot-view-img" src={url} alt={name} />
      </div>
    </>,
    document.body,
  );
}
