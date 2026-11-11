// The GitHub Actions workflows and Dependabot's file (P1 DESIGN 4.1 to 4.8; DESIGN-I1 5.5 for release.yml), parsed with
// Bun's YAML parser: every action pinned by its 40-character commit with its tag in a comment, read-only permissions at
// the top (release.yml's two jobs that write are named), the locked install, no secret, no pull_request_target, no
// persisted checkout credentials, no expression inside a shell line, no claude command, Bun 1.3.14, the check jobs' steps
// equal to scripts/ci.ts CHECK_STEPS (so `bun run ci` runs what CI runs), release.yml's jobs and lines, pages.yml's
// build, check and deploy of the site (DESIGN-W1 5.3), and Dependabot's SDK group.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHECK_STEPS, CI_TEST_PORT, clickArgv } from "../../scripts/ci";

const ROOT = resolve(import.meta.dir, "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const DEPENDABOT = join(ROOT, ".github", "dependabot.yml");
const SDK = "@anthropic-ai/claude-agent-sdk";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const BUN = pkg.devDependencies["@types/bun"];

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: string;
  "working-directory"?: string;
}
interface Job {
  "runs-on": string;
  "timeout-minutes"?: number;
  if?: string;
  needs?: string | string[];
  environment?: unknown;
  permissions?: unknown;
  env?: Record<string, unknown>;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, any>;
  permissions: unknown;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const files = existsSync(WORKFLOWS) ? readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
const raw = (f: string) => readFileSync(join(WORKFLOWS, f), "utf8");
const parse = (f: string) => Bun.YAML.parse(raw(f)) as Workflow;
const stepsOf = (w: Workflow) => Object.values(w.jobs).flatMap((j) => j.steps);
const runs = (j: Job) => j.steps.filter((s) => s.run !== undefined).map((s) => s.run!.trim());
const action = (s: Step) => s.uses?.split("@")[0];
const setupBuns = (j: Job) => j.steps.filter((s) => action(s) === "oven-sh/setup-bun");
const checkRuns = (j: Job) => j.steps.filter((s) => s.run !== undefined).map((s) => ({ run: s.run!.trim(), ...(s.env ? { env: s.env } : {}) }));

test("the workflows folder holds ci.yml, pages.yml and release.yml, and every workflow parses", () => {
  expect(files).toEqual(["ci.yml", "pages.yml", "release.yml"]);
  for (const f of files) expect(typeof parse(f).jobs).toBe("object");
});

describe("every workflow", () => {
  for (const f of files) {
    const w = parse(f);
    const text = raw(f);

    test(`${f}: every action is pinned by its 40-character commit, with its tag in a comment, one commit per action`, () => {
      const uses = stepsOf(w).filter((s) => s.uses !== undefined).map((s) => s.uses!);
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/);
      const lines = text.split("\n").filter((l) => /^\s*(-\s+)?uses:/.test(l));
      expect(lines.length).toBe(uses.length);
      const pins = new Map<string, string>();
      for (const l of lines) {
        const m = /uses:\s*([^@\s]+)@([0-9a-f]{40})\s+#\s*(v\d+(?:\.\d+)*)\s*$/.exec(l);
        expect(m, l).not.toBeNull();
        const [, action, sha, tag] = m!;
        expect(pins.get(action!) ?? `${sha} ${tag}`).toBe(`${sha} ${tag}`);
        pins.set(action!, `${sha} ${tag}`);
      }
    });

    test(`${f}: the workflow's own permissions are read-only`, () => {
      expect(w.permissions).toEqual({ contents: "read" });
    });

    test(`${f}: no secret, no pull_request_target, and every checkout leaves no credential behind`, () => {
      expect(text).not.toContain("secrets.");
      expect(text).not.toContain("pull_request_target");
      expect(Object.keys(w.on)).not.toContain("pull_request_target");
      const checkouts = stepsOf(w).filter((s) => s.uses?.startsWith("actions/checkout@"));
      for (const s of checkouts) expect(s.with?.["persist-credentials"]).toBe(false);
    });

    test(`${f}: every shell line takes the event's values from env:, never from an expression`, () => {
      for (const s of stepsOf(w)) if (s.run !== undefined) expect(s.run).not.toContain("${{");
    });

    test(`${f}: every bun install is the locked one without the optional packages`, () => {
      const installs = stepsOf(w).filter((s) => s.run && /\bbun\s+(install|i)\b/.test(s.run));
      for (const s of installs) expect(s.run!.trim()).toBe("bun install --frozen-lockfile --omit=optional");
    });

    test(`${f}: no step runs a claude command`, () => {
      for (const s of stepsOf(w)) if (s.run !== undefined) expect(s.run).not.toMatch(/(^|[\s;&|(`$])claude(\s|$|[;&|)])/m);
    });

    test(`${f}: every setup-bun installs Bun ${BUN}, package.json's @types/bun`, () => {
      const setups = stepsOf(w).filter((s) => action(s) === "oven-sh/setup-bun");
      expect(setups.length).toBeGreaterThan(0);
      for (const s of setups) expect(s.with).toEqual({ "bun-version": BUN });
      expect(BUN).toBe("1.3.14");
    });

    test(`${f}: every job has a timeout`, () => {
      for (const [name, j] of Object.entries(w.jobs)) expect(typeof j["timeout-minutes"], name).toBe("number");
    });
  }
});

describe("ci.yml", () => {
  const w = parse("ci.yml");
  const jobs = w.jobs;

  test("it runs on pull requests, pushes to main, weekly and by hand; one run per pull request, an older one cancelled; every other run in a group of its own", () => {
    expect(Object.keys(w.on).sort()).toEqual(["pull_request", "push", "schedule", "workflow_dispatch"]);
    expect(w.on.push).toEqual({ branches: ["main"] });
    expect(w.on.schedule).toEqual([{ cron: "17 6 * * 1" }]);
    // A group per pull request's ref; any other run (a push to main, the schedule, a manual run) in a group of its own run
    // id, so it never waits behind click-full, and a newer run never cancels it while it is pending (GitHub cancels a
    // pending run of a group when a newer one is queued there).
    expect(w.concurrency).toEqual({ group: "ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}", "cancel-in-progress": "${{ github.event_name == 'pull_request' }}" });
  });

  test("no job asks for a write permission", () => {
    for (const [name, j] of Object.entries(jobs)) {
      if (j.permissions === undefined) continue;
      expect(typeof j.permissions, name).toBe("object");
      for (const v of Object.values(j.permissions as Record<string, string>)) expect(["read", "none"]).toContain(v);
    }
  });

  test("each job installs Bun once, with setup-bun", () => {
    for (const [name, j] of Object.entries(jobs)) expect(setupBuns(j).length, name).toBe(1);
  });

  test("an artifact is kept only on a failure, for 7 days", () => {
    const uploads = stepsOf(w).filter((s) => action(s) === "actions/upload-artifact");
    expect(uploads.length).toBeGreaterThan(0);
    for (const s of uploads) {
      expect(s.if).toBe("failure()");
      expect(s.with?.["retention-days"]).toBe(7);
    }
  });

  test("the jobs, their runners and their timeouts", () => {
    expect(Object.keys(jobs)).toEqual(["check", "macos", "click", "click-full", "dco"]);
    const shape = Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, [j["runs-on"], j["timeout-minutes"], j.if ?? null]]));
    expect(shape).toEqual({
      check: ["ubuntu-24.04", 30, null],
      macos: ["macos-latest", 30, null],
      click: ["ubuntu-24.04", 20, "github.event_name == 'pull_request'"],
      "click-full": ["ubuntu-24.04", 180, "github.event_name != 'pull_request'"],
      dco: ["ubuntu-24.04", 5, "github.event_name == 'pull_request'"],
    });
  });

  test("the check job's steps are scripts/ci.ts CHECK_STEPS, in order, with the same environment", () => {
    expect(checkRuns(jobs.check!)).toEqual(CHECK_STEPS.map((s) => ({ ...s })));
    expect(CHECK_STEPS.find((s) => s.run === "bun test")?.env).toEqual({ KITESPAN_TEST_PORT: CI_TEST_PORT });
    expect(CHECK_STEPS.at(-1)!.run).toContain("--scope tree");
    expect(CHECK_STEPS.at(-1)!.run).not.toContain("--patterns");
  });

  test("the macos job runs the check job's install, type checks and tests", () => {
    expect(checkRuns(jobs.macos!)).toEqual(CHECK_STEPS.slice(0, 3).map((s) => ({ ...s })));
  });

  test("the click jobs run scripts/ci.ts with the runner's own Chrome, and download none", () => {
    for (const [job, set] of [["click", "pr"], ["click-full", "full"]] as const) {
      expect(jobs[job]!.env).toEqual({ CHROME_PATH: "/usr/bin/google-chrome" });
      expect(runs(jobs[job]!)).toEqual(["bun install --frozen-lockfile --omit=optional", `bun scripts/ci.ts --click ${set} --out "$RUNNER_TEMP/ui-check" --port ${CI_TEST_PORT}`]);
    }
    const actions = new Set(Object.values(jobs).flatMap((j) => j.steps).filter((s) => s.uses).map((s) => s.uses!.split("@")[0]));
    expect([...actions].sort()).toEqual(["actions/checkout", "actions/upload-artifact", "oven-sh/setup-bun"]);
    // The pull-request subset: two runs, each with its own folder under --out; the full run: every check.
    expect(clickArgv("pr", "/out", "7941")).toEqual([
      ["bun", "scripts/ui-check.ts", "--port", "7941", "--out", "/out/routes", "--checks", "routes,actions", "--routes", "home,chat,permission,settingsSection,send,setting,new", "--skip", "chat-*,send-archived,send-over-cap,permission-*,setting-*,update"],
      ["bun", "scripts/ui-check.ts", "--port", "7941", "--out", "/out/flows", "--checks", "flows", "--routes", "smooth-text,send-new-document,resume-drop"],
    ]);
    expect(clickArgv("full", "/out", "7941")).toEqual([["bun", "scripts/ui-check.ts", "--port", "7941", "--out", "/out/full"]]);
  });

  test("the dco job checks the pull request's commits with the base commit's script, outside the checkout", () => {
    const steps = jobs.dco!.steps;
    const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with).toEqual({ ref: "${{ github.event.pull_request.head.sha }}", "fetch-depth": 0, "persist-credentials": false });
    const run = steps.find((s) => s.run !== undefined)!;
    expect(run["working-directory"]).toBe("${{ runner.temp }}");
    expect(run.env).toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      PR_AUTHOR: "${{ github.event.pull_request.user.login }}",
    });
    expect(run.run!.trim().split("\n")).toEqual([
      'git -C "$GITHUB_WORKSPACE" show "$BASE_SHA:scripts/dco.ts" > dco.ts',
      'bun --no-env-file dco.ts --repo "$GITHUB_WORKSPACE" --base "$BASE_SHA" --head "$HEAD_SHA" --pr-author "$PR_AUTHOR"',
    ]);
  });
});

