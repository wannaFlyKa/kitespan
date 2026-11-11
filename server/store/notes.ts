// A chat's notes (`notes/<chat id>.json`, store/types.ts NotesRecord): the record check that every read and write runs,
// and the smaller copy of a card that the notes keep. The checks follow records.ts: each returns a clean copy that holds
// only the known fields, or throws RecordError. A message's mention paths are checked as a send frame's chips are.

import { CHAT_ID, UUID } from "../../shared/ids";
import { CARD_ANSWER_KINDS, LIMITS, PLAN_MODES, capInput, capText, mentionsOf, type Card, type ChatEventOf, type Question } from "../../shared/protocol";
import { contextNoteFrom } from "./context";
import { RecordError } from "./records";
import { STORE_LIMITS, type BashNote, type CardNote, type MentionNote, type NotRunNote, type NotesRecord, type StopNote, type TurnNote } from "./types";

type Obj = Record<string, unknown>;

const fail = (why: string): never => {
  throw new RecordError(why);
};
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${what}: not an object`);
  return v as Obj;
}

/** The longest id a note holds (a tool-use id or a request id). */
const ID_MAX = 128;
/** A string's cap in a note, by field (generous for the read check: noteCard cuts to these). */
const CAP = { line: 2_000, short: 200, plan: 20_000, label: 500 } as const;
/** A stop line's text (D32): the server's own fixed words. */
const STOP_TEXT_MAX = 500;

function text(o: Obj, k: string, max: number): string {
  const v = own(o, k);
  if (typeof v !== "string" || v.length > max) fail(`${k}: not a string of at most ${max}`);
  return v as string;
}
const textOrNull = (o: Obj, k: string, max: number): string | null => (own(o, k) === null ? null : text(o, k, max));
function flag(o: Obj, k: string): boolean {
  const v = own(o, k);
  if (typeof v !== "boolean") fail(`${k}: not a boolean`);
  return v as boolean;
}
const id = (o: Obj, k: string): string => {
  const v = text(o, k, ID_MAX);
  if (!v) fail(`${k}: empty`);
  return v;
};

const cut = (s: string, max: number) => capText(s, max);
const cutOrNull = (s: string | null, max: number) => (s === null ? null : capText(s, max));

/** A card cut down for the notes: its record shows the tool and its target, the questions, the plan, the server. */
export function noteCard(card: Card): Card {
  switch (card.kind) {
    case "permission":
      return {
        ...card,
        title: cutOrNull(card.title, CAP.line),
        displayName: cutOrNull(card.displayName, CAP.short),
        description: cutOrNull(card.description, CAP.line),
        reason: cutOrNull(card.reason, CAP.line),
        blockedPath: cutOrNull(card.blockedPath, CAP.line),
        input: capInput(card.input, { string: CAP.line, budget: 8_000 }),
      };
    case "question":
      return {
        ...card,
        questions: card.questions.slice(0, 16).map((q) => ({
          question: cut(q.question, CAP.line),
          header: cut(q.header, CAP.short),
          multiSelect: q.multiSelect,
          options: q.options.slice(0, 50).map((o) => ({ label: cut(o.label, CAP.label), description: cut(o.description, CAP.line) })),
        })),
      };
    case "plan":
      return { ...card, plan: cut(card.plan, CAP.plan) };
    case "elicitation":
      return {
        ...card,
        server: cut(card.server, CAP.short),
        displayName: cutOrNull(card.displayName, CAP.short),
        title: cutOrNull(card.title, CAP.line),
        description: cutOrNull(card.description, CAP.line),
        message: cut(card.message, CAP.line),
        url: cutOrNull(card.url, CAP.line),
        // The form's schema is not part of the record.
        schema: null,
      };
    case "dialog":
      return { ...card, dialogKind: cut(card.dialogKind, CAP.short), payload: null, expiresAt: cutOrNull(card.expiresAt, CAP.short) };
  }
}

function questionFrom(v: unknown): Question {
  const q = obj(v, "question");
  const options = own(q, "options");
  if (!Array.isArray(options) || options.length > 50) fail("options: not a list of at most 50");
  return {
    question: text(q, "question", CAP.line),
    header: text(q, "header", CAP.short),
    multiSelect: flag(q, "multiSelect"),
    options: (options as unknown[]).map((x) => {
      const o = obj(x, "option");
      return { label: text(o, "label", CAP.label), description: text(o, "description", CAP.line) };
    }),
  };
}

/** A card as the notes keep it (noteCard's shape). */
export function cardFrom(v: unknown): Card {
  const c = obj(v, "card");
  switch (own(c, "kind")) {
    case "permission":
      return {
        kind: "permission",
        id: id(c, "id"),
        toolUseId: id(c, "toolUseId"),
        toolName: text(c, "toolName", CAP.short),
        title: textOrNull(c, "title", CAP.line),
        displayName: textOrNull(c, "displayName", CAP.short),
        description: textOrNull(c, "description", CAP.line),
        reason: textOrNull(c, "reason", CAP.line),
        blockedPath: textOrNull(c, "blockedPath", CAP.line),
        input: capInput(own(c, "input") ?? null, { string: CAP.line, budget: 8_000 }),
        defaultToNo: flag(c, "defaultToNo"),
        suppressAlwaysAllowRule: flag(c, "suppressAlwaysAllowRule"),
        sessionRule: flag(c, "sessionRule"),
        parent: own(c, "parent") === null ? null : id(c, "parent"),
      };
    case "question": {
      const qs = own(c, "questions");
      if (!Array.isArray(qs) || qs.length > 16) fail("questions: not a list of at most 16");
      return { kind: "question", id: id(c, "id"), toolUseId: id(c, "toolUseId"), questions: (qs as unknown[]).map(questionFrom) };
    }
    case "plan":
      return { kind: "plan", id: id(c, "id"), toolUseId: id(c, "toolUseId"), plan: text(c, "plan", CAP.plan) };
    case "elicitation": {
      const mode = own(c, "mode");
      if (mode !== "form" && mode !== "url") fail("mode: not form or url");
      return {
        kind: "elicitation",
        id: id(c, "id"),
        server: text(c, "server", CAP.short),
        displayName: textOrNull(c, "displayName", CAP.short),
        title: textOrNull(c, "title", CAP.line),
        description: textOrNull(c, "description", CAP.line),
        message: text(c, "message", CAP.line),
        mode: mode as "form" | "url",
        url: textOrNull(c, "url", CAP.line),
        elicitationId: own(c, "elicitationId") === null ? null : id(c, "elicitationId"),
        schema: null,
      };
    }
    case "dialog":
      return { kind: "dialog", id: id(c, "id"), dialogKind: text(c, "dialogKind", CAP.short), payload: null, expiresAt: textOrNull(c, "expiresAt", CAP.short) };
    default:
      return fail("kind: not a card kind");
  }
}

/** A card_close event as the notes keep it. */
export function closeFrom(v: unknown): ChatEventOf<"card_close"> {
  const e = obj(v, "close");
  if (own(e, "k") !== "card_close") fail("close: not a card_close");
  const why = own(e, "why");
  if (why !== "answered" && why !== "cancelled" && why !== "lost") fail("why: not a known value");
  const out: ChatEventOf<"card_close"> = { k: "card_close", id: id(e, "id"), why: why as "answered" | "cancelled" | "lost" };
  const answer = own(e, "answer");
  if (answer !== undefined) {
    if (typeof answer !== "string" || !(CARD_ANSWER_KINDS as readonly string[]).includes(answer)) fail("answer: not a known value");
    out.answer = answer as (typeof CARD_ANSWER_KINDS)[number];
  }
  const answers = own(e, "answers");
  if (answers !== undefined) {
    const a = obj(answers, "answers");
    const keys = Object.keys(a);
    if (keys.length > 16) fail("answers: more than 16");
    out.answers = Object.fromEntries(keys.map((k) => [cut(k, CAP.line), text(a, k, LIMITS.answerText)]));
  }
  const mode = own(e, "mode");
  if (mode !== undefined) {
    if (typeof mode !== "string" || !(PLAN_MODES as readonly string[]).includes(mode)) fail("mode: not a plan mode");
    out.mode = mode as (typeof PLAN_MODES)[number];
  }
  if (own(e, "note") !== undefined) out.note = text(e, "note", LIMITS.answerText);
  return out;
}

const DIGEST = /^[0-9a-f]{32,64}$/;
/** A day in milliseconds: far past the `!` command's own timeout. */
const BASH_MS_MAX = 86_400_000;

/** A whole number in [min, max], or null; absent (a note written before the field) reads as null. */
function whole(o: Obj, k: string, min: number, max: number): number | null {
  const v = own(o, k);
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(`${k}: not a whole number in range`);
  return v as number;
}
/** A flag; absent (a note written before the field) reads as false. */
const optFlag = (o: Obj, k: string): boolean => (own(o, k) === undefined ? false : flag(o, k));
/** The most id-less events a Not run row's place may skip after its anchor. */
const SKIP_MAX = 1_000_000;

function notRunFrom(v: unknown): NotRunNote {
  const n = obj(v, "not-run note");
  const uuid = own(n, "uuid");
  if (typeof uuid !== "string" || !UUID.test(uuid)) fail("notRun.uuid: not a uuid");
  const skip = whole(n, "skip", 0, SKIP_MAX);
  if (skip === null) fail("notRun.skip: not a whole number");
  return { uuid: uuid as string, input: text(n, "input", LIMITS.bashInput), after: own(n, "after") === null ? null : id(n, "after"), skip: skip as number };
}

/** A stop line (D32), placed as a Not run row is. */
function stopFrom(v: unknown): StopNote {
  const n = obj(v, "stop note");
  const skip = whole(n, "skip", 0, SKIP_MAX);
  if (skip === null) fail("stops.skip: not a whole number");
  const line = text(n, "text", STOP_TEXT_MAX);
  if (!line) fail("stops.text: empty");
  return { id: id(n, "id"), text: line, after: own(n, "after") === null ? null : id(n, "after"), skip: skip as number };
}

/** U2: a turn's ids (history event ids) a note keeps, its end's subtype and line, its messages, its duration. */
const TURN_IDS_MAX = 2;
const TURN_SUBTYPE_MAX = 64;
const TURN_ERROR_MAX = 240;
const TURN_UUIDS_MAX = STORE_LIMITS.queueMessages;
/** A week in milliseconds: far past any turn. */
const TURN_MS_MAX = 7 * 86_400_000;

function idList(n: Obj, k: string, min: number): string[] {
  const v = own(n, k);
  if (!Array.isArray(v) || v.length < min || v.length > TURN_IDS_MAX) fail(`turns.${k}: not a list of ${min} to ${TURN_IDS_MAX} ids`);
  return (v as unknown[]).map((x) => {
    if (typeof x !== "string" || !x || x.length > ID_MAX) fail(`turns.${k}: not an id`);
    return x as string;
  });
}

/** A turn's end line as a note may keep it: at most TURN_ERROR_MAX characters, and never one that names a provider's resource. */
export function turnErrorNote(error: string | null): string | null {
  if (error === null || /\barn:/i.test(error)) return null;
  return capText(error, TURN_ERROR_MAX);
}

function turnFrom(v: unknown): TurnNote {
  const n = obj(v, "turn note");
  const by = own(n, "by");
  if (by !== "user" && by !== "agent") fail("turns.by: not user or agent");
  const ms = whole(n, "durationMs", 0, TURN_MS_MAX);
  if (ms === null) fail("turns.durationMs: not a whole number");
  const uuids = own(n, "uuids");
  if (!Array.isArray(uuids) || uuids.length > TURN_UUIDS_MAX || uuids.some((u) => typeof u !== "string" || !UUID.test(u))) fail(`turns.uuids: not a list of at most ${TURN_UUIDS_MAX} uuids`);
  const error = textOrNull(n, "error", TURN_ERROR_MAX);
  if (error !== null && turnErrorNote(error) !== error) fail("turns.error: not a line a note keeps");
  const subtype = text(n, "subtype", TURN_SUBTYPE_MAX);
  if (!subtype) fail("turns.subtype: empty");
  return { ids: idList(n, "ids", 1), last: idList(n, "last", 0), by: by as TurnNote["by"], ok: flag(n, "ok"), subtype, durationMs: ms as number, uuids: [...(uuids as string[])], error };
}

function mentionFrom(v: unknown): MentionNote {
  const n = obj(v, "mention note");
  const uuid = own(n, "uuid");
  if (typeof uuid !== "string" || !UUID.test(uuid)) fail("mentions.uuid: not a uuid");
  // Repeats go and the order stays, as the send frame's own check reads the chips; the reason names no path.
  // An empty list is a message sent with no chips.
  const raw = own(n, "paths");
  const paths = Array.isArray(raw) ? mentionsOf(raw, LIMITS.sendMentions) : null;
  if (!paths) fail(`mentions.paths: not a list of at most ${LIMITS.sendMentions} paths relative to the chat's folder`);
  return { uuid: uuid as string, paths: paths as string[] };
}

