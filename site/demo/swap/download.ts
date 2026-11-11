// Downloads in the demo's build only (DESIGN-W1 2.3, 4.2): the demo's files are on no disk, so the existence probe and
// a Download press answer with the demo's line, which the app shows where it shows any refused download (under the
// button, in the file's own view, or as the chat's notice). Every other export is web/panels/download.ts's own; the
// site's build resolves each import of that file to this one, and leaves this file's own imports of it alone.
import type { ProbeResult } from "../../../web/panels/download";
import { DEMO_LINES } from "../lines";

export * from "../../../web/panels/download";

/** What a download says in the demo: not done here, with the demo's line (501: the server does not do it). */
export const DEMO_DOWNLOAD: ProbeResult = { ok: false, status: 501, line: DEMO_LINES.downloads };

export async function probe(_url: string, _what: "file" | "upload", _fetcher?: typeof fetch): Promise<ProbeResult> {
  return DEMO_DOWNLOAD;
}

export async function download(_url: string, _what: "file" | "upload", _fetcher?: typeof fetch, _save?: (url: string) => void): Promise<ProbeResult> {
  return DEMO_DOWNLOAD;
}