// The release (DESIGN-I1 5.2): on a pushed tag, the check job's steps; the archive, SHA256SUMS, install.sh and the
// formula by scripts/release.ts; the installer on clean Linux and macOS runners; the formula through Homebrew; then, in
// the protected environment `release`, their provenance and the GitHub Release, and nothing published before it.
describe("release.yml", () => {
  const w = files.includes("release.yml") ? parse("release.yml") : ({ on: {}, permissions: null, jobs: {} } as unknown as Workflow);
  const jobs = w.jobs;
  const RELEASE = "${{ runner.temp }}/release";
  const download = { name: "release", path: RELEASE };

  test("it runs only on a pushed tag v*, one run per tag at a time, never cancelled", () => {
    expect(w.on).toEqual({ push: { tags: ["v*"] } });
    expect(w.concurrency).toEqual({ group: "release-${{ github.ref }}", "cancel-in-progress": false });
  });

  test("the jobs in order, their runners, timeouts and needs; none runs on a condition", () => {
    expect(Object.keys(jobs)).toEqual(["check", "archive", "install-linux", "install-macos", "brew", "release"]);
    const shape = Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, [j["runs-on"], j["timeout-minutes"], j.needs ?? null, j.if ?? null]]));
    expect(shape).toEqual({
      check: ["ubuntu-24.04", 30, null, null],
      archive: ["ubuntu-24.04", 10, "check", null],
      "install-linux": ["ubuntu-24.04", 20, "archive", null],
      "install-macos": ["macos-latest", 20, "archive", null],
      brew: ["macos-latest", 45, "archive", null],
      release: ["ubuntu-24.04", 10, ["check", "archive", "install-linux", "install-macos", "brew"], null],
    });
  });

  test("only release (the provenance and the GitHub Release, after the approval) holds more than the read of the contents", () => {
    const perms = Object.fromEntries(Object.entries(jobs).filter(([, j]) => j.permissions !== undefined).map(([k, j]) => [k, j.permissions]));
    expect(perms).toEqual({ release: { contents: "write", "id-token": "write", attestations: "write" } });
  });

  test("the actions it uses, and Bun from setup-bun exactly in check, archive, install-linux and install-macos", () => {
    const actions = new Set(stepsOf(w).filter((s) => s.uses).map((s) => action(s)!));
    expect([...actions].sort()).toEqual(["actions/attest", "actions/checkout", "actions/download-artifact", "actions/upload-artifact", "oven-sh/setup-bun"]);
    const count = Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, setupBuns(j).length]));
    expect(count).toEqual({ check: 1, archive: 1, "install-linux": 1, "install-macos": 1, brew: 0, release: 0 });
  });

  test("the check job's steps are scripts/ci.ts CHECK_STEPS, in order, with the same environment", () => {
    expect(checkRuns(jobs.check!)).toEqual(CHECK_STEPS.map((s) => ({ ...s })));
  });

  test("archive: release.ts makes the release folder from the tag, and the one upload keeps it 7 days", () => {
    const j = jobs.archive!;
    expect(j.steps.map((s) => action(s) ?? "run")).toEqual(["actions/checkout", "oven-sh/setup-bun", "run", "actions/upload-artifact"]);
    expect(j.steps[0]!.with).toEqual({ "persist-credentials": false });
    const run = j.steps[2]!;
    expect(run.run!.trim()).toBe('bun --no-env-file scripts/release.ts --tag "$TAG" --out "$RUNNER_TEMP/release"');
    expect(run.env).toEqual({ TAG: "${{ github.ref_name }}" });
    const uploads = stepsOf(w).filter((s) => action(s) === "actions/upload-artifact");
    expect(uploads).toEqual([j.steps[3]!]);
    expect(j.steps[3]!.if).toBeUndefined();
    expect(j.steps[3]!.with).toEqual({ name: "release", path: RELEASE, "retention-days": 7, "if-no-files-found": "error" });
  });

  test("install-linux and install-macos: the installer trial on the release folder, the same steps on both", () => {
    const j = jobs["install-linux"]!;
    expect(j.steps.map((s) => action(s) ?? "run")).toEqual(["actions/checkout", "oven-sh/setup-bun", "actions/download-artifact", "run"]);
    expect(j.steps[0]!.with).toEqual({ "persist-credentials": false });
    expect(j.steps[2]!.with).toEqual(download);
    expect(runs(j)).toEqual(['sh scripts/install-trial.sh "$RUNNER_TEMP/release" 7941']);
    expect(jobs["install-macos"]!.steps).toEqual(j.steps);
  });

  test("brew: the formula through Homebrew's own bun, with no auto-update, no analytics and the old keg kept", () => {
    const j = jobs.brew!;
    expect(j.env).toEqual({ HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" });
    expect(j.steps.map((s) => action(s) ?? "run")).toEqual(["actions/checkout", "actions/download-artifact", "run"]);
    expect(j.steps[0]!.with).toEqual({ "persist-credentials": false });
    expect(j.steps[1]!.with).toEqual(download);
    expect(runs(j)).toEqual(['sh scripts/brew-trial.sh "$RUNNER_TEMP/release" 7941']);
  });

  test("release: in the protected environment, no checkout, a guard that the environment asks for a reviewer, then the provenance of every file that SHA256SUMS names, the GitHub Release of the three files, and the tap's formula printed", () => {
    const j = jobs.release!;
    expect(j.environment).toBe("release");
    for (const [name, other] of Object.entries(jobs)) if (name !== "release") expect(other.environment, name).toBeUndefined();
    expect(j.steps.map((s) => action(s) ?? "run")).toEqual(["actions/download-artifact", "run", "actions/attest", "run", "run"]);
    expect(j.steps[0]!.with).toEqual(download);
    const [, guard, attest, publish, tap] = j.steps as [Step, Step, Step, Step, Step];
    // The attestation is public for good once it is made (Sigstore's public-good log and the attestations API of a public
    // repository), so it comes after the approval and the guard, and only the pinned action runs with id-token: write.
    expect(attest.with).toEqual({ "subject-checksums": `${RELEASE}/SHA256SUMS` });
    expect(attest.env).toBeUndefined();
    expect(guard.env).toEqual({ REPO: "${{ github.repository }}" });
    expect(guard.run!.trim().split("\n")).toEqual([
      'curl --proto =https --tlsv1.2 -fsS "https://api.github.com/repos/$REPO/environments/release" > "$RUNNER_TEMP/environment.json"',
      `grep -q '"type": *"required_reviewers"' "$RUNNER_TEMP/environment.json" || { echo "release: the environment release has no required reviewer, so nothing is published." >&2; exit 1; }`,
    ]);
    expect(publish.env).toEqual({ TAG: "${{ github.ref_name }}", REPO: "${{ github.repository }}", GH_TOKEN: "${{ github.token }}" });
    expect(publish.run!.trim().split("\n")).toEqual([
      "v=${TAG#v}",
      'gh release create "$TAG" --repo "$REPO" --verify-tag --title "kitespan $v" --notes-file "$RUNNER_TEMP/release/release-notes.md" "$RUNNER_TEMP/release/kitespan-$v.tar.gz" "$RUNNER_TEMP/release/SHA256SUMS" "$RUNNER_TEMP/release/install.sh"',
    ]);
    expect(tap.env).toBeUndefined();
    expect(tap.run!.trim().split("\n")).toEqual([
      "printf 'Put this file in wannaFlyKa/homebrew-tap as Formula/kitespan.rb, in a signed-off commit:\\n\\n'",
      'cat "$RUNNER_TEMP/release/kitespan.rb"',
    ]);
  });

  test("an env: value that holds an expression is the tag's name, the repository's name or the job's own token, and nothing else", () => {
    const values = [...Object.values(jobs).map((j) => j.env ?? {}), ...stepsOf(w).map((s) => s.env ?? {})].flatMap((e) => Object.values(e));
    const expressions = values.filter((v) => String(v).includes("${{"));
    expect(expressions.length).toBeGreaterThan(0);
    for (const v of expressions) expect(["${{ github.ref_name }}", "${{ github.repository }}", "${{ github.token }}"]).toContain(String(v));
  });

  test("the scripts that it runs are in the repository", () => {
    for (const f of ["scripts/release.ts", "scripts/install-trial.sh", "scripts/brew-trial.sh"]) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });
});

