// The rename to kitespan (FIX-K1; INVENTORY-K1 3.3): the page's stored keys. Every key that the old name's prefix
// `flydeck.` holds, in local and in session storage, is read once under its old name and written under `kitespan.`, by
// web/index.html's inline script before the first paint and before any module reads one; a key already under the new
// name wins, the old key goes, and a second load finds nothing to move. So a reload keeps the look, the view and the
// drafts. This file names the old prefix on purpose (the sweep's allow-list).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_KEY_PREFIX } from "../../shared/legacy";
import { DRAFT_COPY_KEY, SENT_COPY_KEY, SETTINGS_KEY, SIDE_COPY_KEY, loadSettings, loadView } from "../../web/state/store";
import { TURN_CHOICES_KEY } from "../../web/chat/turnOpen";
import { ENTRY_URLS_KEY } from "../../web/router";
import { FORM_DRAFT_KEY } from "../../web/screens/NewChatForm";

const WEB = join(import.meta.dir, "..", "..", "web");
const html = readFileSync(join(WEB, "index.html"), "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const of = (entries: Record<string, string>) => {
  const s = new MemoryStorage();
  for (const [k, v] of Object.entries(entries)) s.setItem(k, v);
  return s;
};
const dump = (s: MemoryStorage) => Object.fromEntries([...s.map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Run the inline script as the first paint does. `scope` holds the globals it sees; a getter that throws stands for a
 * storage the browser blocks. Returns the root's attributes.
 */
function firstPaint(scope: Record<string, unknown>): Record<string, string> {
  const attrs: Record<string, string> = {};
  const document = { documentElement: { setAttribute: (k: string, v: string) => void (attrs[k] = v) }, querySelectorAll: () => [] };
  const globals = Object.create(null, { ...Object.getOwnPropertyDescriptors(scope), document: { value: document } });
  new Function("scope", `with (scope) {\n${script}\n}`)(globals);
  return attrs;
}

const CHAT = "k3m7q2x4abk3m7q2x4ab";

describe("the stored keys move from flydeck. to kitespan. once, before the first paint", () => {
  test("every key under the old prefix moves in both storages; the look of the moved settings is worn on that same paint", () => {
    const local = of({
      "flydeck.settings": JSON.stringify({ look: "paper", theme: "dark" }),
      "flydeck.view": JSON.stringify({ railHidden: true }),
      [`flydeck.draft.${CHAT}`]: '{"text":"typed"}',
      [`flydeck.sent.${CHAT}`]: "[]",
      [`flydeck.sidedraft.${CHAT}`]: '{"text":"side"}',
      "flydeck.side": '{"w":1}',
      "flydeck.newchat": '{"text":"new"}',
      "flydeck.proto.composer.links": "{}",
    });
    const session = of({ "flydeck.tab": "tab_me", "flydeck.reloadAt": "123", [`flydeck.turns.${CHAT}`]: '{"t1":true}', "flydeck.entryUrls": "[]" });
    const attrs = firstPaint({ localStorage: local, sessionStorage: session });
    expect(dump(local)).toEqual({
      "kitespan.newchat": '{"text":"new"}',
      "kitespan.proto.composer.links": "{}",
      [`kitespan.draft.${CHAT}`]: '{"text":"typed"}',
      [`kitespan.sent.${CHAT}`]: "[]",
      "kitespan.settings": JSON.stringify({ look: "paper", theme: "dark" }),
      "kitespan.side": '{"w":1}',
      [`kitespan.sidedraft.${CHAT}`]: '{"text":"side"}',
      "kitespan.view": JSON.stringify({ railHidden: true }),
    });
    expect(dump(session)).toEqual({ "kitespan.entryUrls": "[]", "kitespan.reloadAt": "123", "kitespan.tab": "tab_me", [`kitespan.turns.${CHAT}`]: '{"t1":true}' });
    expect(attrs).toEqual({ "data-look": "paper", "data-theme": "dark" });
    // The store then reads them where its modules look.
    expect(loadSettings(local)).toMatchObject({ look: "paper", theme: "dark" });
    expect(loadView(local).railHidden).toBe(true);
  });

  test("a key already under the new name wins and the old one goes; other keys stay as they are", () => {
    const local = of({
      "kitespan.settings": JSON.stringify({ look: "mono" }),
      "flydeck.settings": JSON.stringify({ look: "paper" }),
      flydeck: "no dot",
      "flydeckx.view": "another prefix",
      "Flydeck.view": "another case",
      "x.flydeck.view": "not at the start",
      "kitespan.view": "{}",
    });
    const attrs = firstPaint({ localStorage: local, sessionStorage: of({}) });
    expect(dump(local)).toEqual({
      "Flydeck.view": "another case",
      flydeck: "no dot",
      "flydeckx.view": "another prefix",
      "kitespan.settings": JSON.stringify({ look: "mono" }),
      "kitespan.view": "{}",
      "x.flydeck.view": "not at the start",
    });
    expect(attrs).toEqual({ "data-look": "mono" });
  });

  test("a second load finds nothing to move and changes nothing", () => {
    const local = of({ "flydeck.settings": JSON.stringify({ look: "editor" }), "flydeck.view": "{}" });
    const session = of({ "flydeck.tab": "tab_me" });
    firstPaint({ localStorage: local, sessionStorage: session });
    const once = [dump(local), dump(session)];
    // An old page still open in another tab writes an old key again: the next load drops it, as the new key is set.
    local.setItem("flydeck.view", '{"stale":true}');
    firstPaint({ localStorage: local, sessionStorage: session });
    expect([dump(local), dump(session)]).toEqual(once);
    firstPaint({ localStorage: local, sessionStorage: session });
    expect([dump(local), dump(session)]).toEqual(once);
  });

  test("a blocked or full storage: the other storage still moves, and an old key whose copy failed stays for the next load", () => {
    const session = of({ "flydeck.tab": "tab_me" });
    const blocked = {
      get localStorage(): never {
        throw new Error("SecurityError");
      },
      sessionStorage: session,
    };
    expect(() => firstPaint(blocked)).not.toThrow();
    expect(dump(session)).toEqual({ "kitespan.tab": "tab_me" });

    // A full local storage: no new copy fits. The old keys stay for the next load; nothing is lost.
    const full = of({ "flydeck.settings": JSON.stringify({ look: "paper" }), [`flydeck.draft.${CHAT}`]: '{"text":"typed"}' });
    full.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const other = of({ "flydeck.tab": "t" });
    firstPaint({ localStorage: full, sessionStorage: other });
    expect(dump(full)).toEqual({ "flydeck.settings": JSON.stringify({ look: "paper" }), [`flydeck.draft.${CHAT}`]: '{"text":"typed"}' });
    expect(dump(other)).toEqual({ "kitespan.tab": "t" });

    // No storage at all (an old browser, a test page): nothing to move, and nothing throws.
    expect(() => firstPaint({})).not.toThrow();
  });
});

describe("every key the page stores is under kitespan.", () => {
  test("the exported key names", () => {
    for (const key of [SETTINGS_KEY, DRAFT_COPY_KEY, SENT_COPY_KEY, SIDE_COPY_KEY, TURN_CHOICES_KEY, ENTRY_URLS_KEY, FORM_DRAFT_KEY])
      expect([key, key.startsWith("kitespan.")]).toEqual([key, true]);
  });

  test("no module of the page names a key under the old prefix; only index.html's key move does, on one line", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|html)$/.test(name)) files.push(p);
      }
    };
    walk(WEB);
    const hits = files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => [f.slice(WEB.length + 1), i + 1, line] as const)
        .filter(([, , line]) => /flydeck\./i.test(line)),
    );
    expect(hits.map(([f]) => f)).toEqual(["index.html"]);
    expect(html.split("\n").filter((line) => /flydeck/i.test(line)).length).toBe(1);
  });

  test("the inline script's old prefix is shared/legacy.ts's (an inline script cannot import it)", () => {
    expect(script).toContain(`from = ${JSON.stringify(LEGACY_KEY_PREFIX)}`);
  });
});
