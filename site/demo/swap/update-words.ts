// Update's words in the demo's build only (DESIGN-W1 2.3, 4.2): the demo's server answers Check now as a check that
// could not look, with the refusal `dist` (a kitespan that does not update itself), and here that refusal's line says
// that updates do not run in the demo. Check now's own row shows it, as it shows any refused check, so it stays in
// About and is no notice. Every other export is shared/update.ts's own; the site's build resolves each import of that
// file to this one, and leaves this file's own imports of it alone.
import { UPDATE_REFUSAL_LINES as APP_LINES, type UpdateRefusal } from "../../../shared/update";
import { DEMO_CHECK_REFUSAL, DEMO_LINES } from "../lines";

export * from "../../../shared/update";

export const UPDATE_REFUSAL_LINES: Readonly<Record<UpdateRefusal, string>> = { ...APP_LINES, [DEMO_CHECK_REFUSAL]: DEMO_LINES.update };