// The site (DESIGN-W1 5.3): on a push to main and by hand, the landing page and its demo built from this tree, checked in
// headless Chrome, then deployed with GitHub's own Pages actions; only the deploy job may write, and only to Pages.
describe("pages.yml", () => {
  const w = files.includes("pages.yml") ? parse("pages.yml") : ({ on: {}, permissions: null, jobs: {} } as unknown as Workflow);
  const jobs = w.jobs;
  const SITE = "${{ runner.temp }}/site";

  test("it runs on a push to main and by hand, one deployment at a time, never cancelled", () => {
    expect(w.on).toEqual({ push: { branches: ["main"] }, workflow_dispatch: null });
    expect(w.concurrency).toEqual({ group: "pages", "cancel-in-progress": false });
  });

  test("the jobs in order, their runners, timeouts and needs; none runs on a condition", () => {
    expect(Object.keys(jobs)).toEqual(["build", "deploy"]);
    const shape = Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, [j["runs-on"], j["timeout-minutes"], j.needs ?? null, j.if ?? null]]));
    expect(shape).toEqual({ build: ["ubuntu-24.04", 20, null, null], deploy: ["ubuntu-24.04", 10, "build", null] });
  });

  test("only deploy writes, and only to Pages; only deploy has an environment, github-pages", () => {
    const perms = Object.fromEntries(Object.entries(jobs).filter(([, j]) => j.permissions !== undefined).map(([k, j]) => [k, j.permissions]));
    expect(perms).toEqual({ deploy: { pages: "write", "id-token": "write" } });
    const envs = Object.fromEntries(Object.entries(jobs).filter(([, j]) => j.environment !== undefined).map(([k, j]) => [k, j.environment]));
    expect(envs).toEqual({ deploy: { name: "github-pages", url: "${{ steps.deployment.outputs.page_url }}" } });
  });

  test("the actions it uses, Bun from setup-bun once in build and never in deploy, and the pins it shares with ci.yml", () => {
    const actions = new Set(stepsOf(w).filter((s) => s.uses).map((s) => action(s)!));
    expect([...actions].sort()).toEqual(["actions/checkout", "actions/deploy-pages", "actions/upload-artifact", "actions/upload-pages-artifact", "oven-sh/setup-bun"]);
    const count = Object.fromEntries(Object.entries(jobs).map(([k, j]) => [k, setupBuns(j).length]));
    expect(count).toEqual({ build: 1, deploy: 0 });
    const ci = new Map(stepsOf(parse("ci.yml")).filter((s) => s.uses).map((s) => [action(s)!, s.uses!]));
    for (const s of stepsOf(w)) if (s.uses && ci.has(action(s)!)) expect(s.uses).toBe(ci.get(action(s)!)!);
  });

  test("build: the locked install, the site's build, its check in the runner's own Chrome, the check's captures kept only on a failure, then the Pages artifact", () => {
    const j = jobs.build!;
    expect(j.env).toEqual({ CHROME_PATH: "/usr/bin/google-chrome" });
    expect(j.steps.map((s) => action(s) ?? "run")).toEqual(["actions/checkout", "oven-sh/setup-bun", "run", "run", "run", "actions/upload-artifact", "actions/upload-pages-artifact"]);
    expect(j.steps[0]!.with).toEqual({ "persist-credentials": false });
    expect(runs(j)).toEqual([
      "bun install --frozen-lockfile --omit=optional",
      'bun scripts/build-site.ts --out "$RUNNER_TEMP/site"',
      'bun scripts/site-check.ts --site "$RUNNER_TEMP/site" --out "$RUNNER_TEMP/site-check" --port 7941',
    ]);
    for (const s of j.steps) if (s.run !== undefined) expect(s.env).toBeUndefined();
    const upload = j.steps[5]!;
    expect(upload.if).toBe("failure()");
    expect(upload.with).toEqual({ name: "site-check", path: "${{ runner.temp }}/site-check", "retention-days": 7, "if-no-files-found": "ignore" });
    const pages = j.steps[6]!;
    expect(pages.if).toBeUndefined();
    expect(pages.with).toEqual({ path: SITE });
  });

  test("deploy: one step, deploy-pages, whose output is the environment's URL; no checkout and no code of the repository", () => {
    const j = jobs.deploy!;
    expect(j.env).toBeUndefined();
    expect(j.steps.length).toBe(1);
    const step = j.steps[0]!;
    expect(Object.keys(step).sort()).toEqual(["id", "uses"]);
    expect(step.id).toBe("deployment");
    expect(action(step)).toBe("actions/deploy-pages");
  });

  test("no env: value holds an expression", () => {
    const values = [...Object.values(jobs).map((j) => j.env ?? {}), ...stepsOf(w).map((s) => s.env ?? {})].flatMap((e) => Object.values(e));
    for (const v of values) expect(String(v)).not.toContain("${{");
  });

  test("the scripts that it runs are in the repository", () => {
    for (const f of ["scripts/build-site.ts", "scripts/site-check.ts"]) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });
});

