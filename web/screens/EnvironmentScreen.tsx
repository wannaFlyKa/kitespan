// /p/<project>/environment (DESIGN 9.4 "URLs added"; EN 5.7, row 73): the project's environment, in Desktop's words:
// its Folder, the Worktree option (off, with its one line, where a worktree cannot be made) and its Environment
// variables (env/EnvSection.tsx). The title bar names the project, the page's large title is "Environment", as the
// project page's row that opens it. Opening it sends GETs only; the Worktree switch, Save, Remove and Remove the
// unreadable file each send one POST on their own click or tap, and `name` only marks a row.
import { useMemo, useState } from "react";
import type { Route } from "../router";
import { act, useStore } from "../state/store";
import type { Project } from "../state/types";
import { Shell } from "../layout/Shell";
import { LinkNotice } from "../ui/LinkNotice";
import { processLives } from "../terminal/command";
import { EnvSection } from "../env/EnvSection";
import { WorktreeOption } from "../worktree/WorktreeOption";
import { WORKTREE_WORDS } from "../worktree/worktree";
import { PathText } from "../panels/details";
import { Home } from "./Home";

const PROJECT_GONE = "That project is not here.";
/** The page's large title: the project page's row and the chat's Environment card use the same word. */
export const ENVIRONMENT = "Environment";

export function EnvironmentScreen({ route }: { route: Route }) {
  const project = useStore((s) => s.projects.find((p) => p.id === route.params.project));
  if (!project) return <Home route={route} notice={PROJECT_GONE} />;
  return (
    <Shell route={route}>
      <EnvironmentBody key={project.id} project={project} route={route} />
    </Shell>
  );
}

function EnvironmentBody({ project, route }: { project: Project; route: Route }) {
  const chats = useStore((s) => s.chats);
  const running = useMemo(() => chats.some((c) => c.projectId === project.id && !c.archived && processLives(c)), [chats, project.id]);
  const marked = typeof route.query.name === "string" ? route.query.name : null;
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const setWorktree = (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setLine(null);
    void act.setWorktree(project.id, on).then((r) => {
      setBusy(false);
      if (r !== true) setLine(r.line);
    });
  };
  return (
    <div className="scr-page" data-testid="project-environment">
      <div className="scr-col">
        <LinkNotice route={route} />
        <header className="scr-head">
          <div className="scr-head-text">
            <h1 className="scr-h1">{ENVIRONMENT}</h1>
          </div>
        </header>
        <ul className="group env-top">
          <li className="group-row env-folder">
            <span className="group-label">{WORKTREE_WORDS.folder}</span>
            <PathText path={project.folder} className="env-folder-path" />
          </li>
          <li>
            <WorktreeOption on={project.worktree === true} off={project.worktreeOff ?? null} busy={busy} onChange={setWorktree} />
          </li>
        </ul>
        {line ? (
          <p className="notice env-line" role="alert">
            {line}
          </p>
        ) : null}
        <EnvSection project={project} marked={marked} running={running} />
      </div>
    </div>
  );
}
