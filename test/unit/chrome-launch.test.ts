// scripts/lib/chrome.ts: the click-through's Chrome reaches no host but the loopback one (DESIGN.md 8.3 check 35), even
// when the shell has a proxy: Chrome hands its own requests (its push channel's check-in among them) to a proxy, which
// resolves the names itself, so the resolver flag alone does not stop them. Nothing here starts a browser.
import { describe, expect, test } from "bun:test";
import { chromeArgs, chromeEnv } from "../../scripts/lib/chrome";

const PROXY_NAMES = ["http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "NO_PROXY"];

describe("launchChrome's command line and environment", () => {
  test("no proxy and no name but the loopback ones", () => {
    const args = chromeArgs(9341, "/srv/profile", []);
    expect(args).toContain("--no-proxy-server");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE 127.0.0.1,EXCLUDE localhost");
    expect(args).toContain("--remote-debugging-address=127.0.0.1");
    expect(args).toContain("--remote-debugging-port=9341");
    expect(args).toContain("--user-data-dir=/srv/profile");
    expect(args.some((a) => a.startsWith("--proxy-server") || a.startsWith("--proxy-pac-url"))).toBe(false);
    expect(args[args.length - 1]).toBe("about:blank");
  });

  test("a caller's extra flags come before the first page", () => {
    const args = chromeArgs(9341, "/srv/profile", ["--log-net-log=/srv/net.json"]);
    expect(args.indexOf("--log-net-log=/srv/net.json")).toBeGreaterThan(args.indexOf("--no-proxy-server"));
    expect(args[args.length - 1]).toBe("about:blank");
  });

  test("the proxy variables are left out of Chrome's environment, in either case; the rest stays", () => {
    const env: Record<string, string> = { HOME: "/srv/home", PATH: "/usr/bin", LANG: "C.UTF-8", TZ: "UTC" };
    for (const n of PROXY_NAMES) env[n] = "http://127.0.0.1:1";
    const out = chromeEnv(env);
    for (const n of PROXY_NAMES) expect(out[n]).toBeUndefined();
    expect(out).toEqual({ HOME: "/srv/home", PATH: "/usr/bin", LANG: "C.UTF-8", TZ: "UTC" });
    // The caller's own environment is not changed.
    expect(env.https_proxy).toBe("http://127.0.0.1:1");
  });

  test("an unset value is left out", () => {
    expect(chromeEnv({ HOME: "/srv/home", EMPTY: undefined })).toEqual({ HOME: "/srv/home" });
  });
});
