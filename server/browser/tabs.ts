// The shared browser's tabs on disk (DESIGN-B1 2.8; SERVER-B1 5.2): `<state>/browser/tabs.json`, so a kitespan
// restart maps the live tabs back to their ids and a fresh start of Chrome (a crash, Stop and Start, a reboot) opens
// the saved URLs again under the same ids. Only http and https tabs are saved, at most 50, at most once a second and
// at shutdown, 0600, at most 256 KiB; the URL rule runs again on read. The file holds URLs with their queries, because
// a reopen needs them: it stays in the 0700 state folder, and no log line or error ever holds one.
//
//   { "v": 1, "browserStart": "<host.json start>", "spare": "<target>", "tabs": [ { "id": "abcdefghij",
//     "target": "<targetId>", "url": "https://example.com/a?b=c", "title": "Example", "by": "user",
//     "at": "2026-11-09T09:00:00.000Z", "size": { "kind": "desktop" } } ], "shown": "abcdefghij" }
//
// `shown` is the saved tab that a pane socket viewed last (D-6, Q3): a reopen gives it the lowest target id, so the
// first page of a chat's Playwright MCP is the tab that the pane shows. A file without it (an older one) is read as
// naming none.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_LIMITS, browserUrlProblem, type BrowserTabBy, type BrowserUrlRefusals } from "../../shared/browser";
import { BROWSER_TAB_ID } from "../../shared/ids";
import { readJson, setAside, writeAtomic } from "../store/files";

export const TABS_FILE = "tabs.json";
/** At most once a second (as drafts are). */
export const TABS_WRITE_MS = 1_000;

export type SavedSize = { kind: "desktop" } | { kind: "phone"; w: number; h: number };

export interface SavedTab {
  id: string;
  /** Chrome's target id (never sent to a page): an adoption maps the live targets back by it. */
  target: string;
  url: string;
  title: string;
  by: BrowserTabBy;
  at: string;
  size: SavedSize;
}

export interface TabsFile {
  v: 1;
  /** host.json's `start` of the Chrome these targets belong to. */
  browserStart: string;
  /** The spare window's tab (never shown, never saved as a tab), so an adoption knows it. */
  spare: string | null;
  tabs: SavedTab[];
  /** The id of the saved tab that a pane socket viewed last, or null (relay.ts reopen). */
  shown?: string | null;
}

const TARGET_ID = /^[A-F0-9]{32}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A saved size: Desktop, or a Phone size in range; anything else is Desktop. */
export function savedSizeOf(v: unknown): SavedSize {
  if (isObj(v) && v.kind === "phone") {
    const w = v.w;
    const h = v.h;
    const ok = (n: unknown, lo: number, hi: number) => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
    if (ok(w, BROWSER_LIMITS.phoneWMin, BROWSER_LIMITS.phoneWMax) && ok(h, BROWSER_LIMITS.phoneHMin, BROWSER_LIMITS.phoneHMax)) return { kind: "phone", w: w as number, h: h as number };
  }
  return { kind: "desktop" };
}

/** True for a URL that a tab is saved with: http or https, through the URL rule. */
export function savableUrl(url: string, refused: BrowserUrlRefusals): boolean {
  return /^https?:\/\//i.test(url) && browserUrlProblem(url, refused) === null;
}

/**
 * The checked record of a tabs.json value, or null when its frame is not one. A tab that fails a check is dropped (its
 * URL fails the rule now, say), the rest are kept; at most 50, each id once.
 */
export function tabsFileOf(raw: unknown, refused: BrowserUrlRefusals): TabsFile | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.browserStart !== "string" || raw.browserStart.length > 64 || !Array.isArray(raw.tabs)) return null;
  const spare = typeof raw.spare === "string" && TARGET_ID.test(raw.spare) ? raw.spare : null;
  const tabs: SavedTab[] = [];
  const ids = new Set<string>();
  for (const t of raw.tabs) {
    if (tabs.length >= BROWSER_LIMITS.tabs) break;
    if (!isObj(t)) continue;
    const { id, target, url, title, by, at } = t;
    if (typeof id !== "string" || !BROWSER_TAB_ID.test(id) || ids.has(id)) continue;
    if (typeof target !== "string" || !TARGET_ID.test(target)) continue;
    if (typeof url !== "string" || !savableUrl(url, refused)) continue;
    if (by !== "user" && by !== "page" && by !== "other") continue;
    if (typeof at !== "string" || at.length > 40) continue;
    ids.add(id);
    tabs.push({ id, target, url, title: typeof title === "string" ? title.slice(0, BROWSER_LIMITS.title) : "", by, at, size: savedSizeOf(t.size) });
  }
  const shown = typeof raw.shown === "string" && ids.has(raw.shown) ? raw.shown : null;
  return { v: 1, browserStart: raw.browserStart, spare, tabs, shown };
}

/** tabs.json's reader and its throttled writer. */
export class TabsFileStore {
  private pending: TabsFile | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly uid: number,
    private readonly refused: () => BrowserUrlRefusals,
    private readonly onError: () => void = () => {},
  ) {}

  /** The saved tabs, or null when there is no file; a file that fails its checks is set aside as .bad. */
  async read(): Promise<TabsFile | null> {
    if (this.pending) return this.pending;
    let r;
    try {
      r = await readJson(join(this.dir, TABS_FILE), BROWSER_LIMITS.tabsFileBytes, this.uid);
    } catch {
      return null;
    }
    if (r.kind === "absent") return null;
    const file = r.kind === "ok" ? tabsFileOf(r.value, this.refused()) : null;
    if (!file) {
      await setAside(this.dir, TABS_FILE).catch(() => {});
      this.onError();
    }
    return file;
  }

  async count(): Promise<number> {
    return (await this.read())?.tabs.length ?? 0;
  }

  /** Save at most once a second; the newest record wins. */
  save(file: TabsFile): void {
    this.pending = file;
    if (this.timer) return;
    const wait = Math.max(0, this.lastWrite + TABS_WRITE_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
    this.timer.unref?.();
  }

  /** Write the newest record now (at shutdown, and before Clear browsing data reads it). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const file = this.pending;
    this.writing = this.writing.then(async () => {
      if (!file || this.pending !== file) return;
      this.pending = null;
      this.lastWrite = Date.now();
      const text = `${JSON.stringify(file)}\n`;
      try {
        mkdirSync(this.dir, { mode: 0o700 });
      } catch {}
      try {
        await writeAtomic(this.dir, TABS_FILE, text, BROWSER_LIMITS.tabsFileBytes, this.uid);
      } catch {
        this.onError();
      }
    });
    return this.writing;
  }

  /** Clear browsing data: no saved tabs. */
  async clear(): Promise<void> {
    this.pending = { v: 1, browserStart: "", spare: null, tabs: [] };
    await this.flush();
  }
}
