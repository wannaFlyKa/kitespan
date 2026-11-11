// The public docs say what the code does (iteration 6, round P1): the READMEs name the minimum Claude Code version and
// the Bun version that the code and package.json pin, README.md and SECURITY.md hold the remote-access disclaimer as
// the server prints it, each `--origin` example passes the server's own rule, every relative link of a Markdown file
// resolves inside the repository, LICENSE is the Apache License 2.0 text as apache.org publishes it, and NOTICE is its
// three lines; and (round I1, DESIGN-I1 6.3) the install sections name the release's own install command, the tap's
// formula, the installer's own install step and package.json's version, in the same sections in both languages.
// External links are not fetched here.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isExactOrigin, NO_SIGN_IN } from "../../server/adapters/adapters";
import { CLAUDE_CODE_MINIMUM } from "../../server/agents/claude/background";
import { BREW_FORMULA, INSTALLER_FILE, RELEASE_REPO, RELEASES_URL } from "../../shared/release";

const ROOT = resolve(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** Line breaks and runs of blanks as one space, so a wrapped sentence still matches. */
const flat = (text: string) => text.replace(/\s+/g, " ");
/** The text outside fenced code blocks. */
const prose = (text: string) => text.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "");

/**
 * The SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt (11,358 bytes, LF line ends), fetched on 2026-11-07;
 * LICENSE is compared with its line ends made LF.
 */
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

const READMES = ["README.md", "README.zh-CN.md"] as const;

/** Every Markdown file that a commit takes: tracked, or untracked and not ignored. */
function markdownFiles(): string[] {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  const r = Bun.spawnSync(["git", "-C", ROOT, "-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ls-files failed: ${r.stderr.toString().trim()}`);
  return [...new Set(r.stdout.toString().split("\0").filter(Boolean))].filter((p) => existsSync(join(ROOT, p))).sort();
}

/** The targets of a file's Markdown links, `[text](target)`, outside code blocks. */
function linkTargets(text: string): string[] {
  return [...prose(text).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!);
}

describe("the Markdown links", () => {
  const files = markdownFiles();

  test("the public files are there", () => {
    for (const f of ["README.md", "README.zh-CN.md", "CONTRIBUTING.md", "SECURITY.md", "CLAUDE.md"]) expect(files).toContain(f);
  });

  test("every relative link resolves to a file or a folder inside the repository", () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const target of linkTargets(read(file))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
        const path = decodeURIComponent(target.split("#")[0]!);
        const full = resolve(ROOT, dirname(file), path);
        const inside = !relative(ROOT, full).startsWith("..");
        if (!inside || !existsSync(full)) broken.push(`${file}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("each README links the other at its top", () => {
    expect(read("README.md").split("\n").slice(0, 4)).toContain("[简体中文](README.zh-CN.md)");
    expect(read("README.zh-CN.md").split("\n").slice(0, 4)).toContain("[English](README.md)");
  });
});

describe("the READMEs", () => {
  test("they have the same sections, in the same order", () => {
    const headings = (f: string) => read(f).split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => l.match(/^#+/)![0].length);
    expect(headings("README.zh-CN.md")).toEqual(headings("README.md"));
    expect(headings("README.md").length).toBeGreaterThan(10);
  });

  test("they name the minimum Claude Code version and the Bun version that the code pins", () => {
    const bun = JSON.parse(read("package.json")).devDependencies["@types/bun"];
    expect(bun).toMatch(/^\d+\.\d+\.\d+$/);
    expect(flat(read("README.md"))).toContain(`Claude Code ${CLAUDE_CODE_MINIMUM} or later`);
    expect(flat(read("README.zh-CN.md"))).toContain(`Claude Code ${CLAUDE_CODE_MINIMUM} 或更高版本`);
    for (const f of READMES) expect(flat(read(f))).toContain(`Bun ${bun}`);
  });

  test("each --origin example is an origin that the server takes", () => {
    for (const f of READMES) {
      const values = [...read(f).matchAll(/--origin (\S+?)(?=[`\s]|$)/g)].map((m) => m[1]!).filter((v) => !v.includes("<"));
      expect(values.length).toBeGreaterThan(2);
      for (const v of values) expect({ file: f, origin: v, ok: isExactOrigin(v) }).toEqual({ file: f, origin: v, ok: true });
    }
  });
});

