// One HTTP/1.1 exchange with the kitespan on 127.0.0.1:<port> (DESIGN.md 4.10: the restart's health gate and
// `bin/kitespan restart`), over a plain TCP socket (Bun.connect). Never fetch: Bun's fetch sends a request for
// 127.0.0.1 through HTTP_PROXY or http_proxy unless NO_PROXY names that host, and bin/kitespan keeps the user's proxy
// variables (they are the user's, for Claude Code), so on a machine with a proxy every restart would fail after its
// close. A socket knows no proxy.
//
// The answer is read strictly, and at most `maxBytes` of it in all: the status line (HTTP/1.0 or 1.1, a status from 200
// to 599), header lines that end in CRLF (a token name, no folded line, no control byte), exactly one Content-Length
// and no Transfer-Encoding, then that many bytes of body and nothing after them. Anything else, a peer that closes
// early, or the deadline, is a LoopbackError. The body is small JSON (the health route's epoch, the restart's answer).

export const LOOPBACK_LIMITS = { maxBytes: 16 * 1024, maxHeaders: 64 } as const;

export class LoopbackError extends Error {
  override readonly name = "LoopbackError";
}

export interface LoopbackRequest {
  port: number;
  method: "GET" | "POST";
  /** The path, from its "/" (no space, no control byte). */
  path: string;
  /** More header lines; Host, Connection and Content-Length are this module's own. */
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** The whole exchange's deadline, from the connect to the last byte. */
  timeoutMs: number;
  maxBytes?: number;
}

export interface LoopbackAnswer {
  status: number;
  /** The body as JSON; undefined when it is empty or not JSON. */
  json: unknown;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A header value: visible ASCII, spaces and tabs (obs-text too in an answer), no CR, LF or other control byte. */
const VALUE_OUT = /^[\t\x20-\x7e]*$/;
const PATH = /^\/[\x21-\x7e]*$/;
const STATUS_LINE = /^HTTP\/1\.[01] ([2-5][0-9]{2})(?: [\t\x20-\x7e]*)?$/;
const HEADER_LINE = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[\t ]*([\t\x20-\x7e\x80-\xff]*?)[\t ]*$/;
const LENGTH = /^[0-9]{1,9}$/;
const OWN_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding"]);

function requestBytes(r: LoopbackRequest): Uint8Array {
  if (!PATH.test(r.path)) throw new LoopbackError("bad path");
  const body = r.body === undefined ? null : new TextEncoder().encode(r.body);
  const lines = [`${r.method} ${r.path} HTTP/1.1`, `Host: 127.0.0.1:${r.port}`, "Connection: close"];
  for (const [name, value] of Object.entries(r.headers ?? {})) {
    if (!TOKEN.test(name) || !VALUE_OUT.test(value) || OWN_HEADERS.has(name.toLowerCase())) throw new LoopbackError("bad header");
    lines.push(`${name}: ${value}`);
  }
  if (body || r.method === "POST") lines.push(`Content-Length: ${body?.length ?? 0}`);
  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (!body) return head;
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** The index of the CRLF CRLF that ends the head, or -1. */
function headEnd(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
}

/**
 * The answer in `bytes`, read strictly (see the file's head): null while it is not whole and the peer may send more
 * (`eof` false). Throws LoopbackError for an answer that breaks a rule, that passes `max` bytes, or that the peer's end
 * (`eof`) cut.
 */
export function parseAnswer(bytes: Uint8Array, max: number, eof: boolean): LoopbackAnswer | null {
  if (bytes.length > max) throw new LoopbackError("answer too large");
  const end = headEnd(bytes);
  if (end < 0) {
    if (eof) throw new LoopbackError("answer cut");
    return null;
  }
  // One character per byte (ISO 8859-1), so the rules below see every byte as it came.
  const lines = Buffer.from(bytes.buffer, bytes.byteOffset, end).toString("latin1").split("\r\n");
  const status = STATUS_LINE.exec(lines[0]!);
  if (!status) throw new LoopbackError("bad status line");
  if (lines.length - 1 > LOOPBACK_LIMITS.maxHeaders) throw new LoopbackError("too many headers");
  let length: number | null = null;
  for (const line of lines.slice(1)) {
    const h = HEADER_LINE.exec(line);
    if (!h) throw new LoopbackError("bad header line");
    const name = h[1]!.toLowerCase();
    if (name === "transfer-encoding") throw new LoopbackError("transfer-encoding");
    if (name === "content-length") {
      if (length !== null || !LENGTH.test(h[2]!)) throw new LoopbackError("bad content-length");
      length = Number(h[2]);
    }
  }
  if (length === null) throw new LoopbackError("no content-length");
  const start = end + 4;
  if (start + length > max) throw new LoopbackError("answer too large");
  if (bytes.length < start + length) {
    if (eof) throw new LoopbackError("answer cut");
    return null;
  }
  if (bytes.length > start + length) throw new LoopbackError("bytes after the body");
  let json: unknown;
  try {
    json = length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start))) : undefined;
  } catch {
    json = undefined;
  }
  return { status: Number(status[1]), json };
}

