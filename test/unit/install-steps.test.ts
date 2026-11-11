// install.sh's steps (DESIGN-I1 2.8 to 2.13): a first install (the folders, the two links, the lines), a second run of
// the same version (nothing changed), a newer one (installed beside, switched, the old one kept), a third (the oldest
// removed), a version that runs (kept), a step back with KITESPAN_VERSION, the downloads (curl's and wget's flags,
// exactly), every failure of a step (exit 3, its one line, and the home exactly as before), ~/.local/bin on and off
// PATH, the lock, a signal in the middle of a step, --list, --uninstall and --help. Every run is `sh install.sh` in a
// fresh home with the fakes of test/install/fakes as its whole PATH, so nothing reaches the network.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveName, RELEASES_URL } from "../../shared/release";
import { calls, type Entry, good, type Home, install, INSTALL, localRelease, makeHome, releaseEntries, removeHomes, serveRelease, sha256, snapshot, sumsText, tarGz } from "../install/home";
import { PROCFS } from "../linux";

afterAll(removeHomes);

const STEP2 = "Step 2 of 3, install: bun install --frozen-lockfile --omit=optional --production";
const STEP3 = "Step 3 of 3, build: bun run build";
const CURL = "curl --proto =https --tlsv1.2 -fsSL --retry 2 --connect-timeout 10 --speed-limit 1000 --speed-time 10 --max-filesize";
const WGET = "wget --https-only --secure-protocol=TLSv1_2 -q --timeout=10 --tries=3 -O";
const MiB = 1024 * 1024;

const notOnPath = (h: Home) => [
  `${h.bindir} is not on your PATH. Add this line to your shell's startup file (for example ~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal:`,
  '  export PATH="$HOME/.local/bin:$PATH"',
  `Start it: ${h.link}`,
];
const fetchLines = (from: string, v: string) => [`Step 1 of 3, fetch: ${from}/SHA256SUMS`, `Step 1 of 3, fetch: ${from}/${archiveName(v)}`];
const installed = (h: Home, v: string) => `kitespan ${v} is installed in ${h.versions}/${v}; ${h.link} starts it.`;
const removed = (v: string) => `Removed kitespan ${v}: install.sh keeps the version that kitespan starts and the one before it.`;

/** The versions installed, as their folder names. */
const versionsOf = (h: Home) => (existsSync(h.versions) ? readdirSync(h.versions).sort() : []);
const currentOf = (h: Home) => readlinkSync(h.current);
/** A ps line of a kitespan server that runs from version v (its arguments name its real root). */
const serverLine = (h: Home, pid: number, v: string) => `${pid} /usr/local/bin/bun --cwd=${h.versions}/${v} --no-env-file ${h.versions}/${v}/server/main.ts --port 7940`;

/** A home with these versions installed in order, from one local release that lists them all. */
function installedHome(versions: string[], o: { omit?: string[] } = {}): { h: Home; from: string } {
  const h = makeHome(o);
  const from = localRelease(h, "release", versions.map(good));
  for (const v of versions) {
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from, KITESPAN_VERSION: v });
    if (r.code !== 0) throw new Error(`the install of ${v} failed: ${r.err}`);
  }
  return { h, from };
}

/** What the home's link starts prints (nothing, with a failure, when the link leads nowhere). */
const starts = (h: Home) => Bun.spawnSync(["/bin/sh", "-c", 'exec "$0"', h.link], { env: { PATH: h.bin }, stderr: "ignore" }).stdout.toString();

/**
 * The home's rm, replaced by one that stops the removal of a version's tree half way: when what it is to remove is a
 * version's folder (it holds bin/kitespan) or holds one, it removes that tree's bin/ only, logs `rm cut`, and then ends
 * the installer with SIGKILL (`kill`: a kill or the server's deadline in the middle of the removal) or sleeps 30 s in
 * the installer's process group (`sleep`: the test sends the signal). Anything else goes to the system's rm.
 */