describe("dependabot.yml", () => {
  const d = Bun.YAML.parse(readFileSync(DEPENDABOT, "utf8")) as { version: number; updates: Record<string, any>[] };

  test("one weekly bun block (bun.lock) with the Agent SDK in a group of its own, and a monthly block for the actions", () => {
    expect(d.version).toBe(2);
    expect(d.updates.map((u) => u["package-ecosystem"])).toEqual(["bun", "github-actions"]);
    const [js, actions] = d.updates as [Record<string, any>, Record<string, any>];
    expect(pkg.dependencies[SDK]).toBeDefined();
    expect(js.directory).toBe("/");
    expect(js.schedule).toEqual({ interval: "weekly", day: "monday" });
    expect(js.groups["agent-sdk"]).toEqual({ patterns: [SDK] });
    expect(js.groups.packages).toEqual({ patterns: ["*"], "exclude-patterns": [SDK] });
    expect(js.cooldown).toEqual({ "default-days": 30, exclude: [SDK] });
    expect(js.ignore).toEqual([{ "dependency-name": "@types/bun" }, { "dependency-name": "typescript", "update-types": ["version-update:semver-major"] }]);
    expect(actions.directory).toBe("/");
    expect(actions.schedule).toEqual({ interval: "monthly" });
    expect(actions.groups).toEqual({ actions: { patterns: ["*"] } });
  });

  test("Dependabot's file holds no secret", () => {
    expect(readFileSync(DEPENDABOT, "utf8")).not.toContain("secrets.");
  });
});
