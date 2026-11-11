// /p/<project> and /p/<project>/session/<session> (DESIGN.md 6.9). The project page shows the project's folder, its
// remembered choices with Forget (new chats use them while Settings > Chats > New chats start with is "My last choice
// here", 6.8), its chats (archived ones left out, D48), "+ New chat here" and its sessions from the terminal. The line
// that explains remembered choices is one tap away (M31): Forget asks first, in place, and that confirm says it. The
// session page is a read-only preview of a Claude Code session that kitespan has not opened (GET reads only; no Claude
// Code starts); Continue here makes it a chat, and only that click acts. The preview has no banner (M20): its missing
// composer and its button say that it is read-only, and its foot keeps Desktop's advice. A session that another app
// has open now (D58) is marked in the list and in the preview's foot, and its button is Continue in a copy: the chat
// continues a fork, and the other app keeps the session. The page reads the preview again when it comes back into view
// and when the server refuses a Continue here because another app opened the session meanwhile (W19d); a copy that a
// chat holds already is offered beside the button. Settings > Chats decides which sessions the server lists (row 77):
// none while Show sessions from other apps is off, and no session that another app has open while Show sessions open
// in another app is off; the preview of such a session says which setting hides it, in one line with that setting's
// link. The look (plan v3): the project's name as the page title with New chat here as the primary button, then
// grouped lists (.group).
// Row 99: beside New chat here, the environment's menu (Rename and Remove, EnvironmentMenu.tsx); /p/<project>/rename
// puts the name field in the title's place, and /p/<project>/remove opens Remove's confirm over the page.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { closeTo, href, navigate, type Route } from "../router";
import { act, useStore, visibleChats, type SessionsHidden } from "../state/store";
import { applyHistory, type ChatPart } from "../state/reduce";
import { ApiError, apiGet } from "../net/api";
import type { SessionHidden, SessionPreviewReply, SessionView } from "../../server/http/api-types";
import { LIMITS, type SessionOpen } from "../../shared/protocol";
import type { Item, Project } from "../state/types";
import { Shell } from "../layout/Shell";
import { Link, relTime } from "../ui/primitives";
import { LinkNotice } from "../ui/LinkNotice";
import { UpdateLine } from "../update/UpdateLine";
import { IconBranch, IconFolder, IconMore, IconPlus, IconRight } from "../ui/icons";
import { ENV_WORDS, envCell } from "../env/vars";
import { WORKTREE_WORDS } from "../worktree/worktree";
import { ENVIRONMENT } from "./EnvironmentScreen";
import { ItemView } from "../chat/items/ItemView";
import { ChatDot, ChatMeta, ChatTitle, effortLabel, modeLabel, modelLabel, newestFirst, useModelRowsFor, usePopupFocus, useScreenNotice } from "./common";
import { EnvMenu } from "./EnvironmentMenu";
import { EnvRenameForm, RemoveEnvDialog, envParent } from "../dialogs/EnvironmentDialogs";
import { Home, SessionRows, openMark, useTerminalSessions, whenBack } from "./Home";

export { openMark };

const PROJECT_GONE = "That project is not here.";
const SESSION_GONE = "That session is not in this project's folder.";
const ago = (iso: string) => (relTime(iso, Date.now()) === "now" ? "just now" : `${relTime(iso, Date.now())} ago`);

/** Forget's confirm (M31): what remembered choices do, and that a Plan pick is never remembered. */
export function forgetLine(project: Pick<Project, "name">): string {
  return `New chats in ${project.name} start with these. A Plan pick is never remembered.`;
}

/** D58: the preview's button: a session that another app has open is continued in a copy. */
export function continueWord(open: SessionOpen | null | undefined): string {
  return open ? "Continue in a copy" : "Continue here";
}

/** Row 77: the setting in Settings > Chats that hides this session from the lists, as the project's list said, or null. */
export function hiddenBy(hidden: SessionsHidden | undefined, sessionId: string): SessionHidden | null {
  if (!hidden) return null;
  if (hidden.all) return "all";
  return hidden.open.includes(sessionId) ? "open" : null;
}

