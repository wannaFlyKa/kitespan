// The side question (owner rows 124 and 125; DESIGN-R124 section 2.3 and 10): the Agent SDK's undocumented
// `Query.askSideQuestion(question, { history?, signal? })` (sdk.mjs of the pinned 0.3.322; no type in sdk.d.ts). It
// sends the control request `side_question` (history only when it is not empty), and answers `null` for a null
// response, else `{ response, synthetic, refusalFallback? }`. An abort of `signal` rejects it at once and sends
// `control_cancel_request`. Its progress comes on the message stream as `system/control_request_progress`
// (sdk.d.ts 0.3.322 line 5314: "currently only side_question"), matched by a request id that the method never returns.
// The lead's live probe (it5-ui/live/LIVE-NOTES.md, CLI 2.1.317): about 2 s while a turn runs and while none does,
// the main turn untouched, history read only as `{question, response}` pairs (other shapes throw), nothing in the transcript.
//
// This module types the method and maps what comes back; the driver feature-tests it on each call (D6), as it does
// generateSessionTitle.

import { sideFallback } from "../../../shared/protocol";
import type { SideAnswer, SideProgress, SideTurn } from "../types";

/** The DriverError message when the installed SDK has no side question. */
export const SIDE_MISSING = "Query.askSideQuestion is not in this Agent SDK";

/** What the SDK's method answers (sdk.mjs 0.3.322). */
export interface RawSideAnswer {
  response: unknown;
  synthetic?: unknown;
  /** The model names here are never kept, sent or logged: only `content`, Claude Code's notice. */
  refusalFallback?: { originalModel?: unknown; fallbackModel?: unknown; content?: unknown } | null;
}

/** The method, as the pinned SDK has it. */
export type AskSideQuestion = (question: string, opts: { history?: SideTurn[]; signal?: AbortSignal }) => Promise<RawSideAnswer | null>;

/** The query's side question, bound to it, or null when this SDK has none (the feature test). */
export function sideQuestionOf(q: unknown): AskSideQuestion | null {
  const fn = (q as { askSideQuestion?: unknown } | null)?.askSideQuestion;
  return typeof fn === "function" ? (fn as AskSideQuestion).bind(q) : null;
}

/**
 * The seam's answer: null for a null answer or one with no text response (the CLI's "No response received"); the
 * response as Claude Code gave it; the fallback's notice only (sideFallback), never its model names.
 */
export function sideAnswerOf(raw: unknown): SideAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawSideAnswer;
  if (typeof r.response !== "string") return null;
  const f = r.refusalFallback;
  return { response: r.response, synthetic: r.synthetic === true, fallback: f && typeof f === "object" ? sideFallback(f.content) : null };
}

const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** A `system/control_request_progress` message as the seam's progress; null for any other message or status. */
export function sideProgressOf(m: Record<string, unknown>): SideProgress | null {
  if (m.type !== "system" || m.subtype !== "control_request_progress") return null;
  if (m.status === "started") return { status: "started" };
  if (m.status === "api_retry") return { status: "api_retry", attempt: count(m.attempt), max: count(m.max_retries), delayMs: count(m.retry_delay_ms) };
  return null;
}

/** Waits for `p`, or rejects once `signal` aborts (with its reason). */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