describe("the READMEs' install sections (DESIGN-I1 6)", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string; devDependencies: Record<string, string> };
  const bun = pkg.devDependencies["@types/bun"];
  const install = `curl -fsSL ${RELEASES_URL}/latest/download/${INSTALLER_FILE} | sh`;
  /** The installer's own install step (DESIGN-I1 2.9), as its step line names it. */
  const STEP_2 = "bun install --frozen-lockfile --omit=optional --production";
  const SECTIONS = {
    "README.md": ["## Requirements", "## Install", "### With the install script", "### With Homebrew", "### From source", "## Start", "## Update", "## Files"],
    "README.zh-CN.md": ["## 环境要求", "## 安装", "### 用安装脚本", "### 用 Homebrew", "### 从源码安装", "## 启动", "## 更新", "## 文件"],
  } as const;
  /** A fenced code block's lines. */
  const codeLines = (text: string) => [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```$/gm)].flatMap((m) => m[1]!.split("\n"));

  test("Requirements, Install with its three ways, Start, Update and Files follow each other, in both languages", () => {
    for (const f of READMES) {
      const headings = read(f).split("\n").filter((l) => /^#{1,6} /.test(l));
      const at = headings.indexOf(SECTIONS[f][0]);
      expect(at, f).toBeGreaterThan(0);
      expect(headings.slice(at, at + SECTIONS[f].length)).toEqual([...SECTIONS[f]]);
    }
  });

  test("each gives the release's install command and the tap's formula as commands of their own, and the pipe's form for an option", () => {
    for (const f of READMES) {
      const code = codeLines(read(f));
      expect(code, f).toContain(install);
      expect(code, f).toContain(`brew install ${BREW_FORMULA}`);
      expect(code, f).toContain("kitespan");
      expect(flat(read(f)), f).toContain(`\`${install} -s -- --uninstall\``);
      expect(flat(read(f)), f).toContain(`\`gh attestation verify kitespan-<version>.tar.gz --repo ${RELEASE_REPO}\``);
    }
  });

  test("each names the installer's own install step, package.json's version in KITESPAN_VERSION, and Bun's version as a minimum", () => {
    expect(read(INSTALLER_FILE)).toContain(`Step 2 of 3, install: ${STEP_2}`);
    for (const f of READMES) {
      const text = flat(read(f));
      expect(text, f).toContain(`\`${STEP_2}\``);
      expect(text, f).toContain(`\`KITESPAN_VERSION=${pkg.version} sh install.sh\``);
      for (const cmd of ["sh install.sh --list", "sh install.sh --uninstall", "brew upgrade kitespan", "brew uninstall kitespan", "kitespan --version", "kitespan --help"]) expect(text, `${f}: ${cmd}`).toContain(`\`${cmd}\``);
    }
    expect(flat(read("README.md"))).toContain(`Bun ${bun} or later`);
    expect(flat(read("README.zh-CN.md"))).toContain(`Bun ${bun} 或更高版本`);
  });

  test("the Not yet table has Homebrew, in both languages", () => {
    expect(read("README.md").split("\n")).toContain("| Homebrew | Not checked yet (the release workflow runs it on macOS after the push) |");
    expect(read("README.zh-CN.md").split("\n")).toContain("| Homebrew | 尚未验证（推送后由发布工作流在 macOS 上运行） |");
  });
});

describe("the remote-access disclaimer", () => {
  test("README.md and SECURITY.md hold the sentence that the server prints", () => {
    expect(NO_SIGN_IN.length).toBeGreaterThan(40);
    for (const f of ["README.md", "SECURITY.md"]) expect(flat(read(f))).toContain(NO_SIGN_IN);
  });

  test("it opens README.md's From another device", () => {
    const section = read("README.md").split(/^## /m).find((s) => s.startsWith("From another device\n"));
    expect(section).toBeDefined();
    const first = section!.split("\n\n")[1]!;
    expect(flat(first).trim()).toBe(NO_SIGN_IN);
  });
});

describe("LICENSE and NOTICE", () => {
  test("LICENSE is the Apache License 2.0 text, as apache.org publishes it", () => {
    const text = read("LICENSE").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(text).digest("hex")).toBe(APACHE_2_0_SHA256);
  });

  test("NOTICE is the name, one line on what it is, the copyright line, and the one vendored library (v0.6 touch)", () => {
    expect(read("NOTICE")).toBe(
      "kitespan\nA browser UI for the Claude Code CLI on your own machine.\nCopyright 2026 The kitespan Authors\n\n" +
        "web/ui/qrcodegen.ts is the QR Code generator library (TypeScript) by Project Nayuki, under the MIT License, with its\n" +
        "copyright and permission notice kept at the top of the file.\n",
    );
  });
});
