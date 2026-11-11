// R124: the side scene's kept side thread of the example chat ("Fix the flaky upload test"): two questions that a page
// asked earlier and their answers, in kitespan's own side file (side/<chat id>.json), so the side chat opens with
// earlier questions folded above the newest answer. Its ids are fixed, its times relative to the seed's clock.

import type { SideExchange } from "../../../shared/protocol";
import { EX } from "./ids";

/** R130: the first is the exchange that /c/<chat>/btw/<exchange>'s example names (an earlier one, opened in place). */
export const SIDE_THREAD_IDS = [EX.exchange, "6f2e8b31-4c5d-4e6f-9071-8293a405b6c7"] as const;

/** The kept exchanges, oldest first, with their minutes before the seed's clock. */
export const SIDE_KEPT: readonly (Omit<SideExchange, "at"> & { minutes: number })[] = [
  {
    id: SIDE_THREAD_IDS[0],
    question: "What does the retry rule do?",
    state: "answered",
    answer: "It tries the `PUT` up to three times with the same body, and throws the last error after the third try.",
    minutes: 42,
  },
  {
    id: SIDE_THREAD_IDS[1],
    question: "Which file holds the size cap?",
    state: "answered",
    answer: "`src/upload.ts`: `MAX_UPLOAD_BYTES` (25 MiB), checked before the first try.",
    minutes: 40,
  },
];

/** The side file's record for `chat` at the seed's clock `now`: each exchange counted twice in the rev (asked, answered). */
export function sideSeed(chat: string, now: number): { v: 1; id: string; rev: number; exchanges: SideExchange[] } {
  const exchanges = SIDE_KEPT.map(({ minutes, ...x }) => ({ ...x, at: new Date(now - minutes * 60_000).toISOString() }));
  return { v: 1, id: chat, rev: 2 * exchanges.length, exchanges };
}
