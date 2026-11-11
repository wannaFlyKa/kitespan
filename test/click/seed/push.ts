// R130: the main scene's notifications state (kitespan's own push-key.json and push-devices.json), so the example of
// /settings/notifications/device/<device> names a device that is there. The key pair is made fresh at each seed with
// node:crypto and never printed. The device's endpoint is at a host that RFC 2606 reserves (`.invalid`), which is not a
// push service of kitespan's list: the server checks every endpoint again before each send, so it never calls it, and
// no push leaves the click-through. Its id is the route example's (a seeded id, not its endpoint's hash, so no page
// takes it for its own).

import { generateKeyPairSync } from "node:crypto";
import { EX } from "./ids";

export const SEED_DEVICE = { name: "iPhone", endpoint: "https://seed-device.invalid/push/example" } as const;

export function pushSeed(now: number): { key: string; devices: string } {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const receiver = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(receiver.x!, "base64url"), Buffer.from(receiver.y!, "base64url")]).toString("base64url");
  const device = { id: EX.device, name: SEED_DEVICE.name, endpoint: SEED_DEVICE.endpoint, p256dh, auth: Buffer.alloc(16, 7).toString("base64url"), titles: false, at: new Date(now - 26 * 3600_000).toISOString(), failing: false };
  return {
    key: JSON.stringify({ v: 1, publicKey: point.toString("base64url"), privateKey: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d } }),
    devices: JSON.stringify({ v: 1, devices: [device] }),
  };
}
