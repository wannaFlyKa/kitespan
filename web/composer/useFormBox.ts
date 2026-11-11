// The new-chat form's box with a chat's composer rules (D59, DECISIONS-OWNER row 75; DESIGN.md 6.4, 6.9, 7.5): the
// same / menu, mid-line / menu and `@` picker, on the same token rules (mention.ts, slashToken.ts) and the same keys,
// with the one IME guard (composition.ts imeKey), drawn by the same SlashMenu and MentionMenu. The form keeps its
// own draft (screens/NewChatForm.tsx, on this device until Start); this hook holds the menus' state and the field's
// handlers. The composer (Composer.tsx) keeps its own copy of these rules, which its links and its server draft weave
// through; the order of the keys is the same (test/web/form-box.test.ts reads both).
//
// - "/" typed into the empty field picks the / mode: the / menu over the project's commands filters while the user
//   types, and a pick (Enter, Tab, a click or tap) is the command chip; a command name typed in full and a space is the
//   chip too. A terminal-only command is left out: before a chat exists there is no Terminal pane to open it in.
//   Backspace at the field's start takes the chip away, then the / mode.
// - "/" typed at a word start mid-line, or in the chip's arguments, opens the same rows (terminal-only ones too) while
//   a row answers its filter; a pick puts "/<name> " in the text (D57).
// - "@" typed at a word start in Chat mode, or the `@` button on touch, opens the picker over the project's folder (the
//   project corpus routes); a pick takes "@<filter>" out of the field and adds the file's mention chip (onMention).
//   An Enter that comes before the rows for its filter waits for them.
// - While a menu shows, Enter never starts the chat; otherwise Enter starts it, on touch as Settings > General's Return
//   key says (Cmd or Ctrl+Enter starts it either way), never while an input method composes a word (on touch, while
//   the field shows marked text; dictation still starts it).
// - Esc closes a menu (each is a layer); a press outside the box closes it; the on-screen keyboard going down closes
//   the picker and the mid-line menu, as in a chat, and the app's root releases the field (keyboard.ts).
// - The box is near the top of the page, so the menus open under it when it leaves room (formBox.ts menuSide).
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useFileRows, useProjectFileEngine } from "../search/useSearch";
import type { FileRow, FileRows } from "../search/engine";
import { EMPTY, commandRows, findCommand, type Draft, type MenuRow } from "./draft";
import { formStartRows, formTyped, menuSide } from "./formBox";
import { imeKey } from "./composition";
import { useSoftKeyboard } from "./keyboard";
import { insertAt, mentionKey, nextToken, tokenAt, waitedPick, withoutToken, type MentionToken } from "./mention";
import { nextSlash, slashField, slashPick, type SlashToken } from "./slashToken";

const NO_ROWS: readonly FileRow[] = Object.freeze([]);
const NO_COMMANDS: MenuRow[] = [];

export interface FormBoxOptions {
  /** The box's draft: Chat mode, or the / mode with its chip. */
  d: Draft;
  /** Keep the box's next draft. */
  setDraft: (next: Draft) => void;
  /** The project's `/` menu rows. */
  rows: MenuRow[];
  /** The project whose folder the `@` picker lists. */
  project: string | null;
  coarse: boolean;
  returnKey: "send" | "newline";
  field: RefObject<HTMLTextAreaElement | null>;
  /** The box: a press outside it closes the menus, and they open beside it. */
  box: RefObject<HTMLElement | null>;
  /** A file picked in the `@` picker: its mention chip. */
  onMention: (path: string) => void;
  /** Enter with no menu showing. */
  onStart: () => void;
  /** A menu opened while the project has no command rows yet: read them again. */
  onRowsWanted: () => void;
}

export interface FormBox {
  onChange: (value: string) => void;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The start menu ("/" in the empty field). */
  menuVisible: boolean;
  menuRows: MenuRow[];
  menuFilter: string;
  active: number;
  setActive: (i: number) => void;
  pick: (i: number) => void;
  closeMenu: () => void;
  /** The `@` picker. */
  mentionShown: boolean;
  fileRows: FileRows | null;
  mentionAt: number;
  setMentionActive: (i: number) => void;
  pickMention: (i: number) => void;
  closeMention: () => void;
  /** The `@` button (touch): an `@` at the caret opens the picker; a second press closes it. */
  openAt: () => void;
  /** The mid-line `/` menu. */
  slashShown: boolean;
  slashRows: MenuRow[];
  slashFilter: string;
  slashAt: number;
  setSlashActive: (i: number) => void;
  pickSlash: (i: number) => void;
  closeSlash: () => void;
  /** Where the menus open: under the box, or over it; and their height. */
  side: { below: boolean; maxHeight: number };
  /** The field's aria-controls and aria-activedescendant for the menu that shows. */
  aria: (ids: { menu: string; mention: string }) => { controls?: string; activedescendant?: string };
}

