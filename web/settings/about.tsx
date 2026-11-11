// Settings > About's update and restart rows (DESIGN.md 6.8, 4.10; build checklist S3, S4, S14, L17, L18; owner row
// 108): "Update available" with Update, which opens its confirm at /settings/about/update (only the confirm's button
// acts), or with its one line when this checkout and origin have diverged; while an update runs, its step line; when it
// did not finish, its line with Update again; "Restart to apply" (read only), or with the line of an update that did
// not finish; and Restart, which opens the restart dialog at /settings/about/restart. No Update in dev mode.
//
// An installed kitespan (DESIGN-I1 3.6): a release install has the same rows, with "Version <v>" under Update available
// (the newest release) and under Restart to apply (the version that the next start runs); a Homebrew install has no
// Update and no check, and one row, "Installed with Homebrew", whose line names `brew upgrade kitespan`, and Restart to
// apply with its version once `brew upgrade` moved the opt link.

import type { ReactNode } from "react";
import type { RestartReply, UpdateReply } from "../../server/http/api-types";
import type { UpdateKind } from "../../shared/protocol";
import { runningLine, UPDATE_REFUSAL_LINES, UPDATE_WORDS, type UpdateJob } from "../../shared/update";
import { href, navigate } from "../router";
import { IconRight } from "../ui/icons";
import { Link } from "../ui/primitives";

export const ABOUT_WORDS = {
  available: UPDATE_WORDS.available,
  apply: "Restart to apply",
  restart: "Restart",
  diverged: UPDATE_REFUSAL_LINES.diverged,
  update: UPDATE_WORDS.update,
} as const;

export interface AboutLine {
  testId: string;
  label: string;
  line?: ReactNode;
  /** The row has Update, which opens the update's confirm. */
  update?: boolean;
}

/** Origin's line: About's own read when it has one, else the one `welcome` brought. */
export function remoteLine(facts: Pick<RestartReply, "update"> | null, welcome: UpdateKind): RestartReply["update"] {
  if (facts) return facts.update;
  return welcome === "available" || welcome === "diverged" ? welcome : "none";
}

/** How kitespan was installed, and the versions that an installed one names (UpdateReply's). */
export type AboutInstall = Pick<UpdateReply, "kind" | "latest" | "next">;

const CHECKOUT: AboutInstall = { kind: "checkout", latest: null, next: null };

/** What About knows before its own read answers: origin's line from `welcome`, no build line, no job. */
export function aboutFacts(facts: UpdateReply | null, welcome: UpdateKind): Pick<UpdateReply, "update" | "build" | "job" | "can" | "kind" | "latest" | "next"> {
  if (facts) return facts;
  return { update: remoteLine(null, welcome), build: "none", job: { state: "idle" }, can: true, ...CHECKOUT };
}

const IDLE: UpdateJob = { state: "idle" };

/** The brew row's line: "Update it with " + the command, which one tap selects whole, + ", then restart kitespan." */
export function BrewLine() {
  const [before, after] = UPDATE_WORDS.brewLine.split(UPDATE_WORDS.brewCommand);
  return (
    <>
      {before}
      <code className="select-all">{UPDATE_WORDS.brewCommand}</code>
      {after}
    </>
  );
}

/**
 * The read-only rows above Check for updates and Restart: while a job runs, its step line alone; else the job's line
 * when it did not finish (with Update again, unless it diverged), or origin's line; then the build's. A Homebrew
 * install's row comes first.
 */
export function aboutLines(update: RestartReply["update"], build: RestartReply["build"], job: UpdateJob = IDLE, can = true, install: AboutInstall = CHECKOUT): AboutLine[] {
  if (job.state === "running") return [{ testId: "setting-update-step", label: runningLine(job.step) }];
  const out: AboutLine[] = [];
  if (install.kind === "brew") out.push({ testId: "setting-homebrew", label: UPDATE_WORDS.brewLabel, line: <BrewLine /> });
  const failed = job.state === "failed";
  const latest = install.kind === "release" && install.latest ? UPDATE_WORDS.versionLine(install.latest) : undefined;
  const next = install.kind !== "checkout" && install.next ? UPDATE_WORDS.versionLine(install.next) : undefined;
  if (failed) out.push({ testId: "setting-update", label: job.line, update: can && job.line !== ABOUT_WORDS.diverged });
  else if (update === "available") out.push({ testId: "setting-update", label: ABOUT_WORDS.available, update: can, ...(latest ? { line: latest } : {}) });
  else if (update === "diverged") out.push({ testId: "setting-update", label: ABOUT_WORDS.available, line: ABOUT_WORDS.diverged });
  if (build === "apply") out.push({ testId: "setting-restart-to-apply", label: ABOUT_WORDS.apply, ...(next ? { line: next } : {}) });
  else if (build === "unfinished" && !failed)
    out.push({ testId: "setting-restart-to-apply", label: ABOUT_WORDS.apply, line: UPDATE_WORDS.unfinished, update: can && update !== "available" });
  return out;
}

/** Update: a link styled as a button; it opens the confirm, which alone acts. */
export function UpdateLink() {
  const to = href("setting", { section: "about", key: "update" });
  return (
    <a
      href={to}
      className="btn"
      data-testid="update-open"
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {ABOUT_WORDS.update}
    </a>
  );
}

/** Restart: a row that opens the restart dialog; opening it acts on nothing (only the dialog's buttons do). */
export function RestartRow() {
  return (
    <li data-testid="setting-restart">
      <Link to={href("restart")} className="group-row set-link-row">
        <span className="group-label set-link-label">{ABOUT_WORDS.restart}</span>
        <IconRight size={14} className="group-chevron" />
      </Link>
    </li>
  );
}
