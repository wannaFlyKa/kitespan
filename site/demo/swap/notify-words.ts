// Settings > Notifications' words in the demo's build only (DESIGN-W1 2.3, 4.2): the frame hides the service worker,
// so the section's gate is "unsupported", whose line here says that notifications are off in the demo. Every other
// word is the app's own. The site's build resolves each import of web/notify/words.ts to this file; this file's own
// import of it is left alone.
import { NOTIFY_WORDS as APP_WORDS } from "../../../web/notify/words";
import { DEMO_LINES } from "../lines";

export const NOTIFY_WORDS = { ...APP_WORDS, unsupported: DEMO_LINES.notifications } as const;
