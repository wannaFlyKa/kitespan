// The tests that run only on Linux (P1 DESIGN 4.4): they read /proc themselves, or start servers that they stop only
// after a /proc/<pid>/cmdline check. Where /proc cannot be read (macOS), they skip with LINUX_ONLY in their name, so
// the run's log names each one; test/unit/linux-only.test.ts makes sure that they never skip on Linux.
import { existsSync } from "node:fs";

/** True where /proc can be read. */
export const PROCFS = existsSync("/proc/self/stat");

/** The reason a skipped test's name carries. */
export const LINUX_ONLY = "(Linux only: it reads /proc)";
