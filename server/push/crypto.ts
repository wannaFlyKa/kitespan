// R130 (DESIGN-R130 2.3, 4.3): Web Push's two pieces of cryptography with Bun's WebCrypto alone, no dependency.
//
// - RFC 8291 (Message Encryption for Web Push, `aes128gcm`): each message gets a new ECDH P-256 key pair and a new
//   16-octet salt (section 3.1; never the VAPID key, RFC 8292 section 3.2). The shared secret with the browser's
//   `p256dh` key and its `auth` secret give the content key and the nonce by HKDF-SHA-256 (sections 3.3 and 3.4); the
//   body is one record: the header (salt, record size 4096, the key id's length 65, the sender's public key), then
//   AES-128-GCM of the plaintext, the padding delimiter 0x02 and zero padding (section 4, RFC 8188).
// - RFC 8292 (VAPID): the server's own ES256 key pair signs a JWT (`aud` the push service's origin, `exp` at most 24 h
//   ahead, `sub` a contact), sent as `Authorization: vapid t=<JWT>, k=<public key>` (section 3). WebCrypto's ECDSA
//   signature is already JOSE's 64-octet r||s.
//
// The tests check both against the RFCs' own vectors (RFC 8291 Appendix A, RFC 8292 section 2.4). No key is ever logged.

const subtle = crypto.subtle;
const te = new TextEncoder();

/** RFC 8291 section 4: one record of this size holds any Web Push message (at most 4,096 octets). */
export const RECORD_SIZE = 4096;
/** The header: salt (16), record size (4), key id length (1), the sender's public key (65). */
export const HEADER_OCTETS = 86;

const B64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding (RFC 4648 section 5), as Web Push and JOSE write it. */
export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url, padded or not; null for any other character, or a length that no octet string has. */
export function b64urlDecode(text: string): Uint8Array | null {
  const t = text.replace(/=+$/, "");
  if (!B64URL.test(t) || t.length % 4 === 1) return null;
  try {
    const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HKDF-SHA-256 (RFC 5869): extract with `salt`, expand with `info`, `length` octets. */
export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", concat(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) }, key, length * 8));
}

/** A P-256 key as a JWK (RFC 7518 section 6.2): its point's coordinates, and `d` for a private key. */
export interface EcJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d?: string;
}

/** A P-256 public key as its JWK coordinates (the uncompressed point: 0x04, x, y). */
function jwkOfPoint(point: Uint8Array, d?: Uint8Array): EcJwk {
  return { kty: "EC", crv: "P-256", x: b64urlEncode(point.subarray(1, 33)), y: b64urlEncode(point.subarray(33, 65)), ...(d ? { d: b64urlEncode(d) } : {}) };
}

