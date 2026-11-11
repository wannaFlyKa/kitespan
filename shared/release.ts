// kitespan's releases (DESIGN-I1 1): where they are, what each holds, and the version rule. One copy for the server's
// update check (server/update/release.ts), scripts/release.ts and the tests; install.sh repeats the names in sh, and
// test/unit/install-posix.test.ts keeps the two in step. Pure code: no DOM, no Bun API, no import from outside shared/.

/** The GitHub repository of the releases (H1's checklist renames it if the owner's organisation has another name). */
export const RELEASE_REPO = "wannaFlyKa/kitespan";
export const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;
/** The Homebrew tap's formula, as `brew install` names it. */
export const BREW_FORMULA = "wannaFlyKa/tap/kitespan";
/** A release's version: three numbers, no leading zero, nothing after them. */
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const releaseTag = (v: string): string => `v${v}`;
export const archiveName = (v: string): string => `kitespan-${v}.tar.gz`;
export const SUMS_FILE = "SHA256SUMS";
export const INSTALLER_FILE = "install.sh";
/** The most that the check reads of SHA256SUMS, and that install.sh downloads of it. */
export const SUMS_MAX_BYTES = 64 * 1024;
/** A SHA256SUMS line for a release archive: the digest, two spaces, the name. */
export const SUMS_ARCHIVE_LINE = /^([0-9a-f]{64}) {2}kitespan-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.tar\.gz$/;

function parts(v: string): [bigint, bigint, bigint] {
  const m = RELEASE_VERSION.exec(v);
  if (!m) throw new TypeError(`${JSON.stringify(v)} is not a release version`);
  return [BigInt(m[1]!), BigInt(m[2]!), BigInt(m[3]!)];
}

/** -1, 0 or 1, by the three numbers (both must pass RELEASE_VERSION). */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** The highest version that SHA256SUMS lists an archive line for, or null (a CR before a line end is dropped). */
export function newestInSums(text: string): string | null {
  let best: string | null = null;
  for (const raw of text.split("\n")) {
    const m = SUMS_ARCHIVE_LINE.exec(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    if (m && (best === null || compareVersions(m[2]!, best) > 0)) best = m[2]!;
  }
  return best;
}
