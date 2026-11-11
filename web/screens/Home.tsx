// Home (/) and the new-chat route (/new), DESIGN.md 6.9. Home shows the new-chat form, then Recent: the chats of
// every project, newest first, archived ones left out (D48); where the sidebar docks beside it (a laptop from 1,000
// px), the sidebar lists the same chats, so Home shows the form and "From the terminal" only (M9). "From the terminal"
// lists the Claude Code sessions in the known project folders that no chat has: the server's list (listSessions with
// `includeProgrammatic: false`, which leaves every SDK session out, kitespan's own chats among them), read with a GET.
// ChatScreen also shows Home, with one plain line, for a chat id that is not in the list (5.4). The look (plan v3):
// the form's greeting is the large title, and Recent and From the terminal are grouped lists (.group). On the phone a
// Recent row's title takes the row, its project shows under it only when Recent mixes projects, and its state word
// shows only for Needs input and Failed (M10). A session that another app has open now says so in its row (D58), here
// as on the project page; both lists read again when the page comes back into view (W19d), and when a settings reply
// changes Settings > Chats > Show sessions from other apps or Show sessions open in another app, which the server
// applies to the lists (row 77: off, the first leaves no list, so From the terminal is gone). Where no docked sidebar
// shows the chat list's foot, both show the update's line under their notice (row 108, update/UpdateLine.tsx).
import { useEffect, useMemo } from "react";
import { href, type Route } from "../router";
import { act, useStore, visibleChats } from "../state/store";
import type { Chat, ModeId, Project } from "../state/types";
import type { SessionView } from "../../server/http/api-types";
import type { SessionOpen } from "../../shared/protocol";
import { Shell } from "../layout/Shell";
import { useShellLayout, useViewport, type SidebarForm } from "../layout/size";
import { Link, relTime } from "../ui/primitives";
import { LinkNotice } from "../ui/LinkNotice";
import { IconTerminal } from "../ui/icons";
import { NewChatForm, type FormInit } from "./NewChatForm";
import { NoticeEnvLink } from "../env/UnreadableLine";
import { UpdateLine } from "../update/UpdateLine";
import { ChatDot, ChatMeta, ChatTitle, PART_UNREAD, TOO_LONG, byLastUse, effortsOf, knownModels, newestFirst, overCap, useScreenNotice } from "./common";

const RECENT_MAX = 10;
const BYPASS_OFF = "Bypass permissions is off. You can allow it in Settings > Chats.";

export function Home({ route, notice }: { route: Route; notice?: string }) {
  return (
    <Shell route={route}>
      <HomeBody route={route} notice={notice} autoFocus />
    </Shell>
  );
}

/** M9: Recent shows where no docked sidebar lists the same chats beside it (the phone, the drawer layouts). */
export function showsRecent(sidebar: SidebarForm): boolean {
  return sidebar !== "docked";
}

/** Home's main column. On a laptop /chats shows it too, while the sidebar takes the focus (5.3). */
export function HomeBody({ route, notice, autoFocus }: { route: Route; notice?: string; autoFocus: boolean }) {
  const layout = useShellLayout();
  // A Start, an Archive from a row or a Delete that the server refused says why here (the chat screen is not open).
  const refused = useScreenNotice();
  const noticeFor = useStore((s) => s.noticeFor);
  return (
    <div className="scr-page" data-testid="home">
      <div className="scr-col scr-home">
        {notice ? (
          <p className="notice scr-notice" role="status" data-testid="link-notice">
            {notice}
          </p>
        ) : refused ? (
          <>
            <p className="notice scr-notice" role="status" data-testid="screen-notice">
              {refused}
            </p>
            <NoticeEnvLink notice={noticeFor} />
          </>
        ) : (
          <LinkNotice route={route} />
        )}
        <UpdateLine screen className="scr-notice" />
        <NewChatForm init={{}} autoFocus={autoFocus} />
        <div className="scr-recent">
          {showsRecent(layout.sidebar) ? <Recent /> : null}
          <FromTerminal />
        </div>
      </div>
    </div>
  );
}

/**
 * The project a /new link names, as the form takes it: a project of the list; before the list came (`read` false and
 * no project known yet), the link's own id, which the form resolves once the list comes, so a link opened as a new
 * document keeps its project and not the newest one. `unread`: the list came, and it has no such project.
 */
export function linkedProject(want: string | undefined, projects: readonly Project[], read: boolean): { project: string | undefined; unread: boolean } {
  if (!want) return { project: undefined, unread: false };
  if (projects.some((p) => p.id === want)) return { project: want, unread: false };
  return read || projects.length > 0 ? { project: undefined, unread: true } : { project: want, unread: false };
}

