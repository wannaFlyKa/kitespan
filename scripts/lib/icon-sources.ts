// The record of what each kept home-screen icon was made from (web/icons/sources.json): for each PNG of
// shared/home-screen.ts APP_ICONS, its SVG source and the SHA-256 of that SVG and of the PNG as scripts/make-icons.ts
// wrote them. make-icons writes it beside the PNGs; the unit test (test/unit/home-screen.test.ts) reads it with no
// browser, so an SVG changed without a new render, or a PNG put in by hand, fails bun test.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ICONS } from "../../shared/home-screen";

export const SOURCES_FILE = "sources.json";

export interface IconSource {
  /** The SVG it is drawn from, in the same folder. */
  source: string;
  /** SHA-256 (hex) of that SVG when the PNG was made. */
  svg: string;
  /** SHA-256 (hex) of the PNG that was made. */
  png: string;
}
export type IconSources = Record<string, IconSource>;

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The record for the icons as they are in `dir` now (each PNG with its SVG source). */
export function iconSources(dir: string): IconSources {
  const out: IconSources = {};
  for (const i of APP_ICONS) out[i.file] = { source: i.source, svg: sha256(readFileSync(join(dir, i.source))), png: sha256(readFileSync(join(dir, i.file))) };
  return out;
}

/** The record as make-icons writes it: two-space JSON with a final newline, so a check compares the bytes. */
export const sourcesText = (record: IconSources) => `${JSON.stringify(record, null, 2)}\n`;

/** What in `dir` is not as its record says, one line each; [] when every PNG was made from its SVG as it is now. */
export function staleIcons(dir: string): string[] {
  let record: IconSources;
  try {
    record = JSON.parse(readFileSync(join(dir, SOURCES_FILE), "utf8")) as IconSources;
  } catch {
    return [`no ${SOURCES_FILE}`];
  }
  const now = iconSources(dir);
  const out: string[] = [];
  for (const i of APP_ICONS) {
    const was = record[i.file];
    const is = now[i.file]!;
    if (!was || was.source !== i.source) out.push(`${i.file}: not recorded from ${i.source}`);
    else if (was.svg !== is.svg) out.push(`${i.file}: ${i.source} changed after it was made`);
    else if (was.png !== is.png) out.push(`${i.file}: not the PNG that was made`);
  }
  return out;
}
