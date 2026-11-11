// The guards as pure functions (DESIGN.md 4.8, 4.9 guards 2 and 3, BUILD-BRIEF D52) and the access adapter's file
// and schema checks. The socket refusals against a running server are in gate-upgrade.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessHint, adaptersProblemKey, isExactOrigin, NO_SIGN_IN, PUBLIC_ADAPTERS, PUBLIC_PHONE_NOTE, readAdapters } from "../../server/adapters/adapters";
import { startEnvProblems } from "../../server/adapters/start-env";
import { createGate, mediaType, ownOrigin, readOriginPasses, senderPasses, upgradeOriginPasses } from "../../server/gate/guards";

const PORT = 7943;
const FORWARD = "https://forward.example.com";
const gate = createGate(PORT, [FORWARD]);

const req = (method: string, headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:${PORT}/api/projects`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : "{}" });

describe("the allowlists", () => {
  test("own origin first, then the adapter's; the hosts follow them", () => {
    expect(gate.origins).toEqual([ownOrigin(PORT), `http://localhost:${PORT}`, `http://[::1]:${PORT}`, FORWARD]);
    expect(gate.hosts).toEqual([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, "forward.example.com"]);
  });

  test("only exact origins pass", () => {
    expect(gate.originAllowed(`http://127.0.0.1:${PORT}`)).toBe(true);
    expect(gate.originAllowed(`http://localhost:${PORT}`)).toBe(true);
    expect(gate.originAllowed(`http://[::1]:${PORT}`)).toBe(true);
    expect(gate.originAllowed(FORWARD)).toBe(true);
    for (const o of [
      "https://evil.example",
      `http://localhost:${PORT + 1}`,
      `https://localhost:${PORT}`,
      `http://rebind.localhost:${PORT}`,
      `${FORWARD}.evil.example`,
      `http://127.0.0.1:${PORT + 1}`,
      "null",
      `http://127.0.0.1:${PORT}/`,
      `https://127.0.0.1:${PORT}`,
      "http://forward.example.com",
      "",
    ]) {
      expect(gate.originAllowed(o)).toBe(false);
    }
    expect(gate.originAllowed(null)).toBe(false);
  });

  test("hosts compare case-insensitively and in full", () => {
    expect(gate.hostAllowed(`127.0.0.1:${PORT}`)).toBe(true);
    expect(gate.hostAllowed("FORWARD.example.com")).toBe(true);
    // A forwarder that targets localhost (ssh -L, Cloudflare Tunnel, Tailscale Serve) sends a loopback name with kitespan's own
    // port as the Host; a rebinding page sends its own name, never a loopback one.
    for (const h of [`localhost:${PORT}`, `LOCALHOST:${PORT}`, `[::1]:${PORT}`]) expect(gate.hostAllowed(h)).toBe(true);
    for (const h of [`localhost:${PORT + 1}`, `localhost`, `[::1]`, `rebind.localhost:${PORT}`, `127.0.0.1:${PORT + 1}`, "127.0.0.1", `rebind.example:${PORT}`, "forward.example.com:443", ""]) {
      expect(gate.hostAllowed(h)).toBe(false);
    }
    expect(gate.hostAllowed(null)).toBe(false);
  });

  // The ways in that DESIGN 4.8 names, as each one reaches kitespan: the Host it sends and the Origin the page has.
  test("each public way in passes once its origin is listed: Cloudflare Tunnel, Tailscale Serve, ssh -L", () => {
    const pass = (g: ReturnType<typeof createGate>, host: string, origin: string) => [g.hostAllowed(host), g.originAllowed(origin)];
    // Cloudflare Tunnel: the public hostname as the Host, or the target's when cloudflared rewrites it (httpHostHeader).
    const cf = createGate(PORT, ["https://kitespan.example.com"]);
    expect(pass(cf, "kitespan.example.com", "https://kitespan.example.com")).toEqual([true, true]);
    expect(pass(cf, `localhost:${PORT}`, "https://kitespan.example.com")).toEqual([true, true]);
    // Tailscale Serve: the machine's tailnet name as the Host, or the backend's.
    const ts = createGate(PORT, ["https://box.tail1234.ts.net"]);
    expect(pass(ts, "box.tail1234.ts.net", "https://box.tail1234.ts.net")).toEqual([true, true]);
    expect(pass(ts, `127.0.0.1:${PORT}`, "https://box.tail1234.ts.net")).toEqual([true, true]);
    // ssh -L on the same port: the browser opens localhost; nothing needs listing.
    const plain = createGate(PORT);
    expect(pass(plain, `localhost:${PORT}`, `http://localhost:${PORT}`)).toEqual([true, true]);
    expect(pass(plain, `127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`)).toEqual([true, true]);
    // ssh -L on another local port: refused until that origin is listed.
    expect(pass(plain, "localhost:8080", "http://localhost:8080")).toEqual([false, false]);
    expect(pass(createGate(PORT, ["http://localhost:8080"]), "localhost:8080", "http://localhost:8080")).toEqual([true, true]);
    // An unlisted public name is refused, whatever it resolves to.
    expect(pass(cf, "other.example.com", "https://other.example.com")).toEqual([false, false]);
  });

  test("an adapter origin on another port keeps its port in the host", () => {
    expect(createGate(PORT, ["https://forward.example.com:8443"]).hosts).toContain("forward.example.com:8443");
    expect(createGate(PORT, [`http://localhost:${PORT}`]).hosts).toContain(`localhost:${PORT}`);
  });
});

