// A small TCP proxy for the slow-network check (DESIGN.md 9.4 done check 9; build checklist L2, R19). Every byte
// between a browser and kitespan goes through it: late by the delay in each direction (250 ms, so about 500 ms round
// trip), at most the cap in each direction (1 Mbit/s, one link that every connection shares, as a plane's Wi-Fi is),
// and a source that has much on its way stops being read, as a TCP window does, so kitespan's own backpressure still
// works. The link fails in two ways:
// - cut() takes the link down for a gap: every connection it holds is reset at once, and each one that opens during
//   the gap is reset as it opens, so the page knows at once.
// - silence() is a black hole, as in-flight Wi-Fi more often is: no byte moves either way and nothing closes, so only
//   the page's heartbeat can notice; a connection that opens meanwhile reaches nothing. When the link is back, what
//   each side sent arrives in order with its end last (a link's own proxy or TCP's retransmits deliver it), and a dial
//   that its client gave up meanwhile never reaches the server. With lateMs, the WebSocket connections that were open
//   before the silence get theirs that much later still (a late retransmit of a socket's frames, after the page has
//   dialled again or reloaded).
// Chrome's own network emulation may not delay a WebSocket's frames (DESIGN 9.4), so the click-through
// (scripts/ui-check.ts, resume-slow and resume-blackhole) puts this proxy between Chrome and the server instead.
//
// As a script it serves until Ctrl+C; with --every it cuts the link that often, each time for --gap seconds (with
// --silent, a silence instead of a cut):
//   bun scripts/net-proxy.ts --to <port> [--listen <port>] [--delay <ms>] [--kbit <kbit/s>] [--every <s> --gap <s> [--silent]]

import type { Socket, TCPSocketListener } from "bun";
import { FORBIDDEN_PORTS } from "../test/click/ports";

export interface LinkProfile {
  /** The wait added to each direction, in ms (half the round trip it adds). */
  delayMs: number;
  /** The throughput of each direction, in kbit/s. */
  kbit: number;
}

/** DC9's link: about 500 ms round trip at about 1 Mbit/s (build checklist L2). */
export const SLOW_LINK: Readonly<LinkProfile> = { delayMs: 250, kbit: 1000 };

export interface ProxyOptions extends Partial<LinkProfile> {
  /** The port the server listens on, on 127.0.0.1. */
  to: number;
  /** The port to listen on, on 127.0.0.1; 0 (the default): one the system picks. */
  listen?: number;
}

export interface ProxyStats {
  /** Connections that went through. */
  connections: number;
  /** Connections open now. */
  open: number;
  /** Connections that a cut reset. */
  reset: number;
  /** Connections that opened during a gap (reset as they opened). */
  refused: number;
  /** Bytes from the browser to the server, and back. */
  bytesUp: number;
  bytesDown: number;
  cuts: number;
  silences: number;
}

export interface NetProxy {
  readonly port: number;
  /** The link now (setLink changes it). */
  readonly profile: Readonly<LinkProfile>;
  /** True while a cut lasts. */
  readonly down: boolean;
  /** True while a silence lasts. */
  readonly silent: boolean;
  /** Take the link down for `ms`: every connection is reset now; the promise settles when the link is back. */
  cut(ms: number): Promise<void>;
  /**
   * A black hole for `ms`: nothing moves and nothing closes; the promise settles when the link is back. With
   * `lateMs`, the WebSocket connections open before it get their held bytes that much after the link is back.
   */
  silence(ms: number, o?: { lateMs?: number }): Promise<void>;
  /** Another delay or cap for what is sent from now on (a longer round trip, a narrower link). */
  setLink(p: Partial<LinkProfile>): void;
  stats(): ProxyStats;
  stop(): void;
}

/** The most the link sends at one time, so a large write still comes as a stream. */
const SLICE = 16 * 1024;
/** A direction that holds this many bytes on their way stops reading its source; below LOW it reads again. */
const HIGH = 256 * 1024;
const LOW = 64 * 1024;

