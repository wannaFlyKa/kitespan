// The composer (DESIGN.md 6.4 to 6.6, 6.11, 7.5; the link rules of 5.1 rule 7 and the lines of 5.4). It is the one
// bold element of the page: a slab whose rim and mode chip change with the mode. Chat: the accent rim on focus.
// "/": an accent "/" chip and the command menu of the chat's own commands. "!": a warn rim and a "!" chip, like a shell
// prompt, and Run; the chip says when Claude will not reply to the output (D10; M13: no line under the box).
//
// A link only fills: /c/<chat>/send, /bash and /slash pre-fill the field and focus the named button; the pickers mark
// a pre-filled value and wait for Switch. act.* runs only inside a click, tap or key handler; the reads here (`get
// commands`, `get models`, the uploads list) change nothing.
//
// The draft (D49, 7.5) belongs to the chat and lives on the server. The field fills from it on attach and whenever
// another page changes it, unless this page is being typed in: the store holds a draft that comes within 2 s of input
// or while an input method composes (act.setComposing), and the field itself keeps a link's text that the user has not
// changed. The draft's mode is the store's own field (draftOf), never its text's first character, so a message that
// starts with "!" stays a message; only a "!" or "/" typed into an empty field picks a mode (draft.ts typed). A draft
// taken from the server changes the field's value only (the element stays, so the iOS keyboard stays up), keeps the
// focus and puts the caret at the end. A link's text is never saved as the draft until the user edits it. Every change
// the user makes is saved 250 ms later, and at once on blur (flushDrafts).
//
// Files (D37, D50): a paste of files or images (a capture-phase handler on the composer) and + > Add files or photos
// (a file input, multiple) each call act.upload once; a drop on the chat does too (ChatScreen). Each file is a chip
// over the field and nothing else: the field holds no path, a tap on a chip shows its path, and the server adds the
// references at send. Send waits while a file is still on its way.
//
// The `@` picker (9.3, 6.4; mention.ts and MentionMenu.tsx): an `@` that the user types at a word start in Chat mode,
// the `@` button beside + on touch (7.5), or a /c/<chat>/mention?q= link opens it over the chat folder's files. A pick
// takes the `@<filter>` text out of the field and adds the file's mention chip to the draft (act.addMention); Enter
// never sends while it shows, and an Enter that comes before the rows for the filter waits for them. The chip's
// Remove takes it out of the draft only (act.removeMention). A link's `@<q>` is the picker's filter only: it follows
// the server's draft while the user has not changed it, and a close with no pick takes it out again.
//
// The `/` menu at a mid-line `/` (D57; slashToken.ts): a `/` that the user types at a word start in Chat mode, or in a
// command's arguments after its chip, opens the `/` menu's rows (SlashMenu over commandRows) over that word, on the
// `@` picker's token rules and keys. It shows only while a row answers its filter: a path such as /etc/hosts (no
// command name holds a `/`) or a word such as /zzz shows nothing, and Enter sends as with no menu. A pick puts
// `/<name> ` in place of `/<filter>` as plain text; Enter never sends while it shows; Esc closes it and keeps the
// text. It is the field's own state, as the typed `@` picker is: no URL.
//
// Rows 78 and 80 (HeldLine.tsx): while another app has the chat's session open (the chat list's `held`), the box
// cannot be used. Continue in a copy takes Send's place on every size (on a phone, after Stop, while kitespan's own
// turn finishes), and one plain line under the box says why. The field shows the draft read-only (readable and
// selectable; it takes no typing, paste or dropped text, a paste of files uploads nothing, and neither do files that a
// picker opened before the hold hands over; an empty field shows no placeholder, which would invite typing); +, @, the
// mode and model buttons and a chip's Remove are off, shown as off; no key acts but Esc's Stop. A composer link (send,
// bash, the / menu and a command row, mention, add, model, effort, mode) fills and opens nothing: the held line is the
// box's one line. The / menu, the `@` picker and the mid-line `/` menu are hidden, not closed, so when the other app
// closes the session everything comes back as it was, with the draft; a link that came during the hold fills then, and
// one applied before it is not applied again.
//
// R124 (row 124), `/btw`: the `/` menu has kitespan's own /btw row (side/btw.ts; Claude Code's list for an SDK session
// has none, and typed as a prompt it answers "/btw isn't available in this environment."). Send on the btw chip, on the
// filter text "btw ...", or on a message that starts with "/btw" asks a side question (act.sideAsk) and never sends a
// prompt: the box empties as a send empties it (its file chips stay), and the side chat opens at /c/<chat>/btw with no
// text in its URL. A bare /btw only opens it. One side question runs per chat at a time: while one runs, Send keeps the
// text in the box and only opens the side chat, and when another page asked first (a busy ack) the draft comes back. A
// question over a side question's 5,000 characters is never asked: Send is off and a line says so. Where the agent
// answers no side question, none of this applies.
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { apiGet } from "../net/api";
import { closeTo, href, navigate, type Route } from "../router";
import type { UploadsReply } from "../../server/http/api-types";
import { NO_UPLOADS, act, chatFolderIn, draftOf, flushDrafts, mentionsIn, modelRows, uploadRoot, useStore, type ChatDraft } from "../state/store";
import { MODELS } from "../state/catalog";
import type { Chat, Item, ModeId, Upload } from "../state/types";
import { useViewport } from "../layout/size";
import { processLives } from "../terminal/command";
import { openInTerminalHref } from "../terminal/route";
import { usePopupSheet } from "../ui/primitives";
import { sendNowKey } from "../ui/shortcuts";
import { linkNoticeLine } from "../ui/LinkNotice";
import { filesFrom, type FileFacts } from "../ui/files";
import { IconChevron, IconPlus, IconSend, IconShield, IconStop, IconTerminal } from "../ui/icons";
import { chipsOf, clipboardFiles, mentionChipsOf, pastedFacts, unknownIds, uploadFromView, waitsForUpload, type ChipUpload } from "./attach";
import { DraftChip, MentionChip } from "./Chip";
import { EMPTY, commandMenu, draftKey, fromStore, menuRowsOf, outgoing, toInput, typed, type Draft, type MenuRow, type Prefill } from "./draft";
import { ExternalLinkLine } from "./ExternalLinkLine";
import { HeldCopy, HeldLine, HeldSendAgain } from "./HeldLine";
import { ContextRing } from "./ContextRing";
import { SlashMenu } from "./SlashMenu";
import { AtButton, MentionMenu } from "./MentionMenu";
import { insertAt, mentionFill, mentionKey, nextToken, tokenAt, waitedPick, withoutToken, type MentionToken, type OpenMention as Mention } from "./mention";
import { nextSlash, slashField, slashPick, type SlashToken } from "./slashToken";
import { STACK_BAND_EM, lineRows, nextStacked, pinsEnd } from "./stack";
import { useFileEngine, useFileRows } from "../search/useSearch";
import type { FileRow } from "../search/engine";
import { PlusMenu } from "./PlusMenu";
import { ModelPicker, ModePicker, NOT_OFFERED_LINE } from "./Pickers";
import { archivedLinePath } from "../chat/cards/WaitingCard";
import { ownSend } from "../chat/ownSend";
import { connectorsOf } from "../panels/details";
import { EffortBars } from "./icons";
import { effortLabel, effortLevel, modeLabel, modelLabel, shortcut, showsEffort } from "./labels";
import { markPicked, type Field } from "./origin";
import { useCoarse, useSoftKeyboard } from "./keyboard";
import { imeKey } from "./composition";
import { pickerCommand, pickerOf } from "./pickerCommand";
import { keptLine } from "../worktree/worktree";
import { BTW_TOO_LONG, sideQuestionOf, withSideRow } from "../side/btw";
import { sideBoxBack, sideHref, sideShown } from "../side/nav";
import { kindShown, openHref, splitLive, useSplitLive } from "../layout/split";
import { EMPTY_THREAD, askingOf, questionText, questionTooLong } from "../side/thread";
import { WithPath } from "../worktree/PathText";

type PopupName = "add" | "model" | "effort" | "mode";
const POPUP_ROUTES = new Set<string>(["add", "model", "effort", "mode"]);
const COMPOSER_ROUTES = new Set<string>(["send", "bash", "slashMenu", "slash", "mention"]);
const MENU_ROUTES = new Set<string>(["slashMenu", "slash"]);
const UPLOAD_WAIT = "Send waits until the files finish uploading.";
/** How long a tap on Send while files upload shows UPLOAD_WAIT under the box. */
const UPLOAD_WAIT_MS = 4000;
/** What in the slab keeps its own press: the field, the buttons and links, the / menu and the attachments. */
const SLAB_OWN = "textarea, input, button, a, [role], .cmp-attach";
function slabRoom(e: { target: EventTarget; currentTarget: Element }): boolean {
  const own = (e.target as Element).closest(SLAB_OWN);
  return !own || !e.currentTarget.contains(own);
}
// DESIGN.md 6.4 and 6.3 (the Bash block): a ! command typed during a turn waits as "Queued" and runs after the turn.
const QUEUED_LINE = "The command waits as Queued until Claude's turn ends.";
const OVER_CAP_LINE = "That link's text is too long to fill in (the limit is 5,000 characters, or 120 for a title or a setting).";
/** DESIGN.md 5.4: a composer link on an archived chat (D48). */
export const ARCHIVED_LINE = "This chat is archived.";
const NO_IDS: readonly string[] = Object.freeze([]);
const NO_ROWS: readonly FileRow[] = Object.freeze([]);
const NO_COMMANDS: MenuRow[] = [];
/** `pathOf` for a mention chip: this, then its path (an upload chip's is its id). */
const MENTION_KEY = "mention:";
const NO_CONNECTORS: readonly [] = Object.freeze([]) as readonly [];
/** How long after a message left the chat (Take back, a refused send) a draft from the server counts as its text. */
const PUT_BACK_MS = 30_000;

// Drafts (DESIGN.md 7.5): the store keeps each chat's draft as the server's fields (draftOf). In memory, per chat: the
// draft as the field shows it (a link's pre-fill that the user has not changed is not stored: `pre`), with the key of
// the store's draft it stands for, and the last link pre-fill applied to it, so a composer that comes back after a
// card or a chat switch keeps the user's edits. A page load fills from a composer link again.
const DRAFTS = new Map<string, { draft: Draft; stored: string; pre?: boolean }>();
const APPLIED = new Map<string, string | null>();
// Per chat, the failed uploads that a Send put aside: their chips leave the composer (the chat's Uploads list keeps
// them until Remove). View state only, like the drafts above.
const PUT_ASIDE = new Map<string, ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();

