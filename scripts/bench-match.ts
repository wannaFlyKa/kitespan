// The matcher's bench (DESIGN.md 9.3 "Speed"; the build checklist's A8): shared/match.ts over 100,000 synthetic
// paths, run 3 times, each run in a fresh process, and every number printed. It is a script of its own and not part
// of `bun test`, which runs every test file one after another in one process, so a bench there would share the heap
// and the cores of the tests before it.
//
// Usage: bun scripts/bench-match.ts [--runs 3] [--paths 100000]
//
// Two corpus shapes, both from a fixed LCG, so every run times the same paths:
// - `repo`: paths relative to a repository, as `git ls-files` gives them;
// - `prefix`: every path under one shared folder whose name holds an a, so the query `a` matches every row.
// Inputs: 14 filters, each timed 5 times from scratch (70 calls), and a typing script through the narrowing searcher
// (10 words, each typed letter by letter and then deleted to its first letter, the field cleared between words, 3
// passes: 318 timed keystrokes). Each run prints, per shape: the cold `prepare`, the warm-up that the page runs before
// it publishes a list (`warmScorer`), and the first query after them; the scratch p50, p95 and max; the p95 of each
// filter; the typing p50, p95 and max. And the host: its cores, its load before and after the run, and Bun's version.
// The p95 is the sorted sample at ceil(0.95 * n) - 1.
//
// The pass line (a proposal, from the research's numbers): in both shapes, the scratch p95 and the typing p95 are each
// under 25 ms on an idle host. A failed run is fixed by finding the cost per row, never by raising the number. The
// exit code is 0 when every run passes and 1 otherwise.

import { availableParallelism, loadavg } from "node:os";
import { Searcher, prepareCorpus, searchCorpus, warmScorer } from "../shared/match";

const FILTERS = ["a", "ap", "app", "conf", "serv", "index", "mod", "te", "tes", "test", "sch", "han", "fz", "fuz"];
const TYPED = ["app", "config", "server", "index", "test", "schema", "handler", "fuzzy", "web comp", "src test"];
const REPEATS = 5;
const TYPING_PASSES = 3;
const PASS_MS = 25;
const SHAPES = ["repo", "prefix"] as const;
type Shape = (typeof SHAPES)[number];

const WORDS = ["index", "main", "App", "config", "server", "client", "utils", "helper", "model", "view", "controller", "service", "handler", "route", "schema", "test", "spec", "mock", "fixture", "data", "Component", "Provider", "context", "hooks", "styles", "theme", "tokens", "search", "fuzzy", "match"];
const EXTS = ["ts", "tsx", "js", "json", "md", "css", "html", "txt", "yml", "lock"];
const DIRS = ["src", "web", "server", "shared", "test", "lib", "docs", "scripts"];

/** `n` paths of one shape, from a fixed LCG (the Numerical Recipes constants). */
function makePaths(n: number, shape: Shape): string[] {
  let seed = 0x1234_5678;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const a = WORDS[(rnd() * WORDS.length) | 0]!;
    const b = WORDS[(rnd() * WORDS.length) | 0]!;
    const ext = EXTS[(rnd() * EXTS.length) | 0]!;
    const sep = rnd() < 0.5 ? "-" : ".";
    const name = `${a}${sep}${b}${(i % 97).toString(36)}.${ext}`;
    out[i] = shape === "prefix" ? `vault/proj/${i}/${name}` : `${DIRS[i % DIRS.length]}/${WORDS[(i >> 3) % WORDS.length]!.toLowerCase()}/m${i % 211}/${name}`;
  }
  return out;
}

/** Each word typed letter by letter, then deleted to its first letter. */
function typingWords(): string[][] {
  return TYPED.map((w) => {
    const seq: string[] = [];
    for (let i = 1; i <= w.length; i++) seq.push(w.slice(0, i));
    for (let i = w.length - 1; i >= 1; i--) seq.push(w.slice(0, i));
    return seq;
  });
}

