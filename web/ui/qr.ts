// Open on phone's code (DESIGN-T1 2.5, T-14): a QR code of a link, from the vendored encoder (qrcodegen.ts, MIT; NOTICE),
// in byte mode at error correction M and at most version 10 (213 bytes; a chat's link on an https origin is about 60 to
// 100, a link form's filled template about 150). Pure: the module grid and one SVG path, which the tile draws black on
// white with a quiet zone of four modules round it. No DOM.
import { qrcodegen } from "./qrcodegen";

/** The largest version the tile draws: past it a module would be under 3 px in the tile. */
export const QR_MAX_VERSION = 10;
/** The light margin round the code, in modules, that a camera needs to find it. */
export const QR_QUIET = 4;
/** The tile's side in CSS pixels (phone.css .oop-tile); the code is drawn at a whole number of pixels a module in it. */
export const QR_TILE_PX = 216;

export interface QrCode {
  version: number;
  /** Modules on a side, without the quiet zone. */
  size: number;
  /** Rows of modules, true for a dark one. */
  modules: boolean[][];
  /** The view box's side: the size and the quiet zone on both sides. */
  side: number;
  /** One path of the dark modules, a rectangle per run in a row, in the view box's units (a module is 1). */
  path: string;
}

/** The pixels a module takes in the tile: a whole number, so every module edge falls on a pixel. */
export function modulePx(size: number): number {
  return Math.floor(QR_TILE_PX / (size + 2 * QR_QUIET));
}

/** The code of `text` (its UTF-8 bytes), or null when it needs more than version 10. */
export function qrPath(text: string): QrCode | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  let code: qrcodegen.QrCode;
  try {
    code = qrcodegen.QrCode.encodeSegments([qrcodegen.QrSegment.makeBytes(bytes)], qrcodegen.QrCode.Ecc.MEDIUM, 1, QR_MAX_VERSION, -1, false);
  } catch {
    return null;
  }
  const size = code.size;
  const modules = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => code.getModule(x, y)));
  let path = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < size; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < size && row[x + w]) w++;
      path += `M${x + QR_QUIET} ${y + QR_QUIET}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return { version: code.version, size, modules, side: size + 2 * QR_QUIET, path };
}