/** /new: the same form holding the URL's project, model, effort, mode and text. Start sends; nothing else does. */
export function NewChat({ route }: { route: Route }) {
  const projects = useStore((s) => s.projects);
  const projectsRead = useStore((s) => s.projectsRead);
  const chats = useStore((s) => s.chats);
  const allowBypass = useStore((s) => s.settings.allowBypass);
  const startsWithLast = useStore((s) => s.settings.newChats === "last");
  const noticeFor = useStore((s) => s.noticeFor);
  const q = route.query;
  const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  // The model rows the page knows (a chat's `get models`): with none read yet, a well-formed model value stands (the
  // decoder checked its length and characters), and the server's own check decides at Start.
  const rows = knownModels(chats);

  // A value the form cannot hold is dropped alone, and one line says so (DESIGN.md 5.4). The link's project stands
  // until the project list came (a link opened as a new document renders before GET /api/projects answers).
  let unread = Boolean(route.dropped);
  const wantProject = str("project");
  const linked = linkedProject(wantProject, projects, projectsRead);
  const project = linked.project;
  if (linked.unread) unread = true;
  const wantModel = str("model");
  const model = wantModel && (!rows || rows.some((m) => m.id === wantModel)) ? wantModel : undefined;
  if (wantModel && !model) unread = true;
  const base = projects.find((p) => p.id === project) ?? byLastUse(projects, chats)[0];
  const wantEffort = str("effort");
  // The effort must suit the model the form will show: the link's, else the project's remembered one (6.8, 6.9).
  const effort = wantEffort && effortsOf(model ?? (startsWithLast ? base?.picks.model : undefined), rows ?? []).includes(wantEffort) ? wantEffort : undefined;
  if (wantEffort && !effort) unread = true;
  const wantMode = str("mode") as ModeId | undefined;
  const bypassOff = wantMode === "bypassPermissions" && !allowBypass;
  const text = str("text");
  const init: FormInit = { project, model, effort, mode: bypassOff ? undefined : wantMode, text };

  const line = text === undefined && overCap("text", 5000) ? TOO_LONG : bypassOff ? BYPASS_OFF : unread ? PART_UNREAD : undefined;
  const refused = useScreenNotice(); // a Start that the server refused
  return (
    <Shell route={route}>
      <div className="scr-page">
        <div className="scr-col scr-home">
          {line ? (
            <p className="notice scr-notice" role="status" data-testid="link-notice">
              {line}
            </p>
          ) : refused ? (
            <>
              <p className="notice scr-notice" role="status" data-testid="screen-notice">
                {refused}
              </p>
              <NoticeEnvLink notice={noticeFor} />
            </>
          ) : (
            <LinkNotice route={route} />
          )}
          <UpdateLine screen className="scr-notice" />
          {/* A new URL (Back, Forward, another link) opens the form again with what that URL names; the rest of the
              form's draft (its prompt and uploads) stays (NewChatForm). */}
          <NewChatForm key={JSON.stringify(q)} init={init} autoFocus />
        </div>
      </div>
    </Shell>
  );
}

/** Recent: the 10 newest chats that are not archived (6.9). */
export function recentChats(chats: readonly Chat[]): Chat[] {
  return visibleChats(chats).sort(newestFirst).slice(0, RECENT_MAX);
}

/** The phone shows a Recent row's project only when Recent mixes projects (M10). */
export function mixesProjects(chats: readonly Chat[]): boolean {
  return new Set(chats.map((c) => c.projectId)).size > 1;
}

