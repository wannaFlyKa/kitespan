// The detail view of each side card (DESIGN.md 6.7), drawn as grouped lists (plan v3). A detail view replaces the
// card list inside the panel; the panel (SidePanel.tsx) puts its one header row above it, "< Context", which closes
// it to /c/<chat>/details. Everything here comes from the server: the chat's events, its `get` reads and
// /api/settings. Until Claude Code reports a value, its place shows "...", never a made-up value.
import { Fragment, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { ConnectorInfo } from "../../shared/protocol";
import { closeTo, href, type Route } from "../router";
import { act, chatFolderIn, useStore } from "../state/store";
import type { Chat, Output } from "../state/types";
import { Link } from "../ui/primitives";
import { CopyButton } from "../ui/Copy";
import { IconBack, IconDoc, IconDownload, IconFile } from "../ui/icons";
import { filesUrl } from "./download";
import { STATUS_WORD, inChatFolder, isNote, kTokens, outputPath, pathParts, viewOf, viewUrl } from "./format";
import { PathLine, reloadConnectorsSoon, useClaudeFacts, useDownload } from "./parts";
import { WORKTREE_WORDS, chatFolder, worktreeOf } from "../worktree/worktree";
import { shownWorkingFolder } from "../state/reduce";
import { ENV_WORDS } from "../env/vars";
import { fileMenu } from "../ui/fileMenu";
import { useRowMenu, type RowMenuParts } from "../ui/RowMenu";

export type DetailName = "environment" | "context" | "connectors" | "outputs";
export const DETAIL_NAMES = new Set<string>(["environment", "context", "connectors", "outputs"]);

export const DETAIL_LABEL: Record<DetailName, string> = { environment: "Environment", context: "Context", connectors: "Connectors", outputs: "Outputs" };

/** The 5.4 line for a `server` value that is not one of the chat's MCP servers. */
export const CONNECTOR_GONE = "That connector is not in this chat.";

/** Claude Code has not reported this value yet (6.7). */
export const UNKNOWN = "...";

export function Detail({ name, chat, route }: { name: DetailName; chat: Chat; route: Route }) {
  return (
    <div className="side-detail" data-testid={`side-${name}`} data-detail="true" aria-label={DETAIL_LABEL[name]} role="region">
      {name === "environment" ? <EnvironmentDetail chat={chat} /> : null}
      {name === "context" ? <ContextDetail chat={chat} route={route} /> : null}
      {name === "connectors" ? <ConnectorsDetail chat={chat} route={route} /> : null}
      {name === "outputs" ? <OutputsDetail chat={chat} route={route} /> : null}
    </div>
  );
}

// Set when a card's title opens its detail, so the detail takes the focus that the unmounted card link had. A deep
// link that opens a detail directly leaves focus alone.
let focusNextDetail = false;
export function openedFromCard() {
  focusNextDetail = true;
}

/** "< Context": closes the view to its parent, going back when the parent is the previous entry. */
export function BackRow({ label, to, aria, className = "" }: { label: string; to: string; aria?: string; className?: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (!focusNextDetail) return;
    focusNextDetail = false;
    const a = document.activeElement;
    if (!a || a === document.body) ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <a
      ref={ref}
      href={to}
      className={`side-back ${className}`.trim()}
      aria-label={aria ?? `Back to Details from ${label}`}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        closeTo(to);
      }}
    >
      <IconBack size={16} />
      <span>{label}</span>
    </a>
  );
}

