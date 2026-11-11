// Settings > About's update facts on the page (DESIGN.md 4.10, owner row 108): GET /api/update, read when About opens,
// after a restart (a new epoch), when a server notice comes (another page's Update sends the step line to every page),
// and every second while a job or a check runs, so the step line follows the job. Check now, Update and the setting
// Check for updates are requests of their own, each sent only from its click (principle 3); the setting is saved with
// POST /api/settings, so it is the server's and the same on every device (D49).

import { useEffect, useSyncExternalStore } from "react";
import type { SettingsReply, UpdateAccepted, UpdateReply } from "../../server/http/api-types";
import type { NoticeAction, UpdateKind } from "../../shared/protocol";
import { isUpdateCheck, UPDATE_CHECK_DEFAULT, UPDATE_REFUSAL_LINES, UPDATE_WORDS, type UpdateCheck } from "../../shared/update";
import { ApiError, apiGet, apiSend } from "../net/api";

/** How often About reads the job again while one runs. */
export const UPDATE_POLL_MS = 1_000;

interface UpdateState {
  facts: UpdateReply | null;
  /** This page pressed Check now and waits for its answer. */
  checking: boolean;
  /** The line of this page's last request that the server refused or that failed (an Update refused, ...). */
  line: string | null;
  /** The setting as this page saved it last (the store's settings read may be older); null: the server's read. */
  saved: UpdateCheck | null;
}

let state: UpdateState = { facts: null, checking: false, line: null, saved: null };
const listeners = new Set<() => void>();

function patch(p: Partial<UpdateState>): void {
  state = { ...state, ...p };
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The state now (tests set it before they draw). */
export function getUpdateState(): UpdateState {
  return state;
}
export function setUpdateState(p: Partial<UpdateState>): void {
  patch(p);
}
export function resetUpdateState(): void {
  state = { facts: null, checking: false, line: null, saved: null };
  for (const fn of listeners) fn();
}

/** A job or a check runs on the server: About reads again until it ends. */
export function updateBusy(f: UpdateReply | null): boolean {
  return f !== null && (f.job.state === "running" || f.check.running);
}

async function read(): Promise<void> {
  try {
    patch({ facts: await apiGet<UpdateReply>("/api/update") });
  } catch {
    // About keeps what it had; the next read comes with the next notice or open
  }
}

/**
 * About's facts, read as About mounts, when `epoch` or the update notice's line changes, and every second while a job
 * or check runs.
 */
export function useUpdateFacts(epoch: string | null, notice: string | null): UpdateState {
  const s = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    void read();
  }, [epoch, notice]);
  const busy = updateBusy(s.facts);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void read(), UPDATE_POLL_MS);
    return () => clearInterval(t);
  }, [busy]);
  return s;
}

const failedLine = (e: unknown) => (e instanceof ApiError ? e.message : "That did not work.");

/** Check now: POST /api/update/check, inside the click. */
export async function checkNow(): Promise<void> {
  if (state.checking) return;
  patch({ checking: true, line: null });
  try {
    patch({ facts: await apiSend<UpdateReply>("POST", "/api/update/check", {}), checking: false });
  } catch (e) {
    patch({ checking: false, line: failedLine(e) });
  }
}

/** Update: POST /api/update, inside the click; true when the job runs (this press's, or one it joined). */
export async function startUpdate(): Promise<boolean> {
  patch({ line: null });
  try {
    const r = await apiSend<UpdateAccepted>("POST", "/api/update", {});
    if (state.facts) patch({ facts: { ...state.facts, job: r.job } });
    void read();
    return true;
  } catch (e) {
    patch({ line: failedLine(e) });
    return false;
  }
}

/** The setting from the server's settings (GET /api/settings), Daily until it answers. */
export function checkSettingOf(settings: Record<string, unknown> | null | undefined): UpdateCheck {
  const v = settings?.["updates.check"];
  return isUpdateCheck(v) ? v : UPDATE_CHECK_DEFAULT;
}

/** Check for updates: POST /api/settings with the one key, inside the click; the server's saved value comes back. */
export async function saveCheckSetting(v: UpdateCheck): Promise<boolean> {
  const was = state.saved;
  patch({ saved: v, line: null });
  try {
    const r = await apiSend<SettingsReply>("POST", "/api/settings", { "updates.check": v });
    patch({ saved: checkSettingOf(r.settings) });
    void read();
    return true;
  } catch (e) {
    patch({ saved: was, line: failedLine(e) });
    return false;
  }
}

/** The line of this page's last refused or failed update request, or null. */
export function getUpdateLine(): string | null {
  return state.line;
}

/** The update notice as the store keeps it (State.updateNotice): its line and the actions it offers. */
export interface UpdateNoticeView {
  text: string;
  actions: readonly NoticeAction[];
}

/**
 * Origin's line from `welcome` as the update notice (the server's words for it, server/update/notice.ts): "Update
 * available." with Update, the diverged line, or none. A page that loads after the check found new work shows it too.
 */
export function originNotice(kind: UpdateKind): UpdateNoticeView | null {
  if (kind === "available") return { text: UPDATE_WORDS.availableNotice, actions: ["update"] };
  if (kind === "diverged") return { text: UPDATE_REFUSAL_LINES.diverged, actions: [] };
  return null;
}

/**
 * Origin's standing lines (Update available, diverged): they may last for days, so they show only in the chat list's
 * foot and in About, never above a chat's message box or on another screen (principle 0); the lines of an update the
 * user started (the steps, a failure, Restart to apply) show on every screen.
 */
export function isOriginNotice(text: string | null | undefined): boolean {
  return text === UPDATE_WORDS.availableNotice || text === UPDATE_REFUSAL_LINES.diverged;
}

/** A value of a link (`?value=`): a setting's id, or its words ("every-3-hours", "manually"). */
export function checkValueOf(raw: string): UpdateCheck | null {
  const v = raw.trim().toLowerCase();
  if (isUpdateCheck(v)) return v;
  const words: Record<string, UpdateCheck> = { manually: "manual", "every-3-hours": "3h", "every 3 hours": "3h" };
  return words[v] ?? null;
}
