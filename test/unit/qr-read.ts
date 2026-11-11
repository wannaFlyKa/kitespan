// A QR code reader for the tests only (DESIGN-T1 3.4, T-14), written from ISO/IEC 18004's reading order and independent
// of the vendored encoder (web/ui/qrcodegen.ts): it imports nothing of it. It reads a clean module grid (no camera, no
// error correction) of versions 1 to 10 and byte mode, and throws at the first thing that does not hold: the finder,
// timing and alignment patterns, both copies of the format information and their BCH check, the version information
// from version 7, the count of data modules, each block's Reed-Solomon syndromes, the byte segment, its terminator and
// the pad codewords.

export type EccLevel = "L" | "M" | "Q" | "H";

/** The 2-bit level indicator of the format information (ISO/IEC 18004 table 12). */
const LEVEL_BITS: Record<EccLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/** Codewords of each version (table 1), and per level the error correction codewords of a block and the blocks (table 9). */
const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const BLOCKS: Record<EccLevel, readonly (readonly [ecc: number, blocks: number])[]> = {
  L: [[0, 0], [7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4]],
  M: [[0, 0], [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]],
  Q: [[0, 0], [13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8]],
  H: [[0, 0], [17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8]],
};
/** The data codewords of each version and level (table 7), against which the two tables above are checked. */
export const DATA_CODEWORDS: Record<EccLevel, readonly number[]> = {
  L: [0, 19, 34, 55, 80, 108, 136, 156, 194, 232, 274],
  M: [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216],
  Q: [0, 13, 22, 34, 48, 62, 76, 88, 110, 132, 154],
  H: [0, 9, 16, 26, 36, 46, 60, 66, 86, 100, 122],
};
/** The row and column centres of the alignment patterns (annex E). */
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** The format information of a level and a mask: BCH(15,5) with the generator 10100110111, then XOR 101010000010010. */
export function formatBits(level: EccLevel, mask: number): number {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let r = data << 10;
  for (let i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0b10100110111 << (i - 10);
  return ((data << 10) | r) ^ 0b101010000010010;
}

/** The version information of versions 7 and up: BCH(18,6) with the generator 1111100100101. */
export function versionBits(version: number): number {
  let r = version << 12;
  for (let i = 17; i >= 12; i--) if ((r >> i) & 1) r ^= 0b1111100100101 << (i - 12);
  return (version << 12) | r;
}

// GF(256) with the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
const gfPow = (e: number) => EXP[e % 255]!;

/** Each mask's condition for a module in row i and column j: true where the module is inverted (table 10). */
const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function fail(what: string): never {
  throw new Error(`qr-read: ${what}`);
}

/** The modules that are no data (finders and separators, timing, alignment, format and version areas), by row. */
export function functionModules(version: number): boolean[][] {
  const size = 17 + 4 * version;
  const f = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y]![x] = true;
  };
  box(0, 0, 9, 9); // the top-left finder, its separator and both format strips
  box(size - 8, 0, 8, 9);
  box(0, size - 8, 9, 8);
  box(6, 0, 1, size);
  box(0, 6, size, 1);
  const centres = ALIGN[version]!;
  const last = centres.length - 1;
  centres.forEach((cy, a) =>
    centres.forEach((cx, b) => {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) return;
      box(cx - 2, cy - 2, 5, 5);
    }),
  );
  if (version >= 7) {
    box(size - 11, 0, 3, 6);
    box(0, size - 11, 6, 3);
  }
  return f;
}

function checkPatterns(grid: readonly (readonly boolean[])[], version: number): void {
  const size = grid.length;
  const at = (x: number, y: number) => grid[y]![x]!;
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
    for (let dy = -1; dy <= 7; dy++)
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        if (at(x, y) !== (ring === 0 || ring === 1 || ring === 3)) fail(`finder at ${ox},${oy}`);
      }
  }
  for (let i = 8; i < size - 8; i++) if (at(i, 6) !== (i % 2 === 0) || at(6, i) !== (i % 2 === 0)) fail("timing");
  const centres = ALIGN[version]!;
  const last = centres.length - 1;
  centres.forEach((cy, a) =>
    centres.forEach((cx, b) => {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (at(cx + dx, cy + dy) !== (Math.max(Math.abs(dx), Math.abs(dy)) !== 1)) fail("alignment");
    }),
  );
  if (!at(8, size - 8)) fail("the dark module");
}

