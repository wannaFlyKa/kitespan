// The binary pin (DESIGN.md 4.7, D18), the spike's SC-4 ported to fake `claude` scripts in a mkdtemp folder, with
// no company-build case. The PATH claude only, its real path outside node_modules, no fallback to a later PATH entry,
// `claude --version`, and the platform-package scan in its three places.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { driftLine, findPlatformPackages, INSTALL_ROOT, pinSync, probeBinary, readVersion, sdkClaudeCodeVersion } from "../../server/agents/claude/locate";

const T = realpathSync(mkdtempSync(join(tmpdir(), "binary-pin-")));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const EMPTY_ROOT = join(T, "install");
mkdirSync(EMPTY_ROOT);

function fakeClaude(dir: string, version = "2.1.999 (Claude Code)", mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "claude");
  writeFileSync(p, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(p, mode);
  return p;
}
const pin = (pathEnv: string) => pinSync({ pathEnv, installRoot: EMPTY_ROOT });

describe("the PATH claude only", () => {
  test("the first claude on PATH is chosen, with its real path", async () => {
    const a = fakeClaude(join(T, "a"), "2.1.312 (Claude Code)");
    fakeClaude(join(T, "b"), "2.1.300 (Claude Code)");
    const p = pin(`${join(T, "a")}:${join(T, "b")}`);
    expect(p).toEqual({ ok: true, path: a, realpath: a, refused: [], platformPackages: [] });
    const probe = await probeBinary({ pathEnv: `${join(T, "a")}:${join(T, "b")}`, installRoot: EMPTY_ROOT });
    expect(probe).toMatchObject({ ok: true, path: a, version: "2.1.312 (Claude Code)", source: "path", drift: null });
  });

  test("a link on PATH is followed to its real path", () => {
    const real = fakeClaude(join(T, "versions"));
    mkdirSync(join(T, "linkdir"));
    symlinkSync(real, join(T, "linkdir", "claude"));
    expect(pin(join(T, "linkdir"))).toMatchObject({ ok: true, path: join(T, "linkdir", "claude"), realpath: real });
  });

  test("a wrapper script named claude is the PATH claude: it is what the terminal runs", () => {
    const w = join(T, "wrapper");
    mkdirSync(w);
    writeFileSync(join(w, "claude"), `#!/bin/sh\nexec ${join(T, "versions", "claude")} "$@"\n`);
    chmodSync(join(w, "claude"), 0o755);
    expect(pin(w)).toMatchObject({ ok: true, path: join(w, "claude") });
  });

  test("a relative PATH entry: the pin holds the absolute path, so the start runs the file the pin checked", async () => {
    const c = fakeClaude(join(T, "rel", "bin"), "2.1.312 (Claude Code)");
    const rel = relative(realpathSync(process.cwd()), join(T, "rel", "bin"));
    expect(isAbsolute(rel)).toBe(false);
    expect(Bun.which("claude", { PATH: rel })).not.toBe(c);
    expect(pin(rel)).toEqual({ ok: true, path: c, realpath: c, refused: [], platformPackages: [] });
    expect(await probeBinary({ pathEnv: rel, installRoot: EMPTY_ROOT })).toMatchObject({ ok: true, path: c, version: "2.1.312 (Claude Code)" });
    fakeClaude(join(T, "rel", "noexec"), "x", 0o644);
    const relNoExec = relative(realpathSync(process.cwd()), join(T, "rel", "noexec"));
    expect(pin(relNoExec).refused).toEqual([{ path: join(T, "rel", "noexec", "claude"), reason: "not-executable" }]);
  });

  test("nothing on PATH: no claude, nothing refused (the start gets no_claude)", async () => {
    const p = pin(join(T, "nothing-here"));
    expect(p).toEqual({ ok: false, path: null, realpath: null, refused: [], platformPackages: [] });
    expect((await probeBinary({ pathEnv: join(T, "nothing-here"), installRoot: EMPTY_ROOT })).version).toBeNull();
  });

  test("a claude that is not executable is named, and nothing runs", () => {
    fakeClaude(join(T, "noexec"), "x", 0o644);
    expect(pin(join(T, "noexec"))).toMatchObject({ ok: false, path: null, refused: [{ path: join(T, "noexec", "claude"), reason: "not-executable" }] });
  });

  test("a claude inside node_modules is refused, and a later PATH entry is never tried", () => {
    const nm = join(T, "proj", "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64");
    fakeClaude(nm);
    const later = fakeClaude(join(T, "later"));
    const p = pin(`${nm}:${join(T, "later")}`);
    expect(p).toMatchObject({ ok: false, path: null, refused: [{ path: join(nm, "claude"), reason: "inside-node_modules" }] });
    expect(p.path).not.toBe(later);
  });

  test("a link into node_modules is refused by its real path", () => {
    const target = fakeClaude(join(T, "proj2", "node_modules", ".bin-target"));
    mkdirSync(join(T, "nmlink"));
    symlinkSync(target, join(T, "nmlink", "claude"));
    expect(pin(join(T, "nmlink"))).toMatchObject({ ok: false, refused: [{ reason: "inside-node_modules" }] });
  });

  test("claude --version: the first line, null on a failure or a timeout", async () => {
    expect(await readVersion(fakeClaude(join(T, "v1"), "2.1.300 (Claude Code)"))).toBe("2.1.300 (Claude Code)");
    const bad = join(T, "v2");
    mkdirSync(bad);
    writeFileSync(join(bad, "claude"), "#!/bin/sh\nexit 4\n");
    chmodSync(join(bad, "claude"), 0o755);
    expect(await readVersion(join(bad, "claude"))).toBeNull();
    const slow = join(T, "v3");
    mkdirSync(slow);
    writeFileSync(join(slow, "claude"), "#!/bin/sh\nsleep 5\necho late\n");
    chmodSync(join(slow, "claude"), 0o755);
    const t0 = Date.now();
    expect(await readVersion(join(slow, "claude"), 300)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test("the drift line names both versions; none when they match", () => {
    expect(sdkClaudeCodeVersion()).toBe("2.1.312");
    expect(driftLine("2.1.300 (Claude Code)")).toBe("Claude Code 2.1.300 runs here; this SDK was built for 2.1.312.");
    expect(driftLine("2.1.312 (Claude Code)")).toBeNull();
    expect(driftLine(null)).toBeNull();
  });

  test("a company's own build (row 119): its extra numbers are shown, and only the first three are compared", () => {
    expect(driftLine("2.1.312.4 (Claude Code)")).toBeNull();
    expect(driftLine("2.1.312-acme.2 (Claude Code)")).toBeNull();
    expect(driftLine("2.1.317.1 (Claude Code)")).toBe("Claude Code 2.1.317.1 runs here; this SDK was built for 2.1.312.");
    expect(driftLine("2.1.317-acme.2 (Acme Claude Code)")).toBe("Claude Code 2.1.317-acme.2 runs here; this SDK was built for 2.1.312.");
    expect(driftLine("2.1.317+build.9")).toBe("Claude Code 2.1.317+build.9 runs here; this SDK was built for 2.1.312.");
    expect(driftLine("dev build")).toBeNull();
  });
});

describe("the SDK platform packages (case 10)", () => {
  const plant = (dir: string) => mkdirSync(dir, { recursive: true });

  test("none in this repository's install tree", () => {
    expect(findPlatformPackages(INSTALL_ROOT)).toEqual([]);
  });

  test("found under node_modules/@anthropic-ai/", () => {
    const root = join(T, "pp1", "app");
    plant(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk"));
    plant(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64"));
    expect(findPlatformPackages(root)).toEqual([join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64")]);
  });

  test("found under node_modules/.bun/ (an isolated install)", () => {
    const root = join(T, "pp2", "app");
    plant(join(root, "node_modules", ".bun", "@anthropic-ai+claude-agent-sdk@0.3.312"));
    plant(join(root, "node_modules", ".bun", "@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.312"));
    expect(findPlatformPackages(root)).toEqual([join(root, "node_modules", ".bun", "@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.312")]);
  });

  test("found in a parent folder's node_modules", () => {
    const parent = join(T, "pp3");
    const root = join(parent, "deep", "app");
    plant(root);
    plant(join(parent, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-arm64-musl"));
    expect(findPlatformPackages(root)).toEqual([join(parent, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-arm64-musl")]);
  });

  test("a planted package makes the pin fail even with a good claude", () => {
    const root = join(T, "pp4");
    plant(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64"));
    const p = pinSync({ pathEnv: join(T, "a"), installRoot: root });
    expect(p.ok).toBe(false);
    expect(p.path).toBe(join(T, "a", "claude"));
    expect(p.platformPackages).toHaveLength(1);
  });
});