function checkProxyPort(port: number, what: string, zero: boolean): void {
  if (!Number.isInteger(port) || port < (zero ? 0 : 1) || port > 65535) throw new Error(`${what} must be a port number, not ${port}`);
  if (FORBIDDEN_PORTS.includes(port)) throw new Error(`port ${port} belongs to another app on this host; the proxy never touches it`);
}

function checkProfile(p: LinkProfile): void {
  if (!(p.delayMs >= 0) || !(p.kbit > 0)) throw new Error("the delay must be 0 ms or more and the cap above 0 kbit/s");
}

/** One direction of the shared link: when it is free to send the next byte. */
class Link {
  freeAt = 0;
  constructor(private readonly profile: LinkProfile) {}
  /** kbit/s is bits per ms; a byte is 8 bits. */
  get bytesPerMs(): number {
    return this.profile.kbit / 8;
  }
  get delayMs(): number {
    return this.profile.delayMs;
  }
}

/** A piece on its way: when it arrives (Infinity while the link holds it), and its bytes or its end (null). */
type Piece = { due: number; buf: Uint8Array | null };

/** One direction of one connection: what is on its way, when each piece arrives, and its end (null). */
class Pipe {
  dest: Socket<Conn> | null = null;
  /** While true, the link holds every piece (a silence, or a late retransmit after it). */
  holding = false;
  private q: Piece[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly link: Link,
    private readonly source: () => Socket<Conn> | null,
  ) {}

  /** When a piece of `n` bytes that leaves now arrives; the shared link is busy that much longer. */
  private dueOf(n: number): number {
    const start = Math.max(performance.now(), this.link.freeAt);
    this.link.freeAt = start + n / this.link.bytesPerMs;
    return this.link.freeAt + this.link.delayMs;
  }

  push(data: Uint8Array): void {
    if (this.stopped) return;
    for (let i = 0; i < data.length; i += SLICE) {
      // A copy: Bun reuses the buffer of a data callback.
      const piece = data.slice(i, i + SLICE);
      this.q.push({ due: this.holding ? Infinity : this.dueOf(piece.length), buf: piece });
      this.bytes += piece.length;
    }
    if (this.bytes > HIGH) this.source()?.pause();
    this.pump();
  }

  /** The source closed: its end arrives as late as the bytes before it. */
  end(): void {
    if (this.stopped) return;
    this.q.push({ due: this.holding ? Infinity : Math.max(performance.now(), this.link.freeAt) + this.link.delayMs, buf: null });
    this.pump();
  }

  /** The link carries this direction again: what it held leaves now, in order, as if sent now. */
  release(): void {
    this.holding = false;
    for (const p of this.q) if (p.due === Infinity) p.due = p.buf === null ? Math.max(performance.now(), this.link.freeAt) + this.link.delayMs : this.dueOf(p.buf.length);
    this.pump();
  }

  pump(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const dest = this.dest;
    if (this.stopped || !dest || this.holding) return;
    const now = performance.now();
    while (this.q.length) {
      const head = this.q[0]!;
      if (head.due > now + 1) {
        this.timer = setTimeout(() => this.pump(), head.due - now);
        break;
      }
      if (head.buf === null) {
        this.q.shift();
        dest.end();
        return;
      }
      const n = dest.write(head.buf);
      if (n < 0) return;
      this.bytes -= n;
      if (n < head.buf.length) {
        // The socket is full: its drain callback pumps again.
        head.buf = head.buf.subarray(n);
        break;
      }
      this.q.shift();
    }
    if (this.bytes < LOW) this.source()?.resume();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.q = [];
    this.bytes = 0;
  }
}

