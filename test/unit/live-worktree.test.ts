// The model-free parts of the opt-in live worktree test (test/live/worktree.test.ts, FIX-W25b section 2), in the normal
// suite: the fixture repository it makes, the search for a planted value over a folder and over a page's frames, and
// LV-W4's verdict on a typed resume command with the line for L28. Every git call here runs in a scratch repository
// under a mkdtemp folder, with no system or global git config (scratchGit).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DENY_RULE, filesHolding, framesHolding, l28Line, makeFixture, makeTemp, makeTempIn, modelProblem, paneError, paneVerdict, removeTemp, screenText, removeTempIn, scratchGit } from "../live/live";

const tmp = makeTemp("unit");
afterAll(() => removeTemp(tmp));

const SESSION = "0b3e2a4c-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("the live worktree test's fixture repository", () => {
  test("one file in one commit by the test identity; the deny rule in .claude/settings.json, excluded, so a worktree has no copy", () => {
    const f = makeFixture(tmp);
    expect(dirname(f.root)).toBe(tmp);
    expect(basename(f.root).startsWith("kitespan-live-worktree-")).toBe(true);
    const git = (...args: string[]) => scratchGit(f.root, args);
    expect(git("rev-list", "--count", "HEAD").out.trim()).toBe("1");
    expect(git("rev-parse", "HEAD").out.trim()).toBe(f.head);
    expect(git("log", "--format=%an <%ae>|%cn <%ce>").out.trim()).toBe("kitespan live test <kitespan-live@example.invalid>|kitespan live test <kitespan-live@example.invalid>");
    expect(git("ls-files").out).toBe("README.md\n");
    // LV-W1: the main checkout's settings are never committed: .claude/ is in .git/info/exclude.
    expect(git("status", "--porcelain=v1", "--untracked-files=all").out).toBe("");
    expect(git("check-ignore", "--quiet", ".claude/settings.json").code).toBe(0);
    expect(JSON.parse(readFileSync(join(f.root, ".claude", "settings.json"), "utf8"))).toEqual({ permissions: { deny: [DENY_RULE] } });
    // A worktree from HEAD (what kitespan makes, L22) has the file and no .claude folder.
    const wt = join(tmp, "wt-fixture");
    expect(git("worktree", "add", "--quiet", "-b", "kitespan/unitcase", wt, "HEAD").code).toBe(0);
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    expect(existsSync(join(wt, ".claude"))).toBe(false);
    expect(git("worktree", "remove", wt).code).toBe(0);
    removeTempIn(tmp, f.root);
    expect(existsSync(f.root)).toBe(false);
  });

  test("removeTempIn removes only a folder that makeTempIn made directly in that folder", () => {
    const other = join(tmp, "not-the-tests");
    mkdirSync(other);
    removeTempIn(tmp, other);
    expect(existsSync(other)).toBe(true);
    const inner = makeTempIn(other, "inner");
    // Not directly under the folder that the call names.
    removeTempIn(tmp, inner);
    expect(existsSync(inner)).toBe(true);
    removeTempIn(other, inner);
    expect(existsSync(inner)).toBe(false);
  });
});

describe("the search for a planted value", () => {
  const value = "0123456789abcdef0123456789abcdef";

  test("filesHolding names each file that holds it, in order, never through a link, and leaves out what skip names", () => {
    const dir = makeTempIn(tmp, "search");
    writeFileSync(join(dir, "a.log"), `before ${value} after\n`);
    mkdirSync(join(dir, "env"));
    writeFileSync(join(dir, "env", "p.json"), JSON.stringify({ vars: [{ name: "N", value }] }));
    writeFileSync(join(dir, "env", "q.json"), "{}");
    mkdirSync(join(dir, "deep", "er"), { recursive: true });
    writeFileSync(join(dir, "deep", "er", "z.bin"), Buffer.concat([Buffer.from([0, 255, 10]), Buffer.from(value)]));
    writeFileSync(join(dir, "half.txt"), value.slice(0, 16));
    const outside = makeTempIn(tmp, "outside");
    writeFileSync(join(outside, "o.txt"), value);
    symlinkSync(join(outside, "o.txt"), join(dir, "link.txt"));
    symlinkSync(outside, join(dir, "linked-folder"));
    expect(filesHolding(dir, value)).toEqual(["a.log", "deep/er/z.bin", "env/p.json"]);
    expect(filesHolding(dir, value, (rel) => rel === "env/p.json")).toEqual(["a.log", "deep/er/z.bin"]);
    expect(filesHolding(dir, "fedcba9876543210fedcba9876543210")).toEqual([]);
    expect(filesHolding(join(dir, "no-such-folder"), value)).toEqual([]);
  });

  test("framesHolding counts the JSON frames that hold it, and the pane output once, also split across two frames", () => {
    const enc = new TextEncoder();
    expect(framesHolding({ frames: [{ t: "ev", e: { k: "block", text: `x${value}` } }, { t: "chats" }], bytes: [] }, value)).toBe(1);
    expect(framesHolding({ frames: [], bytes: [enc.encode(`$ ${value.slice(0, 10)}`), enc.encode(`${value.slice(10)}\r\n`)] }, value)).toBe(1);
    expect(framesHolding({ frames: [{ t: "ev", e: { k: "tool_call", input: { command: 'printf %s "$NAME" | sha256sum' } } }], bytes: [enc.encode("no value")] }, value)).toBe(0);
  });
});

