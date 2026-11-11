// The update of a kitespan that install.sh installed (DESIGN-I1 1.5, 3.2 to 3.4; shared/release.ts,
// server/update/release.ts): the version rule and SHA256SUMS's newest archive; the check from a local SHA256SUMS
// (KITESPAN_INSTALL_FROM in the start environment only) and from GitHub through an injected fetch (redirects by hand,
// https only, at most 5, the size cap, the time limit, only kitespan's user-agent); "available" against the running
// version and the version that current names; the newest version kept in update.json across a restart; the refusals;
// and the steps: the running version's own install.sh (a fake one here) in the data folder with the start environment
// less KITESPAN_VERSION and with XDG_DATA_HOME, its step lines as the job's, its deadline, the switch it makes, the
// update lock and update.log.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveName, compareVersions, newestInSums, RELEASE_VERSION, RELEASES_URL, releaseTag, SUMS_MAX_BYTES } from "../../shared/release";
import { UPDATE_REFUSAL_LINES, type UpdateJob } from "../../shared/update";
import { createUpdateJobs } from "../../server/update/job";
import { installKind, nextRoot, type Install } from "../../server/update/kind";
import { UPDATE_LOCK, versionsLockHeld } from "../../server/update/lock";
import { fetchSums, installerEnv, localSums, releaseChecker, releaseLine, releaseSource, RELEASE_CHECK, SUMS_URL, type FetchLike } from "../../server/update/release";
import { UPDATE_LOG } from "../../server/update/steps";
import { createUpdates, UPDATE_STATE } from "../../server/update/updates";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "kitespan-update-release-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;

const hex = (c: string) => c.repeat(64);
const line = (v: string, c = "a") => `${hex(c)}  ${archiveName(v)}`;
const SUMS = (...versions: string[]) => [...versions.map((v, i) => line(v, "abcdef"[i % 6]!)), `${hex("f")}  install.sh`, ""].join("\n");

type Release = Extract<Install, { kind: "release" }>;

/** A built version folder of install.sh's layout: package.json's version, bin/kitespan, the page and its stamp. */
function version(vdir: string, v: string, o: { page?: boolean } = {}): string {
  const dir = join(vdir, v);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "kitespan", version: v }));
  writeFileSync(join(dir, "bin", "kitespan"), "#!/bin/sh\n");
  if (o.page !== false) {
    mkdirSync(join(dir, "dist", "web"), { recursive: true });
    writeFileSync(join(dir, "dist", "web", "index.html"), `<title>kitespan ${v}</title>`);
    writeFileSync(join(dir, "dist", "web", "build.json"), `${JSON.stringify({ v: 1, head: null })}\n`);
  }
  return dir;
}

/** <base>/kitespan/versions/<v>... with current naming the first; the running install is the first version's. */
function layout(versions: string[] = ["0.1.0"]) {
  const base = join(ROOT, `install-${++n}`);
  const kit = join(base, "kitespan");
  const vdir = join(kit, "versions");
  for (const v of versions) version(vdir, v);
  symlinkSync(`versions/${versions[0]}/bin/kitespan`, join(kit, "current"));
  const install = installKind(join(vdir, versions[0]!), versions[0]!) as Release;
  if (install.kind !== "release") throw new Error("the layout is not a release install");
  const switchTo = (v: string) => {
    unlinkSync(join(kit, "current"));
    symlinkSync(`versions/${v}/bin/kitespan`, join(kit, "current"));
  };
  return { base, kit, vdir, install, switchTo };
}

