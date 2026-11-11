// kitespan's own page never runs in the shared browser (DESIGN-B1 D-21, 2.16 points 10, 21 and 22; S1). Three layers
// beside the Fetch block of the relay:
// - The document rule: a request for an app path whose Sec-Fetch-Site is `cross-site` or `same-site` (a load that
//   another site started: a link, a popup, a redirect, a form, a frame) gets 403 and a fixed page with no script and
//   no link. It reads no peer, so it holds through a forward. A request with no Sec-Fetch-Site (an older browser)
//   passes, and so do `none` (an address typed, a bookmark, a load the browser starts itself) and `same-origin`.
// - The same refusal on /ws/browser and the /api/browser routes (point 21; the existing /api reads keep their guards).
// - The peer check, on loopback: a request whose TCP peer's socket is held by a process of the shared Chrome's tree
//   (the browser pid of host.json and every process under it) gets 403, for the page shell, every upgrade and every
//   mutating /api request. Through a forward the peer is the forward's own process, which the other layers cover.

import { connectionInode, holderOf, systemProc, treeOf, type ProcReader } from "./procfs";

/** The words of the refusal page (DESIGN-B1 4.16). */
export const SELF_REFUSED_TEXT = "kitespan opens only from its own address. Open it from a bookmark or type its address.";

const SELF_REFUSED_HTML =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="color-scheme" content="light dark"><title>kitespan</title></head><body><p>${SELF_REFUSED_TEXT}</p></body></html>`;

/** True for a load that another site started: Sec-Fetch-Site `cross-site` or `same-site`. */
export function otherSite(req: Request): boolean {
  const v = req.headers.get("sec-fetch-site");
  return v === "cross-site" || v === "same-site";
}

/** The 403 page: no script, no link, nothing loads from it, never cached. */
export function selfRefused(head = false): Response {
  return new Response(head ? null : SELF_REFUSED_HTML, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      vary: "sec-fetch-site",
    },
  });
}

const LOOPBACK_PEER = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export interface PeerCheckOptions {
  /** kitespan's own port (the remote end of the peer's connection). */
  serverPort: number;
  /** The shared Chrome's browser pid while it runs, else null. */
  browserPid: () => number | null;
  proc?: ProcReader;
  now?: () => number;
}

/** How long a connection's answer is kept (a keep-alive connection asks once). */
const CACHE_MS = 30_000;

export class PeerCheck {
  private readonly proc: ProcReader;
  private readonly now: () => number;
  private readonly cache = new Map<string, { inode: string; shared: boolean; at: number }>();

  constructor(private readonly o: PeerCheckOptions) {
    this.proc = o.proc ?? systemProc;
    this.now = o.now ?? Date.now;
  }

  /** True when the peer's socket is held by the shared Chrome's tree. Any other peer, or no browser, passes. */
  shared(peer: { address: string; port: number } | null | undefined): boolean {
    const pid = this.o.browserPid();
    if (!peer || pid === null || !LOOPBACK_PEER.test(peer.address)) return false;
    const inode = connectionInode(this.proc, peer, this.o.serverPort);
    if (inode === null) return false;
    const key = `${peer.address}:${peer.port}`;
    const hit = this.cache.get(key);
    const t = this.now();
    if (hit && hit.inode === inode && t - hit.at < CACHE_MS) return hit.shared;
    const shared = holderOf(this.proc, inode, treeOf(this.proc, pid)) !== null;
    if (this.cache.size > 512) this.cache.clear();
    this.cache.set(key, { inode, shared, at: t });
    return shared;
  }
}
