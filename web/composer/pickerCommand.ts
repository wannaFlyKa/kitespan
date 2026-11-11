// PT-5 (DESKTOP-PARITY; DESIGN-T1 T-22): /model and /effort with no argument open kitespan's own model menu, at its
// Effort section for /effort, instead of sending the command or opening the terminal-only path. With an argument
// (/model opus) they are commands as before. Pure: Composer.tsx asks at Send and at a / menu pick.
import type { Draft } from "./draft";

export type PickerCommand = "model" | "effort";

/** The model menu's section that a command's name opens, or null. */
export function pickerOf(name: string): PickerCommand | null {
  return name === "model" || name === "effort" ? name : null;
}

/** The section a draft opens: the / mode's chip with no argument, or its filter text that names one of the two. */
export function pickerCommand(d: Pick<Draft, "mode" | "command" | "text">): PickerCommand | null {
  if (d.mode !== "slash") return null;
  if (d.command) return d.text.trim() ? null : pickerOf(d.command);
  return pickerOf(d.text.trim());
}
