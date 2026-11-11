// U5's scene (DESIGN-U5 17; scripts/ui-check.ts search-text; search-text-seed.test.ts): the main scene plus three chats
// whose messages hold the flow's words, each in exactly one place, so a search for it has one answer:
//
// - "Cap the text search memory" (kitespan, 3 min ago): a finished turn whose work (a reply before its last one, then a
//   Bash call) holds `quokka` in that reply, so the hit opens the folded turn; `axolotl` only in the Bash call's output,
//   which the search leaves out (no hit); `memory cap` as a phrase in its question and its last reply.
// - "Preview tiles for the looks" (scratch, archived 2 days ago): `pangolin` in its reply; `memory cap` too.
// - "Tune the reconnect backoff" (notes-api, 2 h ago): `narwhal` only in its first message, then 200 rounds of about
//   2,000 characters each, so that message is older than the newest history page (252 KiB): the link loads older pages.
//
// Its ids are fixed and of the right shapes; its times are relative to the seed's clock.

import { CHAT_ID, UUID, itemIdOf } from "../../../shared/ids";
import { Transcript, type ChatSeed, type Folders, type TranscriptFile } from "./demo";

export const SEARCH_TEXT = {
  words: {
    /** Only in a reply inside the finished turn's work (folded) of "Cap the text search memory". */
    reply: "quokka",
    /** Only in a tool's output, in the same turn: the search leaves tool output out, so no hit. */
    tool: "axolotl",
    /** Only in the archived chat's reply. */
    archived: "pangolin",
    /** Only in the long chat's first message, older than its newest history page. */
    old: "narwhal",
    /** A phrase in "Cap the text search memory" (twice) and the archived chat (once). */
    shared: "memory cap",
  },
  chats: { cap: "capthetextsearchmem2", tiles: "previewtilesforthel2", long: "tunethereconnectbac2" },
  titles: { cap: "Cap the text search memory", tiles: "Preview tiles for the looks", long: "Tune the reconnect backoff" },
  sessions: { cap: "d1e2f3a4-b5c6-4d7e-8f90-a1b2c3d4e5f6", tiles: "e2f3a4b5-c6d7-4e8f-9a01-b2c3d4e5f6a7", long: "f3a4b5c6-d7e8-4f90-8a12-c3d4e5f6a7b8" },
  /** The user messages' uuids that the hits name (a group that demo.ts's Transcript counter never makes). */
  uuids: { capQuestion: "d1e2f3a4-1111-4111-8111-000000000001", longFirst: "f3a4b5c6-1111-4111-8111-000000000001" },
  /** The rounds after the long chat's first message. */
  rounds: 200,
} as const;

/** The page's row ids that each word's hit names (a reply block's itemIdOf of `<API message id>:<block index>`). */
export const SEARCH_TEXT_ROWS = {
  /** `quokka`: the reply before the last one, block 1 of its API message (block 0 is the thinking). */
  reply: itemIdOf("msg_21Plan:1"),
  /** The turn's last reply (the answer that stays when the turn folds). */
  answer: itemIdOf("msg_21Measure:0"),
  archived: itemIdOf("msg_22Tiles:0"),
  old: SEARCH_TEXT.uuids.longFirst,
} as const;

/** The scene's three chats, beside demo.ts CHATS. */
export const SEARCH_TEXT_CHATS: ChatSeed[] = [
  { id: SEARCH_TEXT.chats.cap, project: "kitespan", sessionId: SEARCH_TEXT.sessions.cap, title: SEARCH_TEXT.titles.cap, from: "generated", picks: {}, lastActivity: 3, created: 12 },
  { id: SEARCH_TEXT.chats.tiles, project: "scratch", sessionId: SEARCH_TEXT.sessions.tiles, title: SEARCH_TEXT.titles.tiles, from: "generated", picks: {}, lastActivity: 3 * 24 * 60, created: 3 * 24 * 60 + 20, archived: 2 * 24 * 60 },
  { id: SEARCH_TEXT.chats.long, project: "notes", sessionId: SEARCH_TEXT.sessions.long, title: SEARCH_TEXT.titles.long, from: "renamed", picks: {}, lastActivity: 120, created: 600 },
];

const text = (t: string) => ({ type: "text", text: t });
const thinking = (t: string) => ({ type: "thinking", thinking: t, signature: "c2VlZA==" });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });

/** One round's reply of the long chat: about 2,000 characters, none of the flow's words. */
export function roundReply(i: number): string {
  const lines: string[] = [];
  for (let k = 0; lines.join(" ").length < 1_900; k++) {
    const wait = 200 * (((i + k) % 7) + 1);
    lines.push(`Round ${i}, step ${k}: the reconnect waits ${wait} ms, then doubles the wait up to 30 s, with a jitter of ${(i * 7 + k) % 90} ms.`);
  }
  return lines.join(" ");
}

/** The scene's transcripts, in the scratch CLAUDE_CONFIG_DIR. */
export function searchTextTranscripts(f: Folders, now: number): TranscriptFile[] {
  const min = 60_000;
  const S = SEARCH_TEXT;

  const cap = new Transcript(S.sessions.cap, f.kitespan, "sdk-ts", now - 12 * min);
  cap.user("How much may the text search keep before the memory cap drops a chat?", S.uuids.capQuestion);
  cap.assistant("msg_21Plan", [
    thinking("Measure before choosing a number."),
    text("I will measure the quokka corpus first: 200 made-up chats, ten of them over a megabyte."),
    tool("toolu_21Bench", "Bash", { command: "bun scripts/bench-text.ts", description: "Measure the kept text" }),
  ]);
  cap.results([{ id: "toolu_21Bench", content: "axolotl fixture: 200 chats, 56.5 MB of transcripts, 22.1 MB kept" }], { stdout: "axolotl fixture: 200 chats, 56.5 MB of transcripts, 22.1 MB kept", stderr: "", interrupted: false });
  cap.assistant("msg_21Measure", [text("The text search keeps 22 MB for those 200 chats, so a memory cap of 64 MiB leaves room for about three times as many. One chat keeps at most 8 MiB: its newest messages.")]);

  const tiles = new Transcript(S.sessions.tiles, f.scratch, "sdk-ts", now - (3 * 24 * 60 + 20) * min);
  tiles.user("Make a preview tile for each of the four looks.");
  tiles.assistant("msg_22Tiles", [text("Done. Each look has a pangolin test page with its own tile, and the thumbnails stay under a memory cap of 8 MB.")]);

  const long = new Transcript(S.sessions.long, f.notes, "sdk-ts", now - 600 * min);
  long.user("Call the retry branch narwhal, then tune the reconnect backoff round by round.", S.uuids.longFirst);
  long.assistant("msg_23Start", [text("The branch is ready. I will tune the waits one round at a time.")]);
  for (let i = 1; i <= S.rounds; i++) {
    long.user(`Round ${i}: try the next wait.`);
    long.assistant(`msg_23Round${i}`, [text(roundReply(i))]);
  }
  return [cap.file(), tiles.file(), long.file()];
}

// Fix the shapes once, at load.
for (const id of Object.values(SEARCH_TEXT.chats)) if (!CHAT_ID.test(id)) throw new Error(`not a chat id: ${id}`);
for (const id of [...Object.values(SEARCH_TEXT.sessions), ...Object.values(SEARCH_TEXT.uuids)]) if (!UUID.test(id)) throw new Error(`not a uuid: ${id}`);
