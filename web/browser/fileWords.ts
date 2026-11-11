// The file chooser card's words (DESIGN-B1 4.7, F15), with no DOM, so the live test can check what the page would draw
// for a chooser frame. Whose the chooser is comes from the frame's `by`, which the server decided when the chooser
// opened (server/browser/relay.ts chooserOpened), so the card does not change when the acting list does. The server
// sends the frame again, by `other`, when the chat that opened it ends: then the card is the page's.
import type { BrowserServerFrame } from "../../shared/browser";

type ChooserFrame = Extract<BrowserServerFrame, { t: "chooser" }>;

export const FILE_LINES = {
  told: "Tell Claude you chose the file. Its browser tools still see the file field as open.",
  missed: "The file did not reach the page.",
  chat: "The file goes into this chat's uploads, then to the page.",
  own: "The file goes into kitespan's browser uploads, then to the page.",
} as const;

/** Claude's chooser: its card says so, its plain button (and Esc) is Leave it to Claude, and a pick tells Claude. */
export const fileIsClaudes = (c: Pick<ChooserFrame, "by">) => c.by === "claude";

/** The card's plain button, which Esc presses too. */
export const filePlain = (c: Pick<ChooserFrame, "by">) => (fileIsClaudes(c) ? "Leave it to Claude" : "Cancel");

export function fileTitle(c: Pick<ChooserFrame, "multiple" | "by">): string {
  if (fileIsClaudes(c)) return "Claude opened a file field";
  return c.multiple ? "The page asks for files" : "The page asks for a file";
}

export function fileWhere(c: Pick<ChooserFrame, "host" | "label">): string {
  return c.label ? `${c.host}, for ${c.label}` : c.host;
}

/** The input's accept list from the page's (already cleaned by the server: extensions and MIME types). */
export const acceptOf = (c: Pick<ChooserFrame, "accept">) => c.accept.join(",");
