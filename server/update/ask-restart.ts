// `bin/kitespan restart [--now] [--port <port>]` (DESIGN.md 4.10 step 1; build checklist S7): the same request as
// Settings > About > Restart, POST /api/restart to the kitespan on 127.0.0.1:<port> (7940 by default) with the sender
// gate's headers (x-kitespan: 1 and, for one release, the old name's; a JSON body; kitespan's own Origin). It prints
// one line: what the server does, or the server's own sentence when it refuses, and exits 1 on any refusal or when
// nothing answers. The request goes over a plain socket to 127.0.0.1 (loopback.ts), never through the user's HTTP_PROXY
// or http_proxy, which this command keeps. Whatever listens on that port may not be kitespan, so a sentence goes to the
// terminal only when it is one short line with no control character (a terminal escape). `--help` (or `-h`) prints the
// usage on stdout and sends nothing.

import { LEGACY_HEADER } from "../../shared/legacy";
import { CONTROL_CHARS } from "../../shared/protocol";
import { loopback, type LoopbackAnswer } from "./loopback";

const DEFAULT_PORT = 7940;
/** The longest sentence of the server's that is printed (kitespan's own are at most 128 characters). */
const SAID_MAX = 200;
const USAGE = "Usage: bin/kitespan restart [--now] [--port <port>]";

function parse(argv: readonly string[]): { port: number; when: "finish" | "now" } | "help" | string {
  let port = DEFAULT_PORT;
  let when: "finish" | "now" = "finish";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return "help";
    if (a === "--now") when = "now";
    else if (a === "--port") {
      const v = argv[++i];
      if (v === undefined || !/^[0-9]{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) return "--port takes a number from 1 to 65535";
      port = Number(v);
    } else return `unknown option ${a}`;
  }
  return { port, when };
}

const say = (line: string) => process.stdout.write(`${line}\n`);
const complain = (line: string) => process.stderr.write(`kitespan: ${line}\n`);

const args = parse(process.argv.slice(2));
// The usage, and nothing sent.
if (args === "help") {
  say(USAGE);
  process.exit(0);
}
if (typeof args === "string") {
  complain(args);
  complain(USAGE);
  process.exit(2);
}

const origin = `http://127.0.0.1:${args.port}`;
let res: LoopbackAnswer;
try {
  res = await loopback({
    port: args.port,
    method: "POST",
    path: "/api/restart",
    // For one release the old name's header too: after bin/update.sh brings the rename, the server that this asks to
    // restart is still a build of the old name, which takes only its own header.
    headers: { "x-kitespan": "1", [LEGACY_HEADER]: "1", "content-type": "application/json", origin, accept: "application/json" },
    body: JSON.stringify({ when: args.when }),
    // The preflight runs before the answer (a check of the code on disk), so the answer may take some seconds.
    timeoutMs: 60_000,
  });
} catch {
  complain(`no kitespan answers on port ${args.port}.`);
  process.exit(1);
}
if (res.status === 202) {
  say(args.when === "now" ? "kitespan is restarting." : "kitespan restarts when the running turns end.");
  process.exit(0);
}
const said = (res.json as { error?: { message?: unknown } } | null | undefined)?.error?.message;
complain(typeof said === "string" && said.length <= SAID_MAX && !CONTROL_CHARS.test(said) ? said : "That did not work.");
process.exit(1);
