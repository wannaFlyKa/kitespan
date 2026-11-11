// The "Prompt from an external link" line under a field that a URL pre-filled (DESIGN.md 5.1 rule 7, Claude Code's own
// words). The caller passes the field's text while it came from a link, and "" otherwise; the line goes away when the
// text is sent or cleared. Over 1,000 characters it adds the count and asks for a review (kitespan's own wording).
// The new-chat form (agent U3) uses it too. Keep this export and its props.
import { count } from "./labels";

export function ExternalLinkLine({ text }: { text: string }) {
  if (!text) return null;
  const long = text.length > 1000;
  return (
    <p className="cmp-ext" data-testid="external-link-line" role="note">
      Prompt from an external link
      {long ? ` (${count(text.length)} characters). Scroll through it and review the full text before you send.` : null}
    </p>
  );
}
