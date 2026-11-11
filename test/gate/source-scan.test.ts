// The raw-conflict endpoints that are not options (DESIGN.md 4.7 case 1, 8.5, 13.1): createSdkMcpServer and tool
// (functions), updateSettings and setMcpServers (Query methods). No file of the app calls them, by name, by a
// computed name or through the untyped request() with their control subtypes. spawnClaudeCodeProcess appears only
// in the tests that drive the fake CLI (D5), never in the app.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { RAW_CONFLICT_FUNCTIONS, RAW_CONFLICT_QUERY_METHODS } from "../../server/agents/claude/options";

const ROOT = resolve(import.meta.dir, "..", "..");
const APP_DIRS = ["server", "shared", "web", "bin", "scripts", "prototype"];

function sources(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (CODE_FILE.test(n) || !n.includes(".")) out.push(p);
  }
  return out;
}

const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|sh)$/;

/** Every app file: the root-level code files (index.ts) and the app folders. */
function appSources(): string[] {
  const top = readdirSync(ROOT).filter((n) => CODE_FILE.test(n) && statSync(join(ROOT, n)).isFile());
  return [...top.map((n) => join(ROOT, n)), ...APP_DIRS.flatMap((d) => sources(join(ROOT, d)))];
}

/** Comments out, so a sentence about a refused name is not a use of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every use of a raw-conflict endpoint in one source text, as short labels. */
export function rawConflictUses(text: string): string[] {
  const src = code(text);
  const hits: string[] = [];
  // The SDK's module name in quotes: the package itself or one of its subpaths.
  const SDK = String.raw`["'\x60]@anthropic-ai\/claude-agent-sdk(?:\/[^"'\x60]*)?["'\x60]`;
  // A named import of the two functions from the SDK (any spacing, aliased or not).
  for (const m of src.matchAll(new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${SDK}`, "g")))
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if ((RAW_CONFLICT_FUNCTIONS as readonly string[]).includes(name)) hits.push(`import ${name}`);
    }
  // A namespace or default import, import(), require() or a re-export would hide the names: refused as such (a type
  // is written with `import type`, never as `import("...")`).
  if (new RegExp(String.raw`import\s+\*\s*as\s+[\w$]+\s+from\s*${SDK}`).test(src)) hits.push("namespace import of the SDK");
  if (new RegExp(String.raw`import\s+(?!type\s)[\w$]+\s*(?:,|from)\s*${SDK}`).test(src)) hits.push("default import of the SDK");
  if (new RegExp(String.raw`\bimport\s*\(\s*${SDK}`).test(src)) hits.push("dynamic import of the SDK");
  if (new RegExp(String.raw`\brequire\s*\(\s*${SDK}`).test(src)) hits.push("require of the SDK");
  if (new RegExp(String.raw`\bexport\s+(?:type\s*)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*${SDK}`).test(src)) hits.push("re-export of the SDK");
  if (/\bcreateSdkMcpServer\s*\(/.test(src)) hits.push("createSdkMcpServer(");
  for (const name of RAW_CONFLICT_QUERY_METHODS) {
    if (new RegExp(`\\.\\s*${name}\\s*\\(`).test(src)) hits.push(`.${name}(`);
    if (new RegExp(`\\[\\s*["'\`]${name}["'\`]\\s*\\]`).test(src)) hits.push(`["${name}"]`);
  }
  // The same through the untyped request(): their control subtypes.
  for (const sub of ["update_settings", "mcp_set_servers"]) if (new RegExp(`["'\`]${sub}["'\`]`).test(src)) hits.push(sub);
  if (/\bspawnClaudeCodeProcess\b/.test(src)) hits.push("spawnClaudeCodeProcess");
  return hits;
}

describe("the scan itself", () => {
  test("it finds each planted use", () => {
    const sdk = "@anthropic-ai/claude-agent-sdk";
    expect(rawConflictUses(`import { query, tool } from "${sdk}";`)).toEqual(["import tool"]);
    expect(rawConflictUses(`import { createSdkMcpServer as make } from '${sdk}';\nmake({});`)).toEqual(["import createSdkMcpServer"]);
    expect(rawConflictUses(`import * as sdk from "${sdk}";`)).toEqual(["namespace import of the SDK"]);
    expect(rawConflictUses(`await q.updateSettings("userSettings", {});`)).toEqual([".updateSettings("]);
    expect(rawConflictUses(`await q . setMcpServers({});`)).toEqual([".setMcpServers("]);
    expect(rawConflictUses(`await (q as any)["setMcpServers"]({});`)).toEqual(['["setMcpServers"]']);
    expect(rawConflictUses(`await q.request({ subtype: "update_settings" });`)).toEqual(["update_settings"]);
    expect(rawConflictUses(`const o = { spawnClaudeCodeProcess: f };`)).toEqual(["spawnClaudeCodeProcess"]);
  });
  test("it finds the SDK reached some other way: import(), require(), a re-export, a subpath", () => {
    const sdk = "@anthropic-ai/claude-agent-sdk";
    expect(rawConflictUses(`const m = await import("${sdk}");\nm.tool("x", "y", {}, f);`)).toEqual(["dynamic import of the SDK"]);
    expect(rawConflictUses(`const m = await import ( \`${sdk}/sdk.mjs\` );`)).toEqual(["dynamic import of the SDK"]);
    expect(rawConflictUses(`type O = import('${sdk}').Options;`)).toEqual(["dynamic import of the SDK"]);
    expect(rawConflictUses(`const { tool } = require("${sdk}");`)).toEqual(["require of the SDK"]);
    expect(rawConflictUses(`import sdk = require('${sdk}/sdk.mjs');`)).toEqual(["require of the SDK"]);
    expect(rawConflictUses(`export { tool } from "${sdk}";`)).toEqual(["re-export of the SDK"]);
    expect(rawConflictUses(`export type { Options } from '${sdk}/sdk';`)).toEqual(["re-export of the SDK"]);
    expect(rawConflictUses(`export * from "${sdk}";`)).toEqual(["re-export of the SDK"]);
    expect(rawConflictUses(`export * as sdk from "${sdk}/sdk.mjs";`)).toEqual(["re-export of the SDK"]);
    expect(rawConflictUses(`import { tool as t } from "${sdk}/sdk.mjs";`)).toEqual(["import tool"]);
    expect(rawConflictUses(`import {\n  query,\n  createSdkMcpServer,\n} from "${sdk}/sdk";`)).toEqual(["import createSdkMcpServer"]);
    expect(rawConflictUses(`import * as s from '${sdk}/sdk';`)).toEqual(["namespace import of the SDK"]);
    expect(rawConflictUses(`import s from "${sdk}/sdk.mjs";`)).toEqual(["default import of the SDK"]);
  });
  test("another package's import(), require() or re-export is not a use", () => {
    expect(rawConflictUses(`const m = await import("node:fs"); const r = require("./sdk"); export * from "./events";`)).toEqual([]);
    expect(rawConflictUses(`import { tool } from "@anthropic-ai/claude-agent-sdk-tools";`)).toEqual([]);
    expect(rawConflictUses(`const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);`)).toEqual([]);
  });
  test("the scan covers the root-level files too", () => {
    expect(appSources().map((p) => relative(ROOT, p))).toContain("index.ts");
  });
  test("names in strings, lists and comments are not uses", () => {
    expect(rawConflictUses(`export const M = ["updateSettings", "setMcpServers"] as const; // never call updateSettings()`)).toEqual([]);
    expect(rawConflictUses(`/* tool( createSdkMcpServer( */ const toolName = "tool";`)).toEqual([]);
    expect(rawConflictUses(`import { query, type Options } from "@anthropic-ai/claude-agent-sdk";`)).toEqual([]);
  });
});

describe("the app's source", () => {
  test("no file outside the tests uses a raw-conflict function or Query method", () => {
    const files = appSources();
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((p) => rawConflictUses(readFileSync(p, "utf8")).map((h) => `${relative(ROOT, p)}: ${h}`));
    expect(found).toEqual([]);
  });
});