describe("guard 2: the upgrade needs an allowed Origin", () => {
  test("missing and null are refused", () => {
    expect(upgradeOriginPasses(req("GET", {}), gate)).toBe(false);
    expect(upgradeOriginPasses(req("GET", { origin: "null" }), gate)).toBe(false);
    expect(upgradeOriginPasses(req("GET", { origin: ownOrigin(PORT) }), gate)).toBe(true);
  });
});

describe("D52: a read passes with no Origin or an allowed one", () => {
  test("cases", () => {
    expect(readOriginPasses(req("GET", {}), gate)).toBe(true);
    expect(readOriginPasses(req("GET", { origin: FORWARD }), gate)).toBe(true);
    expect(readOriginPasses(req("GET", { origin: "https://evil.example" }), gate)).toBe(false);
    expect(readOriginPasses(req("GET", { origin: "null" }), gate)).toBe(false);
  });
});

describe("guard 3: the sender gate", () => {
  const good = { "x-kitespan": "1", "content-type": "application/json", origin: ownOrigin(PORT) };

  test("passes with all three", () => {
    for (const m of ["POST", "PUT", "DELETE"]) expect(senderPasses(req(m, good), gate, "json")).toBe(true);
    expect(senderPasses(req("POST", { ...good, "content-type": "application/json; charset=utf-8" }), gate, "json")).toBe(true);
    expect(senderPasses(req("POST", { ...good, origin: FORWARD }), gate, "json")).toBe(true);
  });

  test("each missing or wrong part refuses", () => {
    const cases: Record<string, string>[] = [
      { "content-type": "application/json", origin: ownOrigin(PORT) },
      { ...good, "x-kitespan": "true" },
      { ...good, "x-kitespan": "11" },
      { "x-kitespan": "1", origin: ownOrigin(PORT) },
      { ...good, "content-type": "text/plain" },
      { ...good, "content-type": "application/x-www-form-urlencoded" },
      { ...good, "content-type": "multipart/form-data; boundary=x" },
      { "x-kitespan": "1", "content-type": "application/json" },
      { ...good, origin: "https://evil.example" },
      { ...good, origin: "null" },
    ];
    for (const h of cases) expect(senderPasses(req("POST", h), gate, "json")).toBe(false);
  });

  test("a GET is never a sender", () => {
    expect(senderPasses(req("GET", good), gate, "json")).toBe(false);
  });

  test("an upload takes octet-stream bytes and refuses JSON or a form", () => {
    const up = { ...good, "content-type": "application/octet-stream" };
    expect(senderPasses(req("POST", up), gate, "bytes")).toBe(true);
    expect(senderPasses(req("POST", good), gate, "bytes")).toBe(false);
    expect(senderPasses(req("POST", { ...up, "content-type": "multipart/form-data; boundary=x" }), gate, "bytes")).toBe(false);
    expect(senderPasses(req("POST", { ...up, origin: "https://evil.example" }), gate, "bytes")).toBe(false);
  });

  test("mediaType", () => {
    expect(mediaType(" Application/JSON ; charset=utf-8")).toBe("application/json");
    expect(mediaType(null)).toBe(null);
    expect(mediaType("")).toBe(null);
  });
});