/** Row 77: the preview's one line for a session that a setting hides, with that setting's link (it opens the row only). */
export function HiddenLine({ why }: { why: SessionHidden }) {
  if (why === "all")
    return (
      <>
        <Link to={href("setting", { section: "chats", key: "sessions-from-other-apps" })}>Show sessions from other apps</Link> is off in Settings, so this session does not show here.
      </>
    );
  return (
    <>
      Another app has this session open now, and <Link to={href("setting", { section: "chats", key: "sessions-open-elsewhere" })}>Show sessions open in another app</Link> is off in Settings, so it does not show here.
    </>
  );
}

/** The project's sessions from the terminal, each opening its preview; one that another app has open says so (D58). */
export function ProjectSessionRows({ project, sessions }: { project: Project; sessions: readonly SessionView[] }) {
  const rows = useMemo(() => sessions.map((s) => ({ s, p: project })), [sessions, project]);
  return <SessionRows rows={rows} withProject={false} />;
}

export function ProjectScreen({ route }: { route: Route }) {
  const project = useStore((s) => s.projects.find((p) => p.id === route.params.project));
  if (!project) return <Home route={route} notice={PROJECT_GONE} />;
  return (
    <Shell route={route}>
      <ProjectBody project={project} route={route} />
      {route.name === "projectRemove" ? <RemoveEnvDialog project={project} onClose={() => closeTo(envParent(project.id))} /> : null}
    </Shell>
  );
}

