// The home-screen app (owner rows 112 and 113, FIX-U6): what a phone, a tablet or a laptop needs to add kitespan to its
// home screen or install it, and the theme colour of each look. The build (scripts/build-web.ts) writes the manifest
// and copies the icons into the build folder, where the server serves them under /assets/ as the page's own files;
// the page (web/index.html's inline script and web/ui/look.ts) keeps the theme-color metas in step with the look.
// No DOM and no Bun API: the build, the icon script, the page and the tests all read it.

/** The looks' ids, as web/state/types.ts LookId has them. */
export type ThemeLook = "glass" | "paper" | "mono" | "editor";

/**
 * Each look's --bg in light and dark (web/styles/tokens.css): the colour of its title bar, so the status bar (iOS and
 * Android) and an installed app's window bar (desktop Chrome) wear the bar's own colour. A test reads tokens.css.
 */
export const THEME_COLORS: Readonly<Record<ThemeLook, { readonly light: string; readonly dark: string }>> = {
  glass: { light: "#ffffff", dark: "#1c1c1e" },
  paper: { light: "#faf9f5", dark: "#262624" },
  mono: { light: "#ffffff", dark: "#212121" },
  editor: { light: "#ffffff", dark: "#181818" },
};

/** A colour with its opacity: red, green and blue from 0 to 255, alpha from 0 to 1. */
export type Rgba = readonly [number, number, number, number];

/**
 * Each look's --scrim in light and dark (web/styles/tokens.css): the layer under a sheet, a dialog or a drawer, which
 * dims the whole page, its title bar too. A test reads tokens.css.
 */
export const SCRIMS: Readonly<Record<ThemeLook, { readonly light: Rgba; readonly dark: Rgba }>> = {
  glass: { light: [0, 0, 0, 0.25], dark: [0, 0, 0, 0.5] },
  paper: { light: [31, 30, 29, 0.3], dark: [0, 0, 0, 0.5] },
  mono: { light: [0, 0, 0, 0.35], dark: [0, 0, 0, 0.6] },
  editor: { light: [0, 0, 0, 0.3], dark: [0, 0, 0, 0.6] },
};

/** `layers` scrims laid over the opaque colour `hex` (#rrggbb): the colour the page shows there. */
export function underScrim(hex: string, scrim: Rgba, layers = 1): string {
  let rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let n = 0; n < layers; n++) rgb = rgb.map((v, i) => Math.round(scrim[i]! * scrim[3] + v * (1 - scrim[3])));
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The contents of the page's two theme-color metas, the one for a light device and the one for a dark device. With
 * the System theme each holds its own colour, so the device chooses with no script; a chosen theme puts its colour
 * in both. While `scrims` scrims show (a sheet, a dialog, a drawer), each colour is the look's --bg under them, as the
 * page's title bar is then.
 */
export function themeColorMetas(look: ThemeLook, theme: "light" | "dark" | "system", scrims = 0): { light: string; dark: string } {
  const c = THEME_COLORS[look];
  const s = SCRIMS[look];
  const light = scrims > 0 ? underScrim(c.light, s.light, scrims) : c.light;
  const dark = scrims > 0 ? underScrim(c.dark, s.dark, scrims) : c.dark;
  if (theme === "light") return { light, dark: light };
  if (theme === "dark") return { light: dark, dark };
  return { light, dark };
}

/** Where the server serves the build folder's files (server/http/static.ts ASSET_PREFIX). */
const ASSETS = "/assets/";

export interface AppIcon {
  /** Its name in the build folder: a stable name, so the manifest can name it (the server revalidates it). */
  readonly file: string;
  /** Width and height in pixels. */
  readonly size: number;
  /** The SVG it is drawn from (web/icons/): the rounded tile, or the full-bleed tile that a platform masks. */
  readonly source: "mark-any.svg" | "mark-full.svg";
  /** Its purpose in the manifest; null for iOS's apple-touch-icon, which the page's head names instead. */
  readonly purpose: "any" | "maskable" | null;
}

/** The icons, made from the SVG by scripts/make-icons.ts and kept in web/icons/ beside it. */
export const APP_ICONS: readonly AppIcon[] = [
  { file: "icon-192.png", size: 192, source: "mark-any.svg", purpose: "any" },
  { file: "icon-512.png", size: 512, source: "mark-any.svg", purpose: "any" },
  { file: "icon-maskable-512.png", size: 512, source: "mark-full.svg", purpose: "maskable" },
  { file: "apple-touch-icon.png", size: 180, source: "mark-full.svg", purpose: null },
];

/** The maskable icon's safe zone: a centred circle whose radius is this part of the width (web.dev, MDN). */
export const MASKABLE_SAFE_RADIUS = 0.4;

export const MANIFEST_FILE = "manifest.webmanifest";
export const MANIFEST_TYPE = "application/manifest+json";

export interface AppManifest {
  id: string;
  name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: "image/png"; purpose: "any" | "maskable" }[];
}

/**
 * The web app manifest. `name` is the page's title, so a rename changes one place (web/index.html). The colours are
 * the default look's light ones: a manifest cannot follow the device's theme, the page's metas do that once it runs.
 */
export function appManifest(name: string): AppManifest {
  return {
    id: "/",
    name,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: THEME_COLORS.glass.light,
    theme_color: THEME_COLORS.glass.light,
    icons: APP_ICONS.flatMap((i) => (i.purpose ? [{ src: ASSETS + i.file, sizes: `${i.size}x${i.size}`, type: "image/png" as const, purpose: i.purpose }] : [])),
  };
}

/**
 * The two links the build puts in the built page's head: the manifest, and the icon iOS takes over the manifest's. The
 * manifest's link asks for credentials: Chrome fetches a manifest without cookies unless told to, so a sign-in in front
 * of kitespan (a forward's own, or row 114's later) would turn the fetch away and lose the icon and the name.
 */
export function homeScreenLinks(): string {
  const apple = APP_ICONS.find((i) => i.purpose === null)!;
  return `<link rel="manifest" href="${ASSETS}${MANIFEST_FILE}" crossorigin="use-credentials"><link rel="apple-touch-icon" href="${ASSETS}${apple.file}">`;
}