/** A folder with SHA256SUMS, as KITESPAN_INSTALL_FROM names it. */
function sumsFolder(text: string): string {
  const dir = join(ROOT, `from-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SHA256SUMS"), text);
  return dir;
}

/** A fetch that answers from a script and records each call. */
function scripted(answers: ((url: string, init: RequestInit) => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return a(url, init);
  };
  return { f, calls };
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
const ok = (body: string | ReadableStream<Uint8Array>) => () => new Response(body, { status: 200 });

describe("the release rule (shared/release.ts)", () => {
  test("a version is three numbers with no leading zero and nothing after them; the tag and the archive's name", () => {
    for (const v of ["0.1.0", "1.0.0", "10.20.30"]) expect(RELEASE_VERSION.test(v)).toBe(true);
    for (const v of ["01.0.0", "0.1", "0.1.0-rc.1", "v0.1.0", "0.1.0+1", " 0.1.0", "0.1.0\n"]) expect([v, RELEASE_VERSION.test(v)]).toEqual([v, false]);
    expect(releaseTag("0.1.0")).toBe("v0.1.0");
    expect(archiveName("0.1.0")).toBe("kitespan-0.1.0.tar.gz");
    expect(RELEASES_URL).toBe("https://github.com/wannaFlyKa/kitespan/releases");
    expect(SUMS_URL).toBe("https://github.com/wannaFlyKa/kitespan/releases/latest/download/SHA256SUMS");
  });

  test("compareVersions by the three numbers, not by the text", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(() => compareVersions("0.1", "0.1.0")).toThrow();
  });

  test("newestInSums: the highest archive line; none, garbage and other files give null; a CR before the line end is dropped", () => {
    expect(newestInSums(SUMS("0.1.0", "0.1.10", "0.1.9"))).toBe("0.1.10");
    expect(newestInSums(`${hex("f")}  install.sh\n`)).toBeNull();
    expect(newestInSums("")).toBeNull();
    expect(newestInSums("not a sums file\n<html>\n")).toBeNull();
    expect(newestInSums(SUMS("0.2.0", "0.1.0").replaceAll("\n", "\r\n"))).toBe("0.2.0");
    // Not sha256sum's text form: one space, upper case hex, a pre-release name, a path.
    expect(newestInSums(`${hex("a")} ${archiveName("0.3.0")}\n${hex("A")}  ${archiveName("0.4.0")}\n${hex("a")}  kitespan-0.5.0-rc.1.tar.gz\n${hex("a")}  x/${archiveName("0.6.0")}\n`)).toBeNull();
  });
});

describe("the line: available only when the newest is above both the running version and current's", () => {
  test("against R and C", () => {
    expect(releaseLine("0.2.0", "0.1.0", "0.1.0")).toBe("available");
    expect(releaseLine("0.1.0", "0.1.0", "0.1.0")).toBe("none");
    expect(releaseLine("0.2.0", "0.1.0", "0.2.0")).toBe("none");
    expect(releaseLine("0.2.0", "0.1.0", "0.3.0")).toBe("none");
    expect(releaseLine("0.2.0", "0.3.0", "0.1.0")).toBe("none");
    expect(releaseLine("0.2.0", "0.1.0", null)).toBe("available");
    expect(releaseLine("0.1.0", "0.2.0", null)).toBe("none");
  });
});

describe("the check from a local SHA256SUMS: KITESPAN_INSTALL_FROM in the start environment", () => {
  test("a folder, or an archive with SHA256SUMS beside it; the newest, none, garbage, CRLF, too large; no network", async () => {
    const { install } = layout();
    const never = scripted([() => new Response("", { status: 500 })]);
    const check = (from: string) => releaseChecker({ install, env: { KITESPAN_INSTALL_FROM: from }, fetch: never.f }).check();
    const folder = sumsFolder(SUMS("0.1.0", "0.2.0"));
    expect(await check(folder)).toEqual({ kind: "available", failed: false, release: "0.2.0" });
    writeFileSync(join(folder, archiveName("0.2.0")), "an archive");
    expect(localSums(join(folder, archiveName("0.2.0")))).toBe(join(folder, "SHA256SUMS"));
    expect(await check(join(folder, archiveName("0.2.0")))).toEqual({ kind: "available", failed: false, release: "0.2.0" });
    // One named archive is what install.sh installs, so the check offers that version and no other that SHA256SUMS lists.
    writeFileSync(join(folder, archiveName("0.1.0")), "an archive");
    expect(await check(join(folder, archiveName("0.1.0")))).toEqual({ kind: "none", failed: false, release: "0.1.0" });
    writeFileSync(join(folder, archiveName("0.3.0")), "an archive with no line in SHA256SUMS");
    expect(await check(join(folder, archiveName("0.3.0")))).toEqual({ kind: "none", failed: true });
    expect(await check(sumsFolder(SUMS("0.1.0")))).toEqual({ kind: "none", failed: false, release: "0.1.0" });
    expect(await check(sumsFolder(`${hex("f")}  install.sh\n`))).toEqual({ kind: "none", failed: true });
    expect(await check(sumsFolder("garbage\n"))).toEqual({ kind: "none", failed: true });
    expect(await check(sumsFolder(SUMS("0.3.0").replaceAll("\n", "\r\n")))).toEqual({ kind: "available", failed: false, release: "0.3.0" });
    const big = `${line("0.4.0")}\n${"#".repeat(SUMS_MAX_BYTES)}\n`;
    expect(await check(sumsFolder(big))).toEqual({ kind: "none", failed: true });
    const exact = `${line("0.4.0")}\n`;
    expect(await check(sumsFolder(exact + "\n".repeat(SUMS_MAX_BYTES - exact.length)))).toEqual({ kind: "available", failed: false, release: "0.4.0" });
    expect(await check(join(ROOT, "no-such-folder"))).toEqual({ kind: "none", failed: true });
    // A file that is not a kitespan archive, and a folder with no SHA256SUMS.
    writeFileSync(join(folder, "notes.txt"), "x");
    expect(await check(join(folder, "notes.txt"))).toEqual({ kind: "none", failed: true });
    const empty = join(ROOT, `empty-${++n}`);
    mkdirSync(empty);
    expect(await check(empty)).toEqual({ kind: "none", failed: true });
    expect(never.calls).toEqual([]);
  });

  test("a relative value fails with no read at all; the server's own process.env is never read", async () => {
    const { install } = layout();
    const net = scripted([ok(SUMS("0.5.0"))]);
    expect(await releaseChecker({ install, env: { KITESPAN_INSTALL_FROM: "release" }, fetch: net.f }).check()).toEqual({ kind: "none", failed: true });
    expect(localSums("release")).toBeNull();
    expect(net.calls).toEqual([]);
    const own = process.env.KITESPAN_INSTALL_FROM;
    process.env.KITESPAN_INSTALL_FROM = sumsFolder(SUMS("0.9.0"));
    try {
      expect(await releaseChecker({ install, env: {}, fetch: net.f }).check()).toEqual({ kind: "available", failed: false, release: "0.5.0" });
      expect(net.calls.length).toBe(1);
    } finally {
      if (own === undefined) delete process.env.KITESPAN_INSTALL_FROM;
      else process.env.KITESPAN_INSTALL_FROM = own;
    }
  });
});

describe("the check from GitHub: one GET, read only, through an injected fetch", () => {
  test("the URL, a manual redirect, and only kitespan's user-agent: no version, no cookie, no authorization, no query", async () => {
    const { install } = layout();
    const net = scripted([ok(SUMS("0.1.0", "0.2.0"))]);
    expect(await releaseChecker({ install, env: { HOME: "/nonexistent-home" }, fetch: net.f }).check()).toEqual({ kind: "available", failed: false, release: "0.2.0" });
    expect(net.calls.length).toBe(1);
    const [{ url, init }] = net.calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(SUMS_URL);
    expect(new URL(url).search).toBe("");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual({ "user-agent": "kitespan" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body ?? null).toBeNull();
  });

  test("redirects by hand: a relative Location against the URL before; at most 5; never to http", async () => {
    const two = scripted([redirect("/wannaFlyKa/kitespan/releases/download/v0.2.0/SHA256SUMS"), redirect("https://release-assets.example.com/sums?sig=1", 307), ok(SUMS("0.2.0"))]);
    expect(await fetchSums(two.f)).toBe(SUMS("0.2.0"));
    expect(two.calls.map((c) => c.url)).toEqual([SUMS_URL, "https://github.com/wannaFlyKa/kitespan/releases/download/v0.2.0/SHA256SUMS", "https://release-assets.example.com/sums?sig=1"]);
    for (const c of two.calls) expect(c.init.headers).toEqual({ "user-agent": "kitespan" });
    const five = scripted([...Array.from({ length: 5 }, (_, i) => redirect(`https://example.com/${i}`)), ok(SUMS("0.2.0"))]);
    expect(await fetchSums(five.f)).toBe(SUMS("0.2.0"));
    expect(five.calls.length).toBe(6);
    const six = scripted([...Array.from({ length: 6 }, (_, i) => redirect(`https://example.com/${i}`)), ok(SUMS("0.2.0"))]);
    expect(await fetchSums(six.f)).toBeNull();
    expect(six.calls.length).toBe(RELEASE_CHECK.redirects + 1);
    const plain = scripted([redirect("http://example.com/SHA256SUMS"), ok(SUMS("0.2.0"))]);
    expect(await fetchSums(plain.f)).toBeNull();
    expect(plain.calls.length).toBe(1);
    const nowhere = scripted([() => new Response(null, { status: 302 })]);
    expect(await fetchSums(nowhere.f)).toBeNull();
  });

  test("a status that is not 2xx, a body past 64 KiB (the read stops), a thrown fetch: each a failed check", async () => {
    const { install } = layout();
    for (const status of [404, 500, 403]) {
      const net = scripted([() => new Response("nope", { status })]);
      expect(await releaseChecker({ install, env: {}, fetch: net.f }).check()).toEqual({ kind: "none", failed: true });
    }
    expect(await fetchSums(scripted([ok(`${line("0.2.0")}\n${"x".repeat(SUMS_MAX_BYTES)}`)]).f)).toBeNull();
    // An endless body: the read stops past the cap.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(16 * 1024).fill(0x23));
      },
    });
    expect(await fetchSums(scripted([ok(endless)]).f)).toBeNull();
    expect(pulled).toBeLessThan(10);
    const thrown: FetchLike = async () => {
      throw new TypeError("network down");
    };
    expect(await releaseChecker({ install, env: {}, fetch: thrown }).check()).toEqual({ kind: "none", failed: true });
  });

  test("10 s in all (shorter here): a read that hangs ends at its time limit", async () => {
    const { install } = layout();
    const hang: FetchLike = (_u, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    expect(RELEASE_CHECK.timeoutMs).toBe(10_000);
    const t0 = Date.now();
    expect(await releaseChecker({ install, env: {}, fetch: hang, timeoutMs: 200 }).check()).toEqual({ kind: "none", failed: true });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe("update.json keeps the newest version read, so a restart shows the same line with no read", () => {
  test("a check writes `release` in origin's place; a new process shows Update available at once; after the switch, none", async () => {
    const L = layout(["0.1.0", "0.2.0"]);
    const state = join(L.base, "state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const from = sumsFolder(SUMS("0.1.0", "0.2.0"));
    let reads = 0;
    const checker = releaseChecker({ install: L.install, env: { KITESPAN_INSTALL_FROM: from } });
    const make = () =>
      createUpdates({
        root: L.install.root,
        dist: join(L.install.root, "dist", "web"),
        dev: false,
        git: { git: null, env: {} },
        state,
        setting: async () => "daily",
        kind: "release",
        next: () => nextRoot(L.install),
        checkOnce: () => {
          reads++;
          return checker.check();
        },
        release: checker,
      });
    const u = await make();
    expect(u.runningHead).toBeNull();
    expect(await u.check()).toBe("available");
    const kept = JSON.parse(readFileSync(join(state, UPDATE_STATE), "utf8"));
    expect(kept).toMatchObject({ v: 1, ok: true, why: null, release: "0.2.0" });
    expect(kept.origin).toBeUndefined();
    expect(await u.facts()).toEqual({ update: "available", build: "none", kind: "release", latest: "0.2.0", next: null });
    expect(u.welcome()).toEqual({ available: true, kind: "available" });
    // A new process: the line at once from update.json, no read (the next check is a day away).
    const u2 = await make();
    expect(u2.remote).toBe("available");
    u2.start();
    await u2.settled();
    expect(reads).toBe(1);
    u2.stop();
    // install.sh switched current to 0.2.0: Restart to apply with its version, and no Update available.
    L.switchTo("0.2.0");
    const u3 = await make();
    expect(u3.remote).toBe("none");
    expect(await u3.facts()).toEqual({ update: "none", build: "apply", kind: "release", latest: null, next: "0.2.0" });
    // current names a version with no page: the update did not finish.
    version(L.vdir, "0.3.0", { page: false });
    L.switchTo("0.3.0");
    expect((await u3.facts()).build).toBe("unfinished");
    unlinkSync(join(L.kit, "current"));
    expect(await u3.facts()).toMatchObject({ build: "unfinished", next: null });
  });
});

describe("the refusals of a release install (DESIGN-I1 3.3)", () => {
  test("dev mode; a --dist of another folder; install.sh's lock held by a live process; else none", async () => {
    const L = layout();
    const dist = join(L.install.root, "dist", "web");
    const src = (o: { dev?: boolean; dist?: string } = {}) =>
      releaseSource({ install: L.install, dist: o.dist ?? dist, dev: o.dev ?? false, env: {}, checker: releaseChecker({ install: L.install, env: {} }) });
    expect(await src().refusal()).toBeNull();
    expect(await src({ dev: true }).refusal()).toBe("dev");
    expect(await src({ dist: join(L.base, "other", "web") }).refusal()).toBe("dist");
    expect(UPDATE_REFUSAL_LINES.dist).toBe("kitespan was started with --dist, so it does not update itself.");
    // The same folder through a link is the same folder.
    symlinkSync(L.install.root, join(L.base, "via-link"));
    expect(await src({ dist: join(L.base, "via-link", "dist", "web") }).refusal()).toBeNull();
    const lock = join(L.vdir, ".lock");
    mkdirSync(lock);
    expect(versionsLockHeld(L.vdir)).toBe(false);
    writeFileSync(join(lock, "pid"), "garbage\n");
    expect(versionsLockHeld(L.vdir)).toBe(false);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    expect(versionsLockHeld(L.vdir)).toBe(true);
    expect(await src().refusal()).toBe("busy");
    const gone = Bun.spawn(["/bin/sh", "-c", "exit 0"]);
    await gone.exited;
    writeFileSync(join(lock, "pid"), `${gone.pid}\n`);
    expect(versionsLockHeld(L.vdir)).toBe(false);
    expect(await src().refusal()).toBeNull();
  });

  test("the job's busy() (the restart's updating()) is true while install.sh's lock is held", async () => {
    const L = layout();
    const state = join(L.base, "state");
    mkdirSync(join(state, "logs"), { recursive: true, mode: 0o700 });
    const source = releaseSource({ install: L.install, dist: join(L.install.root, "dist", "web"), dev: false, env: {}, checker: releaseChecker({ install: L.install, env: {} }) });
    const jobs = createUpdateJobs({ source, state, logs: join(state, "logs"), restarting: () => false, held: () => versionsLockHeld(L.vdir) });
    expect(await jobs.busy()).toBe(false);
    mkdirSync(join(L.vdir, ".lock"));
    writeFileSync(join(L.vdir, ".lock", "pid"), `${process.pid}\n`);
    expect(await jobs.busy()).toBe(true);
    expect(await jobs.start()).toEqual({ ok: false, refusal: "busy", line: UPDATE_REFUSAL_LINES.busy });
    rmSync(join(L.vdir, ".lock"), { recursive: true });
    expect(await jobs.busy()).toBe(false);
  });
});

/**
 * A fake install.sh in the running version's folder, driven by `<rec>/mode`: it records its working folder, its
 * arguments, its stdin, its pid and the environment names the test asks about, prints the step lines of install.sh's
 * form and ends as the mode says (a switch of current to 0.2.0 included).
 */
function fakeInstaller(L: ReturnType<typeof layout>) {
  const rec = join(L.base, "rec");
  mkdirSync(rec, { recursive: true });
  writeFileSync(
    join(L.install.root, "install.sh"),
    `#!/bin/sh
rec='${rec}'
pwd -P > "$rec/cwd"
echo "$#" > "$rec/argc"
echo $$ > "$rec/pid"
if read -r x; then echo "had input" > "$rec/stdin"; else echo "no input" > "$rec/stdin"; fi
{
  echo "XDG_DATA_HOME=\${XDG_DATA_HOME-unset}"
  echo "KITESPAN_VERSION=\${KITESPAN_VERSION-unset}"
  echo "KITESPAN_INSTALL_FROM=\${KITESPAN_INSTALL_FROM-unset}"
  echo "KEEP_ME=\${KEEP_ME-unset}"
} > "$rec/env"
mode=$(cat "$rec/mode")
echo "Step 1 of 3, fetch: /some/folder/SHA256SUMS"
echo "  Step 3 of 3, build: not at the start of the line"
echo "Step 2 of 3, fetch: a name that does not match its number"
case $mode in
  refuse)
    echo "install.sh: another install of kitespan runs now (process 1, x). Wait for it to end, then run this again." >&2
    exit 1 ;;
  fail-install)
    echo "Step 2 of 3, install: bun install --frozen-lockfile --omit=optional --production"
    echo "install.sh: step 2 of 3 failed: bun install --frozen-lockfile --omit=optional --production exited 1; kitespan did not change." >&2
    exit 3 ;;
  sleep)
    echo "Step 2 of 3, install: bun install --frozen-lockfile --omit=optional --production"
    sleep 30 ;;
esac
echo "Step 2 of 3, install: bun install --frozen-lockfile --omit=optional --production"
echo "Step 3 of 3, build: bun run build"
case $mode in
  ok|broken)
    mkdir -p '${L.vdir}/0.2.0/bin'
    : > '${L.vdir}/0.2.0/bin/kitespan'
    if [ "$mode" = ok ]; then mkdir -p '${L.vdir}/0.2.0/dist/web'; echo page > '${L.vdir}/0.2.0/dist/web/index.html'; fi
    ln -s versions/0.2.0/bin/kitespan '${L.kit}/.current.new'
    mv -f '${L.kit}/.current.new' '${L.kit}/current'
    echo "kitespan 0.2.0 is installed in ${L.vdir}/0.2.0; ~/.local/bin/kitespan starts it." ;;
  same)
    echo "kitespan 0.1.0 is installed already in ${L.vdir}/0.1.0; nothing changed." ;;
esac
exit 0
`,
  );
  chmodSync(join(L.install.root, "install.sh"), 0o755);
  const read = (f: string) => readFileSync(join(rec, f), "utf8").trim();
  return { rec, mode: (m: string) => writeFileSync(join(rec, "mode"), m), read };
}

describe("the steps: the running version's own install.sh (DESIGN-I1 3.4)", () => {
  const START = { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", KITESPAN_VERSION: "0.0.9", KITESPAN_INSTALL_FROM: "/srv/releases", KEEP_ME: "kept", XDG_DATA_HOME: "/elsewhere" };

  function setup(limits?: Partial<{ fetchMs: number; installMs: number; buildMs: number }>) {
    const L = layout();
    const f = fakeInstaller(L);
    const state = join(L.base, "state");
    const logs = join(state, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const source = releaseSource({ install: L.install, dist: join(L.install.root, "dist", "web"), dev: false, env: START, checker: releaseChecker({ install: L.install, env: START }), ...(limits ? { limits } : {}) });
    const seen: UpdateJob[] = [];
    let applied = 0;
    const jobs = createUpdateJobs({ source, state, logs, restarting: () => false, applied: () => void applied++ });
    jobs.onChange((j) => seen.push(j));
    return { L, f, state, logs, source, jobs, seen, applied: () => applied };
  }

  test("ok: no arguments, in the data folder, no input; the step lines are the job's; switched, so the job is done", async () => {
    const s = setup();
    s.f.mode("ok");
    expect(await s.jobs.start()).toEqual({ ok: true, job: { state: "running", step: "fetch" } });
    await s.jobs.idle();
    expect(s.seen).toEqual([{ state: "running", step: "fetch" }, { state: "running", step: "install" }, { state: "running", step: "build" }, { state: "done" }]);
    expect(s.applied()).toBe(1);
    expect(s.f.read("cwd")).toBe(s.L.kit);
    expect(s.f.read("argc")).toBe("0");
    expect(s.f.read("stdin")).toBe("no input");
    expect(nextRoot(s.L.install)).toBe(join(s.L.vdir, "0.2.0"));
    // update.log holds its lines (and stderr's); the lock is given back.
    const log = readFileSync(join(s.logs, UPDATE_LOG), "utf8");
    expect(log).toContain("Step 1 of 3, fetch: /some/folder/SHA256SUMS\n");
    expect(log).toContain("kitespan 0.2.0 is installed in ");
    expect(existsSync(join(s.state, UPDATE_LOCK))).toBe(false);
  });

  test("its environment: the start environment without KITESPAN_VERSION, XDG_DATA_HOME the folder above the data folder", async () => {
    const s = setup();
    s.f.mode("ok");
    await s.jobs.start();
    await s.jobs.idle();
    expect(s.f.read("env").split("\n")).toEqual([`XDG_DATA_HOME=${s.L.base}`, "KITESPAN_VERSION=unset", "KITESPAN_INSTALL_FROM=/srv/releases", "KEEP_ME=kept"]);
    const env = installerEnv(s.L.install, START);
    expect(env.KITESPAN_VERSION).toBeUndefined();
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", KITESPAN_INSTALL_FROM: "/srv/releases", KEEP_ME: "kept", XDG_DATA_HOME: s.L.base });
  });

  test("a step that failed (exit 3) is the job's failed step; a refusal before any step (exit 1) is step 1's; nothing switched", async () => {
    const s = setup();
    s.f.mode("fail-install");
    await s.jobs.start();
    await s.jobs.idle();
    expect(s.seen.at(-1)).toEqual({ state: "failed", step: "install", line: "The update did not finish at step 2 of 3, install." });
    expect(nextRoot(s.L.install)).toBe(s.L.install.root);
    expect(readFileSync(join(s.logs, UPDATE_LOG), "utf8")).toContain("install.sh: step 2 of 3 failed: ");
    s.f.mode("refuse");
    await s.jobs.start();
    await s.jobs.idle();
    expect(s.seen.at(-1)).toEqual({ state: "failed", step: "fetch", line: "The update did not finish at step 1 of 3, fetch." });
    expect(s.applied()).toBe(0);
  });

  test("exit 0 with nothing newer: done (as a checkout's update with nothing to pull); exit 0 with a next version that has no page: failed", async () => {
    const s = setup();
    s.f.mode("same");
    await s.jobs.start();
    await s.jobs.idle();
    expect(s.seen.at(-1)).toEqual({ state: "done" });
    s.f.mode("broken");
    await s.jobs.start();
    await s.jobs.idle();
    expect(s.seen.at(-1)).toEqual({ state: "failed", step: "build", line: "The update did not finish at step 3 of 3, build." });
  });

  test("one deadline for the three steps, recorded in update.lock; past it the whole group ends", async () => {
    const s = setup({ fetchMs: 400, installMs: 400, buildMs: 400 });
    s.f.mode("sleep");
    const t0 = Date.now();
    await s.jobs.start();
    let lock: { step?: { pid: number; until: number } } | null = null;
    for (let i = 0; i < 100 && !lock?.step; i++) {
      await Bun.sleep(20);
      try {
        lock = JSON.parse(readFileSync(join(s.state, UPDATE_LOCK), "utf8"));
      } catch {
        lock = null;
      }
    }
    expect(lock?.step?.pid).toBe(Number(s.f.read("pid")));
    expect(lock!.step!.until - t0).toBeLessThan(1_200 + 1_000);
    await s.jobs.idle();
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(s.seen.at(-1)).toEqual({ state: "failed", step: "install", line: "The update did not finish at step 2 of 3, install." });
    let alive = true;
    try {
      process.kill(Number(s.f.read("pid")), 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 15_000);
});

describe("bin/update.sh's body for a release install (DESIGN-I1 3.7)", () => {
  const CLI = join(import.meta.dir, "..", "..", "server", "update", "cli.ts");

  async function cli(L: ReturnType<typeof layout>, argv: string[] = []) {
    const state = join(L.base, "xdg-state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const code = `const { runUpdate } = await import(${JSON.stringify(CLI)}); process.exit(await runUpdate(${JSON.stringify(L.install.root)}, ${JSON.stringify(argv)}, { ...process.env }));`;
    const p = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
      env: { PATH: "/usr/bin:/bin", HOME: join(L.base, "home"), XDG_STATE_HOME: state, KITESPAN_VERSION: "0.0.1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, exit };
  }

  test("install.sh's own lines are the progress; the last line names kitespan restart; exit 0; KITESPAN_VERSION never reaches it", async () => {
    const L = layout();
    const f = fakeInstaller(L);
    f.mode("ok");
    const r = await cli(L);
    expect(r.exit).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toBe("Step 1 of 3, fetch: /some/folder/SHA256SUMS");
    expect(lines.at(-1)).toBe("Restart kitespan to apply it: Settings > About > Restart, or kitespan restart.");
    expect(r.err).toBe("");
    expect(f.read("env")).toContain("KITESPAN_VERSION=unset");
    expect(nextRoot(L.install)).toBe(join(L.vdir, "0.2.0"));
  });

  test("a failed step: install.sh named it, and nothing is added; exit 1. A --dist of another folder is refused", async () => {
    const L = layout();
    const f = fakeInstaller(L);
    f.mode("fail-install");
    const r = await cli(L);
    expect(r.exit).toBe(1);
    expect(r.err).toBe("install.sh: step 2 of 3 failed: bun install --frozen-lockfile --omit=optional --production exited 1; kitespan did not change.\n");
    expect(r.out).not.toContain("Restart kitespan");
    const d = await cli(L, ["--dist", join(L.base, "elsewhere")]);
    expect(d.exit).toBe(1);
    expect(d.err).toBe(`update.sh: ${UPDATE_REFUSAL_LINES.dist}\n`);
  });
});
