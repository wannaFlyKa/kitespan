// The browser pane's local test site (DESIGN-B1 7.4): the pages that the click-through, the gate tests and the
// ui-check open in the shared browser. One Bun server on 127.0.0.1 (a port the system picks, or one the caller names),
// never anything from the internet. Each page writes what happened into its own title, so a test reads the result
// from the pane's tab list (the strip's titles) without running any script in the page.
//
//   /                  a list of the pages
//   /plain?t=<title>   a page with that title
//   /inputs            a textarea, a text and a password field, a select (an optgroup, a disabled option), a multiple
//                      select, the date-like inputs and a colour with a list, single and multiple file inputs
//   /dialogs           alert, confirm and prompt buttons; the answer goes into the title
//   /chooser           one file input over the whole page (accept .txt and text/plain; ?multiple=1 for several)
//   /select, /date     one select, one date input, over the whole page (a tap anywhere opens it)
//   /text              a textarea over the top 70% of the page ("one two three") and a password field below it
//   /first-dialog      a page whose first script opens an alert
//   /popup             a target=_blank link, a window.open button and a popup window, each to /plain
//   /download          a link to /file.txt, which is an attachment
//   /scroll            a tall page with a button near the top
//   /anim              a page that changes every frame (a cast never runs dry)
//   /hostile?vec=<v>&to=<url>  a page that tries to load <url> one way (the forward cases of S1): link_blank,
//                      link_self, open_tab, open_popup, location, form_post, redirect, meta, auto_location, iframe,
//                      worker, page_fetch
//   /r?to=<url>        a 302 to <url>; /meta?to=<url> a meta refresh; /worker.js?to=<url> a worker that fetches it
//
// As a script: bun test/click/browser-site.ts [--port <port>] prints its address and serves until Ctrl+C.

import type { Server } from "bun";

export interface BrowserSite {
  /** http://127.0.0.1:<port> */
  base: string;
  port: number;
  /** Every request the site answered, newest last: the method, the path, and the Sec-Fetch headers. */
  hits: { method: string; path: string; dest: string | null; site: string | null }[];
  stop(): void;
}

const FULL = "position:fixed;left:0;top:0;width:100vw;height:100vh;display:block;margin:0;border:0;font-size:40px";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** A URL for a script string: JSON keeps it one string literal. */
const js = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${head}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;
}

