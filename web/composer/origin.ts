// The pickers' one head line (DESIGN.md 6.6, D51 / MINIMALISM M19): the check mark shows the current value, so a
// picker says where a value came from only when it changes what Switch does. A model, an effort or a mode (Plan
// excepted, D11) picked in a chat is also the project's pick for its new chats, so after a switch on this page the
// picker says so: "Picked here; new chats in <project> start with it". Nothing shows for a value this page did not
// pick (the user's default, or the project's remembered pick), and nothing for Plan.
import type { Chat, Project } from "../state/types";

export type Field = "model" | "effort" | "mode";

/** Per chat, the value this page switched each field to. View state only. */
const PICKED = new Map<string, Partial<Record<Field, string>>>();

/** Call from the click that switched a value. */
export function markPicked(chatId: string, field: Field, value: string) {
  PICKED.set(chatId, { ...PICKED.get(chatId), [field]: value });
}

/** The head line of a picker's section, or null for none. */
export function headLine(field: Field, chat: Pick<Chat, "id" | "model" | "effort" | "mode">, project: Pick<Project, "name"> | undefined): string | null {
  const value = chat[field];
  if (PICKED.get(chat.id)?.[field] !== value || value === "default" || (field === "mode" && value === "plan")) return null;
  return `Picked here; new chats in ${project?.name ?? "this project"} start with it`;
}

/**
 * The project remembers a pick for its new chats, so a picker offers "Forget for <project>". With `fields`, only a pick
 * of those counts: a picker offers Forget only while the project remembers a value that the picker shows (the mode
 * menu not for a remembered model alone).
 */
export function hasRemembered(project: Pick<Project, "picks"> | undefined, fields: readonly Field[] = ["model", "effort", "mode"]): boolean {
  return !!project && fields.some((f) => project.picks[f] !== undefined);
}

/** Tests only. */
export function resetPicked() {
  PICKED.clear();
}
