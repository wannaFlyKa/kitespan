// GET /api/restart, read each time About or the restart dialog opens, and again after a restart (a new epoch): About's
// update lines (origin's from the last hourly check, the build stamp's read now) and the Terminal panes that run a
// program (DESIGN.md 4.10; build checklist S3, S4, S15). No timer: the read is cheap and only these two show it.

import { useEffect, useSyncExternalStore } from "react";
import type { RestartReply } from "../../server/http/api-types";
import { apiGet } from "../net/api";

let facts: RestartReply | null = null;
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The last read's answer (tests set it before they draw). */
export function setRestartFacts(r: RestartReply | null): void {
  facts = r;
  for (const fn of listeners) fn();
}

/** The last answer, read again as the component mounts and when the server's epoch changes. */
export function useRestartFacts(epoch: string | null): RestartReply | null {
  const value = useSyncExternalStore(subscribe, () => facts, () => facts);
  useEffect(() => {
    let live = true;
    apiGet<RestartReply>("/api/restart").then(
      (r) => live && setRestartFacts(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [epoch]);
  return value;
}
