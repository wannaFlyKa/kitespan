// kitespan's self update (DESIGN.md 4.10, owner row 108): the words and the shapes that the server, bin/update.sh and
// the page share. One setting, "Check for updates" (Manually, Daily, Every 3 hours; settings.json, so the same on every
// device), the three steps of an update (the fast-forward from origin, the locked install, the build), the one line of
// each refusal, and the update job as the server holds it (one at a time; a second press joins the first). The words
// are kitespan's own: a check frequency, not a release channel, so never Claude Code's "stable" or "latest".
// Pure code: no DOM, no Bun API, no import from outside shared/.

/** The setting's values (settings.json `updates.check`), in the row's order. */
export const UPDATE_CHECKS = ["manual", "daily", "3h"] as const;
export type UpdateCheck = (typeof UPDATE_CHECKS)[number];

/** Daily (the owner's "stable") unless the user picks another. */
export const UPDATE_CHECK_DEFAULT: UpdateCheck = "daily";

/** The row's choices, as the page shows them. */
export const UPDATE_CHECK_LABELS: Readonly<Record<UpdateCheck, string>> = { manual: "Manually", daily: "Daily", "3h": "Every 3 hours" };

/** How often a check runs by itself; Manually runs none (only Check now). */
export const UPDATE_CHECK_EVERY_MS: Readonly<Record<Exclude<UpdateCheck, "manual">, number>> = { daily: 24 * 60 * 60_000, "3h": 3 * 60 * 60_000 };

export function isUpdateCheck(v: unknown): v is UpdateCheck {
  return typeof v === "string" && (UPDATE_CHECKS as readonly string[]).includes(v);
}

/** An update's steps, in order: the fetch and fast-forward from origin, the locked install, the page's build. */
export const UPDATE_STEPS = ["fetch", "install", "build"] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

/** What bin/update.sh names when a step fails ("update.sh: step 2 of 3 failed: bun install ..."). */
export const UPDATE_STEP_COMMANDS: Readonly<Record<UpdateStep, string>> = {
  fetch: "git fetch and git merge --ff-only",
  install: "bun install --frozen-lockfile --omit=optional",
  build: "bun run build",
};

/** "step 2 of 3, install". */
export function stepWords(step: UpdateStep): string {
  return `step ${UPDATE_STEPS.indexOf(step) + 1} of ${UPDATE_STEPS.length}, ${step}`;
}

/**
 * Why an update does not start, or a check could not look (each with one line): dev mode serves web/ itself; no git;
 * kitespan's folder is not the top of a git checkout; HEAD is on no branch; the branch has no upstream; origin's URL is
 * not one kitespan reads; the checkout has local changes (tracked or untracked, not ignored); it and origin have
 * diverged; kitespan could not read the checkout; another update runs (bin/update.sh, or another server's); kitespan is
 * restarting. An installed kitespan (DESIGN-I1 3.3): it was started with a --dist of its own; Homebrew installed it.
 */
export const UPDATE_REFUSALS = ["dev", "no_git", "not_checkout", "detached", "no_upstream", "remote", "local_changes", "diverged", "unreadable", "busy", "restarting", "dist", "brew"] as const;
export type UpdateRefusal = (typeof UPDATE_REFUSALS)[number];

export const UPDATE_REFUSAL_LINES: Readonly<Record<UpdateRefusal, string>> = {
  dev: "kitespan does not update itself in dev mode.",
  no_git: "kitespan found no git on PATH.",
  not_checkout: "kitespan's folder is not a git checkout.",
  detached: "This checkout is on no branch.",
  no_upstream: "This checkout's branch has no upstream.",
  remote: "kitespan cannot read this checkout's origin.",
  local_changes: "This checkout has local changes.",
  diverged: "This checkout and origin have diverged; kitespan cannot fast-forward it.",
  unreadable: "kitespan could not read this checkout.",
  busy: "Another update is running.",
  restarting: "kitespan is restarting.",
  dist: "kitespan was started with --dist, so it does not update itself.",
  brew: "Homebrew installed this kitespan: update it with brew upgrade kitespan, then restart kitespan.",
};

export function isUpdateRefusal(v: unknown): v is UpdateRefusal {
  return typeof v === "string" && (UPDATE_REFUSALS as readonly string[]).includes(v);
}

/**
 * The update job as the server holds it: none since the server started; running one step; ended at a step (`step`
 * null: refused before any step ran) with its one line; or done (the build is the checkout's: Restart to apply).
 */
export type UpdateJob =
  | { state: "idle" }
  | { state: "running"; step: UpdateStep }
  | { state: "failed"; step: UpdateStep | null; line: string }
  | { state: "done" };

/** The lines of the update: About's rows and the notice that every page gets. */
export const UPDATE_WORDS = {
  check: "Check for updates",
  checkNow: "Check now",
  checking: "Checking...",
  never: "Not checked yet.",
  checkFailed: "The check did not finish.",
  available: "Update available",
  update: "Update",
  /** The notice of origin's new work, with the Update action. */
  availableNotice: "Update available.",
  /** The notice once the steps are done; About's row is "Restart to apply" with Restart. */
  doneNotice: "Restart to apply the update.",
  dialogTitle: "Update kitespan",
  dialogLine: "kitespan keeps running until you restart it.",
  cancel: "Cancel",
  /** The restart's refusal while an update runs (the preflight). */
  restartBusy: "An update is running.",
  /** The build line when the checkout moved and the build did not (no job of this server says more). */
  unfinished: "The update did not finish.",
  /** Under Update available and Restart to apply, for a release or a brew install: the version it names. */
  versionLine: (v: string) => `Version ${v}`,
  brewLabel: "Installed with Homebrew",
  /** The brew row's line, drawn as "Update it with " + <code>brew upgrade kitespan</code> + ", then restart kitespan." */
  brewCommand: "brew upgrade kitespan",
  brewLine: "Update it with brew upgrade kitespan, then restart kitespan.",
} as const;

/** "Updating kitespan: step 2 of 3, install." */
export function runningLine(step: UpdateStep): string {
  return `Updating kitespan: ${stepWords(step)}.`;
}

/** "The update did not finish at step 2 of 3, install." */
export function failedLine(step: UpdateStep): string {
  return `The update did not finish at ${stepWords(step)}.`;
}

/** "Checked 2 h ago." from the minutes since the last check (the page's relTime rounding). */
export function checkedLine(at: string, now: number): string {
  const m = Math.round((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return "Checked just now.";
  if (m < 60) return `Checked ${m} min ago.`;
  const h = Math.round(m / 60);
  if (h < 24) return `Checked ${h} h ago.`;
  return `Checked ${Math.round(h / 24)} d ago.`;
}
