// The update notice on every page (DESIGN.md 4.10, owner row 108): one notice with the id "update", which a later one
// replaces and `gone` takes away. While a job runs, its step line ("Updating kitespan: step 2 of 3, install."), so
// every page shows the step, a phone that slept too (a page that says hello gets it as a standing notice); then the
// line of a job that did not finish, with Update again, or once it is done "Restart to apply the update."; else
// origin's line: "Update available." with the Update action, or the diverged line; else none.

import type { NoticeFrame } from "../../shared/protocol";
import { runningLine, UPDATE_WORDS, type UpdateJob } from "../../shared/update";
import type { RemoteKind } from "./remote";
import { UPDATE_LINES, UPDATE_NOTICE_ID } from "./updates";

export type UpdateNotice = Required<Pick<NoticeFrame, "text" | "id">> & Pick<NoticeFrame, "actions">;

/** The notice for origin's line and the job now, or null for none. */
export function updateNotice(remote: RemoteKind, job: UpdateJob): UpdateNotice | null {
  const id = UPDATE_NOTICE_ID;
  if (job.state === "running") return { text: runningLine(job.step), id };
  if (job.state === "failed") return job.line === UPDATE_LINES.diverged ? { text: job.line, id } : { text: job.line, id, actions: ["update"] };
  if (job.state === "done") return { text: UPDATE_WORDS.doneNotice, id };
  if (remote === "available") return { text: UPDATE_WORDS.availableNotice, id, actions: ["update"] };
  if (remote === "diverged") return { text: UPDATE_LINES.diverged, id };
  return null;
}

/** The job's notice for a page that says hello now: only while a job of this server is not idle. */
export function standingUpdateNotice(remote: RemoteKind, job: UpdateJob): UpdateNotice[] {
  if (job.state === "idle") return [];
  const n = updateNotice(remote, job);
  return n ? [n] : [];
}

/**
 * A sender that sends each change once: `send` gets the new notice, or null for a notice that went (which the caller
 * sends as `gone`). `now` is the notice that the pages already have from `welcome` (origin's line that a new server
 * read again from update.json), so the first call sends nothing while that stands, and its end is sent.
 */
export function noticeSender(send: (n: UpdateNotice | null) => void, now: UpdateNotice | null = null): (n: UpdateNotice | null) => void {
  let last = JSON.stringify(now);
  return (n) => {
    const key = JSON.stringify(n);
    if (key === last) return;
    last = key;
    send(n);
  };
}