// Per chat: the user messages on screen, and when one last left the chat (Take back or a refused send): the draft that
// brings it back shows in place of a link's pre-fill that the user has not changed.
const SEEN = new Map<string, { items: readonly Item[]; ids: Set<string> }>();
const LEFT = new Map<string, number>();
function noteLeft(chatId: string, items: readonly Item[]) {
  const was = SEEN.get(chatId);
  if (was?.items === items) return;
  const ids = new Set<string>();
  for (const it of items) if (it.kind === "user") ids.add(it.id);
  if (was && [...was.ids].some((id) => !ids.has(id))) LEFT.set(chatId, Date.now());
  SEEN.set(chatId, { items, ids });
}
function leftLately(chatId: string): boolean {
  const at = LEFT.get(chatId);
  return at !== undefined && Date.now() - at < PUT_BACK_MS;
}

/** The store's draft as a key (draft.ts draftKey), to tell it from the one this composer wrote. */
const storeKey = (d: ChatDraft) => draftKey(fromStore(d));

function restore(chatId: string, stored: ChatDraft): Draft {
  const kept = DRAFTS.get(chatId);
  if (kept && kept.stored === storeKey(stored)) return kept.draft;
  return fromStore(stored);
}

/** Focus the field with the caret after its text, as a click at its end would leave it. */
function focusEnd(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.setSelectionRange(el.value.length, el.value.length);
}

/** The field's line in rows (stack.ts lineRows), read with the field's height at auto: the field's lines and its chip. */
function rowsOf(el: HTMLTextAreaElement, pad: number, lh: number): number {
  const chip = el.previousElementSibling;
  return lineRows(el, chip instanceof HTMLElement && chip.classList.contains("cmp-chip") ? chip : null, pad, lh);
}

/**
 * The one-row form's rows for the text with the line `band` px narrower (stack.ts, rule 3), on the real box: the form's
 * class off and a margin on the line for one synchronous layout, then both back before anything paints. Styles only:
 * no element moves, so the focus, the caret, the selection and the keyboard stay (DESIGN.md 7.8).
 */
function oneRowNarrower(cmp: HTMLElement, el: HTMLTextAreaElement, band: number, pad: number, lh: number): number {
  const line = el.parentElement;
  if (!line) return 2;
  const was = line.style.marginInlineEnd;
  cmp.classList.remove("is-stacked");
  line.style.marginInlineEnd = `${band}px`;
  try {
    return rowsOf(el, pad, lh);
  } finally {
    line.style.marginInlineEnd = was;
    cmp.classList.add("is-stacked");
  }
}

/**
 * The one-row form's line width (stack.ts rule 0), read the same in both forms: the field row's content less +, @ and
 * the end key and the gaps between them, because the keys keep their widths in both (the line is flex 1 in one row).
 * Layout reads only: no style changes. NaN when the field has no line or row.
 */
function oneRowWidth(el: HTMLTextAreaElement): number {
  const line = el.parentElement;
  const row = line?.parentElement;
  if (!line || !row) return Number.NaN;
  const cs = getComputedStyle(row);
  let rest = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let shown = 0;
  for (const kid of row.children) {
    const w = kid.getBoundingClientRect().width;
    if (!w) continue;
    shown++;
    if (kid !== line) rest -= w;
  }
  return rest - Math.max(0, shown - 1) * (parseFloat(cs.columnGap) || 0);
}