function cutRemovals(h: Home, how: "kill" | "sleep"): () => void {
  const rm = join(h.bin, "rm");
  const real = realpathSync(rm);
  unlinkSync(rm);
  const stop = how === "kill" ? 'kill -KILL "$PPID"; exit 1' : "sleep 30; exit 1";
  writeFileSync(
    rm,
    `#!/bin/sh\nfor a; do last=$a; done\nfor t in "$last" "$last"/*; do\n  if [ -f "$t/bin/kitespan" ]; then\n    '${real}' -rf -- "$t/bin"\n    printf 'rm cut %s\\n' "$t" >>"$FAKE_LOG"\n    ${stop}\n  fi\ndone\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  return () => {
    unlinkSync(rm);
    symlinkSync(real, rm);
  };
}

/** A process of this test (one Bun that waits) whose arguments name a version's server/main.ts, as a kitespan server's do. */
const pretend = (main: string) => Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", main], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

/** The installed versions' names, without install.sh's own names (.lock, .staging, .removing). */
const namesOf = (h: Home) => versionsOf(h).filter((n) => !n.startsWith("."));

describe("a first install", () => {
  test("the version folder, the two links, the lines, the steps' commands and the folders' modes", () => {
    const h = makeHome();
    const from = localRelease(h, "release", [good("0.1.0")]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([...fetchLines(from, "0.1.0"), STEP2, STEP3, installed(h, "0.1.0"), ...notOnPath(h)]);
    const staging = join(h.versions, ".staging", "kitespan-0.1.0");
    expect(calls(h)).toEqual([`bun install --cwd ${staging} --frozen-lockfile --omit=optional --production`, `bun run --cwd ${staging} build`]);
    expect(versionsOf(h)).toEqual(["0.1.0"]);
    const dir = join(h.versions, "0.1.0");
    for (const f of ["package.json", "install.sh", "bin/kitespan", "node_modules", "dist/web/index.html", "dist/web/build.json"]) expect(existsSync(join(dir, f))).toBe(true);
    expect(currentOf(h)).toBe("versions/0.1.0/bin/kitespan");
    expect(readlinkSync(h.link)).toBe(h.current);
    for (const d of [h.kit, h.versions, dir, h.bindir]) expect((lstatSync(d).mode & 0o777).toString(8)).toBe("700");
    const run = Bun.spawnSync([h.link], { env: { PATH: h.bin } });
    expect(run.stdout.toString()).toBe("kitespan 0.1.0\n");
  });

  test("XDG_DATA_HOME, when absolute, holds kitespan's folder; a relative one is not used", () => {
    const h = makeHome();
    const from = localRelease(h, "release", [good("0.1.0")]);
    const data = join(h.home, "data");
    expect(install(h, [], { KITESPAN_INSTALL_FROM: from, XDG_DATA_HOME: data }).code).toBe(0);
    expect(readlinkSync(join(data, "kitespan", "current"))).toBe("versions/0.1.0/bin/kitespan");
    expect(readlinkSync(h.link)).toBe(join(data, "kitespan", "current"));
    const g = makeHome();
    const gFrom = localRelease(g, "release", [good("0.1.0")]);
    expect(install(g, [], { KITESPAN_INSTALL_FROM: gFrom, XDG_DATA_HOME: "data" }).code).toBe(0);
    expect(currentOf(g)).toBe("versions/0.1.0/bin/kitespan");
  });

  test("with ~/.local/bin on PATH: no PATH lines, and the start line names the command", () => {
    const h = makeHome();
    const from = localRelease(h, "release", [good("0.1.0")]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from, PATH: `${h.bin}:${h.bindir}` });
    expect(r.code).toBe(0);
    expect(r.lines.slice(-2)).toEqual([installed(h, "0.1.0"), "Start it: kitespan"]);
  });

  test("from one archive file: that version, with the SHA256SUMS beside it", () => {
    const h = makeHome();
    const from = localRelease(h, "release", [good("0.1.0"), good("0.2.0")]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: join(from, archiveName("0.1.0")) });
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 2)).toEqual(fetchLines(from, "0.1.0"));
    expect(versionsOf(h)).toEqual(["0.1.0"]);
  });

  test("from a folder: the newest version that SHA256SUMS lists, by its numbers", () => {
    const h = makeHome();
    const from = localRelease(h, "release", [good("0.9.0"), good("0.10.0"), good("0.2.0")]);
    expect(install(h, [], { KITESPAN_INSTALL_FROM: from }).code).toBe(0);
    expect(versionsOf(h)).toEqual(["0.10.0"]);
  });
});

describe("the downloads: https only, with these flags", () => {
  test("curl: the latest release's SHA256SUMS, then the archive by its own tag", () => {
    const h = makeHome();
    const a = good("0.1.0");
    serveRelease(h, "0.1.0", a.data);
    const r = install(h);
    expect(r.code).toBe(0);
    const sumsUrl = `${RELEASES_URL}/latest/download/SHA256SUMS`;
    const archiveUrl = `${RELEASES_URL}/download/v0.1.0/kitespan-0.1.0.tar.gz`;
    expect(r.lines.slice(0, 2)).toEqual([`Step 1 of 3, fetch: ${sumsUrl}`, `Step 1 of 3, fetch: ${archiveUrl}`]);
    const staging = join(h.versions, ".staging");
    expect(calls(h).slice(0, 2)).toEqual([
      `${CURL} 65536 -o ${staging}/SHA256SUMS ${sumsUrl}`,
      `${CURL} 104857600 -o ${staging}/kitespan-0.1.0.tar.gz ${archiveUrl}`,
    ]);
  });

  test("KITESPAN_VERSION: that release's own SHA256SUMS (a leading v is taken off)", () => {
    const h = makeHome();
    serveRelease(h, "0.1.0", good("0.1.0").data, { latest: false });
    const r = install(h, [], { KITESPAN_VERSION: "v0.1.0" });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`Step 1 of 3, fetch: ${RELEASES_URL}/download/v0.1.0/SHA256SUMS`);
  });

  test("wget when there is no curl", () => {
    const h = makeHome({ omit: ["curl"] });
    serveRelease(h, "0.1.0", good("0.1.0").data);
    expect(install(h).code).toBe(0);
    const staging = join(h.versions, ".staging");
    expect(calls(h).slice(0, 2)).toEqual([
      `${WGET} ${staging}/SHA256SUMS ${RELEASES_URL}/latest/download/SHA256SUMS`,
      `${WGET} ${staging}/kitespan-0.1.0.tar.gz ${RELEASES_URL}/download/v0.1.0/kitespan-0.1.0.tar.gz`,
    ]);
  });
});

describe("a second run, a newer version, a third, and a step back", () => {
  test("the same version again: one line, exit 0, and nothing changed", () => {
    const { h, from } = installedHome(["0.1.0"]);
    const before = snapshot(h.home);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([`Step 1 of 3, fetch: ${from}/SHA256SUMS`, `kitespan 0.1.0 is installed already in ${h.versions}/0.1.0; nothing changed.`]);
    expect(snapshot(h.home)).toEqual(before);
  });

  test("a newer version installs beside the old one and switches; the old one is kept", () => {
    const { h } = installedHome(["0.1.0"]);
    const link = snapshot(join(h.home, ".local", "bin"));
    const from = localRelease(h, "newer", [good("0.1.0"), good("0.2.0")]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([...fetchLines(from, "0.2.0"), STEP2, STEP3, installed(h, "0.2.0"), ...notOnPath(h)]);
    expect(versionsOf(h)).toEqual(["0.1.0", "0.2.0"]);
    expect(currentOf(h)).toBe("versions/0.2.0/bin/kitespan");
    expect(snapshot(join(h.home, ".local", "bin"))).toEqual(link);
    expect(Bun.spawnSync([h.link], { env: { PATH: h.bin } }).stdout.toString()).toBe("kitespan 0.2.0\n");
  });

  test("a third: the oldest goes, with one line; the one before the new current stays", () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const from = localRelease(h, "third", [good("0.3.0")]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([...fetchLines(from, "0.3.0"), STEP2, STEP3, removed("0.1.0"), installed(h, "0.3.0"), ...notOnPath(h)]);
    expect(versionsOf(h)).toEqual(["0.2.0", "0.3.0"]);
  });

  test("a version that runs now is kept, and the last lines say to restart it", () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const from = localRelease(h, "third", [good("0.3.0")]);
    const ps = [serverLine(h, 4242, "0.1.0"), `4343 /bin/sh ${h.versions}/0.2.0/install.sh`, "1 /sbin/init"].join("\n");
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_PS: ps });
    expect(r.code).toBe(0);
    expect(r.lines.slice(4)).toEqual([installed(h, "0.3.0"), "kitespan 0.1.0 runs now: restart it to run 0.3.0 (Settings > About > Restart, or kitespan restart).", ...notOnPath(h)]);
    expect(versionsOf(h)).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
  });

  test("a running installer of a version is not a version that runs", () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const from = localRelease(h, "third", [good("0.3.0")]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_PS: `4343 /bin/sh ${h.versions}/0.1.0/install.sh` });
    expect(r.code).toBe(0);
    expect(versionsOf(h)).toEqual(["0.2.0", "0.3.0"]);
  });

  test("when neither ps nor /proc can list the processes (macOS with no ps), nothing is removed and nothing is said", () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const from = localRelease(h, "third", [good("0.3.0")]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_PS_FAIL: "1", FAKE_UNAME: "Darwin" });
    expect(r.code).toBe(0);
    expect(r.lines.slice(4)).toEqual([installed(h, "0.3.0"), ...notOnPath(h)]);
    expect(versionsOf(h)).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
  });

  test.skipIf(!PROCFS)("on Linux with no ps (an image without procps), /proc lists the processes: a version that runs stays, the oldest goes", async () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const from = localRelease(h, "fourth", [good("0.3.0")]);
    const server = pretend(join(h.versions, "0.1.0", "server", "main.ts"));
    try {
      await Bun.sleep(300);
      const r = install(h, [], { KITESPAN_INSTALL_FROM: from, FAKE_PS_FAIL: "1" });
      expect(r.code).toBe(0);
      expect(r.lines.slice(4)).toEqual([installed(h, "0.3.0"), "kitespan 0.1.0 runs now: restart it to run 0.3.0 (Settings > About > Restart, or kitespan restart).", ...notOnPath(h)]);
      expect(versionsOf(h)).toEqual(["0.1.0", "0.2.0", "0.3.0"]);
      expect(install(h, ["--list"], { FAKE_PS_FAIL: "1" }).lines).toEqual(["0.3.0  current", "0.2.0", "0.1.0  runs now"]);
    } finally {
      server.kill();
      await server.exited;
    }
    const again = install(h, [], { KITESPAN_INSTALL_FROM: localRelease(h, "fifth", [good("0.4.0")]), FAKE_PS_FAIL: "1" });
    expect(again.code).toBe(0);
    expect(again.lines).toContain(removed("0.1.0"));
    expect(again.lines).toContain(removed("0.2.0"));
    expect(versionsOf(h)).toEqual(["0.3.0", "0.4.0"]);
  });

  test("KITESPAN_VERSION=<an older one that is installed>: a step back with no download, and the newer one is kept", () => {
    const { h, from } = installedHome(["0.1.0", "0.2.0"]);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from, KITESPAN_VERSION: "v0.1.0" });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([`Step 1 of 3, fetch: ${from}/SHA256SUMS`, `kitespan 0.1.0 is installed already in ${h.versions}/0.1.0.`, `${h.link} starts kitespan 0.1.0 now.`, ...notOnPath(h)]);
    expect(currentOf(h)).toBe("versions/0.1.0/bin/kitespan");
    expect(versionsOf(h)).toEqual(["0.1.0", "0.2.0"]);
    expect(calls(h).filter((c) => c.startsWith("bun install"))).toHaveLength(2);
  });

  test("an installed version whose link is gone: the link is made again", () => {
    const { h, from } = installedHome(["0.1.0"]);
    unlinkSync(h.link);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: from });
    expect(r.code).toBe(0);
    expect(r.lines.slice(1, 3)).toEqual([`kitespan 0.1.0 is installed already in ${h.versions}/0.1.0.`, `${h.link} starts kitespan 0.1.0 now.`]);
    expect(readlinkSync(h.link)).toBe(h.current);
  });
});

describe("a step that fails: exit 3, one line, and kitespan as it was", () => {
  /** A home with 0.1.0 installed; the run must fail at step n with this reason and change nothing in the home. */
  function failed(h: Home, env: Record<string, string>, n: number, reason: string | RegExp): void {
    const before = snapshot(h.home);
    const r = install(h, [], env);
    expect(r.code).toBe(3);
    const last = r.err.trim().split("\n").at(-1)!;
    if (typeof reason === "string") expect(last).toBe(`install.sh: step ${n} of 3 failed: ${reason}; kitespan did not change.`);
    else expect(last).toMatch(new RegExp(`^install\\.sh: step ${n} of 3 failed: ${reason.source}; kitespan did not change\\.$`));
    expect(snapshot(h.home)).toEqual(before);
    expect(currentOf(h)).toBe("versions/0.1.0/bin/kitespan");
  }
  /** A local release of 0.2.0 made of these entries (or these bytes), with a right SHA256SUMS unless one is given. */
  function bad(h: Home, what: Entry[] | Uint8Array, sums?: string): string {
    const data = what instanceof Uint8Array ? what : tarGz(what);
    return localRelease(h, `bad-${Math.random().toString(36).slice(2)}`, [{ v: "0.2.0", data }], sums);
  }

  test("a SHA-256 that is not SHA256SUMS's: the download goes", () => {
    const { h } = installedHome(["0.1.0"]);
    const a = good("0.2.0");
    const wrong = "0".repeat(64);
    const from = bad(h, a.data, `${wrong}  ${archiveName("0.2.0")}\n`);
    failed(h, { KITESPAN_INSTALL_FROM: from }, 1, `the SHA-256 of kitespan-0.2.0.tar.gz is ${sha256(a.data)}, not ${wrong} as SHA256SUMS says, so the download was removed`);
  });

  test("a download that fails, or stops half way (curl 18), or is not there (curl 22, wget 8)", () => {
    const { h } = installedHome(["0.1.0"]);
    serveRelease(h, "0.2.0", good("0.2.0").data);
    const url = `${RELEASES_URL}/download/v0.2.0/kitespan-0.2.0.tar.gz`;
    failed(h, { FAKE_PARTIAL: archiveName("0.2.0") }, 1, `could not download ${url} (curl exit 18)`);
    unlinkSync(join(h.serve, "download", "v0.2.0", archiveName("0.2.0")));
    failed(h, {}, 1, `could not download ${url} (curl exit 22)`);
    const w = installedHome(["0.1.0"], { omit: ["curl"] }).h;
    serveRelease(w, "0.2.0", good("0.2.0").data);
    unlinkSync(join(w.serve, "download", "v0.2.0", archiveName("0.2.0")));
    failed(w, {}, 1, `could not download ${url} (wget exit 8)`);
  });

  test("an archive larger than 100 MiB, a SHA256SUMS larger than 64 KiB", () => {
    const { h } = installedHome(["0.1.0"]);
    const from = bad(h, new Uint8Array(1));
    truncateSync(join(from, archiveName("0.2.0")), 100 * MiB + 1);
    failed(h, { KITESPAN_INSTALL_FROM: from }, 1, "kitespan-0.2.0.tar.gz is larger than 100 MiB");
    serveRelease(h, "0.2.0", new Uint8Array(1));
    truncateSync(join(h.serve, "download", "v0.2.0", archiveName("0.2.0")), 100 * MiB + 1);
    failed(h, {}, 1, "kitespan-0.2.0.tar.gz is larger than 100 MiB");
    writeFileSync(join(from, "SHA256SUMS"), "#".repeat(65_537));
    failed(h, { KITESPAN_INSTALL_FROM: from }, 1, "SHA256SUMS is larger than 64 KiB");
    writeFileSync(join(h.serve, "latest", "download", "SHA256SUMS"), "#".repeat(65_537));
    failed(h, {}, 1, "SHA256SUMS is larger than 64 KiB");
  });

  test("an archive that unpacks to more than 200 MiB, or holds more than 20,000 entries", () => {
    const { h } = installedHome(["0.1.0"]);
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/big", zeros: 200 * MiB }]) }, 1, "kitespan-0.2.0.tar.gz unpacks to more than 200 MiB");
    const many: Entry[] = [...releaseEntries("0.2.0")];
    for (let i = 0; many.length <= 20_000; i++) many.push({ name: `kitespan-0.2.0/f/${i}` });
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, many) }, 1, "kitespan-0.2.0.tar.gz holds more than 20000 entries");
  }, 60_000);

  test("sparse members: the sizes that the archive declares count, alone and summed, though its tar stream is small", () => {
    const { h } = installedHome(["0.1.0"]);
    const big = bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/big", sparse: 1024 * MiB }]);
    expect(Bun.gunzipSync(readFileSync(join(big, archiveName("0.2.0")))).length).toBeLessThan(64 * 1024);
    failed(h, { KITESPAN_INSTALL_FROM: big }, 1, "kitespan-0.2.0.tar.gz unpacks to more than 200 MiB");
    const two = bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/a", sparse: 101 * MiB }, { name: "kitespan-0.2.0/b", sparse: 100 * MiB }]);
    failed(h, { KITESPAN_INSTALL_FROM: two }, 1, "kitespan-0.2.0.tar.gz unpacks to more than 200 MiB");
    const small = bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/c", sparse: 4 * MiB }]);
    expect(install(h, [], { KITESPAN_INSTALL_FROM: small }).code).toBe(0);
    expect(currentOf(h)).toBe("versions/0.2.0/bin/kitespan");
  });

  test("an entry outside kitespan-<v>/, a .. part, a link or a special file", () => {
    const { h } = installedHome(["0.1.0"]);
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, releaseEntries("0.2.0", { top: "kitespan-9.9.9" })) }, 1, "kitespan-0.2.0.tar.gz holds kitespan-9.9.9/, which is outside kitespan-0.2.0/");
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, [...releaseEntries("0.2.0"), { name: "other/x" }]) }, 1, "kitespan-0.2.0.tar.gz holds other/x, which is outside kitespan-0.2.0/");
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/../x" }]) }, 1, "kitespan-0.2.0.tar.gz holds kitespan-0.2.0/../x, which is outside kitespan-0.2.0/");
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/a/../", type: "dir" }]) }, 1, "kitespan-0.2.0.tar.gz holds kitespan-0.2.0/a/../, which is outside kitespan-0.2.0/");
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/bin/x", type: "symlink", target: "/etc/passwd" }]) }, 1, /kitespan-0\.2\.0\.tar\.gz holds a link or a special file: l.*kitespan-0\.2\.0\/bin\/x -> \/etc\/passwd/);
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, [...releaseEntries("0.2.0"), { name: "kitespan-0.2.0/pipe", type: "fifo" }]) }, 1, /kitespan-0\.2\.0\.tar\.gz holds a link or a special file: p.*kitespan-0\.2\.0\/pipe/);
  });

  test("not an archive, another version in its package.json, no install.sh", () => {
    const { h } = installedHome(["0.1.0"]);
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, new TextEncoder().encode("not a tar.gz\n")) }, 1, /tar exited \d+/);
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, releaseEntries("0.2.0", { pkgVersion: "0.1.9" })) }, 1, "kitespan-0.2.0.tar.gz holds version 0.1.9 in its package.json, not 0.2.0");
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, releaseEntries("0.2.0", { installer: false })) }, 1, "kitespan-0.2.0.tar.gz holds no kitespan-0.2.0/install.sh");
  });

  test("SHA256SUMS with no archive line, or none for KITESPAN_VERSION", () => {
    const { h, from } = installedHome(["0.1.0"]);
    failed(h, { KITESPAN_INSTALL_FROM: bad(h, good("0.2.0").data, `${"a".repeat(64)}  install.sh\n${"b".repeat(64)}  kitespan-0.2.tar.gz\n`) }, 1, "SHA256SUMS lists no kitespan archive");
    failed(h, { KITESPAN_INSTALL_FROM: from, KITESPAN_VERSION: "0.9.0" }, 1, "SHA256SUMS has no line for kitespan-0.9.0.tar.gz");
  });

  test("a CRLF SHA256SUMS reads as its lines", () => {
    const { h } = installedHome(["0.1.0"]);
    const a = good("0.2.0");
    const from = bad(h, a.data, sumsText([a]).replaceAll("\n", "\r\n"));
    expect(install(h, [], { KITESPAN_INSTALL_FROM: from }).code).toBe(0);
    expect(currentOf(h)).toBe("versions/0.2.0/bin/kitespan");
  });

  test("bun install fails, the build fails, or the build writes no page", () => {
    const { h } = installedHome(["0.1.0"]);
    const from = localRelease(h, "newer", [good("0.2.0")]);
    failed(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_INSTALL_EXIT: "7" }, 2, "bun install --frozen-lockfile --omit=optional --production exited 7");
    failed(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_BUILD_EXIT: "5" }, 3, "bun run build exited 5");
    failed(h, { KITESPAN_INSTALL_FROM: from, FAKE_BUN_BUILD_NOPAGE: "1" }, 3, "the build wrote no page");
  });
});

describe("a removal stopped half way: a version's folder is renamed first, so no half of one is ever taken as installed", () => {
  test("the removal of an old version, killed half way: that version is gone, and its next install is a whole one", () => {
    const { h, from } = installedHome(["0.1.0", "0.2.0"]);
    const restore = cutRemovals(h, "kill");
    const cut = install(h, [], { KITESPAN_INSTALL_FROM: localRelease(h, "third", [good("0.3.0")]) });
    restore();
    expect(cut.code).not.toBe(0);
    expect(calls(h).filter((c) => c.startsWith("rm cut"))).toHaveLength(1);
    expect(namesOf(h)).toEqual(["0.2.0", "0.3.0"]);
    expect(starts(h)).toBe("kitespan 0.3.0\n");
    // The step back to 0.1.0 installs it again (it is not "installed already"), and the leftover goes.
    const back = install(h, [], { KITESPAN_INSTALL_FROM: from, KITESPAN_VERSION: "0.1.0" });
    expect({ code: back.code, err: back.err }).toEqual({ code: 0, err: "" });
    expect(back.lines).toContain(STEP2);
    expect(starts(h)).toBe("kitespan 0.1.0\n");
    expect(versionsOf(h)).toEqual(["0.1.0", "0.3.0"]);
  });

  test("--uninstall killed half way: every version left is whole, and an install of each starts it", () => {
    const { h, from } = installedHome(["0.1.0", "0.2.0"]);
    const restore = cutRemovals(h, "kill");
    const cut = install(h, ["--uninstall"]);
    restore();
    expect(cut.code).not.toBe(0);
    expect(calls(h).filter((c) => c.startsWith("rm cut"))).toHaveLength(1);
    for (const v of ["0.1.0", "0.2.0"]) {
      const r = install(h, [], { KITESPAN_INSTALL_FROM: from, KITESPAN_VERSION: v });
      expect({ v, code: r.code, err: r.err }).toEqual({ v, code: 0, err: "" });
      expect(starts(h)).toBe(`kitespan ${v}\n`);
    }
    expect(versionsOf(h)).toEqual(["0.1.0", "0.2.0"]);
  });

  test("--uninstall stopped by SIGINT half way: exit 130, and the line says that it did not finish", async () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const restore = cutRemovals(h, "sleep");
    const p = Bun.spawn(["/bin/sh", INSTALL, "--uninstall"], { cwd: h.dir, env: h.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    const end = Date.now() + 20_000;
    while (!calls(h).some((c) => c.startsWith("rm cut")) && Date.now() < end) await Bun.sleep(50);
    await Bun.sleep(100);
    expect(p.exitCode).toBeNull();
    if (PROCFS) expect(readFileSync(`/proc/${p.pid}/cmdline`, "utf8").split("\0")).toContain(INSTALL);
    process.kill(-p.pid, "SIGINT");
    const code = await p.exited;
    restore();
    const err = await new Response(p.stderr).text();
    expect(code).toBe(130);
    expect(err.split("\n").filter((l) => l.startsWith("install.sh:"))).toEqual(["install.sh: stopped before --uninstall finished; run it again to remove the rest."]);
    expect(lstatExists(h.link)).toBe(false);
    expect(namesOf(h)).toEqual(["0.1.0"]);
    expect(install(h, ["--uninstall"]).code).toBe(0);
    expect(existsSync(h.kit)).toBe(false);
  }, 30_000);
});

describe("the lock", () => {
  test("held by a live process: refused, and the lock stays its holder's", () => {
    const { h } = installedHome(["0.1.0"]);
    mkdirSync(join(h.versions, ".lock"));
    writeFileSync(join(h.versions, ".lock", "pid"), `${process.pid}\n`);
    const before = snapshot(h.home);
    const r = install(h, [], { KITESPAN_INSTALL_FROM: localRelease(h, "newer", [good("0.2.0")]) });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`install.sh: another install of kitespan runs now (process ${process.pid}, ${h.versions}/.lock). Wait for it to end, then run this again.\n`);
    expect(snapshot(h.home)).toEqual(before);
  });

  test("a stale lock (a gone process, a bad pid file, none) is taken, and goes at the end", () => {
    for (const pid of ["999999999\n", "x\n", null]) {
      const { h } = installedHome(["0.1.0"]);
      mkdirSync(join(h.versions, ".lock"));
      if (pid !== null) writeFileSync(join(h.versions, ".lock", "pid"), pid);
      expect(install(h, [], { KITESPAN_INSTALL_FROM: localRelease(h, "newer", [good("0.2.0")]) }).code).toBe(0);
      expect(versionsOf(h)).toEqual(["0.1.0", "0.2.0"]);
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} in the middle of a step: exit 130, one line, no staging folder, no lock, kitespan as it was`, async () => {
      const { h } = installedHome(["0.1.0"]);
      const from = localRelease(h, "newer", [good("0.2.0")]);
      const before = snapshot(h.home);
      const installs = () => calls(h).filter((c) => c.startsWith("bun install")).length;
      const earlier = installs();
      const p = Bun.spawn(["/bin/sh", INSTALL], {
        cwd: h.dir,
        env: { ...h.env, KITESPAN_INSTALL_FROM: from, FAKE_BUN_INSTALL_SLEEP: "30" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      const end = Date.now() + 20_000;
      while (installs() === earlier && Date.now() < end) await Bun.sleep(50);
      await Bun.sleep(200);
      // The group of the process this test spawned, after a check that it is still that installer.
      expect(p.exitCode).toBeNull();
      if (PROCFS) expect(readFileSync(`/proc/${p.pid}/cmdline`, "utf8").split("\0")).toContain(INSTALL);
      process.kill(-p.pid, signal);
      const code = await p.exited;
      const err = await new Response(p.stderr).text();
      expect(code).toBe(130);
      // bash, as sh, also reports the step's child that the signal ended ("Terminated"); dash does not.
      expect(err.split("\n").filter((l) => l.startsWith("install.sh:"))).toEqual(["install.sh: stopped; kitespan did not change."]);
      expect(err.endsWith("install.sh: stopped; kitespan did not change.\n")).toBe(true);
      expect(snapshot(h.home)).toEqual(before);
    }, 30_000);
  }
});

describe("--list", () => {
  test("none installed", () => {
    const h = makeHome();
    const before = snapshot(h.home);
    const r = install(h, ["--list"]);
    expect({ code: r.code, lines: r.lines }).toEqual({ code: 0, lines: [`No kitespan is installed in ${h.versions}.`] });
    expect(snapshot(h.home)).toEqual(before);
  });

  test("newest first, by the numbers, with current and runs now", () => {
    const { h } = installedHome(["0.9.0", "0.10.0"]);
    const before = snapshot(h.home);
    expect(install(h, ["--list"], { FAKE_PS: serverLine(h, 77, "0.9.0") }).lines).toEqual(["0.10.0  current", "0.9.0  runs now"]);
    expect(install(h, ["--list"], { FAKE_PS: serverLine(h, 77, "0.10.0") }).lines).toEqual(["0.10.0  current, runs now", "0.9.0"]);
    expect(snapshot(h.home)).toEqual(before);
  });
});

describe("--uninstall", () => {
  const lines = (h: Home, kit = h.kit) => [
    `kitespan is uninstalled: ${h.link} and ${h.versions} are removed.`,
    `Your own files stay: chats, drafts, settings and logs in ${h.state}, your config in ${h.config}, and kitespan's records of worktrees in ${kit}. Remove them yourself if you want them gone.`,
  ];

  test("removes the link, current and the versions; the state, the config and the worktree records stay", () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    for (const d of [h.state, h.config, join(h.kit, "worktrees", "p1")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(h.state, "settings.json"), "{}");
    writeFileSync(join(h.config, "adapters.json"), "{}");
    writeFileSync(join(h.kit, "worktrees", "p1", "w.json"), "{}");
    const r = install(h, ["--uninstall"]);
    expect({ code: r.code, err: r.err, lines: r.lines }).toEqual({ code: 0, err: "", lines: lines(h) });
    for (const p of [h.link, h.current, h.versions]) expect(lstatExists(p)).toBe(false);
    for (const f of [join(h.state, "settings.json"), join(h.config, "adapters.json"), join(h.kit, "worktrees", "p1", "w.json")]) expect(existsSync(f)).toBe(true);
  });

  test("an empty kitespan folder goes too", () => {
    const { h } = installedHome(["0.1.0"]);
    expect(install(h, ["--uninstall"]).code).toBe(0);
    expect(existsSync(h.kit)).toBe(false);
    expect(existsSync(h.bindir)).toBe(true);
  });

  test("nothing installed: one line, nothing changed", () => {
    const h = makeHome();
    const before = snapshot(h.home);
    const r = install(h, ["--uninstall"]);
    expect({ code: r.code, lines: r.lines }).toEqual({ code: 0, lines: [`kitespan is not installed in ${h.versions}; nothing to remove.`] });
    expect(snapshot(h.home)).toEqual(before);
  });

  test("a version that runs now: refused, nothing changed", () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const before = snapshot(h.home);
    const r = install(h, ["--uninstall"], { FAKE_PS: serverLine(h, 4242, "0.1.0") });
    expect({ code: r.code, err: r.err, out: r.out }).toEqual({ code: 1, err: "install.sh: kitespan 0.1.0 runs now (process 4242); stop it, then run this again.\n", out: "" });
    expect(snapshot(h.home)).toEqual(before);
  });

  test("when neither ps nor /proc can list the processes: refused, nothing changed", () => {
    const { h } = installedHome(["0.1.0"]);
    const before = snapshot(h.home);
    const r = install(h, ["--uninstall"], { FAKE_PS_FAIL: "1", FAKE_UNAME: "Darwin" });
    expect({ code: r.code, err: r.err, out: r.out }).toEqual({ code: 1, err: "install.sh: ps cannot list the processes here, so install.sh cannot tell whether kitespan runs now; nothing is removed.\n", out: "" });
    expect(snapshot(h.home)).toEqual(before);
  });

  test.skipIf(!PROCFS)("on Linux with no ps, /proc lists the processes: a version that runs now is refused, nothing changed", async () => {
    const { h } = installedHome(["0.1.0", "0.2.0"]);
    const server = pretend(join(h.versions, "0.2.0", "server", "main.ts"));
    try {
      await Bun.sleep(300);
      const before = snapshot(h.home);
      const r = install(h, ["--uninstall"], { FAKE_PS_FAIL: "1" });
      expect({ code: r.code, err: r.err, out: r.out }).toEqual({ code: 1, err: `install.sh: kitespan 0.2.0 runs now (process ${server.pid}); stop it, then run this again.\n`, out: "" });
      expect(snapshot(h.home)).toEqual(before);
    } finally {
      server.kill();
      await server.exited;
    }
    expect(install(h, ["--uninstall"], { FAKE_PS_FAIL: "1" }).code).toBe(0);
    expect(existsSync(h.versions)).toBe(false);
  });

  test("a file of the user's at the link stays, with a line", () => {
    const { h } = installedHome(["0.1.0"]);
    unlinkSync(h.link);
    writeFileSync(h.link, "#!/bin/sh\n");
    const r = install(h, ["--uninstall"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe(`install.sh: ${h.link} is not kitespan's link, so it stays.\n`);
    expect(readFileSync(h.link, "utf8")).toBe("#!/bin/sh\n");
    expect(existsSync(h.versions)).toBe(false);
  });

  test("a link or a file in place of kitespan's folders is refused", () => {
    const { h } = installedHome(["0.1.0"]);
    unlinkSync(h.current);
    mkdirSync(h.current);
    const before = snapshot(h.home);
    const r = install(h, ["--uninstall"]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 1, err: `install.sh: ${h.current} is not kitespan's link, so install.sh does not touch it.\n` });
    expect(snapshot(h.home)).toEqual(before);
  });
});

test("--help and -h: the usage on stdout, exit 0", () => {
  const h = makeHome();
  const before = snapshot(h.home);
  for (const a of ["--help", "-h"]) {
    const r = install(h, [a]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(r.out).toBe(
      [
        "Usage: sh install.sh [--list | --uninstall]",
        `Installs the latest kitespan release into ${h.versions} and makes ${h.link} start it.`,
        "  KITESPAN_VERSION=<x.y.z>      install that release instead of the latest (an older one to go back)",
        "  KITESPAN_INSTALL_FROM=<path>  install from a folder with SHA256SUMS and kitespan-<x.y.z>.tar.gz, or from one such",
        "                                archive, with no download",
        "  --list                        list the installed versions",
        `  --uninstall                   remove ${h.link} and ${h.versions}; your chats, settings and config stay`,
        "",
      ].join("\n"),
    );
  }
  expect(snapshot(h.home)).toEqual(before);
});

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