/** One browser connection and its connection to the server. */
class Conn {
  server: Socket<Conn> | null = null;
  readonly up: Pipe;
  readonly down: Pipe;
  done = false;
  /** The dial to the server waits for the link (a connection opened during a silence). */
  waiting = false;
  /** Its first bytes asked for a WebSocket (an HTTP upgrade): a late retransmit holds only these. */
  ws = false;
  private first = true;
  clientClosed = false;
  private serverClosed = false;
  constructor(
    readonly client: Socket<Conn>,
    up: Link,
    down: Link,
    silent: boolean,
    private readonly gone: (c: Conn) => void,
  ) {
    this.up = new Pipe(up, () => this.client);
    this.down = new Pipe(down, () => this.server);
    this.down.dest = client;
    this.up.holding = this.down.holding = silent;
  }

  /** What the client sends: the first bytes say whether it is a WebSocket. */
  fromClient(d: Uint8Array): void {
    if (this.first) {
      this.first = false;
      const head = new TextDecoder().decode(d.subarray(0, 2048));
      this.ws = /^GET [^\r\n]* HTTP\/1\.1\r\n/.test(head) && /\r\nupgrade:[ \t]*websocket/i.test(head);
    }
    this.up.push(d);
  }

  /** One side closed: its end goes to the other side as late as its last bytes; with both closed the connection is gone. */
  closed(side: "client" | "server"): void {
    if (side === "client") this.clientClosed = true;
    else this.serverClosed = true;
    if (this.done) return;
    if (side === "client") this.up.end();
    else this.down.end();
    if (this.clientClosed && (this.serverClosed || this.waiting)) {
      this.done = true;
      this.up.stop();
      this.down.stop();
      this.gone(this);
    }
  }

  /** Reset both sides at once (a cut, an error): nothing on its way arrives. */
  reset(): void {
    if (this.done) return;
    this.done = true;
    this.up.stop();
    this.down.stop();
    this.client.terminate();
    this.server?.terminate();
    this.gone(this);
  }

  /** The link holds this connection's bytes (a silence, or a late retransmit after it). */
  get held(): boolean {
    return this.up.holding;
  }

  hold(): void {
    this.up.holding = this.down.holding = true;
  }

  release(): void {
    this.up.release();
    this.down.release();
  }
}