/** One request to 127.0.0.1:<port> and its answer; rejects with LoopbackError on any failure. */
export function loopback(r: LoopbackRequest): Promise<LoopbackAnswer> {
  const max = r.maxBytes ?? LOOPBACK_LIMITS.maxBytes;
  let request: Uint8Array;
  try {
    request = requestBytes(r);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise<LoopbackAnswer>((resolve, reject) => {
    let socket: { write(b: Uint8Array): number; terminate(): void } | null = null;
    let done = false;
    let got = new Uint8Array(0);
    let left = request;
    const finish = (answer: LoopbackAnswer | null, err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.terminate();
      if (answer) resolve(answer);
      else reject(err instanceof LoopbackError ? err : new LoopbackError("failed"));
    };
    const timer = setTimeout(() => finish(null, new LoopbackError("deadline")), Math.max(1, r.timeoutMs));
    const read = (eof: boolean) => {
      try {
        const answer = parseAnswer(got, max, eof);
        if (answer) finish(answer);
      } catch (e) {
        finish(null, e);
      }
    };
    const flush = () => {
      if (!socket || done || left.length === 0) return;
      const n = socket.write(left);
      if (n > 0) left = left.subarray(n);
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port: r.port,
      socket: {
        open(s) {
          socket = s;
          if (done) s.terminate();
          else flush();
        },
        drain() {
          flush();
        },
        data(_s, chunk) {
          if (done) return;
          if (got.length + chunk.length > max) return finish(null, new LoopbackError("answer too large"));
          const next = new Uint8Array(got.length + chunk.length);
          next.set(got);
          next.set(chunk, got.length);
          got = next;
          read(false);
        },
        end() {
          read(true);
        },
        close() {
          read(true);
        },
        error(_s, e) {
          finish(null, e);
        },
        connectError(_s, e) {
          finish(null, e);
        },
      },
    }).then(
      (s) => {
        socket ??= s;
        if (done) s.terminate();
      },
      (e) => finish(null, e),
    );
  });
}

/** One read of GET /api/health on 127.0.0.1:<port> (the restart's gate): the epoch that answered, or null. */
export async function readHealth(port: number, timeoutMs: number): Promise<string | null> {
  try {
    const a = await loopback({ port, method: "GET", path: "/api/health", headers: { Accept: "application/json" }, timeoutMs });
    const epoch = a.status === 200 && a.json !== null && typeof a.json === "object" ? (a.json as { epoch?: unknown }).epoch : null;
    return typeof epoch === "string" ? epoch : null;
  } catch {
    return null;
  }
}

/**
 * Whether anything accepts a TCP connection on 127.0.0.1:<port> (the folder move's check before a start's bind: a
 * server there may use the folders). A refused connection is no; an accepted one, or none by the deadline, is yes.
 */
export function listening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (yes: boolean, s?: { terminate(): void }) => {
      s?.terminate();
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(yes);
    };
    const timer = setTimeout(() => finish(true), Math.max(1, timeoutMs));
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open: (s) => finish(true, s),
        data() {},
        error() {},
        connectError: () => finish(false),
      },
    }).then(
      (s) => {
        if (done) s.terminate();
      },
      () => finish(false),
    );
  });
}
