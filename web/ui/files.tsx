// The shared parts of the files flow (D37, D50): the drop overlay and its drag tracking, the attachment chip and the
// size labels. Downloads go through the server's download routes (panels/download.ts); a download is a read: it
// records nothing. Uploads go through act.upload (state/store.ts), inside the drop, paste or
// change handler that brought the files.
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Upload } from "../state/types";
import { IconClose, IconFile, IconImage, IconInfo, IconUpload } from "./icons";

import { uploadRoot, useStore, type FileFacts } from "../state/store";
/** What act.upload needs of a file: its name, size in bytes and MIME type (state/store.ts). */
export type { FileFacts };

/** A size as Finder writes it (1 KB is 1,000 bytes): "512 bytes", "48 KB", "1.2 MB", "3 GB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${Math.round(bytes)} bytes`;
  const kb = Math.round(bytes / 1e3);
  if (kb < 1000) return `${kb} KB`;
  const one = (n: number) => String(Math.round(n * 10) / 10);
  if (Math.round(bytes / 1e5) < 10_000) return `${one(bytes / 1e6)} MB`;
  return `${one(bytes / 1e9)} GB`;
}

/** The files of a drop, a paste or a file input, as act.upload takes them: the facts, and the file to send. */
export function filesFrom(list: FileList | readonly File[] | null | undefined): FileFacts[] {
  if (!list) return [];
  return Array.from(list as ArrayLike<File>, (f) => ({ name: f.name, size: f.size, type: f.type, file: f }));
}

/** True while a drag carries files (not text or a link). */
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

/**
 * Track a file drag over an element: `over` is true from the first dragenter until the drag leaves, ends or drops.
 * Spread `handlers` on the element (the capture forms, onDragEnterCapture and the rest, to take the drop before any
 * child); a drop calls onFiles with the files, inside the drop handler. A drag of text or a link passes through.
 */
export function useFileDrop(onFiles: (files: FileFacts[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => {
    if (!over) return;
    const end = () => {
      depth.current = 0;
      setOver(false);
    };
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, [over]);
  useEffect(() => {
    if (enabled) return;
    depth.current = 0;
    setOver(false);
  }, [enabled]);
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!enabled || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current++;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!enabled || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!enabled || !hasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!enabled || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      const files = filesFrom(e.dataTransfer.files);
      if (files.length) latest.current(files);
    },
  };
  return { over, handlers };
}

/**
 * The drop overlay (plan v2): a wash with a dashed accent edge and one line, "Drop to upload to <folder>"; `note` is a
 * second line, such as where the files wait while a card is open. While the upload folder is refused (a Custom folder
 * with no usable path, store.ts uploadRoot) the line says so instead, as the failed chips will: the overlay reads that
 * itself, because the refusal does not depend on the chat or its session.
 */
export function DropOverlay({ folder, note }: { folder: string; note?: string }) {
  const refused = useStore((s) => uploadRoot(s.settings, "").refused);
  return (
    <div className="drop-target" data-testid="drop-target" data-refused={refused ? "true" : undefined}>
      <p className="drop-target-line">
        {refused ? <IconInfo size={18} /> : <IconUpload size={18} />}
        {refused ? (
          <span>{refused}</span>
        ) : (
          <span>
            Drop to upload to <span className="drop-target-path">{folder}</span>
            {note ? <span className="drop-target-note">{note}</span> : null}
          </span>
        )}
      </p>
    </div>
  );
}

/** A small ring for an upload's progress, 0 to 1. */
export function ProgressRing({ value, size = 18 }: { value: number; size?: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return (
    <svg className="attach-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="progressbar" aria-label="Uploading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <circle cx={mid} cy={mid} r={r} className="attach-ring-track" />
      <circle cx={mid} cy={mid} r={r} className="attach-ring-fill" strokeDasharray={`${(c * pct) / 100} ${c}`} transform={`rotate(-90 ${mid} ${mid})`} />
    </svg>
  );
}

/**
 * An attachment in the composer (plan v2): an icon, the name over the size (or why it failed), a progress ring while
 * it uploads, and Remove (call act.removeUpload in onRemove). Its test id is attach-<upload id>.
 */
export function AttachChip({ upload, onRemove }: { upload: Upload; onRemove?: () => void }) {
  const failed = upload.state === "failed";
  const icon = failed ? <IconInfo size={16} /> : upload.type.startsWith("image/") ? <IconImage size={16} /> : <IconFile size={16} />;
  const line = failed ? upload.error ?? "That file could not be uploaded." : formatSize(upload.size);
  return (
    <span className={`attach-chip${failed ? " is-failed" : ""}`} data-testid={`attach-${upload.id}`} data-state={upload.state} title={failed ? `${upload.name}: ${line}` : upload.path || upload.name}>
      <span className="attach-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="attach-text">
        <span className="attach-name">{upload.name}</span>
        <span className="attach-size">{line}</span>
      </span>
      {upload.state === "uploading" ? <ProgressRing value={upload.progress} /> : null}
      {onRemove ? (
        <button type="button" className="attach-remove" aria-label={`Remove ${upload.name}`} title="Remove" data-testid="attach-remove" onClick={onRemove}>
          <IconClose size={10} />
        </button>
      ) : null}
    </span>
  );
}