/** `notes/<id>.json`. `fileId`, when given, must equal the record's id (the file name check). */
export function notesFrom(raw: unknown, fileId?: string): NotesRecord {
  const o = obj(raw, "notes");
  if (own(o, "v") !== 1) fail("notes: not version 1");
  const chat = own(o, "id");
  if (typeof chat !== "string" || !CHAT_ID.test(chat)) fail("id: bad shape");
  if (fileId !== undefined && chat !== fileId) fail("id: does not match the file name");
  const cards = own(o, "cards");
  const bash = own(o, "bash");
  const notRun = own(o, "notRun") ?? [];
  const mentions = own(o, "mentions") ?? [];
  const stops = own(o, "stops") ?? [];
  const turns = own(o, "turns") ?? [];
  if (!Array.isArray(cards) || cards.length > STORE_LIMITS.noteCards) fail("cards: not a list within the cap");
  if (!Array.isArray(bash) || bash.length > STORE_LIMITS.noteBash) fail("bash: not a list within the cap");
  if (!Array.isArray(notRun) || notRun.length > STORE_LIMITS.noteNotRun) fail("notRun: not a list within the cap");
  if (!Array.isArray(mentions) || mentions.length > STORE_LIMITS.noteMentions) fail("mentions: not a list within the cap");
  if (!Array.isArray(stops) || stops.length > STORE_LIMITS.noteStops) fail("stops: not a list within the cap");
  if (!Array.isArray(turns) || turns.length > STORE_LIMITS.noteTurns) fail("turns: not a list within the cap");
  return {
    v: 1,
    id: chat as string,
    cards: (cards as unknown[]).map((x): CardNote => {
      const n = obj(x, "card note");
      const after = own(n, "after");
      return { card: cardFrom(own(n, "card")), close: closeFrom(own(n, "close")), after: after === null ? null : id(n, "after") };
    }),
    bash: (bash as unknown[]).map((x): BashNote => {
      const n = obj(x, "bash note");
      const uuid = own(n, "uuid");
      const digest = own(n, "digest");
      if (typeof uuid !== "string" || !UUID.test(uuid)) fail("bash.uuid: not a uuid");
      if (typeof digest !== "string" || !DIGEST.test(digest)) fail("bash.digest: bad shape");
      return { uuid: uuid as string, digest: digest as string, code: whole(n, "code", -(2 ** 31), 2 ** 31), ms: whole(n, "ms", 0, BASH_MS_MAX), timedOut: optFlag(n, "timedOut"), capped: optFlag(n, "capped") };
    }),
    notRun: (notRun as unknown[]).map(notRunFrom),
    ...((mentions as unknown[]).length ? { mentions: (mentions as unknown[]).map(mentionFrom) } : {}),
    ...((stops as unknown[]).length ? { stops: (stops as unknown[]).map(stopFrom) } : {}),
    ...((turns as unknown[]).length ? { turns: (turns as unknown[]).map(turnFrom) } : {}),
    // Row 94: the last context read is a cache: one that fails its checks reads as none, and never fails the notes.
    ...contextOf(own(o, "context")),
  };
}