/** Whether `point` is an uncompressed P-256 public key that WebCrypto takes (on the curve). */
export async function isP256Point(point: Uint8Array): Promise<boolean> {
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    await subtle.importKey("raw", concat(point), { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

/** What a subscription gives the sender: the browser's key and its auth secret (`keys.p256dh`, `keys.auth`). */
export interface PushReceiver {
  /** The uncompressed P-256 point, 65 octets. */
  p256dh: Uint8Array;
  /** 16 octets. */
  auth: Uint8Array;
}

/** The sender's one-message key pair (a test gives the RFC's own; else a new one per message). */
export interface SenderKeys {
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

export interface EncryptOptions {
  /** A test's salt (RFC 8291 Appendix A); else 16 random octets. */
  salt?: Uint8Array;
  /** A test's key pair; else a new one, used for this message only. */
  sender?: SenderKeys;
  /** The padded plaintext's length (the plaintext, the delimiter, then zeros); default: no padding. */
  paddedTo?: number;
}

/** A new ECDH P-256 key pair for one message. */
async function newSenderKeys(): Promise<SenderKeys> {
  const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { publicKey: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)), privateKey: pair.privateKey };
}

/** An ECDH key pair from its raw public point and private scalar (the RFC's test keys). */
export async function senderKeysOf(publicKey: Uint8Array, privateScalar: Uint8Array): Promise<SenderKeys> {
  const privateKey = await subtle.importKey("jwk", jwkOfPoint(publicKey, privateScalar), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { publicKey, privateKey };
}

/** The content key and the nonce of RFC 8291 sections 3.3 and 3.4, with the IKM between them. */
export async function pushKeys(ecdhSecret: Uint8Array, auth: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array): Promise<{ ikm: Uint8Array; cek: Uint8Array; nonce: Uint8Array }> {
  const ikm = await hkdf(auth, ecdhSecret, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  return { ikm, cek, nonce };
}

/**
 * The body of one Web Push message to `to` (RFC 8291): the header, then the one record. `paddedTo` pads the
 * plaintext with zeros after its 0x02 delimiter; it must fit one record (RECORD_SIZE minus the 16-octet tag).
 */
export async function encryptPush(plaintext: Uint8Array, to: PushReceiver, opts: EncryptOptions = {}): Promise<Uint8Array> {
  if (to.p256dh.length !== 65 || to.auth.length !== 16) throw new Error("bad receiver keys");
  const padded = Math.max(plaintext.length + 1, opts.paddedTo ?? 0);
  if (padded > RECORD_SIZE - 16) throw new Error("the message is over one record");
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("bad salt");
  const sender = opts.sender ?? (await newSenderKeys());
  const receiver = await subtle.importKey("raw", concat(to.p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: receiver }, sender.privateKey, 256));
  const { cek, nonce } = await pushKeys(ecdh, to.auth, to.p256dh, sender.publicKey, salt);
  const aes = await subtle.importKey("raw", concat(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const record = new Uint8Array(padded);
  record.set(plaintext);
  record[plaintext.length] = 2;
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: concat(nonce), tagLength: 128 }, aes, record));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, rs, new Uint8Array([sender.publicKey.length]), sender.publicKey, sealed);
}

// ---------------------------------------------------------------------------------------------------------------
// VAPID (RFC 8292)

/** The server's VAPID key pair as push-key.json keeps it: the public point (base64url, 65 octets), the private JWK. */
export interface VapidKeys {
  publicKey: string;
  privateKey: EcJwk & { d: string };
}

/** A new VAPID key pair (made at the first opt-in, DESIGN-R130 4.4). */
export async function makeVapidKeys(): Promise<VapidKeys> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64urlEncode(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  return { publicKey, privateKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! } };
}

/** A key pair as a file holds it, every field checked (a private key whose point is the public key's); else null. */
export function vapidKeysOf(v: unknown): VapidKeys | null {
  if (typeof v !== "object" || v === null) return null;
  const { publicKey, privateKey } = v as Record<string, unknown>;
  if (typeof publicKey !== "string" || typeof privateKey !== "object" || privateKey === null) return null;
  const point = b64urlDecode(publicKey);
  if (!point || point.length !== 65 || point[0] !== 4) return null;
  const j = privateKey as Record<string, unknown>;
  if (j.kty !== "EC" || j.crv !== "P-256" || typeof j.x !== "string" || typeof j.y !== "string" || typeof j.d !== "string") return null;
  const want = jwkOfPoint(point);
  if (j.x !== want.x || j.y !== want.y || b64urlDecode(j.d)?.length !== 32) return null;
  return { publicKey, privateKey: { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d } };
}

export interface VapidClaims {
  /** The push service's origin (the endpoint's). */
  aud: string;
  /** Seconds since the epoch: at most 24 h from now (RFC 8292 section 2). */
  exp: number;
  sub: string;
}

/** The signed JWT (ES256) for `claims`. */
export async function vapidJwt(keys: VapidKeys, claims: VapidClaims): Promise<string> {
  const head = b64urlEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64urlEncode(te.encode(JSON.stringify({ aud: claims.aud, exp: claims.exp, sub: claims.sub })));
  const key = await subtle.importKey("jwk", keys.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64urlEncode(sig)}`;
}

/** RFC 8292 section 3: the Authorization header's value. */
export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}

/** Whether `jwt` is ES256-signed by the public point `k` (base64url): the RFC's vector, and the tests' round trips. */
export async function verifyVapidJwt(jwt: string, k: string): Promise<boolean> {
  const parts = jwt.split(".");
  const point = b64urlDecode(k);
  const sig = parts.length === 3 ? b64urlDecode(parts[2]!) : null;
  if (!point || !sig || sig.length !== 64) return false;
  try {
    const key = await subtle.importKey("raw", concat(point), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, concat(sig), te.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}