function isOtherField(t: EventTarget | null, mine: HTMLElement | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && el !== mine && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/**
 * The draft's uploads that this page has not read (another page added them): the chat's list is read again after a
 * short wait, so the chips get their names. A read only.
 */
function useMissingUploads(chatId: string, missing: readonly string[]): ReadonlyMap<string, Upload> {
  const [got, setGot] = useState<ReadonlyMap<string, Upload>>(() => new Map());
  const key = missing.join(",");
  useEffect(() => {
    if (!key) return;
    let live = true;
    const t = setTimeout(() => {
      apiGet<UploadsReply>(`/api/chats/${chatId}/uploads`).then(
        (r) => {
          if (!live) return;
          setGot((m) => {
            const next = new Map(m);
            for (const v of r.uploads) next.set(v.id, uploadFromView(v, chatId));
            return next;
          });
        },
        () => {},
      );
    }, 1500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [chatId, key]);
  return got;
}

export function Composer({ chat, route }: { chat: Chat; route: Route }) {
  noteLeft(chat.id, chat.items);
  // D48: an archived chat is read-only; one Unarchive button takes the composer's place (M-H).
  if (chat.archived) return <ArchivedBar chat={chat} route={route} />;
  // A waiting card takes the composer's place (DESIGN.md 6.3); the chat's draft waits in the store meanwhile.
  if (chat.pending.length > 0) return null;
  return <ComposerBody key={chat.id} chat={chat} route={route} />;
}

function ArchivedBar({ chat, route }: { chat: Chat; route: Route }) {
  // DESIGN.md 5.4: a composer, picker, Stop or card path on an archived chat.
  const linked = archivedLinePath(route);
  return (
    <div className="cmp-dock">
      <div className="cmp cmp-archived" data-testid="composer-archived">
        {linked ? (
          <p className="notice cmp-archived-line" data-testid="link-notice" role="status">
            {ARCHIVED_LINE}
          </p>
        ) : null}
        {chat.worktree?.kept ? (
          // L25: Archive kept a worktree with changes or ignored files on disk; Unarchive takes the chat back to it.
          <p className="cmp-archived-line cmp-archived-kept wt-path-line" data-testid="worktree-kept">
            <WithPath text={keptLine(chat.worktree.path)} path={chat.worktree.path} />
          </p>
        ) : null}
        <button type="button" className="btn" data-testid="composer-unarchive" onClick={() => void act.unarchive(chat.id)}>
          Unarchive
        </button>
      </div>
    </div>
  );
}

function ComposerBody({ chat, route }: { chat: Chat; route: Route }) {
  const vp = useViewport();
  // U4: whether the side panel splits here, for the context ring's link (layout/split.ts openHref).
  const splitHere = useSplitLive();
  const coarse = useCoarse();
  const phone = vp.size === "phone";
  const sheet = usePopupSheet(); // the Popup primitive's rule for an anchored Popup
  const settings = useStore((s) => s.settings);
  const respondToBash = useStore((s) => s.host?.agent?.respondToBash ?? true);
  const storeNotice = useStore((s) => s.notice);
  const project = useStore((s) => s.projects.find((p) => p.id === chat.projectId));
  // The chat's draft, the server's own fields (D49): its mode and chip come from here, never from its text.
  const stored = useStore((s) => draftOf(s, chat.id));
  const storedKey = storeKey(stored);
  const uploadIds = stored.uploads.length ? stored.uploads : NO_IDS;
  const mentions = mentionsIn(stored);
  // Every chip of the draft: its uploads' ids, then its mentions' paths (9.3). A message may be files alone.
  const ids = useMemo(() => (mentions.length ? [...uploadIds, ...mentions] : uploadIds), [uploadIds, mentions]);
  const uploads = useStore((s) => s.uploads[chat.id] ?? NO_UPLOADS);
  const customFolder = useStore((s) => s.settings.customFolder);
  const uploadFolder = useStore((s) => s.settings.uploadFolder);
  const view = typeof route.query.view === "string" ? route.query.view : undefined;
  const chatUrl = href("chat", { chat: chat.id }, { view });
  const running = chat.state === "running";
  // Rows 78 and 80: another app has the session open: no Send (the line takes its place), and the box is off.
  const held = chat.held ?? null;
  const isHeld = !!held;
  // A press of Send again waits for its ack: the handed hold's Send again is off until then.
  const againOut = useStore((s) => s.sendAgainOut.includes(chat.id));
  // Stop names the running turn by its `turn_start` seq (4.3): without one there is nothing to stop. While kitespan's own
  // orphan finishes its turn (R16), Stop and Esc end that process (an interrupt with turn 0).
  const canStop = chat.turn !== null || held?.kind === "finishing";
  // S16: the hand-over waits for this chat's Claude Code to end: until then the line is Wait, with no Send again.
  const handing = held?.kind === "handed" && processLives(chat);
  const [copying, setCopying] = useState(false);

  // The chat's own lists: the `/` menu (the `commands` event) and the model rows (`get models`). Before they came,
  // the menu has the catalog's rows (none) and the pickers Claude Code's Default row only.
  const sideOn = useStore((s) => s.sideQuestions);
  // R124: one side question runs per chat at a time (the page's copy of the thread, side/thread.ts).
  const sideAsking = useStore((s) => askingOf(s.side[chat.id] ?? EMPTY_THREAD) !== null);
  const menu = useMemo(() => commandMenu(withSideRow(menuRowsOf(chat), sideOn)), [chat.commands, sideOn]);
  const { commandRows, findCommand, prefillOf } = menu;
  const known = !!chat.models?.length;
  const models = useMemo(() => (chat.models?.length ? modelRows(chat) : MODELS), [chat.models]);
  const commandsKnown = !!chat.commands?.length;

  // Row 80: a link on a held chat fills nothing (`pre`); `linkPre` is what it would fill, so a hold that begins or ends
  // never counts as a new link.
  const linkPre = prefillOf(route);
  const pre = held ? null : linkPre;
  const preKey = pre?.key ?? null;
  const linkKey = linkPre?.key ?? null;
  // The + menu and the pickers open only while the box can be used.
  const addOpen = !held && route.name === "add";
  const modelOpen = !held && (route.name === "model" || route.name === "effort");
  const modeOpen = !held && route.name === "mode";
  const popupOpen = addOpen || modelOpen || modeOpen;
  const stash = useRef<Draft | null>(null); // the chat text set aside while + > Slash commands filters
  // The field shows a composer link's pre-fill that the user has not changed: like a link's text, it stays when the
  // server's draft changes (on attach, or from another page), and it is never saved by itself (D49, 5.1 rule 3).
  const prefilled = useRef(false);
  const linkMention = useRef<Mention | null>(null); // the picker that a /c/<chat>/mention link opens with the field
  const [d, setD] = useState<Draft>(() => {
    const kept = restore(chat.id, stored);
    if (!pre || APPLIED.get(chat.id) === pre.key) {
      const was = DRAFTS.get(chat.id);
      prefilled.current = !!was?.pre && was.stored === storedKey;
      return kept;
    }
    APPLIED.set(chat.id, pre.key);
    if (route.name === "slashMenu" && kept.mode === "chat" && kept.text.trim()) stash.current = kept;
    const held = DRAFTS.get(chat.id);
    const untouched = !!held?.pre && held.stored === storedKey; // a link's pre-fill is not the box's text
    const fill = pre.mention !== undefined ? mentionFill(untouched ? fromStore(stored) : kept, pre.mention) : null;
    linkMention.current = fill?.mention ?? null;
    const draft = fill?.draft ?? pre.draft;
    if (draft) {
      DRAFTS.set(chat.id, { draft, stored: storedKey, pre: true });
      prefilled.current = true;
    }
    return draft ?? kept;
  });
  const [menuOpen, setMenuOpen] = useState(() => !!pre?.menu);
  const [active, setActive] = useState(() => menuIndex(pre));
  // The `@` picker (9.3): its token while it is open, and its highlighted row.
  const [mention, setMention] = useState<Mention | null>(() => linkMention.current);
  const [mentionActive, setMentionActive] = useState(0);
  // The `/` menu at a mid-line `/` (D57): its token while it is open, and its highlighted row.
  const [slash, setSlash] = useState<SlashToken | null>(null);
  const [slashActive, setSlashActive] = useState(0);
  const [switching, setSwitching] = useState<{ field: Field; value: string } | null>(null);
  const [putAside, setPutAside] = useState<ReadonlySet<string>>(() => PUT_ASIDE.get(chat.id) ?? NONE);
  const [pathOf, setPathOf] = useState<string | null>(null); // the chip whose path shows
  // The field as it is now, for a refused / command's answer, which comes after the press (send).
  const shown = useRef({ mounted: true, d });
  shown.current.d = d;
  useEffect(() => {
    shown.current.mounted = true;
    return () => {
      shown.current.mounted = false;
    };
  }, []);

  function menuIndex(p: Prefill | null): number {
    const at = p?.menu;
    if (!at || !("command" in at)) return 0;
    return Math.max(0, commandRows("").findIndex((c) => c.name === at.command));
  }

  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const sendBtn = useRef<HTMLButtonElement>(null);
  const plusBtn = useRef<HTMLButtonElement>(null);
  const modeBtn = useRef<HTMLButtonElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachBox = useRef<HTMLDivElement>(null);
  const written = useRef(storedKey); // the key of the draft this composer last gave the store (or took from it)
  const onTrigger = useRef(false);
  const replacingAll = useRef(false); // the next input replaces the whole text (select all, then type or paste)
  const inputType = useRef<string | null>(null); // the next input's InputEvent.inputType: a typed `@` opens the picker
  const caretTo = useRef<number | null>(null); // where the caret goes after a mode change or a taken draft
  const plusFolded = useRef(false); // the phone's picker row was folded when + was pressed (M11)
  const dock = useRef<HTMLDivElement>(null);

  // The reads (`get`): the chat's `/` menu and model rows, once per composer, and again when a menu opens while
  // Claude Code has sent none yet (a chat that starts later has them then).
  useEffect(() => {
    if (chat.commands === null) void act.load(chat.id, "commands");
    if (chat.models === null) void act.load(chat.id, "models");
    // Once per chat: the lists come with their events later on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);
  const pickerOpen = modelOpen || modeOpen;
  useEffect(() => {
    if (pickerOpen && !known) void act.load(chat.id, "models");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);
  // The + menu's Connectors item says when a connector needs the user, so the menu reads the list as it opens.
  useEffect(() => {
    if (addOpen) void act.load(chat.id, "connectors");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen]);

  // ---- the on-screen keyboard (DESIGN.md 7.8) ----
  // While the keyboard is up and the focus is in the composer, the composer rides one fixed wrapper as tall as the
  // visual viewport and moved down by its offsetTop, at the wrapper's bottom; a bottom: offset would land behind the
  // keyboard on iOS. The dock keeps the composer's place in the chat column, plus the part of the layout viewport that
  // the keyboard covers, so the end of the chat stays in view above the composer. Only styles change, never the element
  // tree, because a remount of the focused field closes the iOS keyboard. A keyboard that settles closed releases the
  // field: the app's root blurs it (keyboard.ts useKeyboardRelease), and the composer's root is its owner
  // (data-kb-owner), so a press, a focus or a key anywhere in the composer keeps it.
  const kb = useSoftKeyboard(vp.touch, () => {
    // The `@` picker and the mid-line `/` menu go with the keyboard: nothing of them stays over the composer (7.2).
    closeMention();
    closeSlash();
  });
  const [focusIn, setFocusIn] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // DOM focus events, not React's: React's also bubble out of the pickers' portals, which are not in the composer.
    const on = () => setFocusIn(true);
    const off = (e: FocusEvent) => {
      if (!(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) setFocusIn(false);
    };
    setFocusIn(el.contains(document.activeElement));
    el.addEventListener("focusin", on);
    el.addEventListener("focusout", off);
    return () => {
      el.removeEventListener("focusin", on);
      el.removeEventListener("focusout", off);
    };
  }, []);
  const riding = kb.up && focusIn;
  const [ride, setRide] = useState<{ left: number; width: number; dockHeight: number; menuRoom: number } | null>(null);
  // The ride's measure while the box rides, for the grow effect below: a box that grows or changes its form gives its
  // dock the new height in the same layout effect, so the chat shrinks with it before the paint (a ResizeObserver's
  // state is drawn a frame later, and for that frame the box would cover the conversation's end).
  const rideMeasure = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!riding) {
      rideMeasure.current = null;
      setRide(null);
      return;
    }
    const measure = () => {
      const box = dock.current;
      const cmp = root.current;
      if (!box || !cmp) return;
      const r = box.getBoundingClientRect();
      const height = cmp.offsetHeight;
      const covered = Math.max(0, r.bottom - (kb.offsetTop + kb.visualHeight));
      const slabTop = cmp.querySelector<HTMLElement>(".cmp-slab")?.offsetTop ?? 0;
      const next = { left: r.left, width: r.width, dockHeight: height + covered, menuRoom: Math.round(kb.visualHeight - height + slabTop - 14) };
      setRide((p) => (p && Math.abs(p.left - next.left) < 1 && Math.abs(p.width - next.width) < 1 && Math.abs(p.dockHeight - next.dockHeight) < 1 && p.menuRoom === next.menuRoom ? p : next));
    };
    rideMeasure.current = measure;
    measure();
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    if (dock.current) ro.observe(dock.current);
    return () => {
      rideMeasure.current = null;
      ro.disconnect();
    };
  }, [riding, kb.offsetTop, kb.visualHeight, vp.width]);

  // Keep the draft: local state for the field, and the store's fields for everyone else (they go to the server): its
  // mode, chip and text, and whether it is a link's text.
  const commit = (next: Draft) => {
    setD(next);
    const key = draftKey(next);
    written.current = key;
    prefilled.current = false;
    DRAFTS.set(chat.id, { draft: next, stored: key });
    if (key !== storedKey) act.setDraft(chat.id, toInput(next));
  };

  // The server's draft changed (another page, Take back, a refused send, the draft on attach): show it in the field,
  // in its own mode. A link's pre-fill or text that the user has not changed stays, unless a message just came back
  // (Take back asks for it); a / menu link keeps the server's text aside, and closing the menu brings it back.
  useEffect(() => {
    if (storedKey === written.current) return;
    const untouchedLink = prefilled.current || (d.fromLink && draftKey(d) !== written.current);
    const next = fromStore(stored);
    if (untouchedLink && !leftLately(chat.id)) {
      // A mention link's token that the user has not changed goes after the server's draft as it is now: the draft
      // that comes after the field was built (a page load or a reload of the link) or another page's change. So the
      // box's own text shows, and a pick or a close keeps it. Nothing is saved: the box is still the server's draft.
      if (prefilled.current && pre?.mention !== undefined && mention?.link) {
        const fill = mentionFill(next, pre.mention);
        setD(fill.draft);
        DRAFTS.set(chat.id, { draft: fill.draft, stored: storedKey, pre: true });
        setMention(fill.mention);
        setMentionActive(0);
        if (document.activeElement === field.current) caretTo.current = fill.draft.text.length;
        return;
      }
      if (route.name === "slashMenu" && !d.command) stash.current = next.mode === "chat" && next.text.trim() ? next : null;
      return;
    }
    written.current = storedKey;
    prefilled.current = false;
    stash.current = null;
    setD(next);
    DRAFTS.set(chat.id, { draft: next, stored: storedKey });
    setMenuOpen(false);
    setMention(null);
    setSlash(null);
    // The field keeps the focus where it was (its value changes, never its element); a focused field gets the caret
    // at the end of the text it now holds.
    if (document.activeElement === field.current) caretTo.current = next.text.length;
    // Only a change of the server's draft decides; the field's own state is read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey, chat.id]);

  // A composer link was opened (address bar, Back or Forward): fill from it, in place of the unsent text. Row 80: not
  // while the chat is held; when the hold ends, a link that came meanwhile fills, and the one applied last (APPLIED,
  // which the hold leaves as it was) is not applied again.
  useLayoutEffect(() => {
    if (held) return;
    const was = APPLIED.get(chat.id);
    if (was === preKey) return;
    APPLIED.set(chat.id, preKey);
    if (!pre) {
      // Back (or a pick, or Esc) from a /c/<chat>/mention link: its picker closes with it, and a link's token that is
      // still open goes as on Esc.
      if (was?.startsWith("mention|")) {
        if (mention?.link) dropLink(mention);
        setMention(null);
      }
      return;
    }
    setSlash(null); // the link's fill is not typed text
    if (pre.mention !== undefined) {
      // A link's pre-fill that the user has not changed is not the box's text: the link's token goes after the
      // server's draft instead.
      const fill = mentionFill(prefilled.current ? fromStore(stored) : d, pre.mention);
      setD(fill.draft);
      DRAFTS.set(chat.id, { draft: fill.draft, stored: storedKey, pre: true });
      prefilled.current = true;
      setMention(fill.mention);
      setMentionActive(0);
    } else if (pre.draft) {
      if (route.name === "slashMenu" && d.mode === "chat" && d.text.trim()) stash.current = d;
      setD(pre.draft);
      DRAFTS.set(chat.id, { draft: pre.draft, stored: storedKey, pre: true });
      prefilled.current = true;
    }
    setMenuOpen(!!pre.menu);
    setActive(menuIndex(pre));
    // Only the pre-fill key and the hold decide; the rest of the route is read through them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preKey, isHeld]);

  // DESIGN.md 5.3: on a composer path focus goes to Send; the field never takes focus on a touch device, so the
  // keyboard stays down while the user reads. Opening a chat on a laptop focuses the field; so does the `@` picker's
  // link, whose field the user types the filter in. Row 80: a held field takes no focus by itself, and a hold that
  // begins or ends moves no focus (the link decides, not the hold).
  useEffect(() => {
    if (held) return;
    if (pre) {
      const id = requestAnimationFrame(() => {
        if (document.querySelector(".dialog")) return;
        if (pre.mention !== undefined) {
          if (!coarse) focusEnd(field.current);
        } else if (sendBtn.current && !sendBtn.current.disabled) sendBtn.current.focus({ preventScroll: true });
        else if (!coarse) focusEnd(field.current);
      });
      return () => cancelAnimationFrame(id);
    }
    if (route.name === "chat" && !coarse) focusEnd(field.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey]);
  // Row 80: a hold that comes while the user types on a touch device takes the keyboard down: the field takes no typing.
  useEffect(() => {
    if (held && coarse && document.activeElement === field.current) field.current?.blur();
    // Only the hold's start decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHeld]);

  const filtering = d.mode === "slash" && !d.command;
  const rows = useMemo(() => commandRows(filtering ? d.text : ""), [menu, filtering, d.text]);
  const menuVisible = d.mode === "slash" && menuOpen && !held;
  const message = outgoing(d);
  const missing = useMemo(() => unknownIds(uploadIds, uploads), [uploadIds, uploads]);
  const fetched = useMissingUploads(chat.id, missing);
  const chips = useMemo<ChipUpload[]>(() => chipsOf({ chatId: chat.id, ids: uploadIds, uploads, extra: fetched, putAside }), [chat.id, uploadIds, uploads, fetched, putAside]);
  // The mention chips come after the upload chips, as their references do at send (9.3).
  // A mention is relative to the chat's folder: its worktree's for a worktree chat (row 73).
  const chatFolder = useStore((s) => chatFolderIn(s, chat));
  const mentionChips = useMemo(() => mentionChipsOf(mentions, chatFolder), [mentions, chatFolder]);
  const uploading = waitsForUpload(chips);
  // The chip whose path shows: an upload by its id, a mention by MENTION_KEY and its path.
  const pathChip = pathOf ? chips.find((u) => u.id === pathOf && u.path) : undefined;
  const pathMention = pathOf?.startsWith(MENTION_KEY) ? mentionChips.find((m) => MENTION_KEY + m.path === pathOf) : undefined;
  const chipPath = pathChip?.path ?? (pathMention ? pathMention.abs ?? pathMention.path : undefined);
  // New chips come in at the end of the attachments box, which scrolls past two rows (one sideways row on the phone):
  // bring the end into view so the files just added show.
  const chipTotal = chips.length + mentionChips.length;
  const chipCount = useRef(chipTotal);
  useLayoutEffect(() => {
    const box = attachBox.current;
    if (box && chipTotal > chipCount.current) {
      box.scrollTop = box.scrollHeight;
      box.scrollLeft = box.scrollWidth;
    }
    chipCount.current = chipTotal;
  }, [chipTotal]);

  // The `@` picker's rows: the chat folder's files through the search engine (web/search), asked for when the picker
  // opens. The rows follow the deferred filter, so the field's echo never waits for them (L14); the server is asked for
  // the field's own filter at once, as the search pane asks (engine.ts, the hook contract).
  const mentionShown = mention !== null && d.mode === "chat" && !held;
  const { engine: fileEngine } = useFileEngine(mentionShown ? chat.id : null);
  const mentionFilter = useDeferredValue(mentionShown ? mention.filter : "");
  const fileRows = useFileRows(mentionShown ? fileEngine : null, mentionFilter, mentionShown ? mention.filter : "");
  const mentionRows = fileRows?.rows ?? NO_ROWS;
  const mentionAt = Math.min(mentionActive, Math.max(0, mentionRows.length - 1));
  // The rows shown answer the filter in the field: the server's newest answer, or the deferred list, may be for an
  // older one, and a pick must not add a file that does not match what the user typed. Before any list came there is
  // no row to pick, and Enter does nothing.
  const mentionCurrent = !fileRows || fileRows.q === mention?.filter;
  const waiting = useRef<MentionToken | null>(null); // an Enter or Tab that came before the rows for its filter
  // The `/` menu at a mid-line `/` (D57): the `/` menu's rows for its filter, in Chat mode and in a command's arguments,
  // never beside the start menu or the `@` picker. It shows only with a row: a filter that no command answers (a path
  // such as /etc/hosts, since no command name holds a `/`, or /zzz) leaves the keys to the field, so Enter sends. The
  // token stays open meanwhile, so Backspace back to a filter with rows shows the menu again.
  const slashOpen = slash !== null && slashField(d) && !menuVisible && !mentionShown && !held;
  const slashRows = useMemo(() => (slashOpen ? commandRows(slash.filter) : NO_COMMANDS), [menu, slashOpen, slash?.filter]);
  const slashShown = slashOpen && slashRows.length > 0;
  const slashAt = Math.min(slashActive, Math.max(0, slashRows.length - 1));
  // R124: a /btw draft is a side question (side/btw.ts); the box's file chips stay in the box. One over a side
  // question's cap (the box takes 20,000) is never asked: Send is off, and its line says so.
  const sideAsk = sideOn ? sideQuestionOf(d) : null;
  const sideOver = !!sideAsk?.question && questionTooLong(sideAsk.question);
  // A message may be files alone; a command needs its text.
  const canSend = !held && !uploading && !sideOver && (message !== "" || (d.mode === "chat" && ids.length > 0));
  // DESIGN.md 7.7 (G-3): touch shows no tooltip, so while only an upload holds Send, Send stays a key that a tap
  // reaches (aria-disabled, drawn off), and a tap shows the line that says why for 4 s.
  const uploadWait = !held && uploading && !sideOver;
  const [waitTaps, setWaitTaps] = useState(0);
  const [waitShown, setWaitShown] = useState(false);
  useEffect(() => {
    if (!waitTaps) return;
    setWaitShown(true);
    const t = setTimeout(() => setWaitShown(false), UPLOAD_WAIT_MS);
    return () => clearTimeout(t);
  }, [waitTaps]);
  const pressSend = () => (uploadWait ? setWaitTaps((n) => n + 1) : send());

  // ---- actions (each one inside a click, tap or key handler) ----
  const leaveRoute = () => {
    // Back to the chat when this page pushed the link's entry after it, so no repeated entry stays (5.5 step 3); a link
    // opened as a new document is replaced by the chat (closeTo never goes back to an earlier document).
    if (COMPOSER_ROUTES.has(route.name)) closeTo(chatUrl);
  };
  // Send or Run: the store sends the draft's `rev` and its upload chips with the message (D49, D50) and empties the
  // box at once, so the text is in one place (the transcript) and a second press has nothing to send; until the ack the
  // store keeps a copy that a reload puts back (7.5). A refused request gives the box's draft back as it was: a link's
  // text keeps its link mark and its warning line (5.1 rule 7). The chat text that + > Slash commands set aside comes
  // back as the box's draft; a refused / command takes its place again, and that text goes aside again.
  // `now` (row 111, Ctrl+Enter while a turn runs): Send now follows the message (act.send).
  // PT-5 (DESIGN-T1 T-22): /model and /effort with no argument send nothing; kitespan's own model menu opens.
  const send = (now = false) => {
    if (!canSend) return;
    if (sideAsk) return sendSide(sideAsk.question);
    const own = pickerCommand(d);
    if (own) return openPicker(own);
    const aside = stash.current;
    stash.current = null;
    const next = aside ?? EMPTY;
    const sent = d;
    // The failed chips go with the sent draft (the chat's Uploads list keeps them until Remove).
    const failed = chips.filter((u) => u.state === "failed");
    if (failed.length) {
      const gone = new Set([...putAside, ...failed.map((u) => u.id)]);
      PUT_ASIDE.set(chat.id, gone);
      setPutAside(gone);
    }
    written.current = draftKey(next);
    prefilled.current = false;
    DRAFTS.set(chat.id, { draft: next, stored: written.current });
    const done = d.mode === "bash" ? act.bash(chat.id, message, toInput(d)) : act.send(chat.id, message, toInput(d), now);
    // FIX-Q1: the reader goes on with the chat, so the conversation follows the end (chat/ownSend.ts).
    ownSend(chat.id, done);
    if (next !== EMPTY) act.setDraft(chat.id, toInput(next));
    flushDrafts();
    setD(next);
    setMenuOpen(false);
    setMention(null);
    setSlash(null);
    setPathOf(null);
    leaveRoute();
    if (aside)
      void done.then((ok) => {
        if (ok || !shown.current.mounted || draftKey(shown.current.d) !== draftKey(aside)) return;
        stash.current = aside;
        written.current = draftKey(sent);
        DRAFTS.set(chat.id, { draft: sent, stored: written.current });
        act.setDraft(chat.id, toInput(sent));
        setD(sent);
      });
  };
  // R124: a side question from the message box. The box empties as a send empties it (the chat text that + > Slash
  // commands set aside comes back), the question goes to the side chat (never to Claude Code), and the side chat opens
  // in place of a composer link's entry, else as a new one. A bare /btw only opens it. While a side question runs, the
  // text stays in the box and only the side chat opens (it shows the one that runs, with its Stop); a question over the
  // cap asks nothing. A busy ack (another page asked just before) gives the box its draft back as it was, as a refused
  // send does, or, when the box changed meanwhile, puts the question into the side box.
  const sendSide = (question: string) => {
    const openSide = () => {
      // U4: by the split side panel's opener rules (beside the view that shows, or in its Side chat half).
      if (!sideShown(route) && !kindShown(route, "side", splitLive())) navigate(openHref(route, sideHref(chat.id, view)), { replace: COMPOSER_ROUTES.has(route.name) || MENU_ROUTES.has(route.name) });
    };
    if (question && sideAsking) return openSide();
    if (question && questionTooLong(question)) return;
    const text = question ? questionText(question) : null;
    const aside = stash.current;
    stash.current = null;
    const sent = d;
    const next = aside ?? EMPTY;
    commit(next);
    flushDrafts();
    setMenuOpen(false);
    setMention(null);
    setSlash(null);
    setPathOf(null);
    if (text)
      void act.sideAsk(chat.id, text).then((end) => {
        if (end !== "busy") return;
        if (!shown.current.mounted || draftKey(shown.current.d) !== draftKey(next)) return sideBoxBack(chat.id, text);
        stash.current = aside;
        written.current = draftKey(sent);
        DRAFTS.set(chat.id, { draft: sent, stored: written.current });
        act.setDraft(chat.id, toInput(sent));
        setD(sent);
      });
    openSide();
  };
  // PT-5 (DESIGN-T1 T-22): the model menu, at its Effort section for /effort, in place of the command: the box takes
  // back the chat text that + > Slash commands set aside, or empties, and the menu's URL takes the / menu link's entry.
  const openPicker = (name: "model" | "effort") => {
    const aside = stash.current;
    stash.current = null;
    commit(aside ?? EMPTY);
    setMenuOpen(false);
    setMention(null);
    setSlash(null);
    navigate(href(name, { chat: chat.id }, { view }), { replace: POPUP_ROUTES.has(route.name) || COMPOSER_ROUTES.has(route.name) });
  };
  const stop = () => void act.stop(chat.id);
  // Row 78: Continue in a copy of the held session (D58's fork): the server opens the copy that the lists hold, or
  // makes one, and the page goes there; this chat and its draft stay as they are.
  const copyHeld = () => {
    if (!held || copying) return;
    setCopying(true);
    void act.continueSession(chat.projectId, held.session, true).then((id) => {
      setCopying(false);
      if (id) navigate(href("chat", { chat: id }));
    });
  };

  // Close the / menu: the chat text set aside by + > Slash commands comes back, and a / menu link closes to the chat.
  const closeMenu = (toChat = true) => {
    setMenuOpen(false);
    if (stash.current && !d.command) commit(stash.current);
    stash.current = null;
    if (toChat && MENU_ROUTES.has(route.name)) closeTo(chatUrl);
  };
  const pick = (i: number) => {
    const c = rows[i];
    if (!c) return;
    setMenuOpen(false);
    // T-22: /model and /effort open kitespan's own model menu, also where Claude Code marks them terminal-only; a
    // command chip that holds arguments keeps them for the picked command, as before.
    const own = d.command && d.text.trim() ? null : pickerOf(c.name);
    if (own) return openPicker(own);
    if (c.terminalOnly) {
      // DESIGN.md 6.4 and 6.10: a terminal-only command opens Open in terminal, the Terminal pane with the chat's
      // command typed (D38), as the title bar and the session menu do, on every size (D47), and the pane prints
      // "Then type /<command>." above it. The name rides in the history entry's state, never in the URL; the draft
      // stays empty and nothing is recorded.
      stash.current = null;
      commit(EMPTY);
      navigate(openInTerminalHref(chat.id, view), { replace: MENU_ROUTES.has(route.name), state: { thenType: c.name } });
      return;
    }
    const after = d.command ? d : stash.current;
    stash.current = null;
    commit({ mode: "slash", command: c.name, text: after?.text ?? "", fromLink: after?.fromLink ?? false });
    if (MENU_ROUTES.has(route.name)) closeTo(chatUrl);
    requestAnimationFrame(() => focusEnd(field.current));
  };
  // The / menu opened with no list from Claude Code yet: read it (a chat that started since has one).
  useEffect(() => {
    if ((menuVisible || slashOpen) && !commandsKnown) void act.load(chat.id, "commands");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuVisible, slashOpen]);

  // ---- the `/` menu at a mid-line `/` (D57) ----
  // Close it (Esc, a press outside, the keyboard going down, a popup): the text stays as it is.
  const closeSlash = () => setSlash(null);
  // It follows the field's text and caret: its token after a change, or a typed `/` that opens it.
  const followSlash = (t: SlashToken | null) => {
    if (t?.at !== slash?.at || t?.filter !== slash?.filter) setSlashActive(0);
    setSlash(t);
  };
  // A pick: `/<name> ` in place of `/<filter>`, the caret after the space. Plain text, also for a terminal-only row:
  // no chip, no mode change, nothing sent (Send sends the text as typed). The focus stays (a row's press keeps it).
  const pickSlash = (i: number) => {
    const c = slashRows[i];
    if (!c || !slash) return;
    const out = slashPick(d.text, slash, c.name);
    commit({ ...d, text: out.text });
    caretTo.current = out.caret;
    setSlash(null);
  };

  // ---- the `@` picker (9.3) ----
  // A link's token is the picker's filter only (5.2): a close with no pick takes it out again, with the space the link
  // put before it, so the box is as it was before the link. Untouched, the box is the server's draft as it is, and
  // nothing is saved; after the user typed in the filter, the box's text without the token is saved.
  const dropLink = (m: Mention) => {
    if (!m.link) return;
    if (prefilled.current) {
      const back = fromStore(stored);
      prefilled.current = false;
      written.current = storedKey;
      setD(back);
      DRAFTS.set(chat.id, { draft: back, stored: storedKey });
      if (document.activeElement === field.current) caretTo.current = back.text.length;
      return;
    }
    const out = withoutToken(d.text, m);
    commit({ ...d, text: out.text, fromLink: m.link.fromLink && out.text !== "" });
    caretTo.current = out.caret;
  };
  // Close it (Esc, a press outside, the keyboard going down, the `@` button); a /c/<chat>/mention link closes to the
  // chat. The text stays as it is, but for a link's token.
  const closeMention = (toChat = true) => {
    if (mention?.link) dropLink(mention);
    setMention(null);
    if (toChat && route.name === "mention") closeTo(chatUrl);
  };
  // A pick: the `@<filter>` text leaves the field, the caret goes where the `@` was, and the file's chip joins the
  // draft (one draft frame with the text change, 250 ms later). The focus stays where it is (a row's press keeps it).
  const pickMention = (i: number) => {
    const row = mentionRows[i];
    if (!row || !mention) return;
    const out = withoutToken(d.text, mention);
    // A link's `@<q>` leaves with the pick, so the rest is a link's text only if it was before the link.
    const link = (mention.link ? mention.link.fromLink : d.fromLink) && out.text !== "";
    act.addMention(chat.id, row.path);
    commit({ ...d, text: out.text, fromLink: link });
    caretTo.current = out.caret;
    setMention(null);
    if (route.name === "mention") closeTo(chatUrl);
  };
  // The `@` button (7.5, touch only): an `@` at the caret, or over the selection, opens the picker; with the keyboard
  // down the tap also focuses the field, inside the same tap.
  const openAt = () => {
    const el = field.current;
    const focused = !!el && document.activeElement === el;
    const start = focused ? el.selectionStart : d.text.length;
    const end = focused ? el.selectionEnd : d.text.length;
    const put = insertAt(d.text, start, end);
    commit(typed(d, put.text, false));
    caretTo.current = put.at + 1;
    setSlash(null);
    setMention({ at: put.at, filter: "" });
    setMentionActive(0);
    if (!focused) el?.focus({ preventScroll: true });
  };
  // A second press on `@` while the picker shows closes it, as its aria-expanded says and as + closes its menu.
  const closeAtPicker = () => closeMention();
  // An Enter or Tab that waited (mention.ts mentionKey "wait"): once the rows answer its filter, it picks the first
  // row; a change of the token drops it. The user's own key, so the pick is theirs.
  useEffect(() => {
    if (!waiting.current) return;
    const next = waitedPick(waiting.current, mentionShown ? mention : null, fileRows);
    if (next === "wait") return;
    waiting.current = null;
    if (next !== "drop") pickMention(next);
    // Only the rows and the token decide; the pick reads the rest of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileRows, mention, mentionShown]);
  const removeMentionChip = (path: string) => {
    if (pathOf === MENTION_KEY + path) setPathOf(null);
    act.removeMention(chat.id, path);
    if (!coarse) requestAnimationFrame(() => focusEnd(field.current));
  };

  const openPopup = (name: PopupName) => {
    onTrigger.current = false;
    if (menuVisible) closeMenu(false);
    if (mentionShown) closeMention(false);
    if (slashShown) closeSlash();
    // The model menu is one menu at either section, so the model button or Cmd+Shift+I closes it at Effort too.
    if (route.name === name || (name === "model" && route.name === "effort")) return closeTo(chatUrl);
    navigate(href(name, { chat: chat.id }, { view }), { replace: POPUP_ROUTES.has(route.name) || COMPOSER_ROUTES.has(route.name) });
  };
  // A press on another picker's button while a picker is open switches pickers, so the outside-press close of the
  // open one stands down (the press's own click navigates).
  const closePopup = useCallback(() => {
    if (onTrigger.current) return;
    closeTo(chatUrl);
  }, [chatUrl]);
  useLayoutEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      onTrigger.current = [plusBtn, modeBtn, modelBtn].some((r) => r.current?.contains(t));
    };
    const key = () => {
      onTrigger.current = false;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  // Give focus back to the button that opened a picker when it closes to the chat.
  const prevRoute = useRef(route.name);
  useEffect(() => {
    const was = prevRoute.current;
    prevRoute.current = route.name;
    if (was === route.name || !POPUP_ROUTES.has(was) || route.name !== "chat" || coarse) return;
    const btn = ({ add: plusBtn, model: modelBtn, effort: modelBtn, mode: modeBtn } as Record<string, typeof plusBtn>)[was];
    btn?.current?.focus({ preventScroll: true });
  }, [route.name, coarse]);

  // A value changes only once Claude Code confirms it (the `picks` event); until then the button says Switching...
  // A refused switch (its line shows) or no answer gives the button its value back.
  const switchTo = (f: Field, value: string) => {
    const now = f === "model" ? chat.model : f === "effort" ? chat.effort : chat.mode;
    if (value !== now) {
      markPicked(chat.id, f, value);
      setSwitching({ field: f, value });
      if (f === "model") act.setModel(chat.id, value);
      else if (f === "effort") act.setEffort(chat.id, value);
      else act.setMode(chat.id, value as ModeId);
    }
    closeTo(chatUrl);
  };
  const isSwitching = (f: Field) => !!switching && switching.field === f && (f === "model" ? chat.model : f === "effort" ? chat.effort : chat.mode) !== switching.value;
  useEffect(() => {
    if (!switching) return;
    const t = setTimeout(() => setSwitching(null), 10_000);
    return () => clearTimeout(t);
  }, [switching]);
  const noticeAtSwitch = useRef(storeNotice);
  useEffect(() => {
    if (switching && storeNotice && storeNotice !== noticeAtSwitch.current) setSwitching(null);
    noticeAtSwitch.current = storeNotice;
  }, [storeNotice, switching]);

  // Window keys (DESIGN.md 6.11): Cmd or Ctrl+Shift+M opens the mode menu, I the model menu and E the model menu at
  // its Effort section; Esc stops a running turn once no menu is open (an open menu, the / menu too, a pane over the
  // chat or a dialog is a layer: it takes Esc first, newest first, and the key does not get here). Row 80: while the
  // chat is held, the three keys open nothing; Esc still stops kitespan's own turn.
  const live = useRef({ canStop, menuVisible, popupOpen, held: isHeld, openPopup, pickMention, closeMention });
  live.current = { canStop, menuVisible, popupOpen, held: isHeld, openPopup, pickMention, closeMention };
  // The picker's callbacks keep their identity, so a render that changes none of its rows (a key, a streamed piece of
  // the chat) skips it (MentionMenu is memo).
  const onMentionPick = useCallback((i: number) => live.current.pickMention(i), []);
  const onMentionClose = useCallback(() => live.current.closeMention(), []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector(".dialog")) return;
      const k = live.current;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : "";
        const name: PopupName | null = letter === "m" ? "mode" : letter === "i" ? "model" : letter === "e" ? "effort" : null;
        if (name) {
          e.preventDefault();
          if (!k.held) k.openPopup(name);
        }
        return;
      }
      // Esc while an input method composes a word is the input method's (it cancels the word): the turn runs on.
      if (e.key === "Escape" && k.canStop && !k.menuVisible && !k.popupOpen && !isOtherField(e.target, field.current) && !imeKey(e)) {
        e.preventDefault();
        void act.stop(chat.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat.id]);

  // Close the / menu, or the `@` picker, on a press outside the composer.
  const closeMenuRef = useRef(closeMenu);
  closeMenuRef.current = closeMenu;
  const closeMentionRef = useRef(closeMention);
  closeMentionRef.current = closeMention;
  useEffect(() => {
    if (!menuVisible && !mentionShown && !slashShown) return;
    const down = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      if (menuVisible) closeMenuRef.current();
      else if (mentionShown) closeMentionRef.current();
      else setSlash(null);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [menuVisible, mentionShown, slashShown]);

  // ---- the field ----
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const before = (e: Event) => {
      replacingAll.current = el.value.length > 0 && el.selectionStart === 0 && el.selectionEnd === el.value.length;
      inputType.current = (e as InputEvent).inputType ?? null;
    };
    el.addEventListener("beforeinput", before);
    return () => el.removeEventListener("beforeinput", before);
  }, []);
  // The `@` picker follows the field's text and caret: its token after this change, or a typed `@` that opens it.
  const mentionAfter = (next: Draft, caret: number): Mention | null => {
    const token = nextToken(mention, d, next, caret, inputType.current);
    return token && { ...mention, ...token };
  };
  const followMention = (m: Mention | null) => {
    if (m?.at !== mention?.at || m?.filter !== mention?.filter) setMentionActive(0);
    setMention(m);
    if (!m && mention && route.name === "mention") closeTo(chatUrl);
  };
  // The caret moved (a tap, an arrow key, a click): the picker, or the mid-line `/` menu, closes once the caret is out
  // of its token. Row 80: a selection in a held field is a read; the hidden menus stay as they were.
  const onSelect = () => {
    if (held) return;
    const el = field.current;
    if (!el) return;
    const collapsed = el.selectionStart === el.selectionEnd;
    if (mention) {
      const token = collapsed ? tokenAt(el.value, mention.at, el.selectionStart) : null;
      if (token?.filter !== mention.filter) followMention(token && { ...mention, ...token });
    }
    if (slash) {
      const token = collapsed ? tokenAt(el.value, slash.at, el.selectionStart, "/") : null;
      if (token?.filter !== slash.filter) followSlash(token);
    }
  };
  const onChange = (value: string) => {
    // A "!" or "/" typed into an empty field picks the mode; any other change keeps the draft's own mode, so a message
    // that starts with "!" stays a message. Link text stays plain until it is sent or cleared (5.1 rule 7).
    let next = typed(d, value, replacingAll.current);
    replacingAll.current = false;
    // The caret stays where the "!" was typed.
    if (next.mode === "bash" && d.mode === "chat" && (field.current?.selectionStart ?? 0) <= 1) caretTo.current = 0;
    if (next.mode === "slash" && !next.command) {
      // A command name typed in full and followed by a space becomes the chip, as a pick from the menu does.
      const m = /^(\S+)\s([\s\S]*)$/.exec(next.text);
      const c = m ? findCommand(m[1]!) : undefined;
      if (m && c && !c.terminalOnly) next = { ...next, command: c.name, text: m[2]! };
    }
    if (next.mode === "slash" && !next.command) {
      setMenuOpen(!/\s/.test(next.text));
      if (next.text !== d.text || d.mode !== "slash") setActive(0);
    } else setMenuOpen(false);
    followMention(mentionAfter(next, field.current?.selectionStart ?? value.length));
    followSlash(nextSlash(slash, d, next, field.current?.selectionStart ?? value.length, inputType.current));
    inputType.current = null;
    commit(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Row 80: the held field's keys are the browser's own (select, copy, move): none takes a chip away, picks or sends.
    if (held) return;
    const el = e.currentTarget;
    // The one IME guard (composition.ts imeKey): an input method's keys are its own, by their marks with a fine
    // pointer, and on touch while the field shows marked text or ended it under 100 ms ago; the menus leave them alone
    // and Return waits.
    const ime = imeKey(e.nativeEvent, coarse);
    if (mentionShown) {
      // The `@` picker's keys (mention.ts): Enter never sends while it shows, also with no row.
      const n = mentionRows.length;
      const k = mentionKey({ key: e.key, shiftKey: e.shiftKey, ime }, n, mentionCurrent);
      if (k === "ime") return;
      if (k === "wait") {
        e.preventDefault();
        waiting.current = { at: mention.at, filter: mention.filter };
        return;
      }
      if (k === "down" || k === "up") {
        e.preventDefault();
        setMentionActive((i) => (Math.min(i, n - 1) + (k === "down" ? 1 : n - 1)) % n);
        return;
      }
      if (k === "pick" || k === "stop") {
        e.preventDefault();
        if (k === "pick") pickMention(mentionAt);
        return;
      }
    }
    if (slashShown) {
      // The mid-line `/` menu's keys are the `@` picker's: Enter never sends while it shows (it shows with rows only).
      const n = slashRows.length;
      const k = mentionKey({ key: e.key, shiftKey: e.shiftKey, ime }, n);
      if (k === "ime") return;
      if (k === "down" || k === "up") {
        e.preventDefault();
        setSlashActive((i) => (Math.min(i, n - 1) + (k === "down" ? 1 : n - 1)) % n);
        return;
      }
      if (k === "pick" || k === "stop") {
        e.preventDefault();
        if (k === "pick") pickSlash(slashAt);
        return;
      }
    }
    if (menuVisible && !ime) {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rows.length) {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      // Esc never gets here while the menu shows: the menu is a layer, so the layers' window listener closes it first.
      const pickKey = (e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey && !d.command);
      if (pickKey && rows.length) {
        e.preventDefault();
        pick(active);
        return;
      }
    }
    if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0) {
      // Backspace at the start of the field takes the chip away: a command chip first, then the mode chip.
      if (d.mode === "slash" && d.command) {
        e.preventDefault();
        commit({ ...d, command: null });
        setSlash(null);
        setMenuOpen(!/\s/.test(d.text));
        setActive(0);
        return;
      }
      if (d.mode !== "chat" && d.text === "") {
        e.preventDefault();
        const back = stash.current;
        stash.current = null;
        commit(back ?? EMPTY);
        setSlash(null);
        setMenuOpen(false);
        if (MENU_ROUTES.has(route.name)) closeTo(chatUrl);
        return;
      }
      if (d.mode === "bash") {
        // Backspace right after the "!" takes it away, as it was typed: the command turns back into a message.
        e.preventDefault();
        commit({ ...d, mode: "chat" });
        caretTo.current = 0;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // DESIGN.md 7.5: an input method that is composing a word takes its Return; dictation fires no composition
      // events, so on touch a dictated message sends.
      if (ime) return;
      const forced = e.metaKey || e.ctrlKey;
      // On touch the Return key setting decides; Cmd or Ctrl+Enter sends either way.
      if (coarse && settings.returnKey !== "send" && !forced) return;
      e.preventDefault();
      // Row 111: Ctrl+Enter (Cmd+Enter on macOS too) while a turn runs sends the draft and then Send now acts, or Send
      // now alone from an empty box (6.4); else it is Enter's send.
      const now = sendNowKey(e, { turn: chat.turn !== null, bash: d.mode === "bash", empty: message === "" && ids.length === 0 });
      if (now === "now") {
        act.sendNow(chat.id);
        return;
      }
      send(now === "send-now");
    }
  };

  // ---- files (D37, D50): each way in calls act.upload once, inside its own paste, change or click handler ----
  // Row 80: nothing uploads into a held chat, whichever way the files came (a picker opened before the hold began
  // still hands its files over when the user picks them).
  const attach = (files: FileFacts[]) => {
    if (held || !files.length) return;
    act.upload(chat.id, files);
    if (!coarse) requestAnimationFrame(() => focusEnd(field.current));
  };
  const removeChip = (u: Upload) => {
    if (pathOf === u.id) setPathOf(null);
    act.removeUpload(chat.id, u.id);
    if (!coarse) requestAnimationFrame(() => focusEnd(field.current));
  };
  // A paste anywhere in the composer, caught before the field sees it. Files or images upload (a nameless image is
  // named pasted.<subtype>); a paste that carries text goes into the field as typed (D29). Row 80: while held, nothing
  // uploads, and the read-only field takes no text.
  const onPasteCapture = (e: ClipboardEvent<HTMLDivElement>) => {
    if (held) return;
    const files = clipboardFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    attach(pastedFacts(filesFrom(files)));
  };
  // Add files or photos (the owner's iPhone bug, 2026-10-31): the + menu hides the moment the picker opens, without
  // waiting for its history step, because the phone's browser can drop history.back() while its own picker is up;
  // the sheet then stayed over the message box. When the files arrive or the picker is cancelled, a dropped step is
  // taken again, so the menu's entry still leaves no history behind (DESIGN.md 5.1 rule 4).
  const [picking, setPicking] = useState(false);
  const leaveAdd = () => {
    setPicking(false);
    if (/\/add$/.test(location.pathname)) closeTo(chatUrl);
  };
  useEffect(() => {
    if (!picking) return;
    const input = fileInput.current;
    const back = () => setTimeout(leaveAdd, 0);
    input?.addEventListener("cancel", back);
    window.addEventListener("focus", back);
    return () => {
      input?.removeEventListener("cancel", back);
      window.removeEventListener("focus", back);
    };
  });
  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = filesFrom(e.currentTarget.files);
    e.currentTarget.value = ""; // the same file can be picked again
    attach(files);
    leaveAdd();
  };

  // A mode change that rewrote the field puts the caret back where the user was typing; a taken draft puts it at the
  // end.
  useLayoutEffect(() => {
    const at = caretTo.current;
    caretTo.current = null;
    if (at !== null) field.current?.setSelectionRange(at, at);
  });

  // ---- what shows ----
  const modeName = isSwitching("mode") ? "Switching…" : modeLabel(chat.mode);
  const modelName = isSwitching("model") ? "Switching…" : modelLabel(chat.model, models, known);
  const effortName = isSwitching("effort") ? "Switching…" : effortLabel(chat.effort);
  const effortShown = isSwitching("effort") || showsEffort(chat.model, chat.effort);
  const cmd = d.command ? findCommand(d.command) : undefined;
  const reply = settings.bashReply === "always" ? true : settings.bashReply === "never" ? false : respondToBash;
  const replyLine = reply ? "Claude replies to the output." : "Claude reads the output and does not reply.";
  // Row 80: a held field takes no typing, so it invites none (the held line under the box says why).
  const placeholder = held
    ? ""
    : d.mode === "bash"
      ? "Shell command"
      : d.mode === "slash"
        ? d.command
          ? cmd?.args ?? ""
          : "Filter commands"
        : chat.items.length
          ? "Reply to Claude…"
          : `Ask Claude to work in ${project?.name ?? "this folder"}`;
  // The field grows to 8 lines on a laptop and 4 on the phone, then scrolls; 2 while a phone keyboard leaves under
  // 400 px of visual height (DESIGN.md 6.4 and 7.5). An empty field is as high as its placeholder, so a new
  // placeholder (the chat's first items, a project's name) measures it again.
  // Round C1 (stack.ts): on the phone the same read picks the box's form, before the paint. A draft that takes two
  // lines or more beside +, @ and the end key gets the box's whole width, and the keys keep one row under it, where
  // they were; one class on the root, so the element tree, the focus, the caret, the selection and the keyboard stay.
  // A new form goes on the root's class at once, so the height below is the new form's; React's render of the same
  // class follows, and this effect measures again in it (no switch then).
  // The box keeps its height while the field is measured (its height at auto, and rule 3's one-row form): for that
  // layout the chat above it would be taller, its scroll would be clamped, and the conversation would leave its end
  // by the lines the measure took away. So the root's height is pinned until the field has its new height.
  // A rotated phone keeps one row: rule 0 reads the one-row line's width (stack.ts).
  const [stackedState, setStacked] = useState(false);
  const stacked = phone && stackedState;
  const measured = useRef<string | null>(null); // the text of the last measure: a pass that changed it is an edit
  const maxLines = phone ? (riding && kb.visualHeight < 400 ? 2 : 4) : 8;
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const cmp = root.current;
    const pin = cmp ? cmp.style.height : "";
    if (cmp) cmp.style.height = `${cmp.getBoundingClientRect().height}px`;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 22;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const form =
      phone && cmp
        ? nextStacked(stackedState, {
            empty: d.text === "",
            hasBreak: d.text.includes("\n"),
            lines: rowsOf(el, pad, lh),
            rowEm: oneRowWidth(el) / parseFloat(cs.fontSize),
            narrower: () => oneRowNarrower(cmp, el, STACK_BAND_EM * parseFloat(cs.fontSize), pad, lh),
          })
        : false;
    if (cmp && phone && form !== stackedState) cmp.classList.toggle("is-stacked", form);
    const max = Math.round(lh * maxLines + pad);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    // A caret at the end of a draft past the cap stays in view: a change of form wraps the text again under it (a paste
    // that stacks the box). Only in a pass that changed the text or the form (stack.ts pinsEnd): a pass for a turn
    // that starts or ends, a hold or a rotation keeps the field's scroll, so a reader who scrolled up in the draft keeps
    // their place. A caret elsewhere, and a field with no focus (Bring back on touch), keep their scroll.
    const edited = form !== stackedState || d.text !== measured.current;
    measured.current = d.text;
    if (phone && pinsEnd({ edited, focused: document.activeElement === el, caretAtEnd: el.selectionStart === el.value.length, overCap: el.scrollHeight > max })) el.scrollTop = el.scrollHeight;
    if (cmp) cmp.style.height = pin;
    // Riding the keyboard, the dock takes the box's new height now, before the paint (the ride's measure, above).
    rideMeasure.current?.();
    if (form !== stackedState) setStacked(form);
    // The keys beside the field change its column: the @ button (a coarse pointer, Chat mode) and the held end key's
    // kinds (Stop, Continue in a copy, Send again, none), which differ in width.
  }, [d.text, d.mode, d.command, placeholder, maxLines, vp.width, vp.size, phone, coarse, stackedState, held?.kind, canStop, handing]);
  const notice = pre?.notAvailable ? NOT_OFFERED_LINE : undefined;
  // A link value that the picker cannot use (draft.ts prefillOf): 5.4's line, unless the route has its own line.
  const droppedLine = pre?.dropped && !linkNoticeLine(route) ? linkNoticeLine({ ...route, dropped: true }) : null;
  const menuId = `cmp-slash-${chat.id}`;
  const mentionId = `cmp-mention-${chat.id}`;
  const pathId = `cmp-path-${chat.id}`;
  // The phone shares one button: Stop while the field is empty (7.5). A draft that waits for an upload or holds a file
  // keeps Send, so a tap meant for Send never stops the turn.
  const stopShared = phone && canStop && message === "" && chipTotal === 0;
  const sendTestId = d.mode === "bash" ? "confirm-run" : route.name === "send" || route.name === "slash" ? "confirm-send" : "composer-send";
  // The upload folder now, or the line that says no upload can go anywhere yet (a Custom folder with no path).
  const upRoot = uploadRoot({ uploadFolder, customFolder }, chat.sessionId);

  const chev = phone ? null : <IconChevron size={12} className="cmp-chev" />;
  const modeButton = (
    <button
      ref={modeBtn}
      type="button"
      className={`chip cmp-pick${chat.mode === "bypassPermissions" ? " is-warn" : ""}`}
      disabled={isHeld}
      aria-haspopup="dialog"
      aria-expanded={modeOpen}
      aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
      aria-label={`Permission mode: ${modeName}`}
      title={`Permission mode (${shortcut("M")})`}
      onClick={() => openPopup("mode")}
    >
      <IconShield size={14} />
      <span className="cmp-btn-label">{modeName}</span>
      {chev}
    </button>
  );
  // DESIGN.md 6.4, 6.6 and 7.5: one model button for the model and its effort, as Desktop puts effort in the model
  // picker. Cmd+Shift+I opens the menu at its models, and Cmd+Shift+E and /effort open it at its Effort section.
  const modelButton = (
    <button
      ref={modelBtn}
      type="button"
      className="chip cmp-pick cmp-model"
      disabled={isHeld}
      aria-haspopup="dialog"
      aria-expanded={modelOpen}
      aria-keyshortcuts="Meta+Shift+I Control+Shift+I Meta+Shift+E Control+Shift+E"
      aria-label={`Model: ${modelName}, effort: ${effortName}`}
      title={`Model (${shortcut("I")}) and effort (${shortcut("E")})`}
      onClick={() => openPopup("model")}
    >
      <span className="cmp-btn-label">{modelName}</span>
      {effortShown ? (
        <span className="cmp-effort">
          <EffortBars level={effortLevel(chat.effort)} />
          <span className="cmp-btn-label">{effortName}</span>
        </span>
      ) : null}
      {chev}
    </button>
  );
  const plusButton = (
    <button
      ref={plusBtn}
      type="button"
      className="icon-btn cmp-plus-btn"
      data-testid="composer-plus"
      disabled={isHeld}
      aria-haspopup="dialog"
      aria-expanded={addOpen}
      aria-label="Add to this chat"
      title="Add to this chat"
      onPointerDown={() => {
        plusFolded.current = phone && riding;
      }}
      onClick={(e) => {
        if (e.detail === 0) plusFolded.current = phone && riding; // a key press, not a tap
        openPopup("add");
      }}
    >
      <IconPlus size={phone ? 20 : 18} />
    </button>
  );
  const keepFocus = (e: React.PointerEvent) => e.preventDefault(); // a tap on Send keeps the keyboard up (7.5)
  // The `@` button (7.5, 9.3): on touch only, beside +, because `@` is not on the first page of a phone's keyboard; in
  // Chat mode only, where `@` opens the picker. Off while held (row 80).
  const atButton = coarse && d.mode === "chat" ? <AtButton open={mentionShown} off={isHeld} onOpen={openAt} onClose={closeAtPicker} /> : null;
  // A press on the slab's own room (its padding, around the field, beside the bar's buttons) puts the caret in the
  // field, as in Desktop's prompt box, so the whole slab is the field's target on touch (7.3, 7.4). The press keeps
  // the focus where it is; the click focuses the field only when it is not focused yet, so a selection stays.
  const onSlabDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 0 && slabRoom(e)) e.preventDefault();
  };
  const onSlabClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (slabRoom(e) && document.activeElement !== field.current) focusEnd(field.current);
  };
  const stopButton = (
    <button type="button" className="cmp-key cmp-stop" data-testid="composer-stop" aria-label="Stop" title="Stop (Esc)" onPointerDown={keepFocus} onClick={stop}>
      <IconStop size={phone ? 22 : 18} />
    </button>
  );
  const sendButton =
    d.mode === "bash" ? (
      <button ref={sendBtn} type="button" className="cmp-key cmp-send cmp-run" data-testid={sendTestId} disabled={!canSend && !uploadWait} aria-disabled={uploadWait ? "true" : undefined} title={uploading ? UPLOAD_WAIT : running ? `Run (Enter). ${QUEUED_LINE}` : "Run (Enter)"} onPointerDown={keepFocus} onClick={pressSend}>
        <IconTerminal size={16} />
        <span>Run</span>
      </button>
    ) : (
      <button ref={sendBtn} type="button" className="cmp-key cmp-send" data-testid={sendTestId} disabled={!canSend && !uploadWait} aria-disabled={uploadWait ? "true" : undefined} aria-label="Send" title={uploading ? UPLOAD_WAIT : running ? "Send (Enter). Claude reads it after its current step." : "Send (Enter)"} onPointerDown={keepFocus} onClick={pressSend}>
        <IconSend size={phone ? 20 : 18} />
      </button>
    );

  // S16: a session handed to the terminal offers Send again (it ends the hold) where D58's hold offers the copy, once
  // its Claude Code ended. R16: a chat that kitespan's own orphan holds offers Stop alone (canStop), which ends that
  // process.
  const copyButton =
    held?.kind === "finishing" || handing ? null : held?.kind === "handed" ? (
      <HeldSendAgain busy={againOut} onPress={() => act.sendQueued(chat.id)} />
    ) : (
      <HeldCopy busy={copying} onCopy={copyHeld} />
    );

  const chip =
    d.mode === "bash" ? (
      <span className="cmp-chip is-bash" aria-hidden="true" title={`Bash mode. ${replyLine}`}>
        !{reply ? null : <span className="cmp-chip-word">No reply</span>}
      </span>
    ) : d.mode === "slash" ? (
      <span className="cmp-chip is-slash" aria-hidden="true" title={d.command ? `/${d.command}` : undefined}>
        <span className="cmp-chip-name">/{d.command ?? ""}</span>
      </span>
    ) : null;

  const slashMaxHeight = ride ? Math.max(132, Math.min(340, ride.menuRoom)) : undefined;

  const rideStyle = ride ? { left: ride.left, width: ride.width, height: kb.visualHeight, transform: `translateY(${kb.offsetTop}px)` } : undefined;
  return (
    <div ref={dock} className="cmp-dock" style={ride ? { height: ride.dockHeight } : undefined}>
      <div className={`cmp-ride${ride ? " is-riding" : ""}`} style={rideStyle}>
        <div
          ref={root}
          className={`cmp${phone ? " is-phone" : ""}${stacked ? " is-stacked" : ""}${riding ? " is-kb" : ""}${held ? " is-held" : ""}`}
          data-testid="composer"
          data-mode={d.mode}
          data-kb-owner=""
          onPasteCapture={onPasteCapture}
        >
          {phone ? (
            <div className="cmp-picks" role="group" aria-label="Chat settings">
              {modeButton}
              {modelButton}
            </div>
          ) : null}
          <div className="cmp-slab" onMouseDown={onSlabDown} onClick={onSlabClick}>
            {menuVisible ? (
              <SlashMenu id={menuId} rows={rows} active={active} filter={filtering ? d.text : ""} notice={notice} maxHeight={slashMaxHeight} onPick={pick} onHover={setActive} onClose={() => closeMenu()} />
            ) : null}
            {mentionShown ? (
              <MentionMenu id={mentionId} rows={fileRows} active={mentionAt} maxHeight={slashMaxHeight} onPick={onMentionPick} onHover={setMentionActive} onClose={onMentionClose} />
            ) : null}
            {slashShown ? (
              <SlashMenu id={menuId} rows={slashRows} active={slashAt} filter={slash.filter} inText maxHeight={slashMaxHeight} onPick={pickSlash} onHover={setSlashActive} onClose={closeSlash} />
            ) : null}
            {chipTotal ? (
              <div ref={attachBox} className="cmp-attach" role="group" aria-label="Attachments" data-testid="composer-attachments">
                {chips.map((u) => (
                  <DraftChip key={u.id} upload={u} open={pathOf === u.id} pathId={pathId} onToggle={() => setPathOf((p) => (p === u.id ? null : u.id))} onRemove={() => removeChip(u)} off={isHeld} />
                ))}
                {mentionChips.map((m) => {
                  const key = MENTION_KEY + m.path;
                  return <MentionChip key={key} mention={m} open={pathOf === key} pathId={pathId} onToggle={() => setPathOf((p) => (p === key ? null : key))} onRemove={() => removeMentionChip(m.path)} off={isHeld} />;
                })}
              </div>
            ) : null}
            {chipPath ? (
              <p className="cmp-chip-path" id={pathId} data-testid="composer-chip-path">
                {chipPath}
              </p>
            ) : null}
            <div className="cmp-field">
              {phone ? plusButton : null}
              {phone ? atButton : null}
              <div className="cmp-line">
                {chip}
                <textarea
                  ref={field}
                  className="cmp-input"
                  data-testid="composer-input"
                  dir="auto"
                  rows={1}
                  readOnly={isHeld}
                  value={d.text}
                  placeholder={placeholder}
                  aria-label={d.mode === "bash" ? `Shell command (Bash mode). ${replyLine}` : d.mode === "slash" ? (d.command ? `Arguments for /${d.command}` : "Command") : "Message Claude"}
                  aria-controls={menuVisible || slashShown ? menuId : mentionShown ? mentionId : undefined}
                  aria-activedescendant={menuVisible && rows.length ? `${menuId}-${active}` : mentionShown && mentionRows.length ? `${mentionId}-${mentionAt}` : slashShown && slashRows.length ? `${menuId}-${slashAt}` : undefined}
                  enterKeyHint={coarse && settings.returnKey === "newline" ? "enter" : "send"}
                  autoCapitalize={d.mode === "chat" ? "sentences" : "off"}
                  autoCorrect={d.mode === "bash" ? "off" : "on"}
                  spellCheck={d.mode !== "bash"}
                  autoComplete="off"
                  onChange={(e) => onChange(e.target.value)}
                  onSelect={onSelect}
                  onKeyDown={onKeyDown}
                  onCompositionStart={() => act.setComposing(chat.id, true)}
                  onCompositionEnd={() => act.setComposing(chat.id, false)}
                  onBlur={() => {
                    act.setComposing(chat.id, false);
                    flushDrafts(); // a draft is saved at once on blur (7.5)
                  }}
                />
              </div>
              {phone ? (held ? (canStop ? stopButton : copyButton) : stopShared ? stopButton : sendButton) : null}
            </div>
            {phone ? null : (
              <div className="cmp-bar">
                {plusButton}
                {atButton}
                {modeButton}
                <div className="cmp-bar-end">
                  <ContextRing chat={chat} view={view} open={route.name === "context"} named={vp.touch} to={openHref(route, href("context", { chat: chat.id }, { view }), splitHere)} />
                  {modelButton}
                  {/* The keys in Send's place are one unit, which takes a line of its own at the end when the bar's
                      end is short (G-25: beside a docked pane at 626 and 768). */}
                  <span className="cmp-keys">
                    {canStop ? stopButton : null}
                    {held ? copyButton : sendButton}
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="cmp-lines">
            {held ? <HeldLine app={held.app} kind={held.kind} live={handing} /> : null}
            {uploadWait && waitShown ? (
              <p className="cmp-line" data-testid="composer-upload-wait" role="status">
                {UPLOAD_WAIT}
              </p>
            ) : null}
            {pre?.overCap ? (
              <p className="cmp-line is-warn" data-testid="link-notice" role="status">
                {OVER_CAP_LINE}
              </p>
            ) : null}
            {droppedLine ? (
              <p className="cmp-line is-warn" data-testid="link-notice" role="status">
                {droppedLine}
              </p>
            ) : null}
            {sideOver && !held ? (
              <p className="cmp-line is-warn" data-testid="side-too-long" role="status">
                {BTW_TOO_LONG}
              </p>
            ) : null}
            <ExternalLinkLine text={!held && d.fromLink ? d.text : ""} />
          </div>
          <input ref={fileInput} type="file" multiple className="cmp-file" tabIndex={-1} aria-hidden="true" data-testid="composer-file-input" onChange={onPickFiles} />
          <PlusMenu
            open={addOpen && !picking}
            anchor={plusBtn}
            onClose={closePopup}
            sheet={sheet}
            pickers={phone && plusFolded.current}
            connectors={connectorsOf(chat) ?? NO_CONNECTORS}
            plugins={chat.init ? chat.init.plugins : null}
            refused={upRoot.refused}
            uploads={uploads.length > 0}
            modeName={modeLabel(chat.mode)}
            modelName={showsEffort(chat.model, chat.effort) ? `${modelLabel(chat.model, models, known)}, ${effortLabel(chat.effort)} effort` : modelLabel(chat.model, models, known)}
            onAttach={() => {
              // The picker opens inside this click (a browser opens it only from a user's own click or tap); its
              // change event uploads. The input stays in the composer while the menu closes.
              fileInput.current?.click();
              setPicking(true);
              closeTo(chatUrl);
            }}
            onUploads={() => navigate(href("uploads", { chat: chat.id }, { view }), { replace: true })}
            onSlash={() => {
              focusEnd(field.current);
              navigate(href("slashMenu", { chat: chat.id }, { view }), { replace: true });
            }}
            onConnectors={() => navigate(href("connectors", { chat: chat.id }, { view }), { replace: true })}
            onPermission={() => navigate(href("mode", { chat: chat.id }, { view }), { replace: true })}
            onModel={() => navigate(href("model", { chat: chat.id }, { view }), { replace: true })}
            // T-4: the phone's one key is Send while the box holds a draft (7.5), so Stop is also the + sheet's first
            // row while a turn runs, by the thumb; it opens the Stop confirm, as the session menu's Stop does.
            onStop={phone && canStop ? () => navigate(href("stop", { chat: chat.id }, { view }), { replace: true }) : undefined}
          />
          <ModelPicker
            open={modelOpen}
            at={route.name === "effort" ? "effort" : "model"}
            pick={typeof route.query.pick === "string" ? route.query.pick : undefined}
            anchor={modelBtn}
            sheet={sheet}
            chat={chat}
            project={project}
            rows={models}
            known={known}
            onClose={closePopup}
            onModel={(id) => switchTo("model", id)}
            onEffort={(id) => switchTo("effort", id)}
            onForget={() => act.forgetPicks(chat.projectId)}
          />
          <ModePicker
            open={modeOpen}
            pick={typeof route.query.pick === "string" ? route.query.pick : undefined}
            anchor={modeBtn}
            sheet={sheet}
            chat={chat}
            project={project}
            rows={models}
            allowBypass={settings.allowBypass}
            onClose={closePopup}
            onMode={(id) => switchTo("mode", id)}
            onForget={() => act.forgetPicks(chat.projectId)}
          />
        </div>
      </div>
    </div>
  );
}
