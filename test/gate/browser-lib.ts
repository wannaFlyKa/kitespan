// What the browser pane's gate tests share (DESIGN-B1 7.2, 7.4): a Chrome for Testing to run as the shared browser, a
// free debugging port from 9341 to 9349 (never 9340, the owner's), short scratch folders under the test's TMPDIR, a
// stand-in for a pane socket, and the stop of a Chrome that a test spawned: only a pid the test recorded, after kill -0
// and a check that its command line (in either form) names the test's own profile. Never a process found by a pattern.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCastFrame, type BrowserServerFrame, type CastHeader } from "../../shared/browser";
import { browserCandidates, binaryProblem } from "../../server/browser/config";
import { cmdlineCheck, startOf, systemProc } from "../../server/browser/procfs";
import type { RelayConn } from "../../server/browser/relay";

/** The ports a test may give the shared browser; 9340 is the owner's and is never one. */
export const CDP_PORTS = [9345, 9341, 9342, 9343, 9344, 9346, 9347, 9348, 9349] as const;

/** A Chrome for Testing in the installers' caches (never the user's own Chrome), or null. */
export function testChrome(): string | null {
  return browserCandidates("", homedir()).find((p) => binaryProblem(p) === null) ?? null;
}

function portFree(port: number): boolean {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** The first free debugging port of CDP_PORTS that is not in `not`. */
export function cdpPort(not: readonly number[] = []): number {
  for (const p of CDP_PORTS) if (!not.includes(p) && portFree(p)) return p;
  throw new Error("every test debugging port from 9341 to 9349 is in use");
}

/** A new short scratch folder under the test's TMPDIR (Chrome's socket path must stay under 108 bytes). */
export function scratch(tag: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${tag}-`)));
}

/** A state and a config folder (0700) with browser.json naming the test Chrome and port, loopback only. */
export function browserFolders(root: string, chrome: string, port: number, more: Record<string, unknown> = {}): { state: string; config: string } {
  const state = join(root, "state");
  const config = join(root, "config");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, "browser.json"), JSON.stringify({ v: 1, chrome, port, loopbackOnly: true, ...more }), { mode: 0o600 });
  return { state, config };
}

/** The pids a test spawned, with the profile each names: the only processes it may signal. */
export const spawned: { pid: number; profile: string }[] = [];

export function recordPid(pid: number, profile: string, log?: string): void {
  spawned.push({ pid, profile });
  if (log) writeFileSync(log, `${pid} ${new Date().toISOString()}\n`, { flag: "a" });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop the recorded Chromes that still run: SIGTERM, then SIGKILL, each after kill -0 and the profile check. */
export async function stopSpawned(): Promise<number[]> {
  const stopped: number[] = [];
  for (const { pid, profile } of spawned) {
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      if (!alive(pid) || startOf(systemProc, pid) === null) break;
      if (!cmdlineCheck(systemProc.read(`/proc/${pid}/cmdline`), [`--user-data-dir=${profile}`], []).ok) break;
      process.kill(pid, sig);
      stopped.push(pid);
      const end = Date.now() + 5_000;
      while (alive(pid) && startOf(systemProc, pid) !== null && Date.now() < end) await Bun.sleep(50);
    }
  }
  return stopped;
}

/** A pane socket's stand-in: every text frame it got, and the decoded binary frames. */
export class FakeConn implements RelayConn {
  readonly frames: BrowserServerFrame[] = [];
  readonly casts: { header: CastHeader; bytes: number }[] = [];
  closed: number | null = null;
  bufferedBytes = 0;
  /** Ack every frame as drawn (the page's `drawn`), through this function. */
  onCast: ((h: CastHeader) => void) | null = null;

  send(frame: BrowserServerFrame): void {
    this.frames.push(frame);
  }
  sendBinary(bytes: Uint8Array): number {
    const d = decodeCastFrame(bytes);
    if (d) {
      this.casts.push({ header: d.header, bytes: d.jpeg.length });
      this.onCast?.(d.header);
    }
    return bytes.length;
  }
  buffered(): number {
    return this.bufferedBytes;
  }
  close(code: number): void {
    this.closed = code;
  }
  of<T extends BrowserServerFrame["t"]>(t: T): Extract<BrowserServerFrame, { t: T }>[] {
    return this.frames.filter((f): f is Extract<BrowserServerFrame, { t: T }> => f.t === t);
  }
  last<T extends BrowserServerFrame["t"]>(t: T): Extract<BrowserServerFrame, { t: T }> | undefined {
    return this.of(t).at(-1);
  }
  async wait<T>(what: string, get: () => T | null | undefined | false, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = get();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; frames: ${this.frames.slice(-12).map((f) => f.t).join(", ")}`);
      await Bun.sleep(25);
    }
  }
}

/** The JSON of a file, or null. */
export function readJsonFile(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}
