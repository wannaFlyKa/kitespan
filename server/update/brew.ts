// A kitespan that Homebrew installed (DESIGN-I1 3.2, 3.3): the brew kind of server/update/kind.ts. kitespan never
// updates a Homebrew prefix itself: `brew upgrade kitespan` does, and then a restart runs the new keg (opt names it).
// So no check ever runs (no read, no timer: Homebrew's own `brew outdated` says it, and the tap is updated by hand after
// each release, so a read of GitHub could say "available" before brew has anything), and the Update button and
// bin/update.sh refuse with one line that names the command.

import type { UpdateSource } from "./source";

export function brewSource(o: { dev: boolean }): UpdateSource {
  return {
    check: async () => ({ kind: "none", failed: false }),
    refusal: async () => (o.dev ? "dev" : "brew"),
    apply: async () => ({ ok: false, step: "fetch", refusal: o.dev ? "dev" : "brew" }),
  };
}
