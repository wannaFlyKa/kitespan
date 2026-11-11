// The address field (PAGE-B1 3.2): typed text to an address, and the field's picture at rest. Typed text with no scheme
// gets `http://` for localhost, a name under it, a loopback or other IP address, and a bare host:port, and `https://`
// otherwise; there is no search engine, so text that is no address gets its line. An http or https address, or exactly
// about:blank, passes the shared URL rule (shared/browser.ts browserUrlProblem), which the server runs again with its
// whole list. At rest the field shows the host in --text and the rest in --dim, with no scheme.
import { BROWSER_ERROR_MESSAGES, browserUrlProblem, normalBrowserUrl, type BrowserUrlRefusals } from "../../shared/browser";

export const ADDRESS_LINES = {
  notAddress: "Type a web address, such as localhost:3000 or example.com.",
  scheme: "Only http and https addresses open here.",
  refused: BROWSER_ERROR_MESSAGES.url_refused,
} as const;

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const HOST_PORT = /^[^\s/:?#@]+:\d{1,5}(?:[/?#]|$)/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The host part of a schemeless address: up to the first slash, question mark or hash, less a port. */
function hostOf(text: string): string {
  const head = text.split(/[/?#]/)[0] ?? "";
  if (head.startsWith("[")) return head.slice(0, head.indexOf("]") + 1);
  return head.replace(/:\d{1,5}$/, "");
}

/**
 * The address that typed `text` opens, or the line that says why it opens nothing; null for empty text. `refused`:
 * kitespan's own origins and the loopback ports that the shared rule refuses (the page passes its own origin and the
 * browser's debugging port; the server checks again with every allowed origin).
 */
export function typedAddress(text: string, refused: BrowserUrlRefusals): { url: string } | { problem: string } | null {
  const t = text.trim();
  if (!t) return null;
  let candidate: string;
  const scheme = SCHEME.exec(t);
  if (scheme && !HOST_PORT.test(t)) {
    const s = scheme[1]!.toLowerCase();
    if (t === "about:blank") candidate = t;
    else if (s !== "http" && s !== "https") return { problem: ADDRESS_LINES.scheme };
    else candidate = t;
  } else {
    if (/\s/.test(t)) return { problem: ADDRESS_LINES.notAddress };
    const host = hostOf(t).toLowerCase();
    if (!host) return { problem: ADDRESS_LINES.notAddress };
    const loopback = host === "localhost" || host.endsWith(".localhost") || host.startsWith("[");
    const plain = loopback || IPV4.test(host) || HOST_PORT.test(t);
    if (!plain && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?$/i.test(host)) return { problem: ADDRESS_LINES.notAddress };
    candidate = `${plain ? "http" : "https"}://${t}`;
  }
  const problem = browserUrlProblem(candidate, refused);
  if (problem === "scheme") return { problem: ADDRESS_LINES.scheme };
  if (problem === "own" || problem === "browser_port") return { problem: ADDRESS_LINES.refused };
  if (problem) return { problem: ADDRESS_LINES.notAddress };
  return { url: normalBrowserUrl(candidate) };
}

/** The field's picture at rest: an http or https address as its host and the rest; nothing for a blank tab. */
export function addressShown(url: string): { host: string; rest: string } {
  if (!url || url === "about:blank") return { host: "", rest: "" };
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
      return { host: u.host, rest };
    }
  } catch {
    // shown whole
  }
  return { host: "", rest: url };
}

/** The address the field shows for a tab at rest: a blank tab's is the empty field. */
export const fieldUrl = (url: string | null | undefined): string => (url && url !== "about:blank" ? url : "");

/**
 * Esc in the address field (PAGE-B1 17): the address it puts back (the tab's, as the field shows it; a draft's is
 * empty), or null when the field already shows it, so the Esc is not the field's (over the chat it closes the layer).
 */
export function escapeAddress(value: string, tabUrl: string | null): string | null {
  const url = fieldUrl(tabUrl);
  return value === url ? null : url;
}

/** The address field's own refusals on this page: its own origin, kitespan's port on a loopback name, the browser's port. */
export function pageRefusals(browserPort: number | null, loc: Pick<Location, "origin" | "port" | "hostname" | "protocol"> | null = typeof location === "undefined" ? null : location): BrowserUrlRefusals {
  const ports: number[] = [];
  if (loc) {
    const port = loc.port ? Number(loc.port) : loc.protocol === "https:" ? 443 : 80;
    ports.push(port);
  }
  if (browserPort) ports.push(browserPort);
  return { origins: loc ? [loc.origin] : [], loopbackPorts: ports };
}
