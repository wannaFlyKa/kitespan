// The port bind with a wait (DESIGN.md 4.10 step 4; build checklist S12): a restart's successor starts while the old
// server still holds the port, so it is started with `--bind-wait <seconds>` and tries the bind again every 100 ms
// while the port is in use, up to that long. A plain start has no wait: a busy port ends it at once, as before. The
// listener sets `reusePort: false` (main.ts): two listeners on one port would share its connections (R-restart F9),
// and with `development: false` Bun 1.3.14 sets SO_REUSEPORT unless told not to, so a busy port gave no EADDRINUSE.

export const BIND_STEP_MS = 100;

const inUse = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";

/**
 * `listen()` (Bun.serve), again every `stepMs` while it throws EADDRINUSE, for up to `waitS` seconds; any other error,
 * or the last EADDRINUSE, is thrown.
 */
export async function listenWithWait<T>(listen: () => T, waitS: number, stepMs = BIND_STEP_MS): Promise<T> {
  const end = Date.now() + Math.max(0, waitS) * 1000;
  for (;;) {
    try {
      return listen();
    } catch (e) {
      if (!inUse(e) || Date.now() + stepMs > end) throw e;
      await Bun.sleep(stepMs);
    }
  }
}