/** One fact of a detail: its name over its value, so a long path keeps the full width of the row. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="group-row side-fact">
      <span className="side-fact-label">{label}</span>
      <span className="side-fact-value">{children}</span>
    </li>
  );
}

/** A path in mono that wraps after a slash; a name breaks inside only when it is wider than the column. */
export function PathText({ path, className = "", ref }: { path: string; className?: string; ref?: Ref<HTMLSpanElement> }) {
  return (
    <span className={`mono side-path ${className}`.trim()} ref={ref}>
      {pathParts(path).map((part, i) => (
        <Fragment key={i}>
          {i ? <wbr /> : null}
          <span className="side-path-part">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * A file's name that wraps in a narrow pane in place of an ellipsis: it may break before a dot (not a leading one) and
 * after an underscore, as it already may after a hyphen, so "CHANGELOG.md" wraps as "CHANGELOG" over ".md".
 */
export function NameText({ name, className }: { name: string; className?: string }) {
  const parts = name.split(/(?<=.)(?=\.)|(?<=_)(?=.)/);
  return (
    <span className={className}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

const Unknown = () => <span className="side-dim">{UNKNOWN}</span>;

function EnvironmentDetail({ chat }: { chat: Chat }) {
  const project = useStore((s) => s.projects.find((p) => p.id === chat.projectId));
  const machine = useStore((s) => s.machine); // the server's name for the machine (D54)
  const claude = useClaudeFacts(chat);
  const sessionRef = useRef<HTMLSpanElement>(null);
  // Row 73: a worktree chat's folder is its worktree, of the project's folder, on its own branch (W6).
  const worktree = chat.worktree ?? null;
  const folder = chatFolder(worktree, project?.folder);
  const branch = worktree ? worktree.branch : project?.branch || null;
  // L34: the folder Claude Code says it works in, when Claude moved the session away from the chat's own (EnterWorktree).
  const working = shownWorkingFolder(chat.workingFolder, folder);
  return (
    <>
      <ul className="group side-group">
        <Fact label="Host">{machine ?? <Unknown />}</Fact>
        <Fact label={WORKTREE_WORDS.folder}>
          {folder ? <PathText path={folder} /> : <Unknown />}
          {worktree && project ? (
            <span className="side-dim side-sub" data-testid="worktree-of">
              {worktreeOf(project.folder)}
            </span>
          ) : null}
        </Fact>
        {working ? (
          <Fact label={WORKTREE_WORDS.workingFolder}>
            <PathText path={working} />
          </Fact>
        ) : null}
        {branch ? (
          <Fact label={WORKTREE_WORDS.branch}>
            <span className="mono side-path">{branch}</span>
          </Fact>
        ) : null}
        {project?.env ? (
          <Fact label={ENV_WORDS.title}>
            <Link to={href("projectEnvironment", { project: project.id })} className="side-env-link" aria-label={`${ENV_WORDS.title}: ${project.env}`}>
              {project.env}
            </Link>
          </Fact>
        ) : null}
        <Fact label="Claude Code">
          {claude.path ? <PathText path={claude.path} /> : claude.ok === false ? <span>There is no claude on your PATH.</span> : <Unknown />}
          {claude.realpath && claude.realpath !== claude.path ? <PathText path={claude.realpath} className="side-dim" /> : null}
          {claude.version ? <span>Version {claude.version}</span> : null}
        </Fact>
        <Fact label="Agent SDK">
          <span>Version {claude.sdk}</span>
        </Fact>
        {chat.sessionId ? (
          <Fact label="Session">
            <span className="mono side-path" ref={sessionRef}>
              {chat.sessionId}
            </span>
            <CopyButton text={chat.sessionId} label="Copy session id" withLabel className="side-copy" testId="copy-session-id" target={() => sessionRef.current} />
          </Fact>
        ) : null}
      </ul>
      {claude.drift ? <p className="group-foot side-foot">{claude.drift}</p> : null}
    </>
  );
}

// Shades of the accent for the stacked bar and its swatches; the free space stays the empty track.
const SHADES = [100, 76, 56, 40, 28, 20];

/** The model a chat's Claude Code runs, by its picker name when the chat's model rows know it. */
export function modelName(chat: Chat): string | null {
  const id = chat.liveModel ?? (chat.model !== "default" ? chat.model : null);
  if (!id) return null;
  return chat.models?.find((m) => m.value === id)?.displayName ?? id;
}

/**
 * Context: the window's use and its parts. Until Claude Code reports them, "..." shows only while the chat's Claude
 * Code runs, since a read can still answer; a sleeping or archived chat's Claude Code reports nothing until it wakes,
 * so its view keeps only Compact (M17: no lasting "...").
 */
function ContextDetail({ chat, route }: { chat: Chat; route: Route }) {
  const { usedPct, usedTokens, windowTokens, parts } = chat.context;
  const known = windowTokens > 0;
  const reading = !chat.archived && chat.serverState !== "sleeping" && chat.serverState !== "ending";
  const pct = Math.max(0, Math.min(100, Math.round(usedPct)));
  const free = Math.max(0, windowTokens - usedTokens);
  const model = modelName(chat);
  const shade = (i: number) => `color-mix(in srgb, var(--accent) ${SHADES[i % SHADES.length]}%, var(--elevated))`;
  return (
    <>
      {known || reading ? (
        <div className="group side-group side-ctx">
          {known ? (
            <>
              <p className="side-big">
                {pct}%<span className="side-big-sub">
                  {kTokens(usedTokens)} of {kTokens(windowTokens)} tokens
                </span>
              </p>
              <div className="side-stack" aria-hidden="true">
                {parts.map((p, i) => (
                  <i key={p.label} style={{ width: `${((p.tokens / windowTokens) * 100).toFixed(2)}%`, background: shade(i) }} />
                ))}
              </div>
            </>
          ) : (
            <p className="side-big side-dim">{UNKNOWN}</p>
          )}
        </div>
      ) : null}
      {known ? (
        <>
          <ul className="group side-group" aria-label="What fills the context window">
            {parts.map((p, i) => (
              <li className="group-row side-kv" key={p.label}>
                <span className="side-sw" style={{ background: shade(i) }} aria-hidden="true" />
                <span className="group-label side-kv-k">{p.label}</span>
                <span className="group-value side-kv-v">{kTokens(p.tokens)}</span>
              </li>
            ))}
            <li className="group-row side-kv">
              <span className="side-sw side-sw-free" aria-hidden="true" />
              <span className="group-label side-kv-k">Free space</span>
              <span className="group-value side-kv-v">{kTokens(free)}</span>
            </li>
          </ul>
          <p className="group-foot side-foot">{model ? `${model}, ${kTokens(windowTokens)} window` : `${kTokens(windowTokens)} window`}</p>
        </>
      ) : null}
      <div className="side-actions">
        <Link to={href("slash", { chat: chat.id, command: "compact" }, { view: viewOf(route) })} className="btn">
          Compact
        </Link>
      </div>
    </>
  );
}

/** The chat's MCP servers as the server read them (`get connectors`), or null before the first read. */
export function connectorsOf(chat: Chat): ConnectorInfo[] | null {
  if (chat.connectorInfo) return chat.connectorInfo;
  if (!chat.connectors.length) return null;
  return chat.connectors.map((c) => ({ name: c.name, status: c.status, error: null, tools: c.tools, scope: c.source || null, hasView: false }));
}

function ConnectorsDetail({ chat, route }: { chat: Chat; route: Route }) {
  const list = connectorsOf(chat);
  const marked = typeof route.query.server === "string" ? route.query.server : "";
  const missing = marked !== "" && list !== null && !list.some((c) => c.name === marked);
  const markedRef = useRef<HTMLButtonElement>(null);
  // A Reconnect that was pressed: its button waits until the next read of the list.
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setWaiting(new Set()), [chat.connectorInfo]);
  useEffect(() => {
    // The route marks a row: bring it into view and focus its Reconnect, which still waits for a click.
    const b = markedRef.current;
    if (!b) return;
    b.closest("li")?.scrollIntoView({ block: "nearest" });
    b.focus({ preventScroll: true });
  }, [marked, list !== null]);
  return (
    <>
      {missing ? (
        <p className="notice side-notice" data-testid="link-notice">
          {CONNECTOR_GONE}
        </p>
      ) : null}
      {list === null ? (
        <p className="side-empty">{UNKNOWN}</p>
      ) : list.length ? (
        <ul className="group side-group side-conns">
          {list.map((c) => {
            const isMarked = c.name === marked;
            const busy = c.status === "pending" || waiting.has(c.name);
            const detail = c.status === "connected" ? `${STATUS_WORD.connected}, ${c.tools} ${c.tools === 1 ? "tool" : "tools"}` : STATUS_WORD[c.status];
            return (
              <li key={c.name} className="group-row side-conn" data-marked={isMarked || undefined} data-status={c.status} aria-current={isMarked ? "true" : undefined}>
                <span className={`side-sdot side-sdot-${c.status}`} aria-hidden="true" />
                <span className="side-wrap">
                  <span className="group-text side-wrap-main">
                    <span className="group-label side-conn-name">{c.name}</span>
                    <span className="group-sub side-conn-status">{detail}</span>
                    {c.status === "failed" && c.error ? <span className="group-sub side-conn-error">{c.error}</span> : null}
                  </span>
                  {c.status === "disabled" ? null : (
                    <button
                      type="button"
                      ref={isMarked ? markedRef : undefined}
                      className={`btn side-reconnect${isMarked ? " primary" : ""}`}
                      data-testid={`confirm-reconnect-${c.name}`}
                      disabled={busy}
                      aria-label={`${busy ? "Reconnecting" : "Reconnect"} ${c.name}`}
                      onClick={() => {
                        setWaiting((w) => new Set([...w, c.name]));
                        act.reconnect(chat.id, c.name);
                        reloadConnectorsSoon(chat.id);
                      }}
                    >
                      {busy ? "Reconnecting..." : "Reconnect"}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="side-empty">No MCP servers in this chat.</p>
      )}
    </>
  );
}

function OutputsDetail({ chat, route }: { chat: Chat; route: Route }) {
  const files = [...chat.outputs].reverse();
  const folder = useStore((s) => chatFolderIn(s, chat));
  return files.length ? (
    <ul className="group side-group side-files">
      {files.map((o) => (
        <OutputRow key={o.path} chat={chat} route={route} o={o} folder={folder} />
      ))}
    </ul>
  ) : (
    <p className="side-empty">Claude has not edited a file in this chat.</p>
  );
}

/**
 * One file: its download page, Copy path and Download. A file outside the chat's folder (Plan mode's plan file) is
 * plain text with Copy path only: no URL may hold its path (5.1 rule 2), and the download routes never serve it. The
 * row has the file's menu (DESIGN-T1 2.1): a long press on touch, where its "..." takes Download's place, and a
 * right-click on a laptop, where a link row's menu also has Open in new tab and Copy link.
 */
function OutputRow({ chat, route, o, folder }: { chat: Chat; route: Route; o: Output; folder?: string }) {
  const name = o.path.slice(o.path.lastIndexOf("/") + 1);
  const glyph = isNote(o) ? <IconDoc size={16} className="side-glyph" /> : <IconFile size={16} className="side-glyph" />;
  const copy = <CopyButton text={outputPath(folder, o.path)} label={`Copy path of ${name}`} className="side-copy-icon" />;
  const menu = useRowMenu((here) => fileMenu({ place: "outputs", chatId: chat.id, path: o.path, folder, open: (rel) => viewUrl("files", chat.id, here.route ?? route, { path: rel }), laptop: here.laptop, origin: here.origin }), { openerClass: "side-row-more" });
  if (!inChatFolder(o.path))
    return (
      <li className="side-file-li">
        <div className="group-row side-file">
          {glyph}
          <span className="side-file-text" {...menu.target}>
            <PathLine path={o.path} />
          </span>
          <span className="side-file-tools">
            {copy}
            {menu.opener}
          </span>
        </div>
        {menu.menu}
      </li>
    );
  return <OutputLinkRow chat={chat} route={route} o={o} name={name} glyph={glyph} copy={copy} menu={menu} />;
}

function OutputLinkRow({ chat, route, o, name, glyph, copy, menu }: { chat: Chat; route: Route; o: Output; name: string; glyph: ReactNode; copy: ReactNode; menu: RowMenuParts }) {
  const dl = useDownload(filesUrl(chat.id, o.path), "file");
  return (
    <li className="side-file-li">
      <div className="group-row side-file">
        {glyph}
        <Link to={viewUrl("files", chat.id, route, { path: o.path })} className="side-file-text" draggable={menu.touch ? false : undefined} {...menu.target}>
          <PathLine path={o.path} />
        </Link>
        <span className="side-file-tools">
          {copy}
          {menu.opener ?? (
            <button type="button" className="icon-btn side-dl" aria-label={`Download ${name}`} title="Download" aria-busy={dl.busy || undefined} onClick={dl.press}>
              <IconDownload size={16} />
            </button>
          )}
        </span>
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