function ProjectBody({ project, route, notice }: { project: Project; route: Route; notice?: ReactNode }) {
  const allChats = useStore((s) => s.chats);
  const chats = useMemo(() => visibleChats(allChats).filter((c) => c.projectId === project.id).sort(newestFirst), [allChats, project.id]);
  const sessions = useTerminalSessions(useMemo(() => [project], [project]))[project.id] ?? [];
  const models = useModelRowsFor(project.picks.model, project.id);
  const [asking, setAsking] = useState(false);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  usePopupFocus(menu, "env-menu", more);
  const startsWithLast = useStore((s) => s.settings.newChats === "last");
  const picks = project.picks;
  const kept = Boolean(picks.model || picks.effort || picks.mode);
  const rows: [string, string][] = [
    ["Model", picks.model ? modelLabel(picks.model, models) : "Your Claude Code default"],
    ["Effort", picks.effort ? effortLabel(picks.effort) : "Your Claude Code default"],
    ["Mode", picks.mode ? modeLabel(picks.mode) : "Your Claude Code default"],
  ];
  return (
    <div className="scr-page" data-testid="project">
      <div className="scr-col">
        {notice ? (
          <p className="notice scr-notice" role="status" data-testid="link-notice">
            {notice}
          </p>
        ) : (
          <LinkNotice route={route} />
        )}
        <UpdateLine screen className="scr-notice" />
        <header className="scr-head">
          <div className="scr-head-text">
            {route.name === "projectRename" ? <EnvRenameForm key={String(route.query.name ?? "")} project={project} route={route} /> : <h1 className="scr-h1">{project.name}</h1>}
            <p className="scr-facts">
              <span className="scr-fact">
                <IconFolder />
                <span className="mono">{project.folder}</span>
              </span>
              {project.branch ? (
                <span className="scr-fact">
                  <IconBranch />
                  <span className="mono">{project.branch}</span>
                </span>
              ) : null}
            </p>
          </div>
          <div className="scr-head-acts">
            <Link to={href("new", {}, { project: project.id })} className="btn primary">
              <IconPlus /> New chat here
            </Link>
            <button ref={more} type="button" className="icon-btn scr-head-more" data-testid="project-more" aria-label={`Menu for ${project.name}`} aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
              <IconMore />
            </button>
          </div>
          <EnvMenu open={menu} onClose={() => setMenu(false)} anchor={more} project={project} steps={null} />
        </header>

        <ProjectEnvironmentRows project={project} />

        <section className="scr-section" aria-labelledby="scr-picks-h">
          <h2 id="scr-picks-h" className="group-title scr-h2">
            Remembered choices
          </h2>
          <dl className="group scr-picks">
            {rows.map(([k, v]) => (
              <div key={k} className="group-row scr-pick-row">
                <dt className="group-label">{k}</dt>
                <dd className="group-value">{v}</dd>
              </div>
            ))}
          </dl>
          {!startsWithLast ? <p className="group-foot scr-dim">New chats start with your Claude Code defaults (Settings &gt; Chats), so they do not use these.</p> : null}
          {kept ? (
            asking ? (
              <div className="scr-forget-ask" role="group" aria-label="Forget choices">
                <p className="scr-dim">{forgetLine(project)}</p>
                <div className="scr-forget-actions">
                  <button type="button" className="btn" onClick={() => setAsking(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    data-testid="confirm-forget"
                    autoFocus
                    onClick={() => {
                      act.forgetPicks(project.id);
                      setAsking(false);
                    }}
                  >
                    Forget
                  </button>
                </div>
              </div>
            ) : (
              // Forget asks first (M31); the confirm's own Forget is the named button that sends the request.
              <button type="button" className="btn scr-forget" data-testid="confirm-forget" onClick={() => setAsking(true)}>
                Forget choices
              </button>
            )
          ) : null}
        </section>

        <section className="scr-section" aria-labelledby="scr-pchats-h">
          <h2 id="scr-pchats-h" className="group-title scr-h2">
            Chats
          </h2>
          {chats.length ? (
            <ul className="group scr-items">
              {chats.map((c) => (
                <li key={c.id}>
                  <Link to={href("chat", { chat: c.id })} className="group-row scr-item">
                    <ChatDot chat={c} />
                    <ChatTitle chat={c} className="scr-item-title" />
                    <ChatMeta chat={c} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="scr-empty">No chats in {project.name} yet. Start one with New chat here.</p>
          )}
        </section>

        {sessions.length ? (
          <section className="scr-section" aria-labelledby="scr-pterm-h">
            <h2 id="scr-pterm-h" className="group-title scr-h2">
              From the terminal
            </h2>
            <ProjectSessionRows project={project} sessions={sessions} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The project's Environment (row 73, D60): the Worktree option and the variables' summary (Desktop's "None for this
 * environment", or the count), each row opening the project's editor, which acts only on its own buttons.
 */
export function ProjectEnvironmentRows({ project }: { project: Project }) {
  const to = href("projectEnvironment", { project: project.id });
  return (
    <section className="scr-section" aria-labelledby="scr-penv-h" data-testid="project-environment-rows">
      <h2 id="scr-penv-h" className="group-title scr-h2">
        {ENVIRONMENT}
      </h2>
      <ul className="group scr-penv">
        <li>
          <Link to={to} className="group-row scr-penv-row">
            <span className="group-label">{WORKTREE_WORDS.option}</span>
            <span className="group-value">{project.worktree ? "On" : "Off"}</span>
            <IconRight className="group-chevron" />
          </Link>
        </li>
        <li>
          <Link to={to} className="group-row scr-penv-row">
            <span className="group-label">{ENV_WORDS.title}</span>
            <span className="group-value" data-testid="project-env-summary">
              {envCell(project)}
            </span>
            <IconRight className="group-chevron" />
          </Link>
        </li>
      </ul>
    </section>
  );
}

// ---- the session preview

const PREVIEW_BASE: ChatPart = {
  items: [],
  pending: [],
  title: "",
  titleSource: "first-prompt",
  model: "default",
  effort: "default",
  mode: "default",
  picks: { model: null, effort: null, mode: null },
  sessionId: "",
  bypassFlag: false,
  lostRequests: [],
  turn: null,
  liveModel: null,
  version: null,
  commands: null,
  tasks: [],
  suggestion: null,
  outputs: [],
};

/** The preview's rows from the server's page of the session's transcript (the same reduction as a chat's history). */
export function previewItems(reply: Pick<SessionPreviewReply, "history">, cwd: string | null, now = Date.now()): Item[] {
  return applyHistory(PREVIEW_BASE, reply.history, { cwd, now }, "v").items;
}

const fold = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Whether a session's title only repeats its first prompt: a session from the terminal with no title of its own is
 * named by that prompt, whitespace folded and cut at the title limit (the server's cleanTitle), so the preview's first
 * bubble would say it again right under it. The first message on the page decides, so a page that starts later in a
 * long session keeps the title; a title of its own that only begins the same way is not a cut prompt.
 */
export function titleRepeatsPrompt(title: string, items: readonly Item[]): boolean {
  const t = fold(title);
  if (!t) return true;
  const first = items.find((i) => i.kind === "user");
  if (!first || first.kind !== "user") return false;
  const prompt = fold(first.text);
  return prompt === t || (t.length >= LIMITS.title - 2 && prompt.startsWith(t));
}

type Preview =
  | { state: "loading" }
  | { state: "gone" }
  /** Row 77: a setting in Settings > Chats hides the session; the page says which, in one line. */
  | { state: "hidden"; why: SessionHidden }
  | { state: "ready"; session: string; items: Item[]; chat: string | null; copy: string | null; open: SessionOpen | null };

export function SessionPreview({ route }: { route: Route }) {
  const project = useStore((s) => s.projects.find((p) => p.id === route.params.project));
  const sessionId = route.params.session ?? "";
  const sessions = useStore((s) => (project ? s.sessions[project.id] : undefined));
  // Row 77: the project's list (the server filters it) left this session out because of a setting.
  const why = useStore((s) => (project ? hiddenBy(s.sessionsHidden[project.id], sessionId) : null));
  const [preview, setPreview] = useState<Preview>({ state: "loading" });
  // Each change reads the preview again, the page as it is meanwhile: the page came back into view, or the server
  // refused a Continue here because another app has the session open now (W19d).
  const [reads, setReads] = useState(0);
  const session = sessions?.find((s) => s.sessionId === sessionId);
  useEffect(() => whenBack(() => setReads((n) => n + 1)), []);

  // Reads only: the project's list from the terminal, then, for a session in it, one page of its transcript. A session
  // that is not in the list is never asked for, so a dead link costs no failed request.
  useEffect(() => {
    if (project && !sessions) void act.loadSessions(project.id);
  }, [project?.id, !!sessions]);
  useEffect(() => {
    if (!project || !sessions) return;
    if (why) {
      setPreview({ state: "hidden", why });
      return;
    }
    if (!session) {
      setPreview({ state: "gone" });
      return;
    }
    let live = true;
    // A read again of the same session keeps the page as it is meanwhile; another session's starts empty.
    setPreview((p) => (p.state === "ready" && p.session === sessionId ? p : { state: "loading" }));
    apiGet<SessionPreviewReply>(`/api/projects/${project.id}/sessions/${encodeURIComponent(sessionId)}`).then(
      (r) => {
        if (!live) return;
        // A setting hides it since the list was read (this page's or another's change, or the session opened in
        // another app meanwhile): say so, and read the list again, so it agrees.
        if (r.hidden) {
          setPreview({ state: "hidden", why: r.hidden });
          void act.loadSessions(project.id);
          return;
        }
        setPreview({ state: "ready", session: sessionId, items: previewItems(r, project.folder), chat: r.chat, copy: r.copy ?? null, open: r.open ?? null });
      },
      (e) => {
        // A read again that did not reach the server keeps the page; an answer that the session is not there ends it.
        if (live) setPreview((p) => (p.state === "ready" && p.session === sessionId && e instanceof ApiError && e.status === 0 ? p : { state: "gone" }));
      },
    );
    return () => {
      live = false;
    };
  }, [project?.id, sessionId, !!sessions, !!session, why, reads]);

  if (!project) return <Home route={route} notice={PROJECT_GONE} />;
  if (preview.state === "gone" || preview.state === "hidden")
    return (
      <Shell route={route}>
        <ProjectBody project={project} route={route} notice={preview.state === "hidden" ? <HiddenLine why={preview.why} /> : SESSION_GONE} />
      </Shell>
    );
  return (
    <Shell route={route}>
      <PreviewBody
        project={project}
        sessionId={sessionId}
        title={session?.title ?? ""}
        updated={session?.lastModified ?? null}
        preview={preview}
        readAgain={() => {
          setReads((n) => n + 1);
          void act.loadSessions(project.id);
        }}
      />
    </Shell>
  );
}

function PreviewBody(props: { project: Project; sessionId: string; title: string; updated: number | null; preview: Preview; readAgain: () => void }) {
  const { project, sessionId, title, updated, preview, readAgain } = props;
  // A chat that already has this session (D49): the preview points there instead of offering a second copy.
  const opened = useStore((s) => (preview.state === "ready" && preview.chat ? s.chats.find((c) => c.id === preview.chat) : undefined));
  // A chat that holds a copy of it (D58), while the page knows that chat.
  const copy = useStore((s) => (preview.state === "ready" && preview.copy ? (s.chats.find((c) => c.id === preview.copy)?.id ?? null) : null));
  // A Continue that the server refused says why, in the dock.
  const refused = useScreenNotice();
  // The large title only when it says something the first bubble does not; it stays for screen readers either way.
  const repeats = preview.state === "ready" && titleRepeatsPrompt(title, preview.items);
  const open = preview.state === "ready" ? preview.open : null;
  const continueHere = () => {
    const onRefused = (code: string) => {
      // Another app opened the session after this page read it: read it again, so the dock offers the copy.
      if (code === "session_open") readAgain();
    };
    void act.continueSession(project.id, sessionId, open !== null, onRefused).then((id) => {
      if (id) navigate(href("chat", { chat: id }), { replace: true });
    });
  };
  return (
    <div className="scr-preview" data-testid="session-preview">
      <div className="scr-page">
        <div className="scr-col scr-preview-col">
          <header className="scr-preview-head">
            <h1 className={repeats ? "visually-hidden" : "scr-h1"} dir="auto">
              {title}
            </h1>
            <p className="scr-dim">
              <span className="mono">{project.folder}</span>
              {updated !== null ? `, last active ${ago(new Date(updated).toISOString())}` : null}
            </p>
          </header>
          <div className="scr-preview-items" aria-busy={preview.state === "loading" || undefined}>
            {preview.state === "ready" ? preview.items.map((item) => <ItemView key={item.id} item={item} chatId="" readOnly />) : null}
          </div>
        </div>
      </div>
      <div className="scr-preview-dock">
        <div className="scr-col scr-preview-dock-in">
          {opened ? (
            <Link to={href("chat", { chat: opened.id })} className="btn primary">
              Open the chat
            </Link>
          ) : (
            <>
              {refused ? (
                <p className="notice" role="status" data-testid="screen-notice">
                  {refused}
                </p>
              ) : null}
              <PreviewDock open={open} ready={preview.state === "ready"} onContinue={continueHere} copy={copy} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The preview's foot: Desktop's advice and Continue here; while another app has the session open (D58), where it is
 * open and Continue in a copy, which leaves that app's session as it is. A copy that a chat holds already (`copy`, its
 * chat id) is offered beside the button, so coming back to the session does not make another copy unasked (W19d).
 */
export function PreviewDock({ open, ready, onContinue, copy = null }: { open: SessionOpen | null; ready: boolean; onContinue: () => void; copy?: string | null }) {
  return (
    <>
      {open ? (
        <p className="scr-dim" data-testid="session-open">
          {openMark(open)}. A copy leaves that session as it is.
        </p>
      ) : (
        <p className="scr-dim">Close this session in your terminal first: two processes must not write one session.</p>
      )}
      {copy ? (
        <Link to={href("chat", { chat: copy })} className="btn" data-testid="open-copy">
          Open the copy
        </Link>
      ) : null}
      <button type="button" className="btn primary" data-testid="confirm-continue" disabled={!ready} onClick={onContinue}>
        {continueWord(open)}
      </button>
    </>
  );
}
