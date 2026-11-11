// The side cards of the owner's Desktop screenshot (DESIGN.md 6.7), drawn as grouped lists (plan v3: .group in
// base.css, so each look restyles them). Environment and Outputs fold open in place under their titles; Context,
// Connectors and Uploads are one group of rows that each open a view. Every card's title links to its detail view, so
// each card has a URL. A card or a row shows once it holds something (D51, M17): Context once Claude Code reported the
// chat's context window (a sleeping chat's Claude Code reports nothing until it wakes), Outputs once Claude has edited
// a file, Connectors once the chat has an MCP server, Uploads once the server holds one of the chat's uploads (FIX-Q1:
// it counts those only; a refused or failed one, and one still on its way, show in the list and in the box's chip),
// except beside the pane bar, whose Files button opens the same list (7.3: the bar and the pane never disagree on
// which pane is open). A download is a
// read and records nothing. A file outside the chat's folder (Plan mode's plan file) has no download page and no
// Download: its path is plain text with Copy path, since no URL may hold it (5.1 rule 2).
import type { ReactNode } from "react";
import type { Route } from "../router";
import { NO_UPLOADS, chatFolderIn, useStore } from "../state/store";
import type { Chat, Output } from "../state/types";
import { Link } from "../ui/primitives";
import { IconBranch, IconChevron, IconDoc, IconDownload, IconFile, IconFolder, IconRight, IconTerminal } from "../ui/icons";
import { CopyButton } from "../ui/Copy";
import { UNKNOWN, connectorsOf, openedFromCard } from "./details";
import { filesUrl } from "./download";
import { baseName, connectorProblems, folderParts, inChatFolder, isNote, setSidePrefs, useSidePrefs, viewUrl } from "./format";
import { PathLine, useDownload } from "./parts";
import { ConnectorProblems } from "./problems";
import { fileMenu } from "../ui/fileMenu";
import { useRowMenu, type RowMenuParts } from "../ui/RowMenu";

const OUTPUT_ROWS = 5;

/** `paneBar`: the pane bar is beside the panel, and its Files button opens the chat's uploads, so no Uploads row. */
export function Cards({ chat, route, paneBar = false }: { chat: Chat; route: Route; paneBar?: boolean }) {
  const uploads = useStore((s) => (paneBar ? 0 : (s.uploads[chat.id] ?? NO_UPLOADS).filter((u) => u.state === "done").length));
  const context = chat.context.windowTokens > 0;
  const connectors = !!connectorsOf(chat)?.length;
  return (
    <div className="side-cards">
      <EnvironmentCard chat={chat} route={route} />
      {context || connectors || uploads ? (
        <ul className="group side-group side-links" aria-label="Session">
          {context ? <ContextRow chat={chat} route={route} /> : null}
          {connectors ? <ConnectorsRow chat={chat} route={route} /> : null}
          {uploads ? <LinkRow testId="side-uploads" to={viewUrl("uploads", chat.id, route)} label="Uploads" value={`${uploads} ${uploads === 1 ? "file" : "files"}`} /> : null}
        </ul>
      ) : null}
      {chat.outputs.length ? <OutputsCard chat={chat} route={route} /> : null}
    </div>
  );
}

function Fold({ open, label, controls, onToggle }: { open: boolean; label: string; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className="icon-btn side-fold" aria-expanded={open} aria-controls={controls} aria-label={`${open ? "Collapse" : "Expand"} ${label}`} onClick={onToggle}>
      <IconChevron size={15} />
    </button>
  );
}

/** A card's title over its group: the title links to the detail view, the chevron folds the group. */
function CardHead({ to, title, fold }: { to: string; title: string; fold: { open: boolean; controls: string; onToggle: () => void } }) {
  return (
    <div className="side-card-head">
      <Link to={to} className="side-card-title" onNavigate={openedFromCard}>
        {title}
      </Link>
      <Fold open={fold.open} label={title} controls={fold.controls} onToggle={fold.onToggle} />
    </div>
  );
}

