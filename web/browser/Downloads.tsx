// Downloads (DESIGN-B1 4.8, PAGE 9): a line at the stage's foot for the newest download ("Downloading, 40%", then
// "Downloaded, 84 KB" with Download and Close), and More > Downloads, the list newest first with "No downloads yet."
// Download is a read (GET /api/browser/downloads/<id>/file, an attachment): it fetches the file to this device and
// sends nothing that changes anything. The server holds the files and their names; the page never sees a URL.
import type { BrowserDownloadView } from "../../shared/browser";
import { formatSize } from "../ui/files";
import { IconClose } from "../ui/icons";

export const downloadFileHref = (id: string) => `/api/browser/downloads/${encodeURIComponent(id)}/file`;

/** A download's state in words (PAGE 16). */
export function downloadWords(d: Pick<BrowserDownloadView, "state" | "received" | "total">): string {
  if (d.state === "completed") return `Downloaded, ${formatSize(d.received || d.total)}`;
  if (d.state === "canceled") return "Canceled";
  return d.total > 0 ? `Downloading, ${Math.min(99, Math.floor((d.received / d.total) * 100))}%` : "Downloading…";
}

export function DownloadLine({ d, onClose }: { d: BrowserDownloadView; onClose: () => void }) {
  return (
    <div className="bp-note" role="status" data-testid="browser-download-line">
      <span className="bp-note-text">
        {d.name}
        <br />
        <span className="dim">{downloadWords(d)}</span>
      </span>
      {d.state === "completed" ? (
        <a className="btn" href={downloadFileHref(d.id)} download={d.name}>
          Download
        </a>
      ) : null}
      <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
        <IconClose size={14} />
      </button>
    </div>
  );
}

export function DownloadList({ downloads }: { downloads: readonly BrowserDownloadView[] }) {
  if (!downloads.length) return <p className="bp-more-size-note">No downloads yet.</p>;
  return (
    <ul className="bp-downloads" data-testid="browser-downloads-list">
      {downloads.map((d) => (
        <li key={d.id} className="bp-download">
          <span className="bp-download-text">
            <span className="bp-download-name">{d.name}</span>
            <span className="bp-download-meta">{downloadWords(d)}</span>
          </span>
          {d.state === "completed" ? (
            <a className="btn" href={downloadFileHref(d.id)} download={d.name}>
              Download
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
