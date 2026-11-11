// The old name's literals, in one place (iteration 6, round K1; launch/PLAN.md L4). The product was called flydeck
// before it was kitespan. These let a build of the new name take over an install of the old one: its folders (moved
// once at the first start from the terminal, server/store/move.ts, which also knows a running server of the old name by
// its start command), its environment names and its request header (read for one release), the page's stored keys
// (moved by web/index.html's inline script, whose literal a test checks against this file's), its worktree branches and
// its data folder (kept for good while a worktree made under them exists), and its day log files (swept). The other
// old-name readers (bin/flydeck, bin/kitespan and web/index.html) cannot import this file and are on the sweep test's
// allow-list. No import: the server and the page both import it.

/** The old name, lower case as the product wrote it. */
export const LEGACY_NAME = "flydeck";

/** The old XDG folders' name (state, config, data): `$XDG_STATE_HOME/flydeck` and the others. */
export const LEGACY_FOLDER = "flydeck";

/**
 * The old request header (`x-flydeck: 1`): a page loaded before the restart sends it, and a server of the old name
 * wants it.
 */
export const LEGACY_HEADER = "x-flydeck";

/** The old worktree branches, `flydeck/<8 symbols>`: a worktree made under them keeps its branch for good. */
export const LEGACY_BRANCH_PREFIX = "flydeck/";

/** The old day log files, `flydeck-<YYYY-MM-DD>.log`, which the 14-day sweep still removes. */
export const LEGACY_LOG_PREFIX = "flydeck-";

/** The prefix of the page's old stored keys (local and session storage), `flydeck.<rest>`. */
export const LEGACY_KEY_PREFIX = "flydeck.";

/**
 * The old start command, a stub for one release (relative to the repository root): a checkout that has it, or
 * bin/kitespan, is one of this product's (move.ts knows a running server so).
 */
export const LEGACY_BIN = "bin/flydeck";

/** The first words of the note left at an old folder's path after its move, by which a later start knows the note. */
export const LEGACY_NOTE_HEAD = "kitespan moved this folder to ";

/** The words of the note left at an old folder's path after its move: where it went, and why the note is there. */
export function legacyNote(to: string, day: string): string {
  return `${LEGACY_NOTE_HEAD}${to} on ${day} (flydeck is now called kitespan).\nThis file keeps an older flydeck from starting with an empty folder here. You may delete it.\n`;
}

/**
 * The old name of an environment name: `KITESPAN_X` was `FLYDECK_X`, `KITESPANTEST_X` was `FLYDECKTEST_X`; null for
 * any other.
 */
export function legacyEnvName(name: string): string | null {
  return /^KITESPAN(?:TEST)?_[A-Z0-9_]+$/.test(name) ? `FLYDECK${name.slice("KITESPAN".length)}` : null;
}

/** The names that one `say` has had its line about, so each says it once. */
const told = new WeakMap<(line: string) => void, Set<string>>();

/**
 * An environment name of the new name, with its old name read for one release: the new name's value when it is set;
 * else the old name's, with one line that names both names (never a value). When both are set, the new one wins and
 * the line says that the old one is not read. `say` gets each name's line once.
 */
export function readEnv(env: Readonly<Record<string, string | undefined>>, name: string, say: (line: string) => void): string | undefined {
  const old = legacyEnvName(name);
  const value = env[name];
  if (old === null || env[old] === undefined) return value;
  const once = told.get(say) ?? new Set<string>();
  told.set(say, once);
  if (!once.has(name)) {
    once.add(name);
    say(value === undefined ? `${old} is read as ${name}, its new name; the old name is not read after this release.` : `${old} is not read: ${name} is set, its new name.`);
  }
  return value ?? env[old];
}