describe("LV-W4's verdict and the L28 line", () => {
  const base = { seen: true, output: "Resuming the conversation\r\n> ", record: SESSION, session: SESSION };

  test("accepted: the pane's claude started, its session record names the chat's session, and no error line shows", () => {
    expect(paneVerdict(base)).toBe("accepted");
  });

  test("each other case says why, an error line first", () => {
    expect(paneVerdict({ ...base, output: "error: unknown option '--project-config-root'\r\n$ " })).toBe("refused (error: unknown option '--project-config-root')");
    expect(paneVerdict({ ...base, seen: false, output: `No conversation found with session ID: ${SESSION}\r\n` })).toBe(`refused (No conversation found with session ID: ${SESSION})`);
    expect(paneVerdict({ ...base, record: null, output: "Do you trust the files in this folder?\r\n❯ 1. Yes, proceed" })).toBe("asked whether to trust the folder");
    // Claude Code 2.1.317 draws each space of its trust question as a cursor move (CSI 1 C).
    const drawn = "Quick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?\r\n\x1b[2m❯\x1b[22m\x1b[1CNo,\x1b[1Cexit\r\nYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder";
    expect(paneVerdict({ ...base, record: null, output: drawn })).toBe("asked whether to trust the folder");
    expect(screenText(drawn)).toContain("Yes, I trust this folder");
    expect(paneVerdict({ ...base, seen: false, record: null })).toBe("no claude started");
    expect(paneVerdict({ ...base, record: null })).toBe("no session record within 20 s");
    expect(paneVerdict({ ...base, record: "11111111-2222-4333-8444-555555555555" })).toBe("its session record names another session");
  });

  test("paneError reads the first error line without its URL, and nothing in a plain screen", () => {
    expect(paneError("x\r\nerror: see https://example.invalid/a?b for help\r\n")).toBe("error: see <url> for help");
    expect(paneError("the terror of a word in a sentence")).toBeNull();
    expect(paneError("$ cd /tmp/x && claude --resume id --project-config-root /tmp/y\r\n")).toBeNull();
  });

  test("paneError names no provider ARN and no account id (row 95): each ARN, any case, and each run of 12 digits go before the cut", () => {
    const account = "4321".repeat(3);
    const arn = ["arn", "aws", "bedrock", "us-west-2", account, "application-inference-profile/fdtestprofile"].join(":");
    const long = `error: ${"the model is not available on this provider ".repeat(3)}(${arn.toUpperCase()})`;
    expect(paneError(`x\r\nerror: model ${arn} denied for account ${account}: retry\r\n`)).toBe("error: model [an ARN] denied for account <id>: retry");
    const cut = paneError(`${long}\r\n`)!;
    expect(cut.length).toBeLessThanOrEqual(160);
    expect([cut.toLowerCase().includes("arn:"), cut.includes(account), cut.includes("4321")]).toEqual([false, false, false]);
    expect(paneVerdict({ ...base, output: `error: ${arn} is not a model\r\n` })).toBe("refused (error: [an ARN] is not a model)");
  });

  test("the line names the version and both verdicts, and no path or session id", () => {
    expect(l28Line("2.1.317", "accepted", "refused (error: unknown option '--project-config-root')")).toBe(
      "LV-W4 on Claude Code 2.1.317: `cd <worktree> && claude --resume <id>`: accepted; with `--project-config-root <project folder>`: refused (error: unknown option '--project-config-root').",
    );
    expect(l28Line(null, "accepted", "accepted")).toBe("LV-W4 on Claude Code (version unknown): `cd <worktree> && claude --resume <id>`: accepted; with `--project-config-root <project folder>`: accepted.");
  });
});

describe("the live model row (every live file logs and sends it)", () => {
  test("a provider ARN is refused, and the line does not name it (row 95)", () => {
    const arn = ["arn", "aws", "bedrock", "us-west-2", "4321".repeat(3), "application-inference-profile/fdtestprofile"].join(":");
    const why = modelProblem("KITESPAN_LIVE_MODEL", arn, true);
    expect(why).toBe("KITESPAN_LIVE_MODEL is a provider ARN: give the CLI's own row value that is not one");
    expect(modelProblem("KITESPAN_LIVE_MODEL", arn.toUpperCase(), true)).toBe(why);
    expect(modelProblem("KITESPAN_LIVE_MODEL", "claude-haiku-4-5", true)).toBeNull();
  });
});