const PAGES: Record<string, () => string> = {
  "/": () =>
    page(
      "site index",
      `<ul>${["plain", "inputs", "dialogs", "first-dialog", "popup", "download", "scroll", "anim"].map((p) => `<li><a href="/${p}">${p}</a></li>`).join("")}</ul>`,
    ),
  "/inputs": () =>
    page(
      "inputs",
      `<form onsubmit="return false" style="display:grid;gap:8px;padding:8px;max-width:600px">
<label>Notes <textarea id="ta" rows="3">one two three</textarea></label>
<label>Name <input id="text" type="text" value="hello"></label>
<label>Secret <input id="pw" type="password" value="hidden"></label>
<label>Fruit <select id="s1"><option>Apple</option><option>Banana</option><option disabled>Cherry</option><optgroup label="More"><option>Date</option><option>Elder</option></optgroup></select></label>
<label>Many <select id="multi" multiple size="3"><option>One</option><option>Two</option><option>Three</option></select></label>
<label>Day <input id="date" type="date" value="2026-11-09"></label>
<label>Time <input id="time" type="time" value="13:45"></label>
<label>When <input id="dtl" type="datetime-local" value="2026-11-09T13:45"></label>
<label>Month <input id="month" type="month" value="2026-11"></label>
<label>Week <input id="week" type="week" value="2026-W45"></label>
<label>Colour <input id="color" type="color" value="#336699" list="swatches"></label>
<datalist id="swatches"><option value="#ff0000"><option value="#00ff00"><option value="#0000ff"></datalist>
<label>File <input id="file" type="file" accept=".txt,text/plain"></label>
<label>Files <input id="files" type="file" multiple></label>
</form>
<script>
for (const el of document.querySelectorAll('input,select,textarea')) el.addEventListener('change', () => {
  const v = el.type === 'file' ? 'file=' + [...el.files].map((f) => f.name).join('+') : el.id + '=' + el.value;
  document.title = v;
});
for (const id of ['file', 'files']) document.getElementById(id).addEventListener('cancel', () => { document.title = id + ':cancel'; });
</script>`,
    ),
  "/dialogs": () =>
    page(
      "dialogs",
      `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;height:100vh">
<button id="alert" onclick="alert('hello from the site'); document.title='alert done'">Alert</button>
<button id="confirm" onclick="document.title='confirm=' + confirm('proceed?')">Confirm</button>
<button id="prompt" onclick="document.title='prompt=' + prompt('your name?', 'nobody')">Prompt</button>
</div>`,
    ),
  "/select": () =>
    page(
      "select",
      `<select id="s" style="${FULL}"><option>Apple</option><option>Banana</option><option disabled>Cherry</option><optgroup label="More"><option>Date</option></optgroup></select>
<script>document.getElementById('s').addEventListener('change', (e) => { document.title = 's=' + e.target.value; });</script>`,
    ),
  "/date": () =>
    page("date", `<input id="d" type="date" value="2026-11-09" style="${FULL}"><script>document.getElementById('d').addEventListener('change', (e) => { document.title = 'd=' + e.target.value; });</script>`),
  "/text": () =>
    page(
      "text",
      `<textarea id="ta" style="position:fixed;left:0;top:0;width:100vw;height:70vh;margin:0;font-size:24px">one two three</textarea>
<input id="pw" type="password" value="hidden" style="position:fixed;left:0;top:75vh;width:100vw;height:20vh;font-size:24px">
<script>document.getElementById('ta').addEventListener('input', (e) => { document.title = 'ta=' + e.target.value; });</script>`,
    ),
  "/first-dialog": () => page("first dialog", `<p>A page whose first script opens an alert.</p><script>alert('first'); document.title = 'after first';</script>`),
  "/popup": () =>
    page(
      "popup",
      `<div style="display:grid;grid-template-rows:1fr 1fr 1fr;height:100vh">
<a id="blank" href="/plain?t=opened%20by%20link" target="_blank">A link to a new tab</a>
<button id="open" onclick="window.open('/plain?t=opened%20by%20script')">window.open</button>
<button id="pop" onclick="window.open('/plain?t=a%20popup', 'p', 'popup,width=400,height=400')">A popup</button>
</div>`,
    ),
  "/download": () => page("download", `<a id="dl" href="/file.txt" style="${FULL}">Download the file</a>`),
  "/scroll": () => page("scroll", `<button id="top" style="width:100%;height:120px" onclick="document.title='top pressed'">Top</button><div style="height:6000px;background:linear-gradient(#fff,#88a)"></div>`),
  "/anim": () =>
    page(
      "anim",
      `<canvas id="c" width="320" height="200" style="width:100%;height:100vh"></canvas><script>
const c = document.getElementById('c').getContext('2d'); let i = 0;
(function f() { c.fillStyle = 'hsl(' + (i++ % 360) + ',70%,50%)'; c.fillRect(0, 0, 320, 200); requestAnimationFrame(f); })();
</script>`,
    ),
};

/** The hostile page of one forward case (S1, DESIGN-B1 2.16 point 22; B1's x3 list). */
export function hostilePage(vec: string, to: string): string {
  const u = js(to);
  const body: Record<string, string> = {
    link_blank: `<a style="${FULL}" href="${esc(to)}" target="_blank">go</a>`,
    link_self: `<a style="${FULL}" href="${esc(to)}">go</a>`,
    open_tab: `<button style="${FULL}" onclick='window.open(${u})'>go</button>`,
    open_popup: `<button style="${FULL}" onclick='window.open(${u}, "p", "popup,width=400,height=400")'>go</button>`,
    location: `<button style="${FULL}" onclick='location.href = ${u}'>go</button>`,
    form_post: `<form method="post" action="${esc(to)}"><input type="hidden" name="a" value="1"><button style="${FULL}">go</button></form>`,
    redirect: `<button style="${FULL}" onclick='location.href = "/r?to=" + encodeURIComponent(${u})'>go</button>`,
    meta: `<button style="${FULL}" onclick='location.href = "/meta?to=" + encodeURIComponent(${u})'>go</button>`,
    auto_location: `<script>location.href = ${u};</script>`,
    iframe: `<iframe src="${esc(to)}" style="${FULL}"></iframe>`,
    worker: `<script>new Worker("/worker.js?to=" + encodeURIComponent(${u}));</script>`,
    page_fetch: `<script>fetch(${u}, { mode: "no-cors" }).catch(() => {});</script>`,
  };
  return page(`hostile ${vec}`, body[vec] ?? "plain");
}