function Recent() {
  const chats = useStore((s) => s.chats);
  const projects = useStore((s) => s.projects);
  const phone = useViewport().size === "phone";
  const recent = useMemo(() => recentChats(chats), [chats]);
  const listed = useMemo(() => visibleChats(chats).length, [chats]);
  const project = phone && !mixesProjects(recent) ? null : (id: string) => projects.find((p) => p.id === id)?.name ?? "";
  return (
    <section className="scr-section-recent" aria-labelledby="scr-recent-h">
      <h2 id="scr-recent-h" className="group-title scr-h2">
        Recent
      </h2>
      {recent.length ? (
        <ul className={`group scr-items${phone ? " scr-items-phone" : ""}`}>
          {recent.map((c) => (
            <li key={c.id}>
              <Link to={href("chat", { chat: c.id })} className="group-row scr-item">
                <ChatDot chat={c} />
                {phone ? (
                  <span className="scr-item-text">
                    <ChatTitle chat={c} className="scr-item-title" />
                    {project ? <span className="scr-item-sub">{project(c.projectId)}</span> : null}
                  </span>
                ) : (
                  <>
                    <ChatTitle chat={c} className="scr-item-title" />
                    <span className="scr-item-sub">{project?.(c.projectId)}</span>
                  </>
                )}
                <ChatMeta chat={c} words={!phone} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="scr-empty">No chats yet. Your chats show here after you start one.</p>
      )}
      {listed > recent.length ? (
        <Link to={href("chats")} className="btn plain scr-more">
          Show all chats
        </Link>
      ) : null}
    </section>
  );
}

/** Two signs of one return (a tab shown again, then its window focused) within this long read once. */
const BACK_MS = 2_000;

/**
 * Call `fn` each time the page comes back: the tab is shown again, or its window gets the focus (a phone tab left on
 * a list, a laptop window behind the terminal). D58's marks are read when a list or a preview loads, so a session
 * that another app opened or closed meanwhile is read again. Returns the cleanup.
 */
export function whenBack(fn: () => void, env: { doc?: EventTarget & { visibilityState?: string }; win?: EventTarget; now?: () => number } = {}): () => void {
  const doc = env.doc ?? (typeof document === "undefined" ? undefined : document);
  const win = env.win ?? (typeof window === "undefined" ? undefined : (window as unknown as EventTarget));
  const now = env.now ?? Date.now;
  let last = -Infinity;
  const back = () => {
    if (doc?.visibilityState === "hidden") return;
    const t = now();
    if (t - last < BACK_MS) return;
    last = t;
    fn();
  };
  const onShow = () => {
    if (doc?.visibilityState === "visible") back();
  };
  doc?.addEventListener("visibilitychange", onShow);
  win?.addEventListener("focus", back);
  return () => {
    doc?.removeEventListener("visibilitychange", onShow);
    win?.removeEventListener("focus", back);
  };
}

/** Each known project's sessions from the terminal (GET reads, per project list, and again when the page comes back). */
export function useTerminalSessions(projects: readonly Project[]): Record<string, SessionView[]> {
  const sessions = useStore((s) => s.sessions);
  const ids = projects.map((p) => p.id).join(",");
  useEffect(() => {
    const load = () => {
      for (const p of projects) void act.loadSessions(p.id);
    };
    load();
    return whenBack(load);
  }, [ids]);
  return sessions;
}

/** "From the terminal" (6.9): the Claude Code sessions that no chat has, newest first, each a link to its preview. */
function FromTerminal() {
  const projects = useStore((s) => s.projects);
  const sessions = useTerminalSessions(projects);
  const rows = useMemo(
    () =>
      projects
        .flatMap((p) => (sessions[p.id] ?? []).map((s) => ({ s, p })))
        .sort((a, b) => b.s.lastModified - a.s.lastModified)
        .slice(0, RECENT_MAX),
    [projects, sessions],
  );
  if (!rows.length) return null;
  const mixed = new Set(rows.map((r) => r.p.id)).size > 1;
  return (
    <section className="scr-section-recent" aria-labelledby="scr-terminal-h">
      <h2 id="scr-terminal-h" className="group-title scr-h2">
        From the terminal
      </h2>
      <SessionRows rows={rows} withProject={mixed} />
    </section>
  );
}

const OPEN_IN = { terminal: "in the terminal", desktop: "in the desktop app", other: "in another app" } as const;

/** D58: where a session is open now, and "busy" while that app says it is ("waiting for an answer" for a card, R22). */
export function openMark(open: SessionOpen): string {
  return `Open ${OPEN_IN[open.app]} now${open.waiting ? ", waiting for an answer" : open.busy ? ", busy" : ""}`;
}

/**
 * Rows of sessions from the terminal, each opening its read-only preview (/p/<project>/session/<session>): Home's
 * list and the project page's. A session that another app has open now carries D58's mark under its title, after its
 * project when the list mixes projects.
 */
export function SessionRows({ rows, withProject }: { rows: readonly { s: SessionView; p: Project }[]; withProject: boolean }) {
  return (
    <ul className="group scr-items">
      {rows.map(({ s, p }) => (
        <li key={s.sessionId}>
          <Link to={href("session", { project: p.id, session: s.sessionId })} className="group-row scr-item">
            <IconTerminal className="scr-item-icon" />
            {s.open ? (
              <span className="scr-item-text">
                <span className="scr-item-title" dir="auto">
                  {s.title}
                </span>
                <span className="scr-item-sub" data-testid="session-open">
                  {withProject ? `${p.name}, ${openMark(s.open).replace(/^O/, "o")}` : openMark(s.open)}
                </span>
              </span>
            ) : (
              <>
                <span className="scr-item-title" dir="auto">
                  {s.title}
                </span>
                {/* L31: a session that ran in another worktree of the project's repository names its branch there. */}
                {withProject || s.branch ? (
                  <span className="scr-item-sub" data-testid={s.branch ? "session-branch" : undefined}>
                    {[withProject ? p.name : null, s.branch ?? null].filter(Boolean).join(", ")}
                  </span>
                ) : null}
              </>
            )}
            <span className="scr-meta">{relTime(new Date(s.lastModified).toISOString(), Date.now())}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
