// Open on phone's code (DESIGN-T1 2.5 and 3.4, T-14): web/ui/qr.ts over the vendored encoder (web/ui/qrcodegen.ts) in
// byte mode at error correction M, versions 1 to 10. The checks: the version for each text length, null past version 10,
// the finder and timing patterns in the grid, the SVG path inside its quiet zone and equal to the grid, and a round trip
// through a reader written here from ISO/IEC 18004 (qr-read.ts, which imports nothing of the encoder). The grids of three
// fixed texts are pinned by their SHA-256, so a change of the encoder or of qr.ts shows.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QR_MAX_VERSION, QR_QUIET, QR_TILE_PX, modulePx, qrPath } from "../../web/ui/qr";
import { DATA_CODEWORDS, formatBits, functionModules, readQr, versionBits } from "./qr-read";

const ROOT = join(import.meta.dir, "..", "..");
const CHAT = "k3m7q2x4abk3m7q2x4ab";
/** A text of exactly `n` UTF-8 bytes that reads as a link. */
const linkOf = (n: number) => {
  const base = `https://phone.example.test/c/${CHAT}/files/`;
  return (base + "src/".repeat(60)).slice(0, n);
};
const grid = (m: readonly (readonly boolean[])[]) => m.map((r) => r.map((d) => (d ? "1" : "0")).join("")).join("\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the reader's own tables and checks (ISO/IEC 18004)", () => {
  test("the format bits of mask 0 at each level are the standard's", () => {
    expect(formatBits("L", 0).toString(2).padStart(15, "0")).toBe("111011111000100");
    expect(formatBits("M", 0).toString(2).padStart(15, "0")).toBe("101010000010010");
    expect(formatBits("Q", 0).toString(2).padStart(15, "0")).toBe("011010101011111");
    expect(formatBits("H", 0).toString(2).padStart(15, "0")).toBe("001011010001001");
    expect(formatBits("M", 5).toString(2).padStart(15, "0")).toBe("100000011001110");
  });
  test("the version information of versions 7 to 10 is the standard's", () => {
    expect([7, 8, 9, 10].map((v) => versionBits(v).toString(16).padStart(5, "0"))).toEqual(["07c94", "085bc", "09a99", "0a4d3"]);
  });
  test("the data modules of each version hold its codewords (and its remainder bits)", () => {
    const remainder = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
    const total = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
    for (let v = 1; v <= 10; v++) {
      const free = functionModules(v).flat().filter((f) => !f).length;
      expect([v, free]).toEqual([v, total[v]! * 8 + remainder[v]!]);
    }
    expect(DATA_CODEWORDS.M[10]).toBe(216);
  });
});

