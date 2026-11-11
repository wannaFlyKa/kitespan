// The composer's touch parts of iteration 8 (DESIGN-T1 2.3, 2.4, 2.7, 2.9; T-4, T-16, T-22; G-3, G-10, G-11, G-24,
// G-25, G-29, G-36): Stop where the thumb is (+ > Stop on the phone while a turn runs, and the waiting card's own Stop
// at its foot, each the Stop confirm /c/<chat>/stop); the keys in Send's place as one unit that takes its own row when
// the bar's end is short; /model and /effort with no argument open kitespan's own model menu; a tap on Send while files
// upload says why for 4 s; the side chat's field at 44 px; the picker foot's bottom inset by max(). No browser: the
// pure parts and the card's frame render here, the rest is read from the source (the click-through drives the real
// page: ui-check's stop-menu, composer-fit and plus-pickers flows).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardChat, CardFrame } from "../../web/chat/cards/Frame";
import { pickerCommand, pickerOf } from "../../web/composer/pickerCommand";
import type { Draft } from "../../web/composer/draft";

const WEB = join(import.meta.dir, "..", "..", "web");
const src = (...p: string[]) => readFileSync(join(WEB, ...p), "utf8");
/** A style sheet without its comments. */
const css = (name: string) => src("styles", name).replace(/\/\*[\s\S]*?\*\//g, "");
/** The body of the first rule whose selector list is exactly `sel`. */
function rule(sheet: string, sel: string): string | null {
  const at = sheet.indexOf(`\n${sel} {`);
  if (at < 0) return null;
  const open = sheet.indexOf("{", at);
  return sheet.slice(open + 1, sheet.indexOf("}", open));
}

const CHAT = "demoolxxxxxxxxxxxxxx";

describe("the waiting card's own Stop at its foot (T-4, G-10)", () => {
  const frame = (chat: string | null, view?: string) =>
    renderToStaticMarkup(
      createElement(
        CardChat.Provider,
        { value: chat ? { chat, view } : null },
        createElement(CardFrame, { kind: "permission", icon: null, title: "Allow Claude to use Bash?", cardRef: { current: null }, actions: createElement("button", { type: "button" }, "Allow once") }),
      ),
    );
  test("a quiet Stop under a hairline at the card's end, a link to the Stop confirm, after the answers", () => {
    const html = frame(CHAT);
    expect(html).toContain(`<div class="chat-card-foot"><a href="/c/${CHAT}/stop" class="btn ghost chat-card-stop" data-testid="card-stop">`);
    expect(html).toContain("<span>Stop</span></a></div></section>");
    expect(html.indexOf("chat-card-actions")).toBeLessThan(html.indexOf("chat-card-foot"));
  });
  test("the Stop confirm keeps the transcript view", () => {
    expect(frame(CHAT, "verbose")).toContain(`href="/c/${CHAT}/stop?view=verbose"`);
  });
  test("the card's frame is its fields' owner for the root keyboard release", () => {
    expect(frame(CHAT)).toMatch(/^<section class="chat-card is-permission" data-testid="card-permission" data-kb-owner=""/);
  });
  test("a card drawn with no chat (a test, a preview) has no foot", () => {
    expect(frame(null)).not.toContain("chat-card-foot");
  });
});

describe("+ > Stop on the phone while a turn runs (T-4, G-11)", () => {
  const plus = src("composer", "PlusMenu.tsx");
  const composer = src("composer", "Composer.tsx");
  test("Stop is the + sheet's first row, a group of its own with the red tile, before Add files or photos", () => {
    const stop = plus.indexOf('testId="plus-stop"');
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(plus.indexOf('testId="plus-attach"'));
    expect(plus).toContain('<div className={sheet ? "group cmp-plus cmp-plus-stop" : "cmp-plus cmp-plus-stop"} role="menu" aria-label="Turn" onKeyDown={listKeys}>');
    expect(plus).toContain('<Item sheet={sheet} tile="red" icon={<IconStop />} label="Stop" testId="plus-stop" onClick={props.onStop} />');
    expect(plus.indexOf("{props.onStop ? (")).toBeLessThan(plus.indexOf('aria-label="Add to this chat" onKeyDown={listKeys}'));
    // The sheet's first focus stays on the first row that adds to the message, never on Stop.
    expect(plus).toContain("box.current?.querySelector<HTMLElement>('.cmp-plus-main [role=\"menuitem\"]')?.focus({ preventScroll: true });");
  });
  test("the composer gives it on the phone only, while a turn runs; it opens the Stop confirm in the menu's place", () => {
    expect(composer).toContain('onStop={phone && canStop ? () => navigate(href("stop", { chat: chat.id }, { view }), { replace: true }) : undefined}');
  });
});

describe("the keys in Send's place are one unit (T-16, G-25)", () => {
  const composer = src("composer", "Composer.tsx");
  const sheet = css("composer.css");
  test("one span around Stop and Send, Run, Continue in a copy or Send again, at the end of the bar's end group", () => {
    expect(composer).toContain('<span className="cmp-keys">\n                    {canStop ? stopButton : null}\n                    {held ? copyButton : sendButton}\n                  </span>');
  });
  test("the unit never shrinks or splits; the end group wraps it to a line of its own at the end", () => {
    const end = rule(sheet, ".cmp-bar-end") ?? "";
    for (const d of ["flex-wrap: wrap;", "justify-content: flex-end;", "row-gap: var(--s2);", "min-width: 0;", "margin-left: auto;"]) expect([d, end.includes(d)]).toEqual([d, true]);
    const keys = rule(sheet, ".cmp-keys") ?? "";
    for (const d of ["display: flex;", "flex: none;"]) expect([d, keys.includes(d)]).toEqual([d, true]);
    expect(rule(sheet, ".cmp-keys:empty")).toContain("display: none;");
  });
  test("under 300 px of slab content (the bar's 308 px) the model chip drops its effort word and keeps the bars", () => {
    expect(rule(sheet, ".touch .cmp:not(.is-phone) .cmp-bar")).toContain("container: cmp-bar / inline-size;");
    expect(sheet).toMatch(/@container cmp-bar \(width < 308px\) \{\s*\.cmp-bar-end \.cmp-model \.cmp-effort \.cmp-btn-label \{\s*display: none;\s*\}\s*\}/);
    // The ring keeps its number (without it the ring reads as a spinner).
    expect(sheet).not.toMatch(/@container cmp-bar[^{]*\{[^}]*cmp-ring-pct/);
  });
});

describe("/model and /effort with no argument open kitespan's own model menu (T-22, G-24)", () => {
  const d = (over: Partial<Draft>): Draft => ({ mode: "slash", command: null, text: "", fromLink: false, ...over });
  test("the chip or the typed name with no argument; at Effort for /effort", () => {
    expect([pickerCommand(d({ command: "model" })), pickerCommand(d({ command: "effort", text: "  " })), pickerCommand(d({ text: "model" })), pickerCommand(d({ text: " effort " }))]).toEqual(["model", "effort", "model", "effort"]);
  });
  test("with an argument it is a command as before; other commands and Chat mode are not it", () => {
    expect([pickerCommand(d({ command: "model", text: "opus" })), pickerCommand(d({ text: "model opus" })), pickerCommand(d({ command: "compact" })), pickerCommand(d({ text: "models" }))]).toEqual([null, null, null, null]);
    expect(pickerCommand({ mode: "chat", command: null, text: "/model" })).toBeNull();
    expect(pickerCommand(d({ mode: "bash", text: "model" }))).toBeNull();
    expect([pickerOf("model"), pickerOf("effort"), pickerOf("fast"), pickerOf("")]).toEqual(["model", "effort", null, null]);
  });
  test("Send and a / menu pick open the menu instead of sending or the terminal-only path", () => {
    const composer = src("composer", "Composer.tsx");
    const send = composer.slice(composer.indexOf("const send = (now = false) => {"), composer.indexOf("const stop = () =>"));
    expect(send).toContain("const own = pickerCommand(d);");
    expect(send.indexOf("if (own) return openPicker(own);")).toBeLessThan(send.indexOf("act.send("));
    const pick = composer.slice(composer.indexOf("const pick = (i: number) => {"), composer.indexOf("// The / menu opened with no list"));
    expect(pick.indexOf("if (own) return openPicker(own);")).toBeLessThan(pick.indexOf("if (c.terminalOnly) {"));
  });
});

describe("a tap on Send while files upload says why (G-3)", () => {
  const composer = src("composer", "Composer.tsx");
  test("Send stays a key a tap reaches while only an upload holds it (aria-disabled), and its line shows 4 s", () => {
    expect(composer).toContain("const uploadWait = !held && uploading && !sideOver;");
    expect(composer).toContain("disabled={!canSend && !uploadWait}");
    expect(composer).toContain('aria-disabled={uploadWait ? "true" : undefined}');
    expect(composer).toContain("const UPLOAD_WAIT_MS = 4000;");
    expect(composer).toContain('data-testid="composer-upload-wait"');
  });
  test("it looks off as a disabled Send does", () => {
    expect(css("composer.css")).toMatch(/\.cmp-send:disabled,\s*\.cmp-send\[aria-disabled="true"\] \{/);
  });
});

describe("the side chat's field and the picker foot on touch (G-29, G-36)", () => {
  test("the side chat's field is a 44 px target", () => {
    expect(rule(css("side.css"), ".touch .sc-input")).toContain("min-height: var(--touch);");
  });
  test("the picker foot meets the sheet's bottom by max(), never base plus the inset, and its sides by the sheet's", () => {
    const foot = rule(css("composer.css"), ".sheet .cmp-picker-foot") ?? "";
    expect(foot).toContain("bottom: calc(-1 * max(var(--s4), env(safe-area-inset-bottom)));");
    for (const d of [
      "margin: var(--s2) 0 calc(-1 * max(var(--s4), env(safe-area-inset-bottom)));",
      "margin-left: calc(-1 * max(var(--s4), env(safe-area-inset-left)));",
      "margin-right: calc(-1 * max(var(--s4), env(safe-area-inset-right)));",
      "padding: var(--s3) 0 max(var(--s3), env(safe-area-inset-bottom));",
      "padding-left: max(var(--s4), env(safe-area-inset-left));",
      "padding-right: max(var(--s4), env(safe-area-inset-right));",
    ])
      expect([d, foot.includes(d)]).toEqual([d, true]);
    expect(foot).not.toMatch(/\+ env\(safe-area-inset-bottom\)/);
  });
});