/** The vectors that a click starts, and those that start by themselves (B1's x3 list). */
export const HOSTILE_CLICKED = ["link_blank", "link_self", "open_tab", "open_popup", "location", "form_post", "redirect", "meta"] as const;
export const HOSTILE_LOADED = ["auto_location", "iframe", "worker", "page_fetch"] as const;

function answer(req: Request, url: URL): Response {
  const html = (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
  const to = url.searchParams.get("to") ?? "";
  switch (url.pathname) {
    case "/plain":
      return html(page(url.searchParams.get("t") ?? "plain", `<p>${esc(url.searchParams.get("t") ?? "plain")}</p>`));
    case "/file.txt":
      return new Response("kitespan test download\n", { headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="site-file.txt"' } });
    case "/chooser": {
      const multiple = url.searchParams.get("multiple") === "1";
      return html(
        page(
          "chooser",
          `<input id="f" type="file" accept=".txt,text/plain" ${multiple ? "multiple" : ""} aria-label="Attachment" style="${FULL}">
<script>const f = document.getElementById('f');
f.addEventListener('change', () => { document.title = 'file=' + [...f.files].map((x) => x.name).join('+'); });
f.addEventListener('cancel', () => { document.title = 'file:cancel'; });</script>`,
        ),
      );
    }
    case "/hostile":
      return html(hostilePage(url.searchParams.get("vec") ?? "", to));
    case "/r":
      return new Response(null, { status: 302, headers: { location: to } });
    case "/meta":
      return html(page("meta", "", `<meta http-equiv="refresh" content="0;url=${esc(to)}">`));
    case "/worker.js":
      return new Response(`fetch(${js(to)}, { mode: "no-cors" }).catch(() => {});`, { headers: { "content-type": "text/javascript" } });
  }
  const p = PAGES[url.pathname];
  if (p && (req.method === "GET" || req.method === "HEAD")) return html(p());
  return html(page("not here", "not here"), 404);
}

/**
 * Start the site on 127.0.0.1. `port` 0 (the default) lets the system pick one that nothing uses. `tls`: serve https
 * with this key and certificate (the forward cases' hostile names), with `hostname` still 127.0.0.1.
 */
export function startBrowserSite(opts: { port?: number; tls?: { key: string; cert: string } } = {}): BrowserSite {
  const hits: BrowserSite["hits"] = [];
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    reusePort: false,
    ...(opts.tls ? { tls: { key: opts.tls.key, cert: opts.tls.cert } } : {}),
    fetch(req) {
      const url = new URL(req.url);
      hits.push({ method: req.method, path: url.pathname + url.search, dest: req.headers.get("sec-fetch-dest"), site: req.headers.get("sec-fetch-site") });
      if (hits.length > 2_000) hits.splice(0, 1_000);
      return answer(req, url);
    },
  });
  const port = server.port!;
  return { base: `${opts.tls ? "https" : "http"}://127.0.0.1:${port}`, port, hits, stop: () => void server.stop(true) };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--port");
  const site = startBrowserSite({ port: i > 0 ? Number(process.argv[i + 1]) : 0 });
  console.log(`browser-site: ${site.base}/ (Ctrl+C stops it)`);
  process.on("SIGINT", () => {
    site.stop();
    process.exit(0);
  });
}
