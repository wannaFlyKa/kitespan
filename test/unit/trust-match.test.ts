// R127: the matcher of Claude Code's refusal line (shared/trust.ts) and the text rules of a folder to trust. The line is
// the CLI's own (2.1.317 and 2.1.318, the `--bg` check's refusal; the lead's probe, it5-ui/live/LIVE-NOTES.md item 10):
// "Workspace not trusted. Run `claude` in <the real path> once and accept the trust prompt, then retry."
import { describe, expect, test } from "bun:test";
import { holdsPath, refusedFolder, trustPathProblem, TRUST_REFUSAL_RE } from "../../shared/trust";

const line = (path: string) => `Workspace not trusted. Run \`claude\` in ${path} once and accept the trust prompt, then retry.`;
/** The probe's folder shape: a new repository nested in a scratch folder, by its real path (not the /home link). */
const PROBE = "/srv/scratch/trust-probe-1793894001/inner";

describe("refusedFolder", () => {
  test("the probe's exact line alone gives its real path", () => {
    expect(refusedFolder(line(PROBE))).toBe(PROBE);
    expect(refusedFolder(`${line(PROBE)}\n`)).toBe(PROBE);
  });

  test("the line inside a Bash result, with Exit code 1 and other output around it", () => {
    const text = `Exit code 1\nStarting the investigator...\n${line(PROBE)}\nsomething after`;
    expect(refusedFolder(text)).toBe(PROBE);
  });

  test("a carriage return before the line feed is allowed (CRLF output)", () => {
    expect(refusedFolder(`Exit code 1\r\n${line(PROBE)}\r\nmore\r\n`)).toBe(PROBE);
    expect(refusedFolder(`${line(PROBE)}\r`)).toBe(PROBE);
  });

  test("a path with spaces, a quote, a dollar sign or non-ASCII letters is kept as it is", () => {
    for (const p of ["/srv/you/my projects/task 1", "/srv/you/it's here", "/srv/$HOME/x", "/srv/you/proyectos/año", "/srv/you/任务"]) expect(refusedFolder(line(p))).toBe(p);
  });

  test("a path that holds ' once ' (and even the line's own tail) is read whole, up to the line's end", () => {
    expect(refusedFolder(line("/srv/you/do it once /twice"))).toBe("/srv/you/do it once /twice");
    const tricky = "/srv/you/x once and accept the trust prompt, then retry. y";
    expect(refusedFolder(line(tricky))).toBe(tricky);
  });

  test("the root folder is read too, so its row can be refused as one that holds home (the lead's live run)", () => {
    expect(refusedFolder(line("/"))).toBe("/");
  });

  test("two lines: the first one wins", () => {
    expect(refusedFolder(`${line("/srv/one")}\n${line("/srv/two")}`)).toBe("/srv/one");
  });

  test("Claude Code's other trust lines never match", () => {
    const mustNot = [
      // The home folder's line (U+2014 is the em dash Claude Code writes).
      "Workspace not trusted. The home directory is trusted one session at a time — start this from an interactive terminal there, or from a project directory.",
      // The path that could not be resolved.
      `Workspace not trusted. ${PROBE} could not be resolved on disk.`,
      // Remote Control's and ultrareview's line, with and without ultrareview's addition.
      `Error: Workspace not trusted. Please run \`claude\` in ${PROBE} first to review and accept the workspace trust dialog.`,
      `Error: Workspace not trusted. Please run \`claude\` in ${PROBE} first to review and accept the workspace trust dialog. Or, in a script or CI job, pass \`--trust-workspace\` to trust the folder for this run only.`,
      // --worktree's line.
      "Workspace trust not yet accepted. Run `claude` once in this directory and accept the trust dialog, then retry with --worktree.",
      // The chat's own stderr warning.
      "Ignoring 2 permission entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects[...].hasTrustDialogAccepted: true in ~/.claude.json.",
    ];
    for (const text of mustNot) expect([text, refusedFolder(text)]).toEqual([text, null]);
  });

  test("near misses never match", () => {
    const misses = [
      line(PROBE).slice(0, -1), // no final period
      line(PROBE).replace("`claude`", "claude"), // no backticks
      line("inner/task"), // a relative path
      line("~/task"), // a ~ path (Claude Code never writes one)
      line(""), // no path
      `  ${line(PROBE)}`, // not at the line's start
      `> ${line(PROBE)}`, // quoted
      `${line(PROBE)} (2)`, // more after the line on the same line
      line(PROBE).replace("Workspace not trusted.", "Workspace not trusted:"),
      line(PROBE).toLowerCase(),
    ];
    for (const text of misses) expect([text, refusedFolder(text)]).toEqual([text, null]);
  });

  test("a path never runs past its own line", () => {
    expect(refusedFolder(`Workspace not trusted. Run \`claude\` in /a\n/b once and accept the trust prompt, then retry.`)).toBeNull();
  });

  test("anything that is not a string is no refusal", () => {
    for (const v of [null, undefined, 1, {}, ["x"]]) expect(refusedFolder(v)).toBeNull();
  });

  test("the expression is written with no backslash", () => {
    expect(TRUST_REFUSAL_RE.source.includes("\\")).toBe(false);
    expect(TRUST_REFUSAL_RE.multiline).toBe(true);
  });

  test("a text of several MiB with no refusal is read quickly", () => {
    const big = "Workspace not trusted. no\n".repeat(200_000);
    const t0 = performance.now();
    expect(refusedFolder(big)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("trustPathProblem", () => {
  test("an absolute path of at most 4,096 bytes with no control character is fine", () => {
    expect(trustPathProblem(PROBE)).toBeNull();
    expect(trustPathProblem("/" + "a".repeat(4095))).toBeNull();
  });
  test("over 4,096 bytes of UTF-8 is too long, counted in bytes, not characters", () => {
    expect(trustPathProblem("/" + "a".repeat(4096))).toBe("too_long");
    // 1 + 1,366 three-byte characters = 4,099 bytes, in 1,367 UTF-16 units.
    expect(trustPathProblem("/" + "任".repeat(1366))).toBe("too_long");
    expect(trustPathProblem("/" + "任".repeat(1365))).toBeNull();
  });
  test("a relative path or a control character is bad", () => {
    for (const p of ["inner", "~/x", "", "./x", "/a\tb", "/a\nb", "/a\u0000b", "/a\u202eb", "/a\u2028b", "/a\u007fb"]) expect([p, trustPathProblem(p)]).toEqual([p, "bad"]);
  });
});

describe("holdsPath", () => {
  test("the same path, the root and every folder above hold it; a sibling with a shared prefix does not", () => {
    expect(holdsPath("/srv/you", "/srv/you")).toBe(true);
    expect(holdsPath("/", "/srv/you")).toBe(true);
    expect(holdsPath("/srv", "/srv/you")).toBe(true);
    expect(holdsPath("/srv/yo", "/srv/you")).toBe(false);
    expect(holdsPath("/srv/you/x", "/srv/you")).toBe(false);
  });
});
