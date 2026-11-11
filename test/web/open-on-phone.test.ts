// Open on phone on the page (v0.6 touch; DESIGN-T1 2.3, 2.5 and 3.4; T-4, T-7, T-14): the origin a phone can reach, the
// path of the page the dialog was opened over (never the dialog's own), the text the code encodes with and without the
// access adapter's link form, the dialog's states as it draws them, and the session menu's new rows: Stop while a turn
// runs or a card waits, Open on phone on every size but the phone, Keyboard shortcuts wherever a keyboard is likely.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "../../web/router";
import type { Card } from "../../web/state/types";
import { resetState } from "../../web/state/store";
import { SessionMenu } from "../../web/dialogs/SessionMenu";
import { PhoneBody } from "../../web/dialogs/OpenOnPhone";
import { PHONE_WORDS, openerPath, phoneLink, phoneState, pickOrigin, type PhoneState } from "../../web/dialogs/phoneLink";
import { qrPath } from "../../web/ui/qr";
import { COPY_FAILED } from "../../web/ui/Copy";
import { CHATS } from "./fixtures";
import { expand, inRender, propsWhere } from "./presses";

const WEB = join(import.meta.dir, "..", "..", "web");
const C = "k3m7q2x4abk3m7q2x4ab";
const OTHER = "m7q2x4abk3m7q2x4abk3";
const PHONE = "https://phone.example.test";
const at = (path: string) => parse(new URL(path, "http://127.0.0.1"));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("pickOrigin: an origin a phone can reach", () => {
  test("http origins and loopback hosts are dropped; the page's own is taken when it is one of the rest, else the first", () => {
    const list = ["http://localhost:8080", "https://localhost:9443", "https://127.0.0.1:9443", "https://[::1]:9443", "https://dev.localhost", "https://laptop.example.net", PHONE];
    expect(pickOrigin(list, null)).toBe("https://laptop.example.net");
    expect(pickOrigin(list, PHONE)).toBe(PHONE);
    expect(pickOrigin(list, "http://127.0.0.1:7940")).toBe("https://laptop.example.net");
    expect(pickOrigin(["http://localhost:8080", "https://127.0.0.2"], "http://localhost:8080")).toBeNull();
    expect(pickOrigin([], PHONE)).toBeNull();
    expect(pickOrigin(["not an origin", "https://laptop.example.net/path"], null)).toBeNull();
  });
});

describe("openerPath: the page the dialog was opened over", () => {
  const route = at(`/c/${C}/phone`);
  test("a view of this chat is kept, with its view, its line and a split's other half", () => {
    expect(openerPath(C, route, `/c/${C}/details`)).toBe(`/c/${C}/details`);
    expect(openerPath(C, route, `/c/${C}/details?view=verbose`)).toBe(`/c/${C}/details?view=verbose`);
    expect(openerPath(C, route, `/c/${C}/files/src/upload.ts?line=42`)).toBe(`/c/${C}/files/src/upload.ts?line=42`);
    expect(openerPath(C, route, `/c/${C}/outputs?below=shell`)).toBe(`/c/${C}/outputs?below=shell`);
    expect(openerPath(C, route, `/c/${C}/shell?type=resume&above=details`)).toBe(`/c/${C}/shell?type=resume&above=details`);
    expect(openerPath(C, route, `/c/${C}/tool/toolu_01AbCdEf`)).toBe(`/c/${C}/tool/toolu_01AbCdEf`);
    // An unknown key is not carried.
    expect(openerPath(C, route, `/c/${C}/details?utm=1`)).toBe(`/c/${C}/details`);
  });
  test("anything else gives the chat's own path, with the route's view", () => {
    const own = `/c/${C}`;
    for (const from of [undefined, null, 42, "", `c/${C}/details`, `//evil.example/c/${C}/details`, `https://evil.example/c/${C}`, `/c/${OTHER}/details`, "/chats", "/", `/c/${C}/nope`, `/c/${C}/phone`, `/c/${C}/send?text=my%20draft`, `/c/${C}/delete`, `/c/${C}/rename?title=x`])
      expect([from, openerPath(C, route, from)]).toEqual([from, own]);
    expect(openerPath(C, at(`/c/${C}/phone?view=thinking`), undefined)).toBe(`/c/${C}?view=thinking`);
  });
});