describe("qrPath: byte mode, level M, versions 1 to 10", () => {
  test("the version follows the length: 40, 80, 120 and 213 bytes; one past version 10 is too long", () => {
    for (const [n, v] of [[1, 1], [14, 1], [15, 2], [40, 3], [42, 3], [43, 4], [80, 5], [120, 7], [180, 9], [181, 10], [213, 10]] as const) {
      const q = qrPath(linkOf(n))!;
      expect([n, q.version, q.size]).toEqual([n, v, 17 + 4 * v]);
    }
    expect(QR_MAX_VERSION).toBe(10);
    expect(qrPath(linkOf(214))).toBeNull();
    expect(qrPath("x".repeat(3_000))).toBeNull();
    // Bytes, not characters: 71 two-byte characters are 142 bytes.
    expect(qrPath("é".repeat(71))!.version).toBe(qrPath("e".repeat(142))!.version);
    expect(qrPath("é".repeat(107))).toBeNull();
  });

  test("the grid has the three finder patterns and both timing lines", () => {
    const q = qrPath(linkOf(80))!;
    const m = q.modules;
    const n = q.size;
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const)
      for (let dy = 0; dy < 7; dy++)
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(m[oy + dy]![ox + dx]).toBe(ring !== 2);
        }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
  });

  test("the path draws the grid, inside a quiet zone of four modules in its view box", () => {
    for (const n of [20, 120, 213]) {
      const q = qrPath(linkOf(n))!;
      expect(QR_QUIET).toBe(4);
      expect(q.side).toBe(q.size + 8);
      const drawn = Array.from({ length: q.side }, () => new Array<boolean>(q.side).fill(false));
      const runs = [...q.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
      expect(runs.map((r) => r[0]).join("")).toBe(q.path);
      for (const [, xs, ys, ws, back] of runs) {
        const [x, y, w] = [Number(xs), Number(ys), Number(ws)];
        expect(Number(back)).toBe(w);
        expect(x).toBeGreaterThanOrEqual(QR_QUIET);
        expect(y).toBeGreaterThanOrEqual(QR_QUIET);
        expect(x + w).toBeLessThanOrEqual(q.side - QR_QUIET);
        expect(y + 1).toBeLessThanOrEqual(q.side - QR_QUIET);
        for (let i = 0; i < w; i++) {
          expect(drawn[y]![x + i]).toBe(false);
          drawn[y]![x + i] = true;
        }
      }
      expect(grid(drawn.slice(QR_QUIET, q.side - QR_QUIET).map((r) => r.slice(QR_QUIET, q.side - QR_QUIET)))).toBe(grid(q.modules));
    }
  });

  test("a whole number of pixels a module, in the 216 px tile", () => {
    expect(QR_TILE_PX).toBe(216);
    expect(modulePx(33)).toBe(5); // version 4: 41 modules with the quiet zone, 205 px
    expect(modulePx(21)).toBe(7);
    expect(modulePx(57)).toBe(3);
    for (let v = 1; v <= 10; v++) expect(modulePx(17 + 4 * v) * (25 + 4 * v)).toBeLessThanOrEqual(QR_TILE_PX);
  });

  test("each code reads back to its text with the reader of the standard, at level M", () => {
    const texts = [linkOf(40), linkOf(80), linkOf(120), linkOf(213), `https://phone.example.test/c/${CHAT}/files/docs/café-日本.md?line=42`, "https://open.example.test/?u=https%3A%2F%2Fphone.example.test%2Fc%2Fk3m7q2x4abk3m7q2x4ab%2Fdetails"];
    const versions = new Set<number>();
    for (const text of texts) {
      const q = qrPath(text)!;
      const r = readQr(q.modules);
      expect(r).toMatchObject({ text, level: "M", version: q.version });
      versions.add(r.version);
    }
    expect([...versions].sort((a, b) => a - b)).toEqual([3, 5, 6, 7, 10]);
  });

  test("the reader refuses a grid with one module flipped in its data", () => {
    const q = qrPath(linkOf(80))!;
    const m = q.modules.map((r) => [...r]);
    m[q.size - 1]![q.size - 1] = !m[q.size - 1]![q.size - 1];
    expect(() => readQr(m)).toThrow(/syndrome|pad|segment|terminator/);
    const f = q.modules.map((r) => [...r]);
    f[8]![0] = !f[8]![0];
    expect(() => readQr(f)).toThrow(/format/);
  });

  test("the grids of three fixed texts are pinned", () => {
    const pins: Record<string, string> = {
      [`https://phone.example.test/c/${CHAT}`]: "529d62edcb28d6ef2c872c096b5d322c07559a7ccd095ad2e20ee370fe023a98",
      [`https://phone.example.test/c/${CHAT}/details?view=verbose`]: "0a483bdff1542235767bb303467c3282b66b9c2ae2b30b2feb6567bd39441573",
      [`https://phone.example.test/c/${CHAT}/files/src/upload.ts?line=42`]: "67db7aea6858383e4008d0603fe267afdce534a724865e0e787e54ffc1977bfd",
    };
    const got = Object.fromEntries(Object.keys(pins).map((t) => [t, sha(grid(qrPath(t)!.modules))]));
    expect(got).toEqual(pins);
  });
});

describe("the vendored encoder", () => {
  test("it keeps its MIT licence header, NOTICE names it, and no package was added for it", () => {
    const src = readFileSync(join(ROOT, "web", "ui", "qrcodegen.ts"), "utf8");
    expect(src.startsWith("/* \n * QR Code generator library (TypeScript)\n * \n * Copyright (c) Project Nayuki. (MIT License)\n")).toBe(true);
    expect(src).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy of");
    expect(readFileSync(join(ROOT, "NOTICE"), "utf8")).toContain("web/ui/qrcodegen.ts");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((k) => /qr/i.test(k))).toEqual([]);
  });
});
