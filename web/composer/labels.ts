// The words on the composer's picker buttons and rows (DESIGN.md 6.6 and 6.12). The model rows are the chat's own
// (`get models`, store.ts modelRows); each function takes them, with the catalog's list as the default. Before Claude
// Code reports its rows, the model button says "Model", never a guessed value; the effort shows the user's pick, or
// "Default" while the user picked none (6.6).
import { EFFORTS, MODELS, MODES } from "../state/catalog";
import type { ModelRow } from "../state/types";

export function modelRow(id: string, rows: readonly ModelRow[] = MODELS): ModelRow | undefined {
  return rows.find((m) => m.id === id);
}

/**
 * The model button's label: the row's name; the Default row names the model it stands for when its line says
 * ("Use the default model (currently Opus 5.5)"). A value the rows do not hold is shown as it is once the rows came
 * (`known`), and as "Model" before.
 */
export function modelLabel(id: string, rows: readonly ModelRow[] = MODELS, known = true): string {
  const row = modelRow(id, rows);
  if (!row) return id === "default" ? "Default" : known && id ? id : "Model";
  if (row.id !== "default") return row.label;
  const current = /\(currently ([^)]+)\)/.exec(row.hint)?.[1];
  return current ? `Default (${current})` : "Default";
}

/** The effort the user picked, or "Default" with no pick (6.6, D52). */
export function effortLabel(id: string): string {
  if (id === "default") return "Default";
  return EFFORTS.find((e) => e.id === id)?.label ?? "Effort";
}

/**
 * Whether the model button (and the + menu's Model row) shows the effort beside the model. Not while both are the
 * user's Claude Code defaults: "Default" once says it, not "Default ... Default" (D51, principle 0). The button's
 * accessible name still says both.
 */
export function showsEffort(model: string, effort: string): boolean {
  return model !== "default" || effort !== "default";
}

/** 1 for Low up to 5 for Max; 0 for Default and for a level that is not known. */
export function effortLevel(id: string): number {
  return EFFORTS.findIndex((e) => e.id === id) + 1;
}

export function modeLabel(id: string): string {
  return MODES.find((m) => m.id === id)?.label ?? "Mode";
}

/** The effort levels a model supports; every level when the model is not in the list. */
export function effortsFor(model: string, rows: readonly ModelRow[] = MODELS): string[] {
  return modelRow(model, rows)?.efforts ?? EFFORTS.map((e) => e.id);
}

/** False only when Claude Code says the model cannot run Auto (supportsAutoMode, DESIGN.md 6.6); unknown counts as yes. */
export function supportsAuto(model: string, rows: readonly ModelRow[] = MODELS): boolean {
  return modelRow(model, rows)?.supportsAutoMode !== false;
}

/** The lines under a mode row that cannot be picked (DESIGN.md 6.6 and 5.4). */
export const AUTO_OFF_LINE = "Auto needs a model that supports it.";
export const BYPASS_NEW_CHAT_LINE = "Start a new chat to use Bypass permissions.";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** A shortcut as the platform writes it (DESIGN.md 6.11: Cmd on macOS, Ctrl elsewhere). */
export function shortcut(key: string): string {
  return IS_MAC ? `Cmd+Shift+${key}` : `Ctrl+Shift+${key}`;
}

/** Scroll a list box so that one of its rows is in view, without scrolling anything around the box. */
export function scrollWithin(box: HTMLElement | null, el: HTMLElement | null | undefined) {
  if (!box || !el) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 4;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4;
}

const COUNT = new Intl.NumberFormat("en");
export function count(n: number): string {
  return COUNT.format(n);
}