describe("phoneLink: the link shown and copied, and the text the code encodes", () => {
  test("the plain link is the origin and the path; the link form fills its one {url} with the encoded link", () => {
    expect(phoneLink(PHONE, `/c/${C}/details`, null)).toEqual({ link: `${PHONE}/c/${C}/details`, text: `${PHONE}/c/${C}/details` });
    const filled = phoneLink(PHONE, `/c/${C}/details`, "https://open.example.test/?u={url}&new=1");
    expect(filled).toEqual({ link: `${PHONE}/c/${C}/details`, text: `https://open.example.test/?u=${encodeURIComponent(`${PHONE}/c/${C}/details`)}&new=1` });
    expect(new URL(filled.text).searchParams.get("u")).toBe(filled.link);
    // A template that is not one {url} (the server refuses it; the page does not trust it either) gives the plain link.
    expect(phoneLink(PHONE, `/c/${C}`, "https://open.example.test/?a={url}&b={url}").text).toBe(`${PHONE}/c/${C}`);
    expect(phoneLink(PHONE, `/c/${C}`, "https://open.example.test/").text).toBe(`${PHONE}/c/${C}`);
  });
  test("it never holds /phone: a code never opens Open on phone", () => {
    expect(phoneLink(PHONE, `/c/${C}/phone?view=verbose`, null).link).toBe(`${PHONE}/c/${C}?view=verbose`);
    expect(new URL(phoneLink(PHONE, `/c/${C}/phone`, "x://open?u={url}").text).searchParams.get("u")).toBe(`${PHONE}/c/${C}`);
  });
});