export function useFormBox(o: FormBoxOptions): FormBox {
  const { d, setDraft, rows, project, coarse, returnKey, field, box, onMention, onStart, onRowsWanted } = o;
  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [mention, setMention] = useState<MentionToken | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const [slash, setSlash] = useState<SlashToken | null>(null);
  const [slashActive, setSlashActive] = useState(0);
  const replacingAll = useRef(false); // the next input replaces the whole text (select all, then type or paste)
  const inputType = useRef<string | null>(null); // the next input's InputEvent.inputType: a typed `@` or `/` opens a menu
  const caretTo = useRef<number | null>(null); // where the caret goes after a pick
  const waiting = useRef<MentionToken | null>(null); // an Enter or Tab that came before the rows for its filter

  // ---- what shows ----
  const filtering = d.mode === "slash" && !d.command;
  const menuVisible = d.mode === "slash" && menuOpen;
  const startRows = useMemo(() => formStartRows(rows), [rows]);
  const menuRows = useMemo(() => commandRows(filtering ? d.text : "", true, startRows), [startRows, filtering, d.text]);
  const mentionShown = mention !== null && d.mode === "chat";
  const { engine } = useProjectFileEngine(mentionShown ? project : null);
  const mentionFilter = useDeferredValue(mentionShown ? mention.filter : "");
  const fileRows = useFileRows(mentionShown ? engine : null, mentionFilter, mentionShown ? mention.filter : "");
  const mentionRows = fileRows?.rows ?? NO_ROWS;
  const mentionAt = Math.min(mentionActive, Math.max(0, mentionRows.length - 1));
  const mentionCurrent = !fileRows || fileRows.q === mention?.filter;
  const slashOpen = slash !== null && slashField(d) && !menuVisible && !mentionShown;
  const slashRows = useMemo(() => (slashOpen ? commandRows(slash.filter, false, rows) : NO_COMMANDS), [rows, slashOpen, slash?.filter]);
  const slashShown = slashOpen && slashRows.length > 0;
  const slashAt = Math.min(slashActive, Math.max(0, slashRows.length - 1));
  const anyShown = menuVisible || mentionShown || slashShown;

  // A menu opened with no rows from the server yet: read them again (a read; the store shares one in flight).
  useEffect(() => {
    if ((menuVisible || slashOpen) && rows.length === 0) onRowsWanted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuVisible, slashOpen]);

  // ---- the start menu ----
  const closeMenu = () => setMenuOpen(false);
  const focusEnd = () => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  };
  const pick = (i: number) => {
    const c = menuRows[i];
    if (!c) return;
    setMenuOpen(false);
    setDraft({ mode: "slash", command: c.name, text: "", fromLink: false });
    requestAnimationFrame(focusEnd);
  };

  // ---- the mid-line `/` menu (D57) ----
  const closeSlash = () => setSlash(null);
  const followSlash = (t: SlashToken | null) => {
    if (t?.at !== slash?.at || t?.filter !== slash?.filter) setSlashActive(0);
    setSlash(t);
  };
  const pickSlash = (i: number) => {
    const c = slashRows[i];
    if (!c || !slash) return;
    const out = slashPick(d.text, slash, c.name);
    setDraft({ ...d, text: out.text });
    caretTo.current = out.caret;
    setSlash(null);
  };

  // ---- the `@` picker ----
  const closeMention = () => setMention(null);
  const followMention = (m: MentionToken | null) => {
    if (m?.at !== mention?.at || m?.filter !== mention?.filter) setMentionActive(0);
    setMention(m);
  };
  const pickMention = (i: number) => {
    const row = mentionRows[i];
    if (!row || !mention) return;
    const out = withoutToken(d.text, mention);
    onMention(row.path);
    setDraft({ ...d, text: out.text, fromLink: d.fromLink && out.text !== "" });
    caretTo.current = out.caret;
    setMention(null);
  };
  const openAt = () => {
    if (mentionShown) return closeMention();
    const el = field.current;
    const focused = !!el && document.activeElement === el;
    const start = focused ? el.selectionStart : d.text.length;
    const end = focused ? el.selectionEnd : d.text.length;
    const put = insertAt(d.text, start, end);
    setDraft(formTyped(d, put.text, false));
    caretTo.current = put.at + 1;
    setSlash(null);
    setMention({ at: put.at, filter: "" });
    setMentionActive(0);
    if (!focused) el?.focus({ preventScroll: true });
  };
  // An Enter or Tab that waited: once the rows answer its filter, it picks the first row; a change of the token drops it.
  useEffect(() => {
    if (!waiting.current) return;
    const next = waitedPick(waiting.current, mentionShown ? mention : null, fileRows);
    if (next === "wait") return;
    waiting.current = null;
    if (next !== "drop") pickMention(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileRows, mention, mentionShown]);

  // A press outside the box closes the menu that shows; the text stays.
  const live = useRef({ menuVisible, mentionShown, slashShown });
  live.current = { menuVisible, mentionShown, slashShown };
  useEffect(() => {
    if (!anyShown) return;
    const down = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      const k = live.current;
      if (k.menuVisible) setMenuOpen(false);
      else if (k.mentionShown) setMention(null);
      else setSlash(null);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [anyShown, box]);
  // The picker and the mid-line menu go with the on-screen keyboard (7.2), as in a chat.
  useSoftKeyboard(coarse, () => {
    setMention(null);
    setSlash(null);
  });

  // ---- where the menus open ----
  const [side, setSide] = useState<{ below: boolean; maxHeight: number }>({ below: true, maxHeight: 340 });
  useLayoutEffect(() => {
    if (!anyShown) return;
    const vv = window.visualViewport;
    const measure = () => {
      const el = box.current;
      if (!el) return;
      const bar = document.querySelector<HTMLElement>('[data-testid="topbar"]');
      const barBottom = bar && bar.getClientRects().length ? bar.getBoundingClientRect().bottom : 0;
      const top = Math.max(barBottom, vv?.offsetTop ?? 0);
      const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const next = menuSide(el.getBoundingClientRect(), { top, bottom });
      setSide((p) => (p.below === next.below && p.maxHeight === next.maxHeight ? p : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      ro.disconnect();
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anyShown, box]);

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
  }, [field]);
  useLayoutEffect(() => {
    const at = caretTo.current;
    caretTo.current = null;
    if (at !== null) field.current?.setSelectionRange(at, at);
  });

  // The caret moved: a menu closes once the caret is out of its token.
  const onSelect = () => {
    const el = field.current;
    if (!el) return;
    const collapsed = el.selectionStart === el.selectionEnd;
    if (mention) {
      const token = collapsed ? tokenAt(el.value, mention.at, el.selectionStart) : null;
      if (token?.filter !== mention.filter) followMention(token);
    }
    if (slash) {
      const token = collapsed ? tokenAt(el.value, slash.at, el.selectionStart, "/") : null;
      if (token?.filter !== slash.filter) followSlash(token);
    }
  };
  const onChange = (value: string) => {
    // A "/" typed into an empty field picks the / mode (a "!" is text: formTyped); a link's text stays plain.
    let next = formTyped(d, value, replacingAll.current);
    replacingAll.current = false;
    if (next.mode === "slash" && !next.command) {
      // A command name typed in full and followed by a space becomes the chip, as a pick from the menu does.
      const m = /^(\S+)\s([\s\S]*)$/.exec(next.text);
      const c = m ? findCommand(m[1]!, rows) : undefined;
      if (m && c && !c.terminalOnly) next = { ...next, command: c.name, text: m[2]! };
    }
    if (next.mode === "slash" && !next.command) {
      setMenuOpen(!/\s/.test(next.text));
      if (next.text !== d.text || d.mode !== "slash") setActive(0);
    } else setMenuOpen(false);
    const caret = field.current?.selectionStart ?? value.length;
    followMention(nextToken(mention, d, next, caret, inputType.current));
    followSlash(nextSlash(slash, d, next, caret, inputType.current));
    inputType.current = null;
    setDraft(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    // The one IME guard (composition.ts imeKey), as the composer's: an input method's keys are its own; the menus
    // leave them alone and Return waits.
    const ime = imeKey(e.nativeEvent, coarse);
    if (mentionShown) {
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
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && menuRows.length) {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : menuRows.length - 1)) % menuRows.length);
        return;
      }
      // Esc never gets here while the menu shows: the menu is a layer, so the layers' window listener closes it first.
      const pickKey = (e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey && !d.command);
      if (pickKey && menuRows.length) {
        e.preventDefault();
        pick(active);
        return;
      }
    }
    if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0) {
      // Backspace at the start of the field takes the chip away: the command chip first, then the / mode.
      if (d.mode === "slash" && d.command) {
        e.preventDefault();
        setDraft({ ...d, command: null });
        setSlash(null);
        setMenuOpen(!/\s/.test(d.text));
        setActive(0);
        return;
      }
      if (d.mode !== "chat" && d.text === "") {
        e.preventDefault();
        setDraft(EMPTY);
        setSlash(null);
        setMenuOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // DESIGN.md 7.5: an input method that is composing a word takes its Return; dictation fires no composition
      // events, so on touch a dictated message starts the chat.
      if (ime) return;
      const forced = e.metaKey || e.ctrlKey;
      if (coarse && returnKey !== "send" && !forced) return;
      e.preventDefault();
      onStart();
    }
  };
  // ---- the end of the keys ----

  const aria = (ids: { menu: string; mention: string }) => ({
    controls: menuVisible || slashShown ? ids.menu : mentionShown ? ids.mention : undefined,
    activedescendant:
      menuVisible && menuRows.length ? `${ids.menu}-${active}` : mentionShown && mentionRows.length ? `${ids.mention}-${mentionAt}` : slashShown && slashRows.length ? `${ids.menu}-${slashAt}` : undefined,
  });

  return {
    onChange,
    onSelect,
    onKeyDown,
    menuVisible,
    menuRows,
    menuFilter: filtering ? d.text : "",
    active,
    setActive,
    pick,
    closeMenu,
    mentionShown,
    fileRows,
    mentionAt,
    setMentionActive,
    pickMention,
    closeMention,
    openAt,
    slashShown,
    slashRows,
    slashFilter: slash?.filter ?? "",
    slashAt,
    setSlashActive,
    pickSlash,
    closeSlash,
    side,
    aria,
  };
}