export function startProxy(o: ProxyOptions): NetProxy {
  checkProxyPort(o.to, "--to", false);
  checkProxyPort(o.listen ?? 0, "--listen", true);
  const profile: LinkProfile = { delayMs: o.delayMs ?? SLOW_LINK.delayMs, kbit: o.kbit ?? SLOW_LINK.kbit };
  checkProfile(profile);
  const upLink = new Link(profile);
  const downLink = new Link(profile);
  const conns = new Set<Conn>();
  const stats: Omit<ProxyStats, "open"> = { connections: 0, reset: 0, refused: 0, bytesUp: 0, bytesDown: 0, cuts: 0, silences: 0 };
  let downUntil = 0;
  const isDown = () => performance.now() < downUntil;
  let silent = false;
  /** The timers that end a silence and its late retransmits, so stop() and cut() clear them. */
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const dial = (c: Conn) => {
    c.waiting = false;
    Bun.connect<Conn>({
      hostname: "127.0.0.1",
      port: o.to,
      data: c,
      socket: {
        open(server) {
          if (c.done) return server.terminate();
          c.server = server;
          c.up.dest = server;
          c.up.pump();
        },
        data(_server, d) {
          stats.bytesDown += d.length;
          c.down.push(d);
        },
        drain() {
          c.up.pump();
        },
        close() {
          c.closed("server");
        },
        error() {
          // While the link holds this connection's bytes an error is only an end: what it holds still arrives.
          if (c.held) c.closed("server");
          else c.reset();
        },
        connectError() {
          c.reset();
        },
      },
    }).catch(() => c.reset());
  };

  const listener: TCPSocketListener<Conn> = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: o.listen ?? 0,
    socket: {
      open(client) {
        if (isDown()) {
          stats.refused++;
          client.terminate();
          return;
        }
        const c = new Conn(client, upLink, downLink, silent, (x) => conns.delete(x));
        client.data = c;
        conns.add(c);
        stats.connections++;
        // In a black hole the dial reaches nothing yet: it goes when the link is back, if the client still waits.
        if (silent) c.waiting = true;
        else dial(c);
      },
      data(client, d) {
        stats.bytesUp += d.length;
        client.data?.fromClient(d);
      },
      drain(client) {
        client.data?.down.pump();
      },
      close(client) {
        client.data?.closed("client");
      },
      error(client) {
        const c = client.data;
        if (c?.held) c.closed("client");
        else c?.reset();
      },
    },
  });

  return {
    port: listener.port,
    profile,
    get down() {
      return isDown();
    },
    get silent() {
      return silent;
    },
    cut(ms: number): Promise<void> {
      stats.cuts++;
      silent = false;
      downUntil = performance.now() + ms;
      for (const c of [...conns]) {
        stats.reset++;
        c.reset();
      }
      // What was on the wire is gone with it.
      upLink.freeAt = downLink.freeAt = 0;
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    silence(ms: number, so: { lateMs?: number } = {}): Promise<void> {
      stats.silences++;
      silent = true;
      const before = new Set(conns);
      for (const c of before) c.hold();
      return new Promise((resolve) => {
        later(() => {
          silent = false;
          // A dial that its client gave up during the silence never reached the server; one that still waits goes now.
          for (const c of [...conns]) {
            if (!c.waiting) continue;
            if (c.clientClosed) c.reset();
            else dial(c);
          }
          const late = Math.max(0, so.lateMs ?? 0);
          const isLate = (c: Conn) => late > 0 && c.ws && before.has(c);
          for (const c of conns) if (!isLate(c)) c.release();
          if (late)
            later(() => {
              for (const c of before) if (isLate(c) && !c.done) c.release();
            }, late);
          resolve();
        }, ms);
      });
    },
    setLink(p: Partial<LinkProfile>): void {
      const next = { ...profile, ...p };
      checkProfile(next);
      Object.assign(profile, next);
    },
    stats: () => ({ ...stats, open: conns.size }),
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const c of [...conns]) c.reset();
      listener.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// As a script

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const num = (name: string): number | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v)) {
      console.error(`net-proxy: ${name} needs a number`);
      process.exit(2);
    }
    return v;
  };
  const to = num("--to");
  if (to === undefined || argv.includes("--help")) {
    console.error("Usage: bun scripts/net-proxy.ts --to <port> [--listen <port>] [--delay <ms>] [--kbit <kbit/s>] [--every <s> --gap <s> [--silent]]");
    process.exit(to === undefined ? 2 : 0);
  }
  const every = num("--every");
  const gap = num("--gap");
  const quiet = argv.includes("--silent");
  let proxy: NetProxy;
  try {
    proxy = startProxy({ to, listen: num("--listen"), delayMs: num("--delay"), kbit: num("--kbit") });
  } catch (e) {
    console.error(`net-proxy: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log(`net-proxy: http://127.0.0.1:${proxy.port} to 127.0.0.1:${to}, ${proxy.profile.delayMs} ms each way, ${proxy.profile.kbit} kbit/s each way`);
  if (every && gap) {
    const loop = async () => {
      for (;;) {
        await Bun.sleep(every * 1000);
        console.log(`net-proxy: the link is ${quiet ? "silent" : "down"} for ${gap} s`);
        await (quiet ? proxy.silence(gap * 1000) : proxy.cut(gap * 1000));
        console.log("net-proxy: the link is back");
      }
    };
    void loop();
  }
  const end = () => {
    proxy.stop();
    console.log(`net-proxy: stopped (${JSON.stringify(proxy.stats())})`);
    process.exit(0);
  };
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
}
