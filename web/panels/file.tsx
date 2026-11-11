// The download view of /c/<chat>/files/<relative path> (D37; v0.1 core): a file in the chat's folder with its name,
// its size, Copy path and Download; a folder downloads as .tar.gz. A laptop shows it in the side panel's place beside
// the chat, a medium touch device in the docked pane, the phone as its own screen (screens/FileDownload.tsx, DESIGN.md
// 5.3). The page asks the route's existence probe first (a 200 read: is the path there, a file or a folder, how
// large), so a path that is not in the chat's folder shows the 5.4 line and no Download, with no failed request and
// no console error. A download is a read: it records nothing.
import type { Route } from "../router";
import { chatFolderIn, useStore } from "../state/store";
import type { Chat } from "../state/types";
import { CopyButton } from "../ui/Copy";
import { formatSize } from "../ui/files";
import { IconDoc, IconDownload, IconFile, IconFolder } from "../ui/icons";
import { UNKNOWN } from "./details";
import { FILE_GONE, filesUrl, type ProbeState } from "./download";
import { baseName, cleanRel, inFolder } from "./format";
import { useDownload, useProbe } from "./parts";

export { FILE_GONE } from "./download";

/** Where the view sits: the laptop's column, the medium pane, the phone's sheet, or its own page. */
export type FilePlace = "column" | "pane" | "sheet" | "page";

export function FileView({ chat, route, place }: { chat: Chat; route: Route; place: FilePlace }) {
  const path = cleanRel(route.params.path ?? "");
  const state = useProbe(filesUrl(chat.id, path), "file");
  return <FileBody chat={chat} path={path} place={place} state={state} />;
}

/** The view for one probe state: "..." while the probe runs, the file once it passed, else the probe's line. */
export function FileBody({ chat, path, place, state }: { chat: Chat; path: string; place: FilePlace; state: ProbeState }) {
  const folderOf = useStore((s) => chatFolderIn(s, chat));
  const dl = useDownload(filesUrl(chat.id, path), "file");
  const H = place === "page" ? "h1" : place === "column" ? "h2" : "h3";
  const name = baseName(path) || path;

  if (!path || (state.phase === "done" && !state.ok))
    return (
      <div className="side-detail side-file-view" data-testid="file-download" role="region" aria-label="File">
        <p className="notice side-notice" data-testid="link-notice">
          {path && state.phase === "done" && !state.ok ? state.line : FILE_GONE}
        </p>
      </div>
    );

  const probe = state.phase === "done" && state.ok ? state.probe : null;
  const folder = probe?.kind === "folder";
  const full = inFolder(folderOf, path);
  const line = dl.line;
  return (
    <div className="side-detail side-file-view" data-testid="file-download" role="region" aria-label={folder ? `${name}/` : name}>
      <div className="file-head">
        <span className="file-icon" aria-hidden="true">
          {folder ? <IconFolder size={22} /> : /\.(md|markdown)$/i.test(path) ? <IconDoc size={22} /> : <IconFile size={22} />}
        </span>
        <H className="side-page-title file-name">{folder ? `${name}/` : name}</H>
      </div>
      <ul className="group side-group">
        <li className="group-row">
          <span className="group-label side-grow">Size</span>
          <span className="group-value side-num">{probe ? formatSize(probe.size) : UNKNOWN}</span>
        </li>
      </ul>
      <div className="file-actions">
        {probe ? (
          <button type="button" className="btn primary" data-testid="file-download-button" aria-busy={dl.busy || undefined} onClick={dl.press}>
            <IconDownload size={16} />
            {folder ? "Download as .tar.gz" : "Download"}
          </button>
        ) : null}
        <CopyButton text={full} label="Copy path" withLabel className="side-copy" />
      </div>
      {line ? (
        <p className="notice side-notice" role="status">
          {line}
        </p>
      ) : null}
    </div>
  );
}