function EnvironmentCard({ chat, route }: { chat: Chat; route: Route }) {
  const { envOpen } = useSidePrefs();
  const project = useStore((s) => s.projects.find((p) => p.id === chat.projectId));
  // The machine by its own name from the server (D54), never the browser's address; no row while there is none.
  const machine = useStore((s) => s.machine);
  const folder = project ? folderParts(project.folder) : null;
  const bodyId = `side-env-${chat.id}`;
  return (
    <section className="side-card" data-testid="side-environment" data-open={envOpen} aria-label="Environment">
      <CardHead to={viewUrl("environment", chat.id, route)} title="Environment" fold={{ open: envOpen, controls: bodyId, onToggle: () => setSidePrefs({ envOpen: !envOpen }) }} />
      {envOpen ? (
        <ul className="group side-group" id={bodyId}>
          {machine ? (
            <li className="group-row side-row">
              <IconTerminal size={16} className="side-glyph" />
              <span className="group-label side-row-text">{machine}</span>
            </li>
          ) : null}
          <li className="group-row side-row" title={project?.folder}>
            <IconFolder size={16} className="side-glyph" />
            {folder ? (
              <>
                <span className="group-label side-row-text">{folder.name}</span>
                {folder.parent ? (
                  <span className="group-value side-row-parent">
                    <bdi>{folder.parent}</bdi>
                  </span>
                ) : null}
              </>
            ) : (
              <span className="group-label side-dim">{UNKNOWN}</span>
            )}
          </li>
          {chat.worktree?.branch ? (
            // Row 73: a worktree chat works on its own branch, beside its project's folder (W6).
            <li className="group-row side-row" data-testid="side-worktree-branch">
              <IconBranch size={16} className="side-glyph" />
              <span className="group-label side-row-text mono">{chat.worktree.branch}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * One row of the session group: a label, a value and a chevron, opening a view. When the label and the value do not
 * fit on one line (a narrow pane, a large text size), the value moves whole to its own line under the label.
 */
function LinkRow({ to, label, value, testId }: { to: string; label: string; value: ReactNode; testId: string }) {
  return (
    <li data-testid={testId}>
      <Link to={to} className="group-row side-link" onNavigate={openedFromCard}>
        <span className="side-link-body">
          <span className="group-label side-link-label">{label}</span>
          {value === null ? null : <span className="group-value side-link-value">{typeof value === "string" ? <span className="side-link-words">{value}</span> : value}</span>}
        </span>
        <IconRight size={14} className="group-chevron" />
      </Link>
    </li>
  );
}

/** The context row, drawn once Claude Code reported the chat's window: the percent used and its meter. */
function ContextRow({ chat, route }: { chat: Chat; route: Route }) {
  const pct = Math.max(0, Math.min(100, Math.round(chat.context.usedPct)));
  return (
    <LinkRow
      testId="side-context"
      to={viewUrl("context", chat.id, route)}
      label="Context"
      value={
        <>
          <span className="side-num">{pct}%</span>
          <span className="side-meter" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </span>
        </>
      }
    />
  );
}

/** "Connectors" and a problem count only (D51): nothing while every server is connected. */
function ConnectorsRow({ chat, route }: { chat: Chat; route: Route }) {
  const list = connectorsOf(chat) ?? [];
  const { failed, signIn } = connectorProblems(list);
  const value =
    failed || signIn ? (
      <span className="side-link-words">
        <ConnectorProblems list={list} />
      </span>
    ) : null;
  return <LinkRow testId="side-connectors" to={viewUrl("connectors", chat.id, route)} label="Connectors" value={value} />;
}

function OutputsCard({ chat, route }: { chat: Chat; route: Route }) {
  const { outOpen, outMore } = useSidePrefs();
  const files = [...chat.outputs].reverse(); // newest first: the chat appends each file as Claude writes it
  const shown = outMore ? files : files.slice(0, OUTPUT_ROWS);
  const bodyId = `side-out-${chat.id}`;
  return (
    <section className="side-card" data-testid="side-outputs" data-open={outOpen} aria-label="Outputs">
      <CardHead to={viewUrl("outputs", chat.id, route)} title="Outputs" fold={{ open: outOpen, controls: bodyId, onToggle: () => setSidePrefs({ outOpen: !outOpen }) }} />
      {outOpen ? (
        <ul className="group side-group" id={bodyId}>
          {shown.map((o) => (
            <OutputCardRow key={o.path} chat={chat} route={route} o={o} />
          ))}
          {files.length > OUTPUT_ROWS ? (
            <li>
              <button type="button" className="group-row side-more" aria-expanded={outMore} onClick={() => setSidePrefs({ outMore: !outMore })}>
                {outMore ? "Show less" : "Show more"}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * One file on one line: its download page, and Download beside it. A file outside the chat's folder is plain text,
 * with Copy path (its own full path) in Download's place. The row has the file's menu (DESIGN-T1 2.1: a long press on
 * touch, whose "..." takes the one button's place, and a right-click on a laptop).
 */
function OutputCardRow({ chat, route, o }: { chat: Chat; route: Route; o: Output }) {
  const glyph = isNote(o) ? <IconDoc size={16} className="side-glyph" /> : <IconFile size={16} className="side-glyph" />;
  const folder = useStore((s) => chatFolderIn(s, chat));
  const menu = useRowMenu((here) => fileMenu({ place: "outputs", chatId: chat.id, path: o.path, folder, open: (rel) => viewUrl("files", chat.id, here.route ?? route, { path: rel }), laptop: here.laptop, origin: here.origin }), { openerClass: "side-row-more" });
  if (!inChatFolder(o.path))
    return (
      <li className="side-out-li">
        <div className="side-out">
          <span className="group-row side-out-link" {...menu.target}>
            {glyph}
            <PathLine path={o.path} className="group-label" />
          </span>
          {menu.opener ?? <CopyButton text={o.path} label={`Copy path of ${baseName(o.path)}`} className="side-copy-icon" />}
        </div>
        {menu.menu}
      </li>
    );
  return <OutputCardLink chat={chat} route={route} o={o} glyph={glyph} menu={menu} />;
}

function OutputCardLink({ chat, route, o, glyph, menu }: { chat: Chat; route: Route; o: Output; glyph: ReactNode; menu: RowMenuParts }) {
  const name = baseName(o.path);
  const dl = useDownload(filesUrl(chat.id, o.path), "file");
  return (
    <li className="side-out-li">
      <div className="side-out">
        <Link to={viewUrl("files", chat.id, route, { path: o.path })} className="group-row side-out-link" draggable={menu.touch ? false : undefined} {...menu.target}>
          {glyph}
          <PathLine path={o.path} className="group-label" />
        </Link>
        {menu.opener ?? (
          <button type="button" className="icon-btn side-dl" aria-label={`Download ${name}`} title="Download" aria-busy={dl.busy || undefined} onClick={dl.press}>
            <IconDownload size={16} />
          </button>
        )}
      </div>
      {dl.line ? (
        <p className="side-row-line" role="status">
          {dl.line}
        </p>
      ) : null}
      {menu.menu}
    </li>
  );
}
