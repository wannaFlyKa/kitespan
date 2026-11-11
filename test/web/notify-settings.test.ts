// Settings > Notifications' rows (owner rows 128 and 130; DESIGN-R130 4.5, 6, 8 and 10), drawn with React's server
// renderer from each state of the section: the three states with no switch and their one line each (an insecure
// origin, a browser with no push, a blocked permission), the first and the last with the devices that have them on
// under the line, each with Turn off; reading, with no control drawn; off; on, with Show chat
// titles and its line, and the Devices group (this device first with "This device", Turn off on every other row, a
// failing device's line); a turn-on on its way (busy); a turn-on that did not go through (its line); and the links,
// which only pre-fill: this-device's value with Not saved and its Save named "Turn on notifications", show-titles'
// value with Save, and a device's row marked with the link's name in its field, not saved, its own name above it.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PushDevice } from "../../web/notify/api";
import type { NotifyActions, NotifyModel } from "../../web/notify/useNotify";
import { NOTIFY_WORDS } from "../../web/notify/words";
import { NotificationsBody, type NotifyCtx } from "../../web/settings/Notifications";
import { KEY_SECTION, SectionBody } from "../../web/screens/Settings";
import { SETTINGS_SECTIONS, parsePath } from "../../shared/route";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ME = "aaaabbbbccccdddd";
const PHONE = "eeeeffffgggghhhh";
const dev = (id: string, name: string, more: Partial<PushDevice> = {}): PushDevice => ({ id, name, titles: false, at: "2026-11-05T10:00:00.000Z", failing: false, ...more });
const NOOP: NotifyActions = { setThisDevice() {}, setTitles() {}, rename: async () => true, remove() {} };
const model = (p: Partial<NotifyModel> = {}): NotifyModel => ({ gate: "ok", read: { key: "BKEY", devices: [], mine: null }, busy: null, line: null, ...p });
const draw = (m: NotifyModel, ctx: Partial<NotifyCtx> = {}) => renderToStaticMarkup(createElement(NotificationsBody, { model: m, actions: NOOP, ctx: { touch: false, ...ctx } }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
const switches = (html: string) => [...html.matchAll(/<input type="checkbox" role="switch"[^>]*>/g)].map((m) => m[0]);

describe("the first row's states, tested in the design's order", () => {
  test("insecure, unsupported, denied: no switch and one line each; with no device on, no other row", () => {
    for (const [gate, line] of [
      ["insecure", NOTIFY_WORDS.insecure],
      ["unsupported", NOTIFY_WORDS.unsupported],
      ["denied", NOTIFY_WORDS.denied],
    ] as const) {
      const html = draw(model({ gate, read: gate === "unsupported" ? null : { key: "BKEY", devices: [], mine: null } }));
      expect(switches(html)).toEqual([]);
      expect(text(html)).toBe(`${NOTIFY_WORDS.thisDevice} ${line}`);
      expect(html).not.toContain("settings-devices");
    }
  });

  test("insecure and denied: the devices that have them on are listed, each with Turn off, so they can be turned off from here", () => {
    for (const [gate, line] of [
      ["insecure", NOTIFY_WORDS.insecure],
      ["denied", NOTIFY_WORDS.denied],
    ] as const) {
      const html = draw(model({ gate, read: { key: "BKEY", devices: [dev(PHONE, "iPhone"), dev(ME, "Chrome", { at: "2026-11-06T10:00:00.000Z" })], mine: null } }));
      expect(switches(html)).toEqual([]);
      expect(text(html)).toBe(`${NOTIFY_WORDS.thisDevice} ${line} ${NOTIFY_WORDS.devices} iPhone ${NOTIFY_WORDS.turnOff} Chrome ${NOTIFY_WORDS.turnOff}`);
      expect(html).toContain('aria-label="Turn off iPhone"');
      expect(html).not.toContain(NOTIFY_WORDS.titles);
      expect(html).not.toContain(NOTIFY_WORDS.you);
      // A device link works here too, and one the list does not have gets its line.
      expect(draw(model({ gate, read: { key: "BKEY", devices: [dev(PHONE, "iPhone")], mine: null } }), { device: PHONE, deviceName: "Personal iPhone" })).toContain('value="Personal iPhone"');
      expect(text(draw(model({ gate, read: { key: "BKEY", devices: [dev(PHONE, "iPhone")], mine: null } }), { device: ME }))).toContain(NOTIFY_WORDS.deviceGone);
    }
  });

  test("unsupported (the phone's company browser): its line and nothing more, even when the server lists a device", () => {
    const html = draw(model({ gate: "unsupported", read: { key: "BKEY", devices: [dev(PHONE, "iPhone")], mine: null } }), { device: ME });
    expect(text(html)).toBe(`${NOTIFY_WORDS.thisDevice} ${NOTIFY_WORDS.unsupported}`);
  });

  test("while the section reads, the row draws no control", () => {
    const html = draw(model({ read: null }));
    expect(switches(html)).toEqual([]);
    expect(text(html)).toBe(NOTIFY_WORDS.thisDevice);
  });

  test("off: the switch off, no titles row, and no Devices group while no device is on", () => {
    const html = draw(model());
    expect(switches(html)).toHaveLength(1);
    expect(switches(html)[0]).not.toContain("checked");
    expect(html).not.toContain(NOTIFY_WORDS.titles);
    expect(html).not.toContain(NOTIFY_WORDS.devices);
  });

  test("off here, on elsewhere: the Devices group lists the other device with Turn off, and no row says This device", () => {
    const html = draw(model({ read: { key: "BKEY", devices: [dev(PHONE, "iPhone")], mine: null } }));
    expect(text(html)).toContain(`${NOTIFY_WORDS.devices} iPhone ${NOTIFY_WORDS.turnOff}`);
    expect(html).not.toContain(NOTIFY_WORDS.you);
    expect(html).toContain('aria-label="Turn off iPhone"');
  });

  test("on: Show chat titles with its line, then the devices: this device first, Turn off on the others, a failing one's line", () => {
    const html = draw(model({ read: { key: "BKEY", devices: [dev(PHONE, "iPhone", { failing: true, at: "2026-11-01T00:00:00.000Z" }), dev(ME, "Chrome")], mine: ME } }));
    const sw = switches(html);
    expect(sw).toHaveLength(2);
    expect(sw[0]).toContain("checked");
    expect(sw[1]).not.toContain("checked");
    expect(text(html)).toBe(
      `${NOTIFY_WORDS.thisDevice} ${NOTIFY_WORDS.titles} ${NOTIFY_WORDS.titlesLine} ${NOTIFY_WORDS.devices} Chrome ${NOTIFY_WORDS.you} iPhone ${NOTIFY_WORDS.failing} ${NOTIFY_WORDS.turnOff}`,
    );
    // The name is a button that turns into a field; the line of a failing device is a status.
    expect(html).toContain('<button type="button" class="nt-name-btn" aria-label="Rename Chrome" data-testid="device-name">Chrome</button>');
    expect(html).toMatch(/<span class="set-row-line" role="status">The last notification did not go through\.<\/span>/);
    expect(html).toContain(`data-testid="device-${ME}" data-mine="true"`);
  });

  test("Show chat titles shows this device's own choice", () => {
    const html = draw(model({ read: { key: "BKEY", devices: [dev(ME, "Chrome", { titles: true })], mine: ME } }));
    expect(switches(html)[1]).toContain("checked");
  });

  test("a turn-on on its way: the switch on and busy, no titles row yet; a turn-on that failed: its one line", () => {
    const busy = draw(model({ busy: "on" }));
    expect(switches(busy)[0]).toContain("checked");
    expect(switches(busy)[0]).toContain('aria-busy="true"');
    expect(busy).not.toContain(NOTIFY_WORDS.titles);
    const failed = draw(model({ line: NOTIFY_WORDS.unreached }));
    expect(failed).toContain(`<span class="set-row-line" role="status" data-testid="notify-line">${NOTIFY_WORDS.unreached.replace(/'/g, "&#x27;")}</span>`);
  });
});

describe("the links: they only pre-fill (5.2)", () => {
  test("this-device?value=on: the switch shows on, Not saved, and its Save is named Turn on notifications", () => {
    const html = draw(model(), { focusKey: "this-device", urlValue: "on" });
    expect(switches(html)[0]).toContain("checked");
    expect(text(html)).toContain(`Not saved ${NOTIFY_WORDS.turnOn}`);
    expect(html).toContain('data-testid="setting-this-device" data-focused="true"');
    // The same value as now: no draft to save.
    expect(draw(model(), { focusKey: "this-device", urlValue: "off" })).not.toContain("Not saved");
    const off = draw(model({ read: { key: "BKEY", devices: [dev(ME, "Chrome")], mine: ME } }), { focusKey: "this-device", urlValue: "off" });
    expect(text(off)).toContain(`Not saved ${NOTIFY_WORDS.turnOffAll}`);
  });

  test("a value the row cannot read: one line, and no draft", () => {
    const html = draw(model(), { focusKey: "this-device", urlValue: "maybe" });
    expect(text(html)).toContain("Part of that link could not be read.");
    expect(html).not.toContain("Not saved");
  });

  test("show-titles?value=on: shown with Not saved and Save", () => {
    const html = draw(model({ read: { key: "BKEY", devices: [dev(ME, "Chrome")], mine: ME } }), { focusKey: "show-titles", urlValue: "on" });
    expect(switches(html)[1]).toContain("checked");
    expect(text(html)).toContain(`${NOTIFY_WORDS.titlesLine} Not saved Save`);
  });

  test("device/<device>?name=: that row marked, the name in its field, not saved; Turn off is not pressed", () => {
    const html = draw(model({ read: { key: "BKEY", devices: [dev(ME, "Chrome"), dev(PHONE, "iPhone")], mine: ME } }), { device: PHONE, deviceName: "Personal iPhone" });
    expect(html).toContain(`data-testid="device-${PHONE}" data-focused="true"`);
    // The field names the device it renames, and the row keeps the device's name in view above it.
    expect(html).toMatch(/<input class="field nt-name" type="text" maxLength="40" aria-label="Rename iPhone"[^>]*value="Personal iPhone"\/>/);
    expect(html).toContain('<span class="set-help" aria-hidden="true" data-testid="device-current">iPhone</span>');
    expect(text(html)).toContain("iPhone Not saved Save");
    const plain = draw(model({ read: { key: "BKEY", devices: [dev(ME, "Chrome"), dev(PHONE, "iPhone")], mine: ME } }), { device: PHONE });
    expect(plain).toContain(`data-testid="device-${PHONE}" data-focused="true"`);
    expect(plain).not.toContain("nt-name\"");
  });

  test("a device the list does not have: one line", () => {
    const html = draw(model({ read: { key: "BKEY", devices: [dev(ME, "Chrome")], mine: ME } }), { device: PHONE });
    expect(text(html)).toContain(NOTIFY_WORDS.deviceGone);
  });
});

describe("its place in Settings", () => {
  test("a section of its own after Chats, with its two keys; the device route opens it", () => {
    expect(SETTINGS_SECTIONS.indexOf("notifications")).toBe(SETTINGS_SECTIONS.indexOf("chats") + 1);
    expect([KEY_SECTION["this-device"], KEY_SECTION["show-titles"]]).toEqual(["notifications", "notifications"]);
    const r = parsePath("/settings/notifications/device/k3m7q2x4abk3m7q2?name=My%20iPhone");
    expect([r.name, r.params.device, r.query.name]).toEqual(["settingsDevice", "k3m7q2x4abk3m7q2", "My iPhone"]);
  });

  test("the tile is the red one that every look has, with a bell; the section's words are Desktop's \"Notifications\"", () => {
    const code = readFileSync(join(import.meta.dir, "..", "..", "web", "screens", "Settings.tsx"), "utf8");
    expect(code).toContain('notifications: { tile: "tile-red", icon: <IconBell size={14} /> }');
    expect(NOTIFY_WORDS.section).toBe("Notifications");
    const tokens = readFileSync(join(import.meta.dir, "..", "..", "web", "styles", "tokens.css"), "utf8");
    expect(tokens.match(/--tile-red:/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("here (no secure context in the test runner) the section draws its first row with the insecure line and no switch", () => {
    const html = renderToStaticMarkup(createElement(SectionBody, { id: "notifications", ctx: { touch: false, laptop: true, phone: false, narrow: false } }));
    expect(switches(html)).toEqual([]);
    expect(text(html)).toBe(`${NOTIFY_WORDS.thisDevice} ${NOTIFY_WORDS.insecure}`);
  });

  test("nothing is asked or registered at load: the permission prompt and the registration are in the turn-on only", () => {
    const web = join(import.meta.dir, "..", "..", "web");
    const files = ["settings/Notifications.tsx", "notify/useNotify.ts", "notify/worker.ts", "notify/gate.ts", "main.tsx", "screens/Settings.tsx", "state/store.ts"];
    for (const f of files) {
      const code = readFileSync(join(web, f), "utf8");
      expect(code).not.toContain("requestPermission(");
      expect(code).not.toContain(".register(");
    }
    const device = readFileSync(join(web, "notify", "device.ts"), "utf8");
    expect(device).toContain('navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })');
  });
});
