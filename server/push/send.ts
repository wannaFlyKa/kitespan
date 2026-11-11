// R130 (DESIGN-R130 2.4, 4.3; RFC 8030): one push to one device's push service. The body is the payload encrypted to
// the subscription (crypto.ts), padded to a step of 256 octets so that its length tells nothing; the request is a
// POST with Content-Encoding aes128gcm, TTL 86400 (a day covers a long flight; older news the dots tell), Urgency high
// while Claude waits for the user, a Topic per chat or session (a newer push replaces one the service still holds),
// and the VAPID Authorization. One JWT per push service origin is kept in memory and used while it has more than an
// hour left (Apple refreshes no more than once an hour); `exp` is 12 h ahead (at most 24 h, RFC 8292 section 2).
//
// The call is a plain fetch with the server's own environment, so the user's proxy variables apply to it as to every
// call that reaches the network on purpose (DESIGN 4.10; Bun's fetch takes HTTPS_PROXY, HTTP_PROXY and NO_PROXY),
// with no redirect, a 10 s deadline, at most 4 at once, no retry, and never Bun's verbose output (which
// BUN_CONFIG_VERBOSE_FETCH would turn on, printing the URL and the headers to stderr). The `push` log line holds the
// push service's host and the status (0 when there was no answer, with `timeout` or `network`) and the time: never the
// endpoint's path, which is a capability, a key, the payload, a title or a device's name (guard 5).

import { PUSH_CONTACT, PUSH_LIMITS, type PushPayload } from "../../shared/push";
import { b64urlDecode, encryptPush, vapidAuthorization, vapidJwt, type VapidKeys } from "./crypto";

export const PUSH_SEND = {
  /** RFC 8030 section 5.2. */
  ttlS: 86_400,
  timeoutMs: 10_000,
  parallel: 4,
  /** The JWT's lifetime, and the time it must have left to be used again. */
  jwtLifeS: 12 * 3600,
  jwtReuseS: 3600,
} as const;

/** How a send ended (DESIGN-R130 4.3's answers). */
export type SendResult =
  /** Any 2xx: the push service took it (201 does not say it was delivered, RFC 8030 section 5). */
  | { kind: "sent"; status: number }
  /** 404 or 410: the subscription is gone, so the device goes. */
  | { kind: "gone"; status: number }
  /** 401 or 403: the push service refused kitespan's token (or a proxy refused the host): the device is failing. */
  | { kind: "refused"; status: number }
  /** Any other status, or no answer (`answer`): kept, and failing after three in a row. */
  | { kind: "failed"; status: number; answer?: "timeout" | "network" };

export interface PushLogFields {
  host: string;
  status: number;
  ms?: number;
  answer?: "timeout" | "network";
}

/** `verbose` is Bun's: false keeps BUN_CONFIG_VERBOSE_FETCH from printing the call (its path and token) to stderr. */
type Fetch = (url: string, init: RequestInit & { signal: AbortSignal; verbose?: boolean }) => Promise<Response>;

export interface PushSenderDeps {
  /** Bun's fetch by default (tests give a stand-in). */
  fetch?: Fetch;
  /** ms since the epoch. */
  now?: () => number;
  /** One `push` line per send. */
  log?: (f: PushLogFields) => void;
  timeoutMs?: number;
  parallel?: number;
  /** The JWT's `sub`. */
  contact?: string;
}

export interface SendOptions {
  urgent: boolean;
  /** RFC 8030 section 5.4: at most 32 characters of the URL-safe alphabet (kitespan's are alphanumeric). */
  topic: string;
}

/** The device's part of a send. */
export interface SendTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The plaintext of a payload, padded to the next step of 256 octets (with its 0x02 delimiter). */
export function paddedLength(octets: number): number {
  return Math.ceil((octets + 1) / PUSH_LIMITS.padStep) * PUSH_LIMITS.padStep;
}

export class PushSender {
  private readonly jwts = new Map<string, { jwt: string; exp: number; key: string }>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly deps: PushSenderDeps = {}) {}

  private nowS(): number {
    return Math.floor((this.deps.now?.() ?? Date.now()) / 1000);
  }

  /** The JWT for a push service origin: the kept one while it has more than an hour left, else a new one. */
  async jwtFor(origin: string, keys: VapidKeys): Promise<string> {
    const now = this.nowS();
    const kept = this.jwts.get(origin);
    if (kept && kept.key === keys.publicKey && kept.exp - now > PUSH_SEND.jwtReuseS) return kept.jwt;
    const exp = now + PUSH_SEND.jwtLifeS;
    const jwt = await vapidJwt(keys, { aud: origin, exp, sub: this.deps.contact ?? PUSH_CONTACT });
    this.jwts.set(origin, { jwt, exp, key: keys.publicKey });
    return jwt;
  }

  private async slot(): Promise<() => void> {
    const max = this.deps.parallel ?? PUSH_SEND.parallel;
    while (this.running >= max) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.running--;
      this.waiting.shift()?.();
    };
  }

  /** One push of `payload` to `to`, signed with `keys`. Never throws. */
  async send(to: SendTarget, keys: VapidKeys, payload: PushPayload, opts: SendOptions): Promise<SendResult> {
    let url: URL;
    try {
      url = new URL(to.endpoint);
    } catch {
      return { kind: "failed", status: 0, answer: "network" };
    }
    const host = url.hostname;
    const p256dh = b64urlDecode(to.p256dh);
    const auth = b64urlDecode(to.auth);
    let body: Uint8Array;
    let authorization: string;
    try {
      if (!p256dh || !auth) throw new Error("bad keys");
      const plain = new TextEncoder().encode(JSON.stringify(payload));
      body = await encryptPush(plain, { p256dh, auth }, { paddedTo: Math.min(paddedLength(plain.length), PUSH_LIMITS.padded) });
      authorization = vapidAuthorization(await this.jwtFor(url.origin, keys), keys.publicKey);
    } catch {
      return { kind: "failed", status: 0, answer: "network" };
    }
    const release = await this.slot();
    const t0 = performance.now();
    let result: SendResult;
    try {
      const res = await (this.deps.fetch ?? (fetch as unknown as Fetch))(to.endpoint, {
        method: "POST",
        body: body as Uint8Array<ArrayBuffer>,
        headers: {
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(PUSH_SEND.ttlS),
          urgency: opts.urgent ? "high" : "normal",
          topic: opts.topic,
          authorization,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? PUSH_SEND.timeoutMs),
        // Never Bun's verbose output, whatever the environment says: it prints the endpoint and the Authorization.
        verbose: false,
      });
      // The answer's body is never read beyond its end (nothing of it is kept).
      await res.body?.cancel().catch(() => {});
      const s = res.status;
      result = s >= 200 && s < 300 ? { kind: "sent", status: s } : s === 404 || s === 410 ? { kind: "gone", status: s } : s === 401 || s === 403 ? { kind: "refused", status: s } : { kind: "failed", status: s };
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      result = { kind: "failed", status: 0, answer: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    } finally {
      release();
    }
    const ms = performance.now() - t0;
    this.deps.log?.({ host, status: result.status, ms, ...(result.kind === "failed" && result.answer ? { answer: result.answer } : {}) });
    return result;
  }
}
