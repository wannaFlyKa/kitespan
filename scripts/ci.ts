// What CI runs (.github/workflows/ci.yml; P1 DESIGN 4.3 and 4.5), on this machine: the check job's steps in order, or
// the click jobs' ui-check runs. test/unit/workflows.test.ts checks that the check job's steps are CHECK_STEPS and that
// the click jobs call this script, so a local run is what CI runs.
//
// Usage: bun scripts/ci.ts [--test-arg <bun test argument>]...
//        bun scripts/ci.ts --click pr|full --out <folder> [--port <port>]
//
// The check job: each step prints its time; the first step that fails ends the run with its exit code. The tests get
// KITESPAN_TEST_PORT as set, else 7941 as in CI. Each --test-arg goes to the `bun test` step only (for example
// `--test-arg --bail`); CI gives none.
// The click jobs: `pr` is the pull-request subset (the core screens in every size and theme, the actions that start,
// send, answer a card and save a setting, and three flows: a long reply, one send, a dropped connection); `full` is
// every check. Each run writes its report and screenshots under --out; every run goes, and the first failure's exit
// code ends it.

import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export interface CheckStep {
  /** The step's command line, as ci.yml's check job writes it. */
  run: string;
  /** The step's environment, as ci.yml's check job sets it. */
  env?: Record<string, string>;
}

/** The test port of CI's jobs: the first test port; no other agent's server runs on a runner. */
export const CI_TEST_PORT = "7941";

export const CHECK_STEPS: readonly CheckStep[] = [
  { run: "bun install --frozen-lockfile --omit=optional" },
  { run: "bun run typecheck" },
  { run: "bun test", env: { KITESPAN_TEST_PORT: CI_TEST_PORT } },
  { run: "bun run build" },
  { run: "bun scripts/audit-public-clean.ts --repo . --scope tree" },
];

export type ClickSet = "pr" | "full";

/** The ui-check runs of each click job: each run's own subfolder of --out, and its options. */
export const CLICK_RUNS: Readonly<Record<ClickSet, readonly { name: string; args: readonly string[] }[]>> = {
  pr: [
    {
      name: "routes",
      args: [
        "--checks",
        "routes,actions",
        "--routes",
        "home,chat,permission,settingsSection,send,setting,new",
        "--skip",
        "chat-*,send-archived,send-over-cap,permission-*,setting-*,update",
      ],
    },
    { name: "flows", args: ["--checks", "flows", "--routes", "smooth-text,send-new-document,resume-drop"] },
  ],
  full: [{ name: "full", args: [] }],
};

/** The argv of one ui-check run. */
export function clickArgv(set: ClickSet, out: string, port: string): string[][] {
  return CLICK_RUNS[set].map((r) => ["bun", "scripts/ui-check.ts", "--port", port, "--out", join(out, r.name), ...r.args]);
}

async function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; seconds: number }> {
  const t0 = performance.now();
  // `bun` is the Bun that runs this script.
  const [cmd = "", ...rest] = argv;
  const p = Bun.spawn([cmd === "bun" ? process.execPath : cmd, ...rest], { cwd: ROOT, env: { ...process.env, ...env }, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  return { code, seconds: (performance.now() - t0) / 1000 };
}

const USAGE = `Usage: bun scripts/ci.ts [--test-arg <bun test argument>]...
       bun scripts/ci.ts --click pr|full --out <folder> [--port <port>]`;

function fail(line: string): never {
  console.error(`ci: ${line}\n${USAGE}`);
  process.exit(2);
}

async function check(testArgs: string[]): Promise<number> {
  const t0 = performance.now();
  for (const [i, step] of CHECK_STEPS.entries()) {
    const argv = step.run.split(" ");
    if (step.run === "bun test") argv.push(...testArgs);
    // The test port: the one this machine's run was given, else CI's.
    const env = step.env ? { ...step.env, ...(process.env.KITESPAN_TEST_PORT ? { KITESPAN_TEST_PORT: process.env.KITESPAN_TEST_PORT } : {}) } : {};
    const shown = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv].join(" ");
    console.log(`ci: step ${i + 1} of ${CHECK_STEPS.length}: ${shown}`);
    const r = await run(argv, env);
    console.log(`ci: step ${i + 1} ${r.code === 0 ? "passed" : `failed with exit code ${r.code}`} in ${r.seconds.toFixed(1)} s`);
    if (r.code !== 0) return r.code;
  }
  console.log(`ci: the check job's ${CHECK_STEPS.length} steps passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return 0;
}

async function click(set: ClickSet, out: string, port: string): Promise<number> {
  let first = 0;
  for (const argv of clickArgv(set, resolve(out), port)) {
    console.log(`ci: ${argv.join(" ")}`);
    const r = await run(argv);
    console.log(`ci: ${r.code === 0 ? "passed" : `failed with exit code ${r.code}`} in ${r.seconds.toFixed(1)} s`);
    if (r.code !== 0 && first === 0) first = r.code;
  }
  return first;
}

async function main(argv: string[]): Promise<number> {
  const opts: Record<string, string> = {};
  const testArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (!["--click", "--out", "--port", "--test-arg"].includes(a)) fail(`unknown argument "${a}"`);
    const v = argv[++i];
    // A bun test argument is itself an option; the others' values never start with --.
    if (v === undefined || v === "" || (a !== "--test-arg" && v.startsWith("--"))) fail(`${a} needs a value`);
    if (a === "--test-arg") testArgs.push(v);
    else opts[a.slice(2)] = v;
  }
  if (!opts.click) {
    if (opts.out || opts.port) fail("--out and --port are for --click");
    return check(testArgs);
  }
  if (opts.click !== "pr" && opts.click !== "full") fail(`--click takes pr or full, not "${opts.click}"`);
  if (!opts.out) fail("--click needs --out <folder>");
  if (testArgs.length) fail("--test-arg is for the check job's bun test step");
  return click(opts.click, opts.out, opts.port ?? process.env.KITESPAN_TEST_PORT ?? CI_TEST_PORT);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
