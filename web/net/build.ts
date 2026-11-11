// The page's build after a restart (DESIGN.md 4.10). A server holds only its own build, read into memory at start
// (server/http/static.ts), and an open page keeps running the build it loaded: after Restart to apply, its lazy chunks
// (the Terminal pane's xterm) may be gone, and the code the owner applied is not in it. So when a `welcome` comes from
// another server life (an epoch this page life has not seen), the page reads the server's page (GET /, never from the
// cache) and compares the module scripts it names, whose names carry the build's hashes, with its own. Another build
// reloads the page once (the caller's reload keeps the 30 s guard; drafts are the server's, D49). A plain reconnect
// to the same server reads nothing, and so does the page life's first welcome.

import type { ServerFrame } from "../../shared/protocol";

/** The `src` of each module script of a page's HTML, in order. */
export function moduleScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    if (!/\btype\s*=\s*["']?module\b/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (src) out.push(src[1] ?? src[2]!);
  }
  return out;
}

export interface BuildWatch {
  /** The page's own module scripts, as its document names them. */
  own: readonly string[];
  /** The server's page now. */
  readPage(): Promise<string>;
  reload(): void;
}

/** Watch the welcomes: a new server life whose page names other module scripts reloads this page. */
export function watchBuild(conn: { on(fn: (f: ServerFrame) => void): () => void }, deps: BuildWatch): () => void {
  let epoch: string | null = null;
  return conn.on((f) => {
    if (f.t !== "welcome") return;
    const was = epoch;
    epoch = f.epoch;
    if (was === null || was === f.epoch || !deps.own.length) return;
    deps.readPage().then(
      (html) => {
        const now = moduleScripts(html);
        if (now.length && (now.length !== deps.own.length || now.some((s, i) => s !== deps.own[i]))) deps.reload();
      },
      () => {}, // no answer: the next new server life asks again
    );
  });
}
