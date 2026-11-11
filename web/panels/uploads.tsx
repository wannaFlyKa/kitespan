// The chat's uploads (D37; /c/<chat>/uploads, v0.1 core): a grouped list, newest first, one line per upload, its
// folder part dimmed before its name (D51), with its size, Download, Copy path and Remove. It shows in the side panel's
// place on a laptop, in the docked pane on a tablet and as its own screen on the phone (screens/Uploads.tsx). The list
// comes from the server (GET /api/chats/<chat>/uploads when the chat opens); Remove is one DELETE under /api/, on its
// own click only; a download is a read and records nothing. The foot is only "Change the folder" (D51), with the
// server's line when the upload folder does not pass its check. A row has the upload's menu (DESIGN-T1 2.1: Download,
// Copy path and Remove, its full path first): a long press on touch, a right-click on a laptop, and in a narrow pane
// (panels.css, 23em) the row's "...", into which the three buttons fold.
import { href, type Route } from "../router";
import { act, NO_UPLOADS, uploadRoot, useStore } from "../state/store";
import type { Chat, Upload } from "../state/types";
import { Link } from "../ui/primitives";
import { CopyButton } from "../ui/Copy";
import { formatSize, ProgressRing } from "../ui/files";
import { IconDownload, IconFile, IconImage, IconInfo, IconTrash } from "../ui/icons";
import { uploadUrl } from "./download";
import { PathLine, useDownload } from "./parts";
import { uploadMenu } from "../ui/fileMenu";
import { breakable } from "../ui/breakable";
import { useRowMenu } from "../ui/RowMenu";

/** Where the view sits: the laptop's column, a pane or sheet, or its own page. */
export type UploadsPlace = "column" | "pane" | "sheet" | "page";

export function UploadsView({ chat }: { chat: Chat; route: Route; place: UploadsPlace }) {
  const uploads = useStore((s) => s.uploads[chat.id] ?? NO_UPLOADS);
  const uploadFolder = useStore((s) => s.settings.uploadFolder);
  const customFolder = useStore((s) => s.settings.customFolder);
  // Read here so the line follows the server's check of the folder (/api/settings).
  useStore((s) => s.host?.uploads);
  const root = uploadRoot({ uploadFolder, customFolder }, chat.sessionId);
  const list = [...uploads].reverse(); // newest first
  return (
    <div className="side-detail side-uploads" data-testid="uploads" role="region" aria-label="Uploads">
      {list.length ? (
        <ul className="group side-group side-ups">
          {list.map((u) => (
            <UploadRow key={u.id} chat={chat} u={u} />
          ))}
        </ul>
      ) : (
        <p className="side-empty">No uploads in this chat.</p>
      )}
      <p className="group-foot side-foot">
        {root.refused ? <span className="side-foot-line">{root.refused}</span> : null}
        <Link to={href("setting", { section: "chats", key: "upload-folder" })} className="side-foot-link">
          Change the folder
        </Link>
      </p>
    </div>
  );
}

function UploadRow({ chat, u }: { chat: Chat; u: Upload }) {
  const failed = u.state === "failed";
  const uploading = u.state === "uploading";
  const done = u.state === "done";
  const dl = useDownload(uploadUrl(chat.id, u.id), "upload");
  const icon = failed ? <IconInfo size={16} /> : u.type.startsWith("image/") ? <IconImage size={16} /> : <IconFile size={16} />;
  const sub = failed ? (u.error ?? "That file could not be uploaded.") : uploading ? `Uploading, ${formatSize(u.size)}` : formatSize(u.size);
  const menu = useRowMenu(() => uploadMenu(u, true), { openerClass: "side-up-more", openerAlways: true, onRun: () => act.removeUpload(chat.id, u.id) });
  return (
    <li className="side-up" data-testid={`upload-${u.id}`} data-state={u.state}>
      <span className="side-up-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="group-text side-up-text" {...menu.target}>
        {u.path ? <PathLine path={u.path} className="group-label side-up-name" /> : <span className="group-label side-up-name side-pl-name">{breakable(u.name)}</span>}
        <span className="group-sub side-up-line">{dl.line ?? sub}</span>
      </span>
      {uploading ? <ProgressRing value={u.progress} /> : null}
      <span className="side-up-tools">
        {done ? (
          <button type="button" className="icon-btn side-up-btn" aria-label={`Download ${u.name}`} title="Download" aria-busy={dl.busy || undefined} onClick={dl.press}>
            <IconDownload size={16} />
          </button>
        ) : null}
        {u.path ? <CopyButton text={u.path} label={`Copy path of ${u.name}`} className="side-up-copy" /> : null}
        <button
          type="button"
          className="icon-btn side-up-btn side-up-remove"
          data-testid="confirm-remove-upload"
          aria-label={`Remove ${u.name}`}
          title="Remove"
          onClick={() => act.removeUpload(chat.id, u.id)}
        >
          <IconTrash size={16} />
        </button>
      </span>
      {menu.opener}
      {menu.menu}
    </li>
  );
}
