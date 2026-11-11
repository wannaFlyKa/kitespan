// R130 (FIX-R130 1, "A live check for the lead"): one real push to a real push service. The subscription is made by
// hand first: run a kitespan, open its Settings > Notifications in a browser (Chrome on a laptop, or the home-screen
// app on a phone) and turn Notifications on this device on, with your own tap. That kitespan's state folder then holds
// its key (push-key.json) and the device (push-devices.json). This file reads both from KITESPAN_LIVE_PUSH_STATE,
// through the server's own store and its checks, and sends one push to the newest device (or KITESPAN_LIVE_PUSH_DEVICE)
// with the server's own sender: the payload encrypted to the subscription (RFC 8291), the VAPID token (RFC 8292), a 10
// s deadline, and your proxy variables as they are in this environment. The push says "Claude finished" and opens Home.
// No model turn runs. It logs the push service's host, the status and the time, never the endpoint's path, a key or a
// name.

import { describe, expect, test } from "bun:test";
import { isAbsolute } from "node:path";
import { PUSH_WORDS, pushHostOf, type PushPayload } from "../../shared/push";
import { PushSender, type PushLogFields } from "../../server/push/send";
import { PushStore, endpointProblem } from "../../server/push/store";
import { ownUid } from "../../server/store/files";
import { liveSuite, liveVar } from "./live";

/** A chat id of the right shape that no kitespan has: the tag's, so the push is one the service worker takes. */
const LIVE_TAG_CHAT = "kitespanlivecheckaaa";

liveSuite("notify.test.ts", {}, () => {
  const state = liveVar("KITESPAN_LIVE_PUSH_STATE");
  const wanted = liveVar("KITESPAN_LIVE_PUSH_DEVICE");
  describe("R130: one push to a subscription made by hand", () => {
    test(
      "the newest device that turned notifications on gets one push, and its push service takes it (2xx)",
      async () => {
        if (!state || !isAbsolute(state)) throw new Error("KITESPAN_LIVE_PUSH_STATE is not set: give the state folder (absolute) of the kitespan where you turned Notifications on in a browser");
        const store = new PushStore({ dir: state, uid: ownUid() });
        const keys = await store.key();
        if (!keys) throw new Error("that state folder has no push-key.json: turn Notifications on in that kitespan's Settings first");
        const devices = [...(await store.devices())].sort((a, b) => (a.at < b.at ? 1 : -1));
        const device = wanted ? devices.find((d) => d.id === wanted) : devices[0];
        if (!device) throw new Error(wanted ? "KITESPAN_LIVE_PUSH_DEVICE names no device of that state folder" : "that state folder has no device: turn Notifications on in a browser first");
        const host = new URL(device.endpoint).hostname;
        expect(endpointProblem(device.endpoint, null)).toBeNull();
        expect(pushHostOf(host)).not.toBeNull();
        const lines: PushLogFields[] = [];
        const sender = new PushSender({ log: (f) => lines.push(f) });
        const payload: PushPayload = { v: 1, title: PUSH_WORDS.done, body: "", tag: `c:${LIVE_TAG_CHAT}`, url: "/" };
        const r = await sender.send(device, keys, payload, { urgent: false, topic: LIVE_TAG_CHAT });
        const line = lines[0]!;
        console.log(`notify live: device ${device.id} (${pushHostOf(host)}), host ${line.host}, status ${line.status}${line.answer ? ` (${line.answer})` : ""}, ${Math.round(line.ms ?? 0)} ms`);
        if (r.kind === "refused" && pushHostOf(host) === "apple") console.log("notify live: Apple refused the token; its sub (shared/push.ts PUSH_CONTACT) is the first thing to check");
        expect(r.kind).toBe("sent");
        console.log("notify live: look at the device now: one notification, \"Claude finished\", whose click opens kitespan at Home");
      },
      30_000,
    );
  });
});
