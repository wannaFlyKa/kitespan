// What the Workflow launch card (CA-4) shows of a Workflow call, as Desktop's card does: "the workflow name, the
// phase list, and a token-usage caution" (code.claude.com/docs/en/workflows, "Approve the plan before it runs"). The
// call's input is a script whose first statement is `export const meta = {...}`, a plain object literal with a
// `name`, a `description` and, when the script lists them, its `phases`; the body groups agents under `phase()`
// titles. Nothing here runs the script: it reads string literals only. A saved workflow can also come by its name.

/** Claude Code's own caution for a run (the same page, "Cost"). */
export const WORKFLOW_CAUTION = "A workflow spawns many agents, so a single run can use meaningfully more tokens than working through the same task in conversation.";

export interface WorkflowPlan {
  name: string | null;
  description: string | null;
  phases: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A string literal in single, double or back quotes (no `${}` in a template). */
const STRING = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|` + "`([^`$\\\\]*)`";

function unquote(m: RegExpExecArray, at = 1): string {
  const raw = m[at] ?? m[at + 1] ?? m[at + 2] ?? "";
  return raw.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

/** The text between a bracket at `open` and its match, skipping strings and comments; null when it does not close. */
function enclosed(src: string, open: number, max = 40_000): string | null {
  const pair: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const stack: string[] = [];
  let q: string | null = null;
  for (let i = open; i < src.length && i < open + max; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl;
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 1;
    } else if (ch === "'" || ch === '"' || ch === "`") q = ch;
    else if (pair[ch]) stack.push(pair[ch]!);
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The value of a top-level `key: '...'` in an object literal's text. */
function field(block: string, key: string): string | null {
  const m = new RegExp(String.raw`(?:^|[\s,{])${key}\s*:\s*(?:${STRING})`).exec(block);
  const v = m ? unquote(m).trim() : "";
  return v ? v : null;
}

function strings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(STRING, "g"))) out.push(unquote(m as RegExpExecArray).trim());
  return out.filter(Boolean);
}

export function workflowPlan(input: unknown): WorkflowPlan {
  const o = isObj(input) ? input : {};
  const script = typeof o.script === "string" ? o.script : "";
  const at = script.search(/export\s+const\s+meta\s*=\s*\{/);
  const open = at >= 0 ? script.indexOf("{", at) : -1;
  const meta = open >= 0 ? (enclosed(script, open) ?? "") : "";
  const own = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  const phases: string[] = [];
  const add = (t: string) => {
    if (t && !phases.includes(t) && phases.length < 40) phases.push(t);
  };
  const listAt = meta.search(/(?:^|[\s,{])phases\s*:\s*\[/);
  if (listAt >= 0) {
    const list = enclosed(meta, meta.indexOf("[", listAt)) ?? "";
    const titles = [...list.matchAll(new RegExp(String.raw`title\s*:\s*(?:${STRING})`, "g"))].map((m) => unquote(m as RegExpExecArray).trim());
    for (const t of titles.length ? titles : strings(list)) add(t);
  }
  const body = open >= 0 ? script.slice(open + meta.length + 2) : script;
  for (const m of body.matchAll(new RegExp(String.raw`\bphase\(\s*(?:${STRING})`, "g"))) add(unquote(m as RegExpExecArray).trim());
  return {
    name: own("name") ?? own("workflow") ?? field(meta, "name"),
    description: field(meta, "description") ?? own("description"),
    phases,
  };
}
