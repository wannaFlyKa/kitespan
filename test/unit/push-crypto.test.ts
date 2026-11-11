// R130 (DESIGN-R130 2.3): Web Push's encryption (RFC 8291) and VAPID (RFC 8292) with Bun's WebCrypto, against the
// RFCs' own vectors. Every key here is a fixed test vector printed in the RFC (RFC 8291 Appendix A; RFC 8292 section
// 2.4 gives a public key only), or a fresh key made in the test and never printed.
import { describe, expect, test } from "bun:test";
import {
  HEADER_OCTETS,
  b64urlDecode,
  b64urlEncode,
  encryptPush,
  hkdf,
  isP256Point,
  makeVapidKeys,
  pushKeys,
  senderKeysOf,
  vapidAuthorization,
  vapidJwt,
  vapidKeysOf,
  verifyVapidJwt,
} from "../../server/push/crypto";

const dec = (s: string): Uint8Array => {
  const b = b64urlDecode(s);
  if (!b) throw new Error("not base64url");
  return b;
};

/** RFC 8291 Appendix A, "Intermediate Values for Encryption" (page 12), and the section 5 message. */
const A = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  as_public: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  as_private: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  ua_public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  ua_private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth_secret: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdh_secret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  IKM: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  CEK: "oIhVW04MRdy2XN9CiKLxTg",
  NONCE: "4h_95klXJ5E_qnoN",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  /** Section 5's body, as its 192 base64url characters print it. */
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** RFC 8292 section 2.4: the example JWT and its `k`. No private key is given, so it is a verification vector. */
const VAPID_EXAMPLE = {
  jwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA",
  k: "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
};

const subtle = crypto.subtle;

/** The receiver's side of RFC 8291 (what a browser does), with the RFC's own receiver key. */
async function openAsReceiver(body: Uint8Array, uaPublic: Uint8Array, uaPrivate: Uint8Array, auth: Uint8Array): Promise<Uint8Array> {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const ua = await senderKeysOf(uaPublic, uaPrivate);
  const asKey = await subtle.importKey("raw", new Uint8Array(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const { cek, nonce } = await pushKeys(ecdh, auth, uaPublic, new Uint8Array(asPublic), new Uint8Array(salt));
  const aes = await subtle.importKey("raw", new Uint8Array(cek), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce) }, aes, new Uint8Array(sealed)));
}

