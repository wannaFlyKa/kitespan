// A small PNG reader for the icon tests: the header, and the pixels of an 8-bit, non-interlaced RGB or RGBA image (what
// Chrome's screenshots are), with the five scanline filters undone. Anything else is refused, never guessed.
import { inflateSync } from "node:zlib";

export interface Png {
  width: number;
  height: number;
  /** 2: RGB; 6: RGBA. */
  colorType: number;
  /** The pixel at (x, y) as [r, g, b, a]; a is 255 in an RGB image. */
  at(x: number, y: number): [number, number, number, number];
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function readPng(bytes: Uint8Array): Png {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error("not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = data[8];
      colorType = data[9]!;
      const interlace = data[12];
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) throw new Error(`unsupported PNG: depth ${depth}, colour type ${colorType}, interlace ${interlace}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error(`PNG data is ${raw.length} bytes, not ${height * (stride + 1)}`);
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!;
      const a = i >= channels ? px[row + i - channels]! : 0;
      const b = y > 0 ? px[row - stride + i]! : 0;
      const c = y > 0 && i >= channels ? px[row - stride + i - channels]! : 0;
      const v = filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : filter === 4 ? x + paeth(a, b, c) : NaN;
      if (Number.isNaN(v)) throw new Error(`unknown PNG filter ${filter}`);
      px[row + i] = v & 255;
    }
  }
  return {
    width,
    height,
    colorType,
    at(x, y) {
      const i = y * stride + x * channels;
      return [px[i]!, px[i + 1]!, px[i + 2]!, channels === 4 ? px[i + 3]! : 255];
    },
  };
}