function pct(samples: readonly number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

const ms = (x: number) => Number(x.toFixed(2));

interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

const stats = (xs: readonly number[]): Stats => ({ n: xs.length, p50: ms(pct(xs, 50)), p95: ms(pct(xs, 95)), max: ms(Math.max(...xs)) });

interface ShapeRun {
  shape: Shape;
  paths: number;
  prepareMs: number;
  warmMs: number;
  firstMs: number;
  firstCount: number;
  scratch: Stats;
  perFilter: Record<string, number>;
  counts: Record<string, number>;
  typing: Stats;
  pass: boolean;
}

interface Run {
  nproc: number;
  loadBefore: string;
  loadAfter: string;
  bun: string;
  shapes: ShapeRun[];
}

function benchShape(shape: Shape, n: number): ShapeRun {
  const paths = makePaths(n, shape);
  const t0 = performance.now();
  const corpus = prepareCorpus(paths);
  const t1 = performance.now();
  warmScorer(corpus);
  const tw = performance.now();
  const first = searchCorpus(corpus, "a");
  const t2 = performance.now();

  for (const f of FILTERS) searchCorpus(corpus, f); // the warm-up pass
  const all: number[] = [];
  const per: Record<string, number[]> = {};
  const counts: Record<string, number> = {};
  for (let r = 0; r < REPEATS; r++)
    for (const f of FILTERS) {
      const t = performance.now();
      const res = searchCorpus(corpus, f);
      const d = performance.now() - t;
      all.push(d);
      (per[f] ??= []).push(d);
      counts[f] = res.count;
    }

  const typing: number[] = [];
  const words = typingWords();
  for (let pass = 0; pass < TYPING_PASSES; pass++) {
    const searcher = new Searcher(corpus);
    for (const seq of words) {
      for (const q of seq) {
        const t = performance.now();
        searcher.search(q);
        typing.push(performance.now() - t);
      }
      searcher.search(""); // the field cleared between words, not timed
    }
  }

  const scratch = stats(all);
  const typed = stats(typing);
  return {
    shape,
    paths: n,
    prepareMs: ms(t1 - t0),
    warmMs: ms(tw - t1),
    firstMs: ms(t2 - tw),
    firstCount: first.count,
    scratch,
    perFilter: Object.fromEntries(FILTERS.map((f) => [f, ms(pct(per[f]!, 95))])),
    counts,
    typing: typed,
    pass: scratch.p95 < PASS_MS && typed.p95 < PASS_MS,
  };
}

async function hostLoad(): Promise<string> {
  try {
    return (await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ");
  } catch {
    return loadavg()
      .map((x) => x.toFixed(2))
      .join(" ");
  }
}

async function oneRun(n: number): Promise<Run> {
  const loadBefore = await hostLoad();
  const shapes = SHAPES.map((s) => benchShape(s, n));
  return { nproc: availableParallelism(), loadBefore, loadAfter: await hostLoad(), bun: Bun.version, shapes };
}

function intArg(args: string[], name: string, fallback: number, min: number, max: number): number {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const raw = args[i + 1] ?? "";
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || n < min || n > max) {
    console.error(`${name}: a whole number from ${min} to ${max}`);
    process.exit(2);
  }
  return n;
}

function printRun(k: number, runs: number, r: Run): void {
  console.log(`run ${k} of ${runs} | nproc ${r.nproc} | load ${r.loadBefore} before, ${r.loadAfter} after | bun ${r.bun}`);
  for (const s of r.shapes) {
    console.log(
      `  ${s.shape.padEnd(6)} ${s.paths} paths | prepare ${s.prepareMs} ms, warm ${s.warmMs} ms, first a ${s.firstMs} ms (${s.firstCount} matches)` +
        ` | scratch p50 ${s.scratch.p50} p95 ${s.scratch.p95} max ${s.scratch.max} ms (${s.scratch.n} calls)` +
        ` | typing p50 ${s.typing.p50} p95 ${s.typing.p95} max ${s.typing.max} ms (${s.typing.n} keys) | ${s.pass ? "PASS" : "FAIL"}`,
    );
    console.log(`         p95 per filter (ms): ${FILTERS.map((f) => `${f} ${s.perFilter[f]}`).join(", ")}`);
    console.log(`         matches per filter: ${FILTERS.map((f) => `${f} ${s.counts[f]}`).join(", ")}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const n = intArg(args, "--paths", 100_000, 1, 1_000_000);
  if (args.includes("--child")) {
    console.log(JSON.stringify(await oneRun(n)));
    return;
  }
  const runs = intArg(args, "--runs", 3, 1, 20);
  console.log(`bench-match: ${n} paths, ${FILTERS.length} filters x ${REPEATS} from scratch, ${TYPING_PASSES} typing passes; pass: scratch p95 and typing p95 under ${PASS_MS} ms`);
  const done: Run[] = [];
  for (let k = 1; k <= runs; k++) {
    const child = Bun.spawn([process.execPath, import.meta.path, "--child", "--paths", String(n)], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    const out = await new Response(child.stdout).text();
    const code = await child.exited;
    if (code !== 0) {
      console.error(`run ${k}: the bench process exited with ${code}`);
      process.exit(2);
    }
    const run = JSON.parse(out.trim().split("\n").at(-1)!) as Run;
    printRun(k, runs, run);
    done.push(run);
  }
  const passed = done.filter((r) => r.shapes.every((s) => s.pass)).length;
  console.log(`verdict: ${passed} of ${runs} runs pass`);
  for (const shape of SHAPES) {
    const of = (pick: (s: ShapeRun) => number) => done.map((r) => pick(r.shapes.find((s) => s.shape === shape)!)).join(", ");
    console.log(`  ${shape.padEnd(6)} scratch p95 ${of((s) => s.scratch.p95)} ms | typing p95 ${of((s) => s.typing.p95)} ms | prepare ${of((s) => s.prepareMs)} ms | warm ${of((s) => s.warmMs)} ms | first a ${of((s) => s.firstMs)} ms`);
  }
  process.exit(passed === runs ? 0 : 1);
}

await main();
