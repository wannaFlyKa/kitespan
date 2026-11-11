// R130 (DESIGN-R130 section 3): a stub push service on 127.0.0.1, for the unit tests and the click-through's `notify`
// flow. It never calls any other host, and no real push service is used. Each subscription it gives is a receiver as a
// browser makes one: a P-256 key pair and a 16-octet auth secret, new per subscription, never printed. A push to one
// of its endpoints (`POST /push/<id>`) is recorded: the headers (the Authorization value cut short), whether the VAPID
// token verifies with the `k` it carries (aud its own origin, exp within 24 h, sub a `mailto:` or `https:` contact),
// and the plaintext, decrypted with node:crypto (createECDH, hkdfSync, createDecipheriv), so the check shares no code
// with the server's WebCrypto sender. It answers 201 with a Location, or the status a test names for a subscription.
//
// `fetch` is an in-process stand-in for the server's sender (no socket at all); `listen: true` also serves it on a port
// the system picks, for a server in another process (KITESPAN_PUSH_TEST_ORIGIN=<origin>, with NO_PROXY=127.0.0.1).

import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from "node:crypto";

export interface StubPush {
  /** The subscription's id (its endpoint's last segment). */
  id: string;
  status: number;
  /** Lowercase header names; `authorization` cut to its first 12 characters. */
  headers: Record<string, string>;
  /** The body's length in octets. */
  bytes: number;
  /** "ok", or what is wrong with the VAPID token. */
  vapid: string;
  /** The token's claims, when it parsed. */
  claims: { aud?: unknown; exp?: unknown; sub?: unknown } | null;
  /** The `k` of the Authorization header (the server's public key). */
  k: string | null;
  /** The decrypted plaintext (without its padding), or null when it did not decrypt. */
  plain: string | null;
  /** The plaintext's padded length (with the 0x02 delimiter and the zeros). */
  padded: number | null;
}

export interface StubSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushStub {
  readonly origin: string;
  readonly received: StubPush[];
  /** A new receiver: its subscription JSON, as `PushSubscription.toJSON()` gives it. */
  subscribe(id?: string): StubSubscription;
  /** The status this subscription's pushes get from now on (201 by default; 404 and 410 say it is gone). */
  answer(id: string, status: number): void;
  /** Hold every answer until release() (a push service that does not answer). */
  hold(): void;
  release(): void;
  /** The pushes so far, once there are at least `n`, or after `ms` with what there is. */
  waitFor(n: number, ms?: number): Promise<StubPush[]>;
  /** The server's sender's stand-in for fetch: the request goes to the stub's handler in this process. */
  fetch(url: string, init: RequestInit): Promise<Response>;
  stop(): void;
}

const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

interface Receiver {
  ecdh: ECDH;
  publicKey: Buffer;
  auth: Buffer;
  status: number;
}

function decrypt(body: Buffer, r: Receiver): { plain: string; padded: number } {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  if (idlen !== 65 || rs < 18 || sealed.length > rs || sealed.length < 17) throw new Error("bad header");
  const secret = r.ecdh.computeSecret(asPublic);
  const info = (label: string) => Buffer.concat([Buffer.from(label, "latin1"), Buffer.from([0])]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, r.auth, Buffer.concat([info("WebPush: info"), r.publicKey, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: aes128gcm"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: nonce"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("bad padding delimiter");
  return { plain: padded.subarray(0, end).toString("utf8"), padded: padded.length };
}

function checkVapid(header: string | null, origin: string): { vapid: string; claims: StubPush["claims"]; k: string | null } {
  const m = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return { vapid: "no vapid authorization", claims: null, k: null };
  const [h, c, s] = m[1]!.split(".") as [string, string, string];
  const k = m[2]!;
  let claims: StubPush["claims"] = null;
  try {
    claims = JSON.parse(unb64u(c).toString("utf8"));
    const head = JSON.parse(unb64u(h).toString("utf8"));
    if (head.alg !== "ES256" || head.typ !== "JWT") return { vapid: "not an ES256 JWT", claims, k };
  } catch {
    return { vapid: "the token does not parse", claims, k };
  }
  const point = unb64u(k);
  if (point.length !== 65 || point[0] !== 4) return { vapid: "k is not a P-256 point", claims, k };
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: "jwk" });
    if (!verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, unb64u(s))) return { vapid: "the signature does not verify", claims, k };
  } catch {
    return { vapid: "the signature does not verify", claims, k };
  }
  const now = Date.now() / 1000;
  if (claims?.aud !== origin) return { vapid: "aud is not the push service's origin", claims, k };
  if (typeof claims.exp !== "number" || claims.exp <= now || claims.exp > now + 86_400) return { vapid: "exp is not within 24 h", claims, k };
  if (typeof claims.sub !== "string" || !/^(mailto:|https:)/.test(claims.sub)) return { vapid: "sub is not a mailto: or https: contact", claims, k };
  return { vapid: "ok", claims, k };
}

/** A stub push service; `listen` serves it on 127.0.0.1 at a port the system picks, else it is in-process only. */
export function startPushStub(opts: { listen?: boolean } = {}): PushStub {
  const receivers = new Map<string, Receiver>();
  const received: StubPush[] = [];
  let held: (() => void)[] | null = null;
  let n = 0;
  let origin = "http://127.0.0.1:9";

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = /^\/push\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname)?.[1];
    const r = id ? receivers.get(id) : undefined;
    if (req.method !== "POST" || !id || !r) return new Response(null, { status: 404 });
    const body = Buffer.from(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k.toLowerCase()] = k.toLowerCase() === "authorization" ? `${v.slice(0, 12)}...` : v));
    const v = checkVapid(req.headers.get("authorization"), origin);
    let plain: string | null = null;
    let padded: number | null = null;
    try {
      ({ plain, padded } = decrypt(body, r));
    } catch {
      plain = null;
    }
    received.push({ id, status: r.status, headers, bytes: body.length, vapid: v.vapid, claims: v.claims, k: v.k, plain, padded });
    if (held) await new Promise<void>((done) => held!.push(done));
    const ok = r.status === 201;
    return new Response(null, { status: r.status, headers: ok ? { location: `${origin}/message/${++n}`, ttl: headers.ttl ?? "0" } : {} });
  }

  const server = opts.listen ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle }) : null;
  if (server) origin = `http://127.0.0.1:${server.port}`;

  return {
    get origin() {
      return origin;
    },
    received,
    subscribe(id = `s${receivers.size + 1}`) {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      const r: Receiver = { ecdh, publicKey: ecdh.getPublicKey(), auth: randomBytes(16), status: 201 };
      receivers.set(id, r);
      return { endpoint: `${origin}/push/${id}`, keys: { p256dh: b64u(r.publicKey), auth: b64u(r.auth) } };
    },
    answer(id, status) {
      const r = receivers.get(id);
      if (!r) throw new Error(`no subscription ${id}`);
      r.status = status;
    },
    hold() {
      held ??= [];
    },
    release() {
      const h = held ?? [];
      held = null;
      for (const done of h) done();
    },
    async waitFor(count, ms = 5_000) {
      const end = Date.now() + ms;
      while (received.length < count && Date.now() < end) await Bun.sleep(10);
      return [...received];
    },
    async fetch(url, init) {
      const signal = init.signal ?? null;
      const answer = handle(new Request(url, init));
      if (!signal) return answer;
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        answer.then(resolve, reject);
      });
    },
    stop() {
      this.release();
      server?.stop(true);
    },
  };
}