describe("the access adapter (4.8)", () => {
  test("exact origins only", () => {
    for (const o of ["https://forward.example.com", "https://a-b.example.com:8443", "http://127.0.0.1:7943", "http://localhost:7943", "http://[::1]:7943", "https://[::1]"]) {
      expect(isExactOrigin(o)).toBe(true);
    }
    for (const o of [
      "https://forward.example.com/",
      "https://forward.example.com/path",
      "https://*.example.com",
      "https://.example.com",
      "http://forward.example.com",
      "https://user@forward.example.com",
      "https://Forward.example.com",
      "https://forward.example.com:443",
      "ftp://forward.example.com",
      "forward.example.com",
      "null",
      "",
      42,
    ]) {
      expect(isExactOrigin(o)).toBe(false);
    }
  });

  test("the schema names the first bad key", () => {
    expect(adaptersProblemKey({ v: 1 })).toBe(null);
    expect(adaptersProblemKey({ v: 1, access: { origins: [FORWARD], hint: "ssh in first" }, phoneNotes: { lines: ["one"] } })).toBe(null);
    expect(adaptersProblemKey({ v: 2 })).toBe("v");
    expect(adaptersProblemKey({ v: 1, extra: true })).toBe("extra");
    expect(adaptersProblemKey({ v: 1, access: { origins: [FORWARD, "https://*.example.com"] } })).toBe("access.origins[1]");
    expect(adaptersProblemKey({ v: 1, access: { origins: FORWARD } })).toBe("access.origins");
    expect(adaptersProblemKey({ v: 1, access: { hint: "a\u001b[31mb" } })).toBe("access.hint");
    expect(adaptersProblemKey({ v: 1, access: { suffix: ".example.com" } })).toBe("access.suffix");
    expect(adaptersProblemKey({ v: 1, phoneNotes: { lines: ["a\nb"] } })).toBe("phoneNotes.lines[0]");
    expect(adaptersProblemKey([])).toBe("(the top level)");
  });

  const dir = mkdtempSync(join(tmpdir(), "kitespan-gate-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, body: string, mode = 0o600) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, mode);
    return p;
  };

  test("a missing file gives the public defaults with no line", () => {
    expect(readAdapters(join(dir, "none.json"))).toEqual({ origins: [], hint: null, phoneNotes: [PUBLIC_PHONE_NOTE], phoneLink: null, problem: null });
  });

  test("a good file gives its values", () => {
    const a = readAdapters(put("good.json", JSON.stringify({ v: 1, access: { origins: [FORWARD, FORWARD] }, phoneNotes: { lines: ["No notifications."] } })));
    expect(a).toEqual({ origins: [FORWARD], hint: null, phoneNotes: ["No notifications."], phoneLink: null, problem: null });
  });

  test("a bad file falls back to the defaults with one line naming the file and the key, never a value", () => {
    const p = put("bad.json", JSON.stringify({ v: 1, access: { origins: ["https://*.secret-host.example"] } }));
    const a = readAdapters(p);
    expect(a.origins).toEqual([]);
    expect(a.problem).toContain(p);
    expect(a.problem).toContain("access.origins[0]");
    expect(a.problem).not.toContain("secret-host");
    expect(readAdapters(put("notjson.json", "{")).problem).toContain("not JSON");
  });

  test("a file others can write, a link or a folder is refused", () => {
    const body = JSON.stringify({ v: 1, access: { origins: [FORWARD] } });
    expect(readAdapters(put("wide.json", body, 0o666)).origins).toEqual([]);
    expect(readAdapters(put("wide.json", body, 0o666)).problem).toContain("chmod 600");
    expect(readAdapters(put("group.json", body, 0o620)).problem).not.toBe(null);
    expect(readAdapters(put("readable.json", body, 0o644)).problem).toBe(null);
    const target = put("target.json", body);
    symlinkSync(target, join(dir, "link.json"));
    expect(readAdapters(join(dir, "link.json")).problem).toContain("symbolic link");
    mkdirSync(join(dir, "folder.json"));
    expect(readAdapters(join(dir, "folder.json")).problem).toContain("not a regular file");
    expect(readAdapters(target, 123456789).problem).toContain("another user");
  });

  test("the public hint gives the ssh -L way in and the public products only; the owner's hint replaces it", () => {
    const pub = accessHint(PORT, { hint: null, origins: [] }).join("\n");
    expect(pub).toContain(`http://127.0.0.1:${PORT}`);
    expect(pub).toContain(`ssh -L ${PORT}:127.0.0.1:${PORT}`);
    expect(pub).toContain("Other ways in: Tailscale Serve, Cloudflare Tunnel with Access, a reverse proxy.");
    expect(pub).toContain("403 unless --origin or access.origins in adapters.json allows it.");
    expect(accessHint(PORT, { hint: "Use my forward.", origins: [] })).toEqual([`kitespan listens on http://127.0.0.1:${PORT}`, "Use my forward."]);
    // With the file's origin in force, its line and the disclaimer come first (origin-flag.test.ts has the cases).
    expect(accessHint(PORT, { hint: "Use my forward.", origins: [FORWARD] })).toEqual([
      `kitespan listens on http://127.0.0.1:${PORT}`,
      `Also allowed: ${FORWARD} (adapters.json)`,
      NO_SIGN_IN,
      "Use my forward.",
    ]);
  });
});

describe("the start environment at boot (4.7)", () => {
  test("a clean start has no problem", () => {
    expect(startEnvProblems({ PATH: "/usr/bin", HOME: "/nonexistent" }, ["--no-env-file"])).toEqual([]);
  });

  test("a dirty start names the variables, never their values", () => {
    const lines = startEnvProblems({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "secret-session-value", PATH: "/usr/bin" }, ["--no-env-file"]);
    const text = lines.join("\n");
    expect(text).toContain("CLAUDECODE");
    expect(text).toContain("CLAUDE_CODE_SESSION_ID");
    expect(text).not.toContain("secret-session-value");
    expect(text).toContain("bin/kitespan");
  });

  test("Bun without --no-env-file is refused", () => {
    expect(startEnvProblems({}, []).join("\n")).toContain("--no-env-file");
    expect(startEnvProblems({}, ["--hot", "--no-env-file"])).toEqual([]);
  });
});

describe("the phone adapters (v0.6 touch, T-14 and T-23)", () => {
  const LINK = "https://open.example.test/?u={url}";
  const dir = mkdtempSync(join(tmpdir(), "kitespan-phone-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, body: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(body));
    chmodSync(p, 0o600);
    return p;
  };

  test("the public default has one phone note, for a phone's own browser, and names no browser; no link form", () => {
    expect(PUBLIC_ADAPTERS.phoneNotes).toEqual([PUBLIC_PHONE_NOTE]);
    expect(PUBLIC_PHONE_NOTE).toBe("In your phone's browser, Add to Home Screen gives kitespan a window of its own and notifications.");
    expect(PUBLIC_ADAPTERS.phoneLink).toBeNull();
  });

  test("access.phoneLink: a template of at most 300 characters with exactly one {url}", () => {
    expect(adaptersProblemKey({ v: 1, access: { phoneLink: LINK } })).toBe(null);
    expect(adaptersProblemKey({ v: 1, access: { origins: [FORWARD], phoneLink: "opener://open?target={url}&new=1" } })).toBe(null);
    const long = `https://open.example.test/?u={url}&pad=${"p".repeat(300)}`;
    for (const bad of [
      "https://open.example.test/",
      "https://open.example.test/?a={url}&b={url}",
      "https://open.example.test/?u={URL}",
      long.slice(0, 301),
      "https://open.example.test/?u={url}\n",
      "https://open.example.test/\u0000?u={url}",
      "https://open.example.test/?u={url}\u202e",
      "",
      42,
      null,
      ["https://open.example.test/?u={url}"],
    ])
      expect([bad, adaptersProblemKey({ v: 1, access: { phoneLink: bad } })]).toEqual([bad, "access.phoneLink"]);
    expect(LINK.length).toBeLessThanOrEqual(300);
    expect(adaptersProblemKey({ v: 1, access: { phoneLink: `https://o.example.test/?u={url}${"p".repeat(300 - 31)}` } })).toBe(null);
  });

  test("the filled template must be a URL, and never one that runs or reads where it opens", () => {
    for (const bad of ["javascript:{url}", "JavaScript:alert(1)//{url}", " javascript:{url}", "data:text/html,{url}", "file:///tmp/{url}", "vbscript:{url}", "not a link {url}", "{url}", "//open.example.test/?u={url}"])
      expect([bad, adaptersProblemKey({ v: 1, access: { phoneLink: bad } })]).toEqual([bad, "access.phoneLink"]);
  });

  test("a file's link form and notes are read; a bad link form is the file's one line and the defaults apply", () => {
    expect(readAdapters(put("link.json", { v: 1, access: { phoneLink: LINK } }))).toMatchObject({ phoneLink: LINK, phoneNotes: [PUBLIC_PHONE_NOTE], problem: null });
    // The owner's notes replace the public one; an empty list shows none.
    expect(readAdapters(put("notes.json", { v: 1, phoneNotes: { lines: ["No notifications here."] } })).phoneNotes).toEqual(["No notifications here."]);
    expect(readAdapters(put("none.json", { v: 1, phoneNotes: { lines: [] } })).phoneNotes).toEqual([]);
    const p = put("bad-link.json", { v: 1, access: { origins: [FORWARD], phoneLink: "javascript:secret-scheme({url})" } });
    const a = readAdapters(p);
    expect(a).toMatchObject({ origins: [], phoneLink: null, phoneNotes: [PUBLIC_PHONE_NOTE] });
    expect(a.problem).toBe(`${p}: access.phoneLink is not valid, so kitespan uses its defaults.`);
    expect(a.problem).not.toContain("secret-scheme");
  });
});
