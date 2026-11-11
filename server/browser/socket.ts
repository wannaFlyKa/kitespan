// The browser pane's socket, /ws/browser (DESIGN-B1 3; D-10). The route table runs the Host allowlist, GET only, the
// exact Origin, the Sec-Fetch-Site refusal and the peer check before the upgrade (server/http/app.ts). Here: the first
// frame must be `open` with this protocol's version within 10 s, else close 1008; a binary frame from the page gets
// `error bad_request` and close 1003; every text frame goes through parseBrowserFrame; `ping` gets `pong` at once;
// everything else goes to the relay. Bun's socket options are the app's own (maxPayloadLength 1 MiB, idleTimeout 60,
// sendPings, backpressureLimit 4 MiB with closeOnBackpressureLimit, no deflate).

import { BROWSER_ERROR_MESSAGES, BROWSER_LIMITS, parseBrowserFrame, type BrowserServerFrame } from "../../shared/browser";
import { PROTOCOL_VERSION, WIRE } from "../../shared/protocol";
import { plainSocketRoute, type KitespanSocket, type SocketRoute } from "../http/app";
import type { Logger } from "../log";
import type { Relay, RelayConn } from "./relay";

interface ConnSlot {
  conn: RelayConn;
  opened: boolean;
  /** The socket closed, or this side closed it: nothing more is sent. */
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserSocketOptions {
  relay: Relay;
  log?: Pick<Logger, "log"> | null;
  /** How long a new socket may wait before its `open` (default 10 s). */
  openWaitMs?: number;
}

const slotOf = (ws: KitespanSocket): ConnSlot | null => {
  const s = ws.data.state as ConnSlot | null;
  return s && typeof s === "object" && "conn" in s ? s : null;
};

export function browserSocketRoute(o: BrowserSocketOptions): SocketRoute {
  const { relay } = o;
  const waitMs = o.openWaitMs ?? BROWSER_LIMITS.openWaitMs;
  const err = (conn: RelayConn, code: "bad_request") => conn.send({ t: "error", code, message: BROWSER_ERROR_MESSAGES[code] });
  return plainSocketRoute(
    WIRE.browserPath,
    {
      open(ws) {
        const slot: ConnSlot = { conn: null as unknown as RelayConn, opened: false, closed: false, timer: null };
        const conn: RelayConn = {
          send(frame: BrowserServerFrame) {
            if (slot.closed) return;
            // A text frame that the socket drops leaves the page out of step: it dials again.
            if (ws.sendText(JSON.stringify(frame)) === 0) conn.close(1011);
          },
          sendBinary: (bytes) => (slot.closed ? 0 : ws.sendBinary(bytes)),
          buffered: () => (slot.closed ? 0 : ws.getBufferedAmount()),
          close(code) {
            if (slot.closed) return;
            slot.closed = true;
            ws.close(code, "");
          },
        };
        slot.conn = conn;
        slot.timer = setTimeout(() => {
          slot.timer = null;
          if (!slot.opened) conn.close(1008);
        }, waitMs);
        slot.timer.unref?.();
        ws.data.state = slot;
      },
      message(ws, message) {
        const slot = slotOf(ws);
        if (!slot) return;
        const { conn } = slot;
        if (typeof message !== "string") {
          err(conn, "bad_request");
          return conn.close(1003);
        }
        const r = parseBrowserFrame(message);
        if (!r.ok) {
          if (r.rid) conn.send({ t: "ack", rid: r.rid, ok: false, code: "bad_request" });
          else err(conn, "bad_request");
          return;
        }
        const f = r.frame;
        if (f.t === "open") {
          if (slot.opened || f.v !== PROTOCOL_VERSION) {
            err(conn, "bad_request");
            if (!slot.opened) conn.close(1008);
            return;
          }
          slot.opened = true;
          if (slot.timer) clearTimeout(slot.timer);
          slot.timer = null;
          relay.addConn(conn);
          return conn.send(relay.opened());
        }
        if (!slot.opened) return err(conn, "bad_request");
        // At once: it waits only behind bytes already in the socket (the page's slow line).
        if (f.t === "ping") return conn.send({ t: "pong", n: f.n });
        return relay.handle(conn, f);
      },
      drain(ws) {
        const slot = slotOf(ws);
        if (slot?.opened) relay.drained(slot.conn);
      },
      close(ws) {
        const slot = slotOf(ws);
        if (!slot) return;
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = null;
        slot.closed = true;
        relay.removeConn(slot.conn);
      },
    },
    o.log,
  );
}
