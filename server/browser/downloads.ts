// The shared browser's downloads (DESIGN-B1 2.12; SERVER-B1 10): Chrome saves each file under its download id (a
// GUID) in `<state>/browser/downloads/` (0700, opaque to the state folder's tree check), because kitespan sets
// Browser.setDownloadBehavior {allowAndName} at every connect. At `completed` the file is opened without following a
// link and made 0600, and a record goes into `<state>/browser/downloads.json` (0600): kitespan's id, the GUID, the
// suggested name cleaned as an upload's name is, the size and the time. The page lists the names, never the URLs; a
// file leaves only as an attachment. Files older than Settings' keep days go at boot, and the oldest go past 2 GB.

import { constants, mkdirSync } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BROWSER_LIMITS, type BrowserDownloadState, type BrowserDownloadView } from "../../shared/browser";
import { BROWSER_DOWNLOAD_ID, newBrowserDownloadId } from "../../shared/ids";
import { capText } from "../../shared/protocol";
import { readJson, writeAtomic } from "../store/files";
import { UNSAFE_NAME } from "../store/records";
import { uploadName } from "../store/uploads";

export const DOWNLOADS_FILE = "downloads.json";
export const DOWNLOAD_LIMITS = { fileBytes: 512 * 1024, records: 500, totalBytes: 2 * 1024 ** 3 } as const;

/** Chrome's download id: a GUID (the name of the file in the downloads folder). */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DownloadRecord {
  id: string;
  guid: string;
  name: string;
  size: number;
  at: string;
}

interface Live {
  id: string;
  guid: string;
  name: string;
  state: BrowserDownloadState;
  received: number;
  total: number;
  at: string;
  began: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A downloads.json record that passes its checks, or null. */
export function downloadRecordOf(v: unknown): DownloadRecord | null {
  if (!isObj(v)) return null;
  const { id, guid, name, size, at } = v;
  if (typeof id !== "string" || !BROWSER_DOWNLOAD_ID.test(id) || typeof guid !== "string" || !GUID.test(guid)) return null;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > BROWSER_LIMITS.downloadName || UNSAFE_NAME.test(name)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || typeof at !== "string" || at.length > 40) return null;
  return { id, guid, name, size, at };
}

/** A download's shown name: the suggested name cleaned as an upload's name, cut to 200 characters. */
export function downloadName(suggested: unknown): string {
  const n = uploadName(typeof suggested === "string" ? suggested : "", "");
  if (n === "pasted") return "download";
  return uploadName(capText(n, BROWSER_LIMITS.downloadName), "") || "download";
}

export interface DownloadsOptions {
  /** `<state>/browser`. */
  dir: string;
  uid: number;
  /** Settings' uploads.keepDays. */
  keepDays: () => Promise<number>;
  onChange: (view: BrowserDownloadView) => void;
  /** One `browser_download` line per download as it ends. */
  ended?: (ok: boolean, ms: number) => void;
  now?: () => number;
}

export class Downloads {
  private records: DownloadRecord[] = [];
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;
  private writing: Promise<void> = Promise.resolve();
  readonly folder: string;

  constructor(private readonly o: DownloadsOptions) {
    this.now = o.now ?? Date.now;
    this.folder = join(o.dir, "downloads");
  }

  /** Read downloads.json, and drop what is past the keep days or the 2 GB cap (at boot). */
  async open(): Promise<void> {
    let r;
    try {
      r = await readJson(join(this.o.dir, DOWNLOADS_FILE), DOWNLOAD_LIMITS.fileBytes, this.o.uid);
    } catch {
      r = { kind: "bad" as const };
    }
    const list = r.kind === "ok" && isObj(r.value) && Array.isArray(r.value.downloads) ? r.value.downloads : [];
    this.records = list.map(downloadRecordOf).filter((x): x is DownloadRecord => x !== null).slice(-DOWNLOAD_LIMITS.records);
    const keep = (await this.o.keepDays().catch(() => 7)) * 86_400_000;
    const cutoff = this.now() - keep;
    const old = this.records.filter((d) => Date.parse(d.at) < cutoff);
    for (const d of old) await this.unlinkFile(d.guid);
    this.records = this.records.filter((d) => !old.includes(d));
    await this.capTotal();
    // A file with no record (a download that a crash cut) goes too.
    const names = await readdir(this.folder).catch(() => [] as string[]);
    const known = new Set(this.records.map((d) => d.guid));
    for (const n of names) if (!known.has(n.replace(/\.crdownload$/, ""))) await this.unlinkFile(n);
    if (old.length) await this.persist();
  }