describe("RFC 8291 Appendix A", () => {
  test("every intermediate value: the ECDH secret, IKM, CEK and NONCE", async () => {
    const as = await senderKeysOf(dec(A.as_public), dec(A.as_private));
    const ua = await subtle.importKey("raw", new Uint8Array(dec(A.ua_public)), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: ua }, as.privateKey, 256));
    expect(b64urlEncode(ecdh)).toBe(A.ecdh_secret);
    const k = await pushKeys(ecdh, dec(A.auth_secret), dec(A.ua_public), dec(A.as_public), dec(A.salt));
    expect(b64urlEncode(k.ikm)).toBe(A.IKM);
    expect(b64urlEncode(k.cek)).toBe(A.CEK);
    expect(b64urlEncode(k.nonce)).toBe(A.NONCE);
  });

  test("the whole body, byte for byte: 144 octets (section 5 prints Content-Length 145, one too many)", async () => {
    const body = await encryptPush(dec(A.plaintext), { p256dh: dec(A.ua_public), auth: dec(A.auth_secret) }, { salt: dec(A.salt), sender: await senderKeysOf(dec(A.as_public), dec(A.as_private)) });
    expect(body.length).toBe(144);
    expect(b64urlEncode(body.subarray(0, HEADER_OCTETS))).toBe(A.header);
    expect(b64urlEncode(body.subarray(HEADER_OCTETS))).toBe(A.ciphertext);
    expect(b64urlEncode(body)).toBe(A.body);
    expect(dec(A.body).length).toBe(144);
  });

  test("the receiver opens it: the plaintext, then the 0x02 delimiter", async () => {
    const body = dec(A.body);
    const opened = await openAsReceiver(body, dec(A.ua_public), dec(A.ua_private), dec(A.auth_secret));
    expect(opened[opened.length - 1]).toBe(2);
    expect(new TextDecoder().decode(opened.subarray(0, -1))).toBe("When I grow up, I want to be a watermelon");
  });

  test("a message of our own: a new sender key and salt each time, padding of zeros after the delimiter", async () => {
    const ua = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const uaPublic = new Uint8Array(await subtle.exportKey("raw", ua.publicKey));
    const uaPrivate = dec((await subtle.exportKey("jwk", ua.privateKey)).d!);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const plain = new TextEncoder().encode(JSON.stringify({ v: 1, title: "Claude finished" }));
    const a = await encryptPush(plain, { p256dh: uaPublic, auth }, { paddedTo: 256 });
    const b = await encryptPush(plain, { p256dh: uaPublic, auth }, { paddedTo: 256 });
    expect(a.length).toBe(HEADER_OCTETS + 256 + 16);
    expect(b64urlEncode(a.subarray(0, 16))).not.toBe(b64urlEncode(b.subarray(0, 16)));
    expect(b64urlEncode(a.subarray(21, 86))).not.toBe(b64urlEncode(b.subarray(21, 86)));
    expect(new DataView(a.buffer, a.byteOffset).getUint32(16)).toBe(4096);
    expect(a[20]).toBe(65);
    const opened = await openAsReceiver(a, uaPublic, uaPrivate, auth);
    expect(opened.length).toBe(256);
    expect(opened[plain.length]).toBe(2);
    expect([...opened.subarray(plain.length + 1)].every((x) => x === 0)).toBe(true);
    expect(new TextDecoder().decode(opened.subarray(0, plain.length))).toBe(new TextDecoder().decode(plain));
  });

  test("a body made for one subscription opens with no other receiver's key and no other auth secret", async () => {
    const receiver = async () => {
      const k = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
      return { pub: new Uint8Array(await subtle.exportKey("raw", k.publicKey)), priv: dec((await subtle.exportKey("jwk", k.privateKey)).d!) };
    };
    const a = await receiver();
    const b = await receiver();
    const authA = crypto.getRandomValues(new Uint8Array(16));
    const authB = crypto.getRandomValues(new Uint8Array(16));
    const plain = new TextEncoder().encode(JSON.stringify({ v: 1, title: "Claude finished" }));
    const body = await encryptPush(plain, { p256dh: a.pub, auth: authA }, { paddedTo: 256 });
    // A's own key and secret open it.
    expect(new TextDecoder().decode((await openAsReceiver(body, a.pub, a.priv, authA)).subarray(0, plain.length))).toBe(new TextDecoder().decode(plain));
    // B's key (with A's secret), and A's key with another secret: AES-GCM's tag refuses both.
    await expect(openAsReceiver(body, b.pub, b.priv, authA)).rejects.toThrow();
    await expect(openAsReceiver(body, a.pub, a.priv, authB)).rejects.toThrow();
    // The RFC's own body, with another auth secret.
    await expect(openAsReceiver(dec(A.body), dec(A.ua_public), dec(A.ua_private), authB)).rejects.toThrow();
  });

  test("refuses what does not fit one record, and bad receiver keys", async () => {
    const to = { p256dh: dec(A.ua_public), auth: dec(A.auth_secret) };
    await expect(encryptPush(new Uint8Array(4080), to)).rejects.toThrow();
    await expect(encryptPush(new Uint8Array(1), { p256dh: to.p256dh.subarray(1), auth: to.auth })).rejects.toThrow();
    await expect(encryptPush(new Uint8Array(1), { p256dh: to.p256dh, auth: to.auth.subarray(1) })).rejects.toThrow();
  });

  test("a receiver key must be a point on P-256", async () => {
    expect(await isP256Point(dec(A.ua_public))).toBe(true);
    const off = new Uint8Array(dec(A.ua_public));
    off[40] = off[40]! ^ 1;
    expect(await isP256Point(off)).toBe(false);
    expect(await isP256Point(dec(A.ua_public).subarray(0, 64))).toBe(false);
    const compressed = new Uint8Array(65);
    compressed[0] = 2;
    expect(await isP256Point(compressed)).toBe(false);
  });

  test("HKDF is RFC 5869's (its test case 1)", async () => {
    const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
    const okm = await hkdf(hex("000102030405060708090a0b0c"), hex("0b".repeat(22)), hex("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect([...okm].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });
});

describe("RFC 8292 (VAPID)", () => {
  test("section 2.4's example JWT verifies with its k; a changed one does not", async () => {
    expect(await verifyVapidJwt(VAPID_EXAMPLE.jwt, VAPID_EXAMPLE.k)).toBe(true);
    const [h, c, s] = VAPID_EXAMPLE.jwt.split(".") as [string, string, string];
    const claims = JSON.parse(new TextDecoder().decode(dec(c)));
    expect(claims).toEqual({ aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" });
    const other = b64urlEncode(new TextEncoder().encode(JSON.stringify({ ...claims, aud: "https://push.example.org" })));
    expect(await verifyVapidJwt(`${h}.${other}.${s}`, VAPID_EXAMPLE.k)).toBe(false);
    expect(await verifyVapidJwt(`${h}.${c}`, VAPID_EXAMPLE.k)).toBe(false);
  });

  test("a fresh key pair signs a token that verifies with its public key; the header and claims are ES256's", async () => {
    const keys = await makeVapidKeys();
    expect(dec(keys.publicKey).length).toBe(65);
    expect(dec(keys.publicKey)[0]).toBe(4);
    expect(keys.privateKey.kty).toBe("EC");
    expect(dec(keys.privateKey.d!).length).toBe(32);
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const jwt = await vapidJwt(keys, { aud: "https://fcm.googleapis.com", exp, sub: "mailto:kitespan@example.com" });
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(dec(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(dec(c)))).toEqual({ aud: "https://fcm.googleapis.com", exp, sub: "mailto:kitespan@example.com" });
    expect(dec(s).length).toBe(64);
    expect(await verifyVapidJwt(jwt, keys.publicKey)).toBe(true);
    expect(await verifyVapidJwt(jwt, VAPID_EXAMPLE.k)).toBe(false);
    expect(vapidAuthorization(jwt, keys.publicKey)).toBe(`vapid t=${jwt}, k=${keys.publicKey}`);
  });

  test("a key file's record: the private key's point must be the public key's", async () => {
    const keys = await makeVapidKeys();
    expect(vapidKeysOf(JSON.parse(JSON.stringify(keys)))).toEqual(keys);
    const other = await makeVapidKeys();
    expect(vapidKeysOf({ publicKey: other.publicKey, privateKey: keys.privateKey })).toBeNull();
    expect(vapidKeysOf({ publicKey: keys.publicKey, privateKey: { ...keys.privateKey, d: undefined } })).toBeNull();
    expect(vapidKeysOf({ publicKey: "!", privateKey: keys.privateKey })).toBeNull();
    expect(vapidKeysOf(null)).toBeNull();
  });
});

describe("base64url", () => {
  test("round trips, takes padding, refuses other characters and impossible lengths", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(100));
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(b64urlEncode(new Uint8Array([251, 255]))).toBe("-_8");
    expect(b64urlDecode("-_8=")).toEqual(new Uint8Array([251, 255]));
    expect(b64urlDecode("+/8")).toBeNull();
    expect(b64urlDecode("abcde")).toBeNull();
    expect(b64urlDecode("ab cd")).toBeNull();
  });
});
