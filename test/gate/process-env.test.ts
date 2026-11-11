// D60 (build checklist E4; R-env 5.6): no server code writes the server's own process.env. That is what keeps an
// environment's variables away from the corpus's git, kitespan's own worktree git, the binary pin's `claude --version`
// and the restart's successor: they get the start environment, or the server's own, and the variables are never in
// either. A scan of every file under server/, comments left out, with a check that the scan finds each planted write.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

/** Comments out, so a sentence about process.env is not a write of it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Every write of process.env in a source text: an assignment, a delete, an Object.assign or defineProperty, a swap. */
export function processEnvWrites(text: string): string[] {
  const src = code(text);
  const env = String.raw`(?:globalThis\s*\.\s*)?process\s*\.\s*env`;
  const hits: string[] = [];
  const patterns: [string, RegExp][] = [
    ["assignment", new RegExp(String.raw`${env}\s*(?:\.\s*[\w$]+|\[[^\]]*\])\s*(?:[-+*/%&|^]|\?\?|\|\||&&|<<|>>>?|\*\*)?=(?!=)`)],
    ["replacement", new RegExp(String.raw`${env}\s*=(?!=)`)],
    ["delete", new RegExp(String.raw`\bdelete\s+${env}`)],
    ["Object.assign", new RegExp(String.raw`Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*${env}\b`)],
    ["Reflect", new RegExp(String.raw`Reflect\s*\.\s*(?:set|deleteProperty|defineProperty)\s*\(\s*${env}\b`)],
    ["an alias", new RegExp(String.raw`(?:const|let|var)\s+[\w$]+\s*=\s*${env}\s*[;\n]`)],
    ["a destructured alias", new RegExp(String.raw`\{\s*env\s*(?::\s*[\w$]+)?\s*\}\s*=\s*process\b`)],
  ];
  for (const [label, re] of patterns) if (re.test(src)) hits.push(label);
  return hits;
}

describe("the scan itself", () => {
  test("it finds each planted write, and no read", () => {
    expect(processEnvWrites(`process.env.X = "1";`)).toEqual(["assignment"]);
    expect(processEnvWrites(`process.env["X"] ??= v;`)).toEqual(["assignment"]);
    expect(processEnvWrites(`process . env [name]= v`)).toEqual(["assignment"]);
    expect(processEnvWrites(`process.env = {}`)).toEqual(["replacement"]);
    expect(processEnvWrites(`delete process.env.X;`)).toEqual(["delete"]);
    expect(processEnvWrites(`Object.assign(process.env, vars);`)).toEqual(["Object.assign"]);
    expect(processEnvWrites(`Reflect.set(process.env, "X", "1");`)).toEqual(["Reflect"]);
    expect(processEnvWrites(`const e = process.env;\ne.X = 1;`)).toEqual(["an alias"]);
    expect(processEnvWrites(`const { env } = process;`)).toEqual(["a destructured alias"]);
    expect(processEnvWrites(`globalThis.process.env.X = "1"`)).toEqual(["assignment"]);
    // Reads, copies and comments are fine.
    expect(processEnvWrites(`const v = process.env.X === "1"; const c = { ...process.env }; f(process.env);`)).toEqual([]);
    expect(processEnvWrites(`if (process.env.X == "1" || process.env.Y === y) {}`)).toEqual([]);
    expect(processEnvWrites(`// process.env.X = "1"\n/* delete process.env.Y */`)).toEqual([]);
  });
});

describe("no server code writes process.env (E4)", () => {
  test("every file under server/", () => {
    const offenders = sources(join(ROOT, "server"))
      .map((p) => ({ file: relative(ROOT, p), hits: processEnvWrites(readFileSync(p, "utf8")) }))
      .filter((f) => f.hits.length > 0);
    expect(offenders).toEqual([]);
  });
});
