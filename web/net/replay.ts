// A chat's replay after an attach (DESIGN.md 4.3, row 79): from `attached` until the page holds every event up to
// `attached.seq` (state/store.ts afterReplay), whether a snapshot and its tail bring them or only the missed `ev`
// frames do. What comes in it is a load, not live text: smooth text shows it at once and no row enters
// (chat/arrivals.ts quietNow), however long a slow link takes to bring it. The store marks it; nothing here draws.

/** The page's motion clock (ui/motion.ts motionNow), which the reveal compares with. */
const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** By chat: null while its replay comes, else when the last one was in. */
const marks = new Map<string, number | null>();

export function replayBegins(chatId: string): void {
  marks.set(chatId, null);
}

export function replayEnds(chatId: string): void {
  if (marks.get(chatId) === null) marks.set(chatId, clock());
}

/** The chat's replay comes now, or was in less than `ms` before `now`. */
export function inReplay(chatId: string, now: number, ms: number): boolean {
  const at = marks.get(chatId);
  return at === null || (at !== undefined && now - at < ms);
}

/** Tests only: forget every replay. */
export function resetReplays(): void {
  marks.clear();
}