describe("phoneState: the dialog's state for a settings reply", () => {
  const reply = (origins: string[], phoneLink: string | null = null) => ({ access: { origins, hint: [], phoneLink } });
  test("no reachable origin is the one line's state", () => {
    expect(phoneState(reply([]), null, `/c/${C}`)).toEqual({ kind: "none" });
    expect(phoneState(reply(["http://localhost:8080"]), null, `/c/${C}`)).toEqual({ kind: "none" });
    expect(phoneState({ access: { origins: [], hint: [] } }, null, `/c/${C}`)).toEqual({ kind: "none" });
  });
  test("the code holds the origin and the path, no token and no host path", () => {
    const s = phoneState(reply([PHONE]), null, `/c/${C}/details`) as Extract<PhoneState, { kind: "code" }>;
    expect(s.kind).toBe("code");
    expect(s.text).toBe(`${PHONE}/c/${C}/details`);
    expect(s.link).toBe(s.text);
    expect(s.code).toEqual(qrPath(s.text)!);
    expect(s.text).not.toMatch(/token|\/home\/|\/Users\//);
  });
  test("with the link form, the code holds the filled form and the link stays the plain one", () => {
    const s = phoneState(reply([PHONE], "https://open.example.test/?u={url}"), null, `/c/${C}/details`) as Extract<PhoneState, { kind: "code" }>;
    expect(s.link).toBe(`${PHONE}/c/${C}/details`);
    expect(s.text).toBe(`https://open.example.test/?u=${encodeURIComponent(s.link)}`);
  });
  test("a link too long for a code at version 10 says so and still has the link", () => {
    const path = `/c/${C}/files/${"deep/".repeat(40)}name.ts`;
    const s = phoneState(reply([PHONE]), null, path);
    expect(s).toEqual({ kind: "long", link: `${PHONE}${path}`, text: `${PHONE}${path}` });
  });
});

describe("the dialog's states as drawn", () => {
  const draw = (state: PhoneState, sheet = false) => renderToStaticMarkup(createElement(PhoneBody, { state, sheet, onClose: () => {}, onRetry: () => {} }));
  const code = phoneState({ access: { origins: [PHONE], hint: [] } }, null, `/c/${C}/details`);
  test("reading: an empty tile of the code's size and Done, nothing to copy", () => {
    const html = draw({ kind: "reading" });
    expect(html).toContain('class="oop-tile" aria-hidden="true" data-testid="phone-code-wait"');
    expect(html).not.toContain("data-text");
    expect(text(html)).toBe("Done");
    expect(text(draw({ kind: "reading" }, true))).toBe("");
  });
  test("the code: the tile with its exact text and its name, the link as text, then Done and Copy link", () => {
    const html = draw(code);
    expect(html).toContain(`role="img" aria-label="${PHONE_WORDS.tile}" data-testid="phone-code" data-text="${PHONE}/c/${C}/details"`);
    expect(html).toMatch(/<svg viewBox="0 0 (\d+) \1" width="(\d+)" height="\2" shape-rendering="crispEdges"/);
    // The link wraps after its slashes and before its dots first (ui/breakable.tsx); its text is the link exactly.
    const link = /<p class="oop-link" dir="ltr" data-testid="phone-link">(.*?)<\/p>/.exec(html)![1]!;
    expect(link).toContain("<wbr/>");
    expect(link.replace(/<wbr\/>/g, "")).toBe(`${PHONE}/c/${C}/details`);
    expect(html.indexOf('data-testid="phone-done"')).toBeLessThan(html.indexOf('data-testid="phone-copy"'));
    expect(html).toContain('data-autofocus="true" data-testid="phone-done"');
    // Copy link keeps its width: its three words in one cell, the one shown marked.
    expect(html).toContain(`aria-label="${PHONE_WORDS.copy}"`);
    expect(html).toContain(`<span aria-hidden="true" data-on="true">${PHONE_WORDS.copy}</span><span aria-hidden="true">${PHONE_WORDS.copied}</span><span aria-hidden="true">${COPY_FAILED}</span>`);
    // The sheet has Done at the top right only (Modal's sheet), so its body holds the tile, the link and Copy link.
    const sheet = draw(code, true);
    expect(sheet).not.toContain("phone-done");
    expect(sheet).toContain('data-testid="phone-copy"');
  });
  test("too long: the line over the link and Copy link, no tile", () => {
    const html = draw({ kind: "long", link: `${PHONE}/c/${C}`, text: `${PHONE}/c/${C}` });
    expect(text(html)).toStartWith(PHONE_WORDS.long);
    expect(html).not.toContain("oop-tile");
    expect(html).toContain('data-testid="phone-copy"');
  });
  test("no remote address: the one line and Done (on the sheet the line alone); a failed read: its line and Try again", () => {
    expect(text(draw({ kind: "none" }))).toBe(`${PHONE_WORDS.none} Done`);
    expect(text(draw({ kind: "none" }, true))).toBe(PHONE_WORDS.none);
    expect(PHONE_WORDS.none).toBe("No remote address is set up for this host.");
    expect(text(draw({ kind: "failed" }))).toBe(`${PHONE_WORDS.failed} Done ${PHONE_WORDS.retry}`);
    expect(text(draw({ kind: "failed" }, true))).toBe(`${PHONE_WORDS.failed} ${PHONE_WORDS.retry}`);
  });
  test("Done is the same node in every state: the read, the code, too long, no address, a failed read", () => {
    // Where React finds an element: the slot and the element type at each level down to it. A Done in another place
    // after the read would be a new button, and the focus the dialog gave it would fall to the page's body.
    const where = (state: PhoneState): string | null => {
      const walk = (node: ReactNode, at: string): string | null => {
        if (!isValidElement(node)) return null;
        const el = node as ReactElement<{ children?: ReactNode; "data-testid"?: string }>;
        const here = `${at}/${typeof el.type === "string" ? el.type : ((el.type as { name?: string }).name ?? "fragment")}`;
        if (el.props["data-testid"] === "phone-done") return here;
        const slots = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
        for (const [i, k] of slots.entries()) {
          const hit = walk(k as ReactNode, `${here}[${i}]`);
          if (hit) return hit;
        }
        return null;
      };
      return walk(inRender(() => expand(createElement(PhoneBody, { state, sheet: false, onClose: () => {}, onRetry: () => {} }))), "");
    };
    const first = where({ kind: "reading" });
    expect(first).not.toBeNull();
    for (const s of [code, { kind: "long", link: `${PHONE}/c/${C}`, text: `${PHONE}/c/${C}` }, { kind: "none" }, { kind: "failed" }] as PhoneState[]) expect([s.kind, where(s)]).toEqual([s.kind, first]);
  });
  test("no line asks the user to scan, and the words name no product", () => {
    const words = Object.values(PHONE_WORDS).join(" ");
    expect(words).not.toMatch(/scan|camera|QR/i);
  });
  test("ChatDialogs mounts it at /c/<chat>/phone, and its style sheet keeps the tile black on white", () => {
    expect(readFileSync(join(WEB, "dialogs", "ChatDialogs.tsx"), "utf8")).toContain('case "phone":\n      return <OpenOnPhone chat={chat} route={route} />;');
    const css = readFileSync(join(WEB, "styles", "phone.css"), "utf8");
    expect(css).toMatch(/\.oop-tile \{[^}]*background: #ffffff;[^}]*forced-color-adjust: none;/);
    expect(css).toMatch(/\.oop-tile path \{\s*fill: #000000;/);
    expect(css).toContain("@media (max-height: 480px)");
  });
});

describe("the session menu's new rows (T-4, T-7, T-14)", () => {
  const g = globalThis as unknown as { window: { innerWidth?: number; innerHeight?: number }; matchMedia?: unknown };
  const own = { window: g.window === undefined, mm: g.matchMedia };
  afterEach(() => {
    if (own.mm === undefined) delete g.matchMedia;
    else g.matchMedia = own.mm;
    if (own.window) delete (g as { window?: unknown }).window;
    resetState();
  });
  /** The menu at a size: the phone (390 x 844), a medium tablet (834 x 1194) or a laptop (1100 x 800, fine pointer). */
  const menuAt = (size: "phone" | "medium" | "laptop", over: Partial<(typeof CHATS)[number]> = {}) => {
    const touch = size !== "laptop";
    g.window ??= {};
    Object.assign(g.window, size === "phone" ? { innerWidth: 390, innerHeight: 844 } : size === "medium" ? { innerWidth: 834, innerHeight: 1194 } : { innerWidth: 1100, innerHeight: 800 });
    g.matchMedia = (q: string) => ({ matches: touch && q === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} });
    const chat = { ...CHATS[0]!, id: C, archived: false, turn: null, pending: [] as Card[], ...over };
    return inRender(() => SessionMenu({ open: true, onClose: () => {}, anchor: { current: null }, chat, route: at(`/c/${C}`) }));
  };
  const row = (menu: unknown, id: string) => propsWhere(menu as never, "data-testid", id);
  /** The menu's words in their order (the Popup is not drawn: its portal needs a document). */
  const words = (node: unknown): string[] => {
    if (typeof node === "string") return [node];
    if (Array.isArray(node)) return node.flatMap(words);
    const props = (node as { props?: { children?: unknown } } | null)?.props;
    return props ? words(props.children) : [];
  };

  test("Stop is the first row, to the Stop confirm, while a turn runs or a card waits; not otherwise", () => {
    for (const size of ["phone", "medium", "laptop"] as const) {
      const running = menuAt(size, { turn: 7 });
      expect(row(running, "menu-stop")).toMatchObject({ to: `/c/${C}/stop`, children: "Stop" });
      expect(words(running).slice(0, 2)).toEqual(["Stop", "Rename"]);
      expect(row(menuAt(size, { pending: [{ kind: "permission" } as unknown as Card] }), "menu-stop")).not.toBeNull();
      expect(row(menuAt(size), "menu-stop")).toBeNull();
      expect(row(menuAt(size, { turn: 7, archived: true }), "menu-stop")).toBeNull();
    }
  });

  test("Open on phone follows Open in terminal on every size but the phone", () => {
    for (const size of ["medium", "laptop"] as const) {
      const menu = menuAt(size);
      expect(row(menu, "menu-phone")).toMatchObject({ to: `/c/${C}/phone`, children: "Open on phone" });
      const w = words(menu);
      expect(w.indexOf("Open on phone")).toBe(w.indexOf("Open in terminal") + 1);
    }
    expect(row(menuAt("phone"), "menu-phone")).toBeNull();
  });

  test("Keyboard shortcuts on medium touch and the laptop class, not on the phone (Settings > General has it there)", () => {
    for (const size of ["medium", "laptop"] as const) expect(row(menuAt(size), "menu-shortcuts")).toMatchObject({ to: "/settings/general/shortcuts" });
    expect(row(menuAt("phone"), "menu-shortcuts")).toBeNull();
  });
});