function contextOf(v: unknown): Pick<NotesRecord, "context"> {
  const context = contextNoteFrom(v);
  return context ? { context } : {};
}

/** The entries of `list` that pass `check`; one that does not (an id longer than a note holds) is left out. */
function passing<T>(list: readonly T[], check: (x: T) => unknown): T[] {
  return list.filter((x) => {
    try {
      check(x);
      return true;
    } catch (e) {
      if (e instanceof RecordError) return false;
      throw e;
    }
  });
}

/**
 * Notes as a caller hands them to saveNotes: each card cut down (noteCard), an entry that fails its check left out
 * (so one odd card never keeps the others from being written), the oldest entries dropped to the caps of
 * STORE_LIMITS (the count, then the file's 1 MiB: the messages' mention paths first, since a message without them
 * reads as before, then the turns, then the cards, then the Not run rows), then checked.
 */
export function notesForSave(rec: NotesRecord): NotesRecord {
  const cards = passing(
    rec.cards.slice(-STORE_LIMITS.noteCards).map((n) => ({ ...n, card: noteCard(n.card) })),
    (n) => notesFrom({ v: 1, id: rec.id, cards: [n], bash: [] }),
  );
  const bash = passing(rec.bash.slice(-STORE_LIMITS.noteBash), (n) => notesFrom({ v: 1, id: rec.id, cards: [], bash: [n] }));
  const notRun = passing(rec.notRun.slice(-STORE_LIMITS.noteNotRun), (n) => notesFrom({ v: 1, id: rec.id, cards: [], bash: [], notRun: [n] }));
  const mentions = passing((rec.mentions ?? []).slice(-STORE_LIMITS.noteMentions), (n) => notesFrom({ v: 1, id: rec.id, cards: [], bash: [], mentions: [n] }));
  const stops = passing((rec.stops ?? []).slice(-STORE_LIMITS.noteStops), (n) => notesFrom({ v: 1, id: rec.id, cards: [], bash: [], stops: [n] }));
  const turns = passing((rec.turns ?? []).slice(-STORE_LIMITS.noteTurns), (n) => notesFrom({ v: 1, id: rec.id, cards: [], bash: [], turns: [n] }));
  let next = notesFrom({ v: 1, id: rec.id, cards, bash, notRun, mentions, stops, turns, context: rec.context });
  const tooBig = () => Buffer.byteLength(JSON.stringify(next)) > STORE_LIMITS.notesBytes;
  while (next.mentions && tooBig()) {
    next = { ...next, mentions: next.mentions.slice(Math.ceil(next.mentions.length / 10)) };
    if (!next.mentions!.length) delete next.mentions;
  }
  // U2: an older turn without its note reads as history alone groups it (the page's own rule).
  while (next.turns && tooBig()) {
    next = { ...next, turns: next.turns.slice(Math.ceil(next.turns.length / 10)) };
    if (!next.turns!.length) delete next.turns;
  }
  while (next.cards.length > 0 && tooBig()) next = { ...next, cards: next.cards.slice(Math.ceil(next.cards.length / 10)) };
  while (next.notRun.length > 0 && tooBig()) next = { ...next, notRun: next.notRun.slice(Math.ceil(next.notRun.length / 10)) };
  return next;
}

export function emptyNotes(chat: string): NotesRecord {
  return { v: 1, id: chat, cards: [], bash: [], notRun: [] };
}