  private async capTotal(): Promise<void> {
    let total = this.records.reduce((n, d) => n + d.size, 0);
    while (total > DOWNLOAD_LIMITS.totalBytes && this.records.length > 0) {
      const d = this.records.shift()!;
      total -= d.size;
      await this.unlinkFile(d.guid);
    }
  }

  private async unlinkFile(name: string): Promise<void> {
    if (!GUID.test(name.replace(/\.crdownload$/, ""))) return;
    try {
      const st = await lstat(join(this.folder, name));
      if (st.isFile() || st.isSymbolicLink()) await unlink(join(this.folder, name));
    } catch {}
  }

  private persist(): Promise<void> {
    const text = `${JSON.stringify({ v: 1, downloads: this.records })}\n`;
    this.writing = this.writing.then(() => writeAtomic(this.o.dir, DOWNLOADS_FILE, text, DOWNLOAD_LIMITS.fileBytes, this.o.uid).catch(() => {}));
    return this.writing;
  }

  /** The list the page shows: those in progress, then the saved ones, newest first. */
  list(): BrowserDownloadView[] {
    const live = [...this.live.values()].map((d) => this.viewOf(d));
    const done = this.records.map((d): BrowserDownloadView => ({ id: d.id, name: d.name, state: "completed", received: d.size, total: d.size, at: d.at }));
    return [...live, ...done].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
  }

  private viewOf(d: Live): BrowserDownloadView {
    return { id: d.id, name: d.name, state: d.state, received: d.received, total: d.total, at: d.at };
  }

  /** Browser.downloadWillBegin. */
  begin(guid: unknown, suggested: unknown): void {
    if (typeof guid !== "string" || !GUID.test(guid) || this.live.has(guid)) return;
    try {
      mkdirSync(this.folder, { mode: 0o700 });
    } catch {}
    const d: Live = { id: newBrowserDownloadId(), guid, name: downloadName(suggested), state: "progress", received: 0, total: 0, at: new Date(this.now()).toISOString(), began: this.now() };
    this.live.set(guid, d);
    this.o.onChange(this.viewOf(d));
  }

  /** Browser.downloadProgress. */
  async progress(guid: unknown, received: unknown, total: unknown, state: unknown): Promise<void> {
    if (typeof guid !== "string") return;
    const d = this.live.get(guid);
    if (!d) return;
    if (typeof received === "number" && Number.isFinite(received) && received >= 0) d.received = Math.floor(received);
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) d.total = Math.floor(total);
    if (state === "inProgress") return this.o.onChange(this.viewOf(d));
    this.live.delete(guid);
    if (state === "completed") {
      const size = await this.seal(guid);
      if (size === null) {
        d.state = "canceled";
        this.o.ended?.(false, this.now() - d.began);
        return this.o.onChange(this.viewOf(d));
      }
      d.state = "completed";
      d.received = d.total = size;
      this.records.push({ id: d.id, guid, name: d.name, size, at: d.at });
      if (this.records.length > DOWNLOAD_LIMITS.records) for (const old of this.records.splice(0, this.records.length - DOWNLOAD_LIMITS.records)) await this.unlinkFile(old.guid);
      await this.capTotal();
      await this.persist();
      this.o.ended?.(true, this.now() - d.began);
      return this.o.onChange(this.viewOf(d));
    }
    d.state = "canceled";
    await this.unlinkFile(guid);
    this.o.ended?.(false, this.now() - d.began);
    this.o.onChange(this.viewOf(d));
  }

  /** The finished file: opened without following a link, a regular file, made 0600; its size, or null. */
  private async seal(guid: string): Promise<number | null> {
    let h;
    try {
      h = await open(join(this.folder, guid), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const st = await h.stat();
      if (!st.isFile() || (this.o.uid >= 0 && st.uid !== this.o.uid)) return null;
      await h.chmod(0o600);
      return st.size;
    } catch {
      return null;
    } finally {
      await h.close();
    }
  }

  /** The GUID of a download in progress (download_cancel), or null. */
  guidOf(id: string): string | null {
    for (const d of this.live.values()) if (d.id === id) return d.guid;
    return null;
  }

  /** A saved download's file, for the route that sends it. */
  fileOf(id: string): { path: string; name: string; size: number } | null {
    const d = this.records.find((r) => r.id === id);
    return d ? { path: join(this.folder, d.guid), name: d.name, size: d.size } : null;
  }

  /** Remove one saved download; false when there is none of that id. */
  async remove(id: string): Promise<boolean> {
    const d = this.records.find((r) => r.id === id);
    if (!d) return false;
    this.records = this.records.filter((r) => r !== d);
    await this.unlinkFile(d.guid);
    await this.persist();
    return true;
  }
}