function readFormat(grid: readonly (readonly boolean[])[]): { level: EccLevel; mask: number } {
  const size = grid.length;
  const bit = (x: number, y: number) => (grid[y]![x] ? 1 : 0);
  let a = 0;
  let b = 0;
  for (let i = 0; i <= 5; i++) a |= bit(8, i) << i;
  a |= bit(8, 7) << 6;
  a |= bit(8, 8) << 7;
  a |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) a |= bit(14 - i, 8) << i;
  for (let i = 0; i < 8; i++) b |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) b |= bit(8, size - 15 + i) << i;
  if (a !== b) fail("the two format copies differ");
  for (const level of ["L", "M", "Q", "H"] as const) for (let mask = 0; mask < 8; mask++) if (formatBits(level, mask) === a) return { level, mask };
  return fail("format bits");
}

function checkVersionInfo(grid: readonly (readonly boolean[])[], version: number): void {
  const size = grid.length;
  let a = 0;
  let b = 0;
  for (let i = 0; i < 18; i++) {
    const p = size - 11 + (i % 3);
    const q = Math.floor(i / 3);
    if (grid[q]![p]) a |= 1 << i;
    if (grid[p]![q]) b |= 1 << i;
  }
  if (a !== b || a !== versionBits(version)) fail("version information");
}

/** The codewords in the standard's placement order: two-module columns from the right, up then down, column 6 skipped. */
function readCodewords(grid: readonly (readonly boolean[])[], version: number, mask: number): number[] {
  const size = grid.length;
  const fn = functionModules(version);
  const inverted = MASKS[mask]!;
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let n = 0; n < size; n++) {
      const y = upward ? size - 1 - n : n;
      for (const x of [right, right - 1]) if (!fn[y]![x]) bits.push((grid[y]![x] ? 1 : 0) ^ (inverted(y, x) ? 1 : 0));
    }
    upward = !upward;
  }
  const total = TOTAL[version]!;
  if (Math.floor(bits.length / 8) !== total) fail(`${bits.length} data modules for ${total} codewords`);
  const out: number[] = [];
  for (let i = 0; i < total; i++) out.push(bits.slice(8 * i, 8 * i + 8).reduce((v, x) => (v << 1) | x, 0));
  return out;
}

/** The data codewords: the blocks taken apart (short blocks first), each block's syndromes checked to be zero. */
function dataOf(codewords: readonly number[], version: number, level: EccLevel): number[] {
  const [ecc, count] = BLOCKS[level][version]!;
  const total = TOTAL[version]!;
  if (total - ecc * count !== DATA_CODEWORDS[level][version]) fail("the block table");
  const shortLen = Math.floor(total / count);
  const shorts = count - (total % count);
  const dataLen = Array.from({ length: count }, (_, b) => shortLen - ecc + (b >= shorts ? 1 : 0));
  const blocks = dataLen.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...dataLen); i++) for (let b = 0; b < count; b++) if (i < dataLen[b]!) blocks[b]!.push(codewords[k++]!);
  for (let i = 0; i < ecc; i++) for (let b = 0; b < count; b++) blocks[b]!.push(codewords[k++]!);
  if (k !== total) fail("codeword count");
  blocks.forEach((block, b) => {
    const n = block.length;
    for (let j = 0; j < ecc; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s ^= gfMul(block[t]!, gfPow(j * (n - 1 - t)));
      if (s !== 0) fail(`block ${b}: syndrome ${j} is ${s}`);
    }
  });
  return blocks.flatMap((block, b) => block.slice(0, dataLen[b]!));
}

/** One byte segment, then the terminator, the zero bits to a byte and the pad codewords 11101100 and 00010001 in turn. */
function bytesOf(data: readonly number[], version: number): Uint8Array {
  const bits = data.flatMap((c) => Array.from({ length: 8 }, (_, i) => (c >> (7 - i)) & 1));
  let at = 0;
  const take = (n: number) => {
    if (at + n > bits.length) fail("the data ends early");
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bits[at++]!;
    return v;
  };
  if (take(4) !== 0b0100) fail("not a byte segment");
  const n = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = take(8);
  const term = Math.min(4, bits.length - at);
  if (take(term) !== 0) fail("terminator");
  if (at % 8 && take(8 - (at % 8)) !== 0) fail("the bits to a byte");
  for (let p = 0; at < bits.length; p++) if (take(8) !== (p % 2 === 0 ? 0xec : 0x11)) fail("pad codeword");
  return out;
}

/** Read a module grid (rows of true for a dark module, no quiet zone) back to its text, or throw. */
export function readQr(grid: readonly (readonly boolean[])[]): { version: number; level: EccLevel; mask: number; text: string } {
  const size = grid.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10 || grid.some((r) => r.length !== size)) fail(`a grid of ${size}`);
  checkPatterns(grid, version);
  const { level, mask } = readFormat(grid);
  if (version >= 7) checkVersionInfo(grid, version);
  const bytes = bytesOf(dataOf(readCodewords(grid, version, mask), version, level), version);
  return { version, level, mask, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}
