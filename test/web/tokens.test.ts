// The looks (prototype design plan v3): tokens.css defines four looks, each in light and dark, as token sets. This test
// reads tokens.css itself and checks that every look defines every token, that the System theme's dark copies match
// the dark blocks, that the text colours meet WCAG AA on their grounds, and that the shared styles (base.css and
// layout.css) use only tokens: no literal colour, radius, font or shadow.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STYLES = join(import.meta.dir, "..", "..", "web", "styles");
const read = (name: string) => readFileSync(join(STYLES, name), "utf8");
const LOOKS = ["glass", "paper", "mono", "editor"] as const;

interface Block {
  selector: string;
  media: string | null;
  props: Map<string, string>;
}

/** The rule blocks of a style sheet, with the media query they sit in (one level of @media, as tokens.css uses). */
function blocks(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  const walk = (text: string, media: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head.slice(6).trim());
      else {
        const props = new Map<string, string>();
        for (const decl of body.split(";")) {
          const at = decl.indexOf(":");
          if (at < 0) continue;
          props.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
        }
        out.push({ selector: head.replace(/\s+/g, " "), media, props });
      }
      i = j;
    }
  };
  walk(src, null);
  return out;
}

const TOKENS = blocks(read("tokens.css"));
const DARK_MEDIA = "(prefers-color-scheme: dark)";
const sel = (b: Block) => b.selector.split(",").map((s) => s.trim());

function lightBlock(look: string): Block {
  const b = TOKENS.find((x) => !x.media && sel(x).includes(`[data-look="${look}"]`));
  if (!b) throw new Error(`no light block for ${look}`);
  return b;
}
function darkBlock(look: string): Block {
  const b = TOKENS.find((x) => !x.media && sel(x).includes(`[data-look="${look}"][data-theme="dark"]`));
  if (!b) throw new Error(`no dark block for ${look}`);
  return b;
}
function systemDarkBlock(look: string): Block {
  const b = TOKENS.find((x) => x.media === DARK_MEDIA && sel(x).includes(`[data-look="${look}"]:not([data-theme="light"])`));
  if (!b) throw new Error(`no System dark block for ${look}`);
  return b;
}
/** A look's tokens in a theme: the light block, with the dark block over it for dark. */
function palette(look: string, theme: "light" | "dark"): Map<string, string> {
  const m = new Map(lightBlock(look).props);
  if (theme === "dark") for (const [k, v] of darkBlock(look).props) m.set(k, v);
  return m;
}

// ---- colour maths (WCAG 2 relative luminance)
function hex(value: string | undefined): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value ?? "");
  if (!m) throw new Error(`not a #rrggbb colour: ${value}`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as [number, number, number];
}
const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (v: string | undefined) => {
  const [r, g, b] = hex(v);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
function contrast(a: string | undefined, b: string | undefined): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** A colour token's value as #rrggbb or rgba(): [r, g, b, alpha]. */
function rgba(value: string | undefined): [number, number, number, number] {
  const m = /^rgba?\(([^)]*)\)$/.exec(value ?? "");
  if (!m) return [...hex(value), 1];
  const [r, g, b, a] = m[1]!.split(",").map((s) => Number(s.trim()));
  return [r!, g!, b!, a ?? 1];
}
const asHex = (c: number[]) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** The ground a stack of tokens paints, the first one at the bottom (opaque), each next one blended over it. */
function ground(p: Map<string, string>, layers: string[]): string {
  let c = rgba(p.get(layers[0]!));
  for (const t of layers.slice(1)) {
    const [r, g, b, a] = rgba(p.get(t));
    c = [r * a + c[0] * (1 - a), g * a + c[1] * (1 - a), b * a + c[2] * (1 - a), 1];
  }
  return asHex(c);
}

/**
 * The blocks after the look blocks that set a token for one look (the glass ring of a dot on a highlighted menu row),
 * or for one look and theme (the glass dark unread dot), in that order: a theme's own block is the more specific.
 */
const overrides = (look: string, theme: "light" | "dark") => {
  const extra = (b: Block) => !b.media && b !== lightBlock(look) && b !== darkBlock(look);
  const all = TOKENS.filter((b) => extra(b) && sel(b).includes(`[data-look="${look}"]`));
  return theme === "light" ? all : [...all, ...TOKENS.filter((b) => extra(b) && sel(b).includes(`[data-look="${look}"][data-theme="dark"]`))];
};
/** A token as an element of the look resolves it: the alias block, the look's blocks, then its overrides; var() followed. */
function resolved(look: string, theme: "light" | "dark", token: string): string | undefined {
  const alias = TOKENS.find((b) => sel(b).includes("[data-look]") && b.props.has("--unread-dot"))!;
  const m = new Map(alias.props);
  for (const [k, v] of palette(look, theme)) m.set(k, v);
  for (const b of overrides(look, theme)) for (const [k, v] of b.props) m.set(k, v);
  let v = m.get(token);
  for (let i = 0; v?.startsWith("var(") && i < 5; i++) v = m.get(v.slice(4, -1));
  return v;
}

// Plan v3 section 2: the tokens every look defines.
const PLAN_COLOUR = [
  "--bg", "--panel", "--elevated", "--hover", "--selected", "--fill", "--fill-strong", "--hairline", "--hairline-strong", "--text", "--dim", "--faint",
  "--accent", "--accent-ink", "--accent-text", "--accent-wash", "--accent-rim", "--ring", "--ok", "--warn", "--danger", "--danger-fill", "--scrim", "--code-bg",
  "--bubble-bg", "--bubble-text", "--composer-bg", "--composer-border", "--composer-shadow", "--shadow-1", "--shadow-2", "--shadow-3", "--material-bg",
];
const PLAN_SHAPE = [
  "--font-ui", "--font-prose", "--font-mono", "--fs-ui", "--fs-prose", "--fs-input", "--fs-meta", "--fs-title", "--fs-large", "--lh-prose",
  "--tracking-large", "--r-row", "--r-btn", "--r-field", "--r-card", "--r-menu", "--r-bubble", "--r-composer", "--r-sheet", "--r-send", "--row-h",
  "--btn-h", "--weight-strong", "--material-filter",
];
// The names an earlier round used; each still resolves (directly in every look, or through the alias block).
const OLD_NAMES = [
  "--ui-font", "--mono-font", "--fw-bold", "--fw-regular", "--track-title", "--track-large", "--fs-caption", "--fs-small", "--fs-touch", "--fs-h1", "--fs-h2",
  "--fs-h3", "--r-chip", "--r-popover", "--r-btn-touch", "--r-capsule", "--r-pill", "--menu-row-h", "--accent-dim", "--ok-fill", "--warn-fill", "--warn-wash",
  "--danger-wash", "--bubble", "--group-bg", "--seg-thumb", "--knob", "--material-sidebar", "--material-bar", "--tile-grey", "--tile-blue", "--tile-green",
  "--tile-orange", "--tile-red", "--tile-purple", "--tile-indigo", "--shadow-thumb", "--shadow-knob", "--text-scale", "--lh-ui", "--measure", "--touch",
  "--header-h", "--sidebar-w", "--panel-w", "--pane-bar-w", "--pane-w", "--t-reveal", "--t-toggle", "--t-sheet", "--t-hue", "--ease", "--ease-spring",
  "--s1", "--s2", "--s3", "--s4", "--s5", "--s6",
];
const SHAPE_PREFIX = /^--(font-|fs-|lh-|tracking-|weight-|r-|row-h$|btn-h$|menu-row-h$|header-h$|material-filter$)/;

const defined = new Set(TOKENS.flatMap((b) => [...b.props.keys()].filter((k) => k.startsWith("--"))));

describe("every look defines every token", () => {
  const glass = lightBlock("glass");
  const glassDark = darkBlock("glass");
  test("the glass blocks also style a page with no data-look (the default)", () => {
    expect(sel(glass)).toContain(":root");
    expect(sel(glassDark)).toContain(':root:not([data-look])[data-theme="dark"]');
    expect(sel(systemDarkBlock("glass"))).toContain(':root:not([data-look]):not([data-theme="light"])');
  });
  test("plan v3's colour, shape and type tokens are in the glass light block", () => {
    for (const t of [...PLAN_COLOUR, ...PLAN_SHAPE]) expect([t, glass.props.has(t)]).toEqual([t, true]);
  });
  test("the older names still resolve", () => {
    for (const t of OLD_NAMES) expect([t, defined.has(t)]).toEqual([t, true]);
  });
  for (const look of LOOKS)
    test(`${look}: the light block has glass's tokens, the dark block every colour, and the System copy matches it`, () => {
      expect([...lightBlock(look).props.keys()].sort()).toEqual([...glass.props.keys()].sort());
      const dark = darkBlock(look);
      expect([...dark.props.keys()].sort()).toEqual([...glassDark.props.keys()].sort());
      // The dark block redefines every colour of the light block; only shape and type tokens stay shared.
      for (const k of glass.props.keys()) if (!dark.props.has(k)) expect([k, SHAPE_PREFIX.test(k)]).toEqual([k, true]);
      expect(dark.props.get("color-scheme")).toBe("dark");
      expect(lightBlock(look).props.get("color-scheme")).toBe("light");
      expect(Object.fromEntries(systemDarkBlock(look).props)).toEqual(Object.fromEntries(dark.props));
    });
  test("no style sheet names a look by a product's name (row 105)", () => {
    const old: string[] = [];
    for (const name of readdirSync(STYLES).filter((n) => n.endsWith(".css")))
      for (const b of blocks(read(name))) if (/\[data-look="(?:apple|claude)"\]/.test(b.selector)) old.push(`${name}: ${b.selector}`);
    expect(old).toEqual([]);
    for (const look of LOOKS) expect(TOKENS.some((b) => sel(b).some((s) => s.includes(`[data-look="${look}"]`)))).toBe(true);
  });
  test("touch and the phone also resize a nested look", () => {
    const touch = TOKENS.find((b) => sel(b).includes("body.touch [data-look]"));
    const phone = TOKENS.find((b) => sel(b).includes('body[data-size="phone"] [data-look]'));
    expect(touch?.props.get("--row-h")).toBe("var(--touch)");
    expect(phone?.props.get("--fs-prose")).toBe("var(--fs-prose-phone)");
  });
});

/** The ratios the header comment of tokens.css lists, for one look and theme. */
function ratios(look: string, theme: "light" | "dark") {
  const p = palette(look, theme);
  const bg = p.get("--bg");
  return {
    text: contrast(p.get("--text"), bg),
    dim: contrast(p.get("--dim"), bg),
    dimPanel: contrast(p.get("--dim"), p.get("--panel")),
    accentText: contrast(p.get("--accent-text"), bg),
    ok: contrast(p.get("--ok"), bg),
    warn: contrast(p.get("--warn"), bg),
    danger: contrast(p.get("--danger"), bg),
    ink: contrast(p.get("--accent-ink"), p.get("--accent")),
    ring: contrast(p.get("--ring"), bg),
  };
}

/**
 * The second table of tokens.css (D40, row 116): the state dots, which are not text but must be seen (WCAG 1.4.11,
 * 3:1 on --bg and on --panel, where the sidebar and the chat lists draw them), and --danger on --elevated (error words
 * on cards and sheets, 4.5:1). The needs-you dot is --attn-dot, a warm gold-amber of each look's own; the unread dot
 * is --unread-dot: --accent in every look (the alias block), except glass dark, whose override draws it in --ring, and
 * paper, whose override draws it in its ink.
 */
function fills(look: string, theme: "light" | "dark") {
  const p = palette(look, theme);
  const [bg, panel] = [p.get("--bg"), p.get("--panel")];
  return {
    okBg: contrast(p.get("--ok-fill"), bg),
    okPanel: contrast(p.get("--ok-fill"), panel),
    warnBg: contrast(p.get("--warn-fill"), bg),
    warnPanel: contrast(p.get("--warn-fill"), panel),
    needsBg: contrast(resolved(look, theme, "--attn-dot"), bg),
    needsPanel: contrast(resolved(look, theme, "--attn-dot"), panel),
    unreadBg: contrast(resolved(look, theme, "--unread-dot"), bg),
    unreadPanel: contrast(resolved(look, theme, "--unread-dot"), panel),
    dangerElevated: contrast(p.get("--danger"), p.get("--elevated")),
  };
}

describe("contrast (WCAG AA)", () => {
  for (const look of LOOKS)
    for (const theme of ["light", "dark"] as const)
      test(`${look} ${theme}: the running, reconnecting, needs-you and unread dots 3:1 on --bg and --panel, --danger 4.5:1 on --elevated`, () => {
        const f = fills(look, theme);
        for (const [name, value] of Object.entries(f)) expect([name, value >= (name === "dangerElevated" ? 4.5 : 3)]).toEqual([name, true]);
        // The failed dot and the word Failed that leads a failed chat's row are --danger, also in the sidebar (--panel).
        const p = palette(look, theme);
        expect(contrast(p.get("--danger"), p.get("--panel"))).toBeGreaterThanOrEqual(4.5);
      });
  for (const look of LOOKS)
    for (const theme of ["light", "dark"] as const)
      test(`${look} ${theme}: text 4.5:1 on its grounds, the focus ring 3:1`, () => {
        const r = ratios(look, theme);
        for (const [name, value] of Object.entries(r)) expect([name, value >= (name === "ring" ? 3 : 4.5)]).toEqual([name, true]);
        const p = palette(look, theme);
        // The primary button's hover and pressed fills keep the label readable too, and --dim reads on cards.
        expect(contrast(p.get("--accent-ink"), p.get("--accent-hover"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.get("--accent-ink"), p.get("--accent-dim"))).toBeGreaterThanOrEqual(4.5);
        // A filled danger button (Delete chat) puts the accent ink on --danger-fill.
        expect(contrast(p.get("--accent-ink"), p.get("--danger-fill"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.get("--dim"), p.get("--elevated"))).toBeGreaterThanOrEqual(4.5);
      });
  test("the two tables in the header comment of tokens.css match the values", () => {
    const css = read("tokens.css");
    const head = css.slice(0, css.indexOf("*/")).replace(/ +/g, " ");
    for (const look of LOOKS)
      for (const theme of ["light", "dark"] as const)
        for (const r of [ratios(look, theme), fills(look, theme)]) {
          const row = [look, theme, ...Object.values(r).map((v) => v.toFixed(2))].join(" ");
          expect(head).toContain(row);
        }
  });
});

/**
 * Words and dots on the tinted grounds the areas draw (a translucent token blended over the surface under it): the
 * open chat's row (--selected on the sidebar's --panel, or on --bg in the phone's list and the drawer), a quiet chip
 * or a secondary button (--fill or --btn-bg on a card or the composer), a row a link marks or a ticked choice
 * (--accent-wash), code (--code-bg) and the risky Save and the Bypass mode pill (--warn-wash). Text 4.5:1, dots 3:1.
 */
const TINTED: { use: string; fg: string; grounds: string[][]; min: number }[] = [
  {
    use: "secondary words (--dim): the time and Working on the open row, chips, pills, hints on a marked row, comments in code",
    fg: "--dim",
    grounds: [["--panel", "--selected"], ["--bg", "--selected"], ["--elevated", "--fill"], ["--bg", "--fill"], ["--elevated", "--btn-bg"], ["--composer-bg", "--btn-bg"], ["--elevated", "--accent-wash"], ["--bg", "--accent-wash"], ["--code-bg"]],
    min: 4.5,
  },
  {
    use: "danger words: Failed on the open row and on a marked connector row, tags in code",
    fg: "--danger",
    grounds: [["--panel", "--selected"], ["--bg", "--selected"], ["--elevated", "--accent-wash"], ["--bg", "--accent-wash"], ["--code-bg"]],
    min: 4.5,
  },
  { use: "From the link on a marked row, links in prose (--accent-text)", fg: "--accent-text", grounds: [["--panel", "--selected"], ["--bg", "--selected"], ["--elevated", "--accent-wash"], ["--bg", "--accent-wash"], ["--code-bg"]], min: 4.5 },
  {
    use: "needs you (--attn, row 116): Needs input on a row and on the open row, the count badge's number on its --fill pill, the title bar, code",
    fg: "--attn",
    grounds: [["--panel", "--selected"], ["--bg", "--selected"], ["--bg"], ["--panel"], ["--panel", "--fill"], ["--bg", "--fill"], ["--elevated"], ["--code-bg"]],
    min: 4.5,
  },
  { use: "the waiting card's icon (--attn, an icon) on the card", fg: "--attn", grounds: [["--composer-bg"], ["--elevated"]], min: 3 },
  { use: "the needs-you dot (row 116) on the lists, the open row, a hovered row and the cards", fg: "--attn-dot", grounds: [["--bg"], ["--panel"], ["--panel", "--selected"], ["--bg", "--selected"], ["--panel", "--hover"], ["--elevated"]], min: 3 },
  { use: "--ok words: strings and the diff's add counts in code, Saved, on the sidebar", fg: "--ok", grounds: [["--code-bg"], ["--panel"], ["--elevated"]], min: 4.5 },
  { use: "--warn words: numbers in code, the risky Save and the Bypass mode pill on --warn-wash", fg: "--warn", grounds: [["--code-bg"], ["--composer-bg", "--warn-wash"], ["--elevated", "--warn-wash"], ["--bg", "--warn-wash"]], min: 4.5 },
  { use: "the running dot on the open row", fg: "--ok-fill", grounds: [["--panel", "--selected"], ["--bg", "--selected"]], min: 3 },
  { use: "the failed dot on the open row", fg: "--danger", grounds: [["--panel", "--selected"], ["--bg", "--selected"]], min: 3 },
  { use: "the starting dot on the open row", fg: "--dim", grounds: [["--panel", "--selected"], ["--bg", "--selected"]], min: 3 },
  // Iteration 7 (DESIGN-B1 4.2, F11): the browser pane's frame ring, drawn outside the frame on the stage's own ground;
  // and its "Reconnecting..." pill (--text on --elevated, F18), already a pair above.
  { use: "the browser frame's ring (it holds the keys), on the stage", fg: "--ring", grounds: [["--panel"]], min: 3 },
];

describe("contrast on the tinted grounds (WCAG AA)", () => {
  for (const look of LOOKS)
    for (const theme of ["light", "dark"] as const)
      test(`${look} ${theme}: words 4.5:1 and dots 3:1 on the open row, chips, marked rows, code and the warn wash`, () => {
        const p = palette(look, theme);
        const low: string[] = [];
        for (const t of TINTED)
          for (const g of t.grounds) {
            const r = contrast(p.get(t.fg), ground(p, g));
            if (r < t.min) low.push(`${t.fg} on ${g.join(" over ")}: ${r.toFixed(2)} (${t.use})`);
          }
        // The unread dot, as the element resolves it (glass dark's override included).
        for (const g of [["--panel", "--selected"], ["--bg", "--selected"], ["--panel", "--hover"], ["--elevated"]]) {
          const r = contrast(resolved(look, theme, "--unread-dot"), ground(p, g));
          if (r < 3) low.push(`--unread-dot on ${g.join(" over ")}: ${r.toFixed(2)}`);
        }
        expect(low).toEqual([]);
      });
  test("a highlighted search result (a menu row on --menu-hover-bg over --elevated): its dots 3:1, or the look rings them in --menu-hover-text (row 116)", () => {
    // A result marks Needs input and Failed (MARKED). Where a look's highlight is its solid accent (glass), those dots
    // fall under 3:1 on it, so the look rings them in the row's text colour, 3:1 on the highlight; no other look does.
    const css = blocks(read("base.css"));
    const rule = css.find((b) => sel(b).includes('.menu-row[data-active="true"] .dot'));
    expect(rule && sel(rule)).toEqual([".menu-row:hover .dot", '.menu-row[data-active="true"] .dot', ".menu-row:focus-visible .dot"]);
    expect(rule?.props.get("outline")).toBe("var(--menu-dot-ring)");
    const seen: string[] = [];
    for (const look of LOOKS)
      for (const theme of ["light", "dark"] as const) {
        const p = palette(look, theme);
        const g = ground(p, ["--elevated", "--menu-hover-bg"]);
        const low = ["--attn-dot", "--danger"].filter((t) => contrast(resolved(look, theme, t), g) < 3);
        const ring = resolved(look, theme, "--menu-dot-ring");
        const m = /^1px solid var\((--[a-z-]+)\)$/.exec(ring ?? "");
        const colour = m ? resolved(look, theme, m[1]!) : undefined;
        seen.push(`${look} ${theme}: ${low.length ? `under 3:1 ${low.join(" ")}` : "3:1"}, ring ${m ? `${m[1]} ${contrast(colour, g).toFixed(2)}` : ring}`);
        if (low.length) {
          expect([look, theme, m?.[1]]).toEqual([look, theme, "--menu-hover-text"]);
          expect(contrast(colour, g)).toBeGreaterThanOrEqual(3);
        } else expect([look, theme, ring]).toEqual([look, theme, "none"]);
      }
    expect(seen.filter((l) => l.includes("under 3:1")).map((l) => l.split(":")[0])).toEqual(["glass light", "glass dark"]);
  });
  test("a translucent token is blended over its ground (the ground helper)", () => {
    const p = new Map([["--a", "#ffffff"], ["--b", "rgba(0, 0, 0, 0.5)"]]);
    expect(ground(p, ["--a", "--b"])).toBe("#808080");
    expect(ground(p, ["--a"])).toBe("#ffffff");
  });
});

describe("the shared styles use only tokens", () => {
  for (const file of ["base.css", "layout.css"])
    test(`${file}: no literal colour (so no literal shadow), radius, font or font size`, () => {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
      const bad: string[] = [];
      for (const b of blocks(css))
        for (const [prop, value] of b.props) {
          const v = value.replace(/var\([^)]*\)/g, "");
          if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b/i.test(v)) bad.push(`${b.selector} ${prop}: ${value} (colour)`);
          if (/radius/.test(prop) && /\d/.test(v.replace(/(^|\s)0(?=\s|$)/g, " "))) bad.push(`${b.selector} ${prop}: ${value} (radius)`);
          if (prop === "font-family" || prop === "font") if (!/^var\(--font-|^inherit$/.test(value)) bad.push(`${b.selector} ${prop}: ${value} (font)`);
          if (prop === "font-size" && /\d(px|rem|em)/.test(v) && !/^min\(var\(--fs-[a-z0-9-]+\), \d+px\)$/.test(value)) bad.push(`${b.selector} ${prop}: ${value} (font size)`);
        }
      expect(bad).toEqual([]);
    });
  // Plan v3 section 1: the area style sheets hold no literal colour, radius or font either. A radius worked out from a
  // look's radius token (calc on a --r- token) and a font size in em (relative to the look's --fs- token) follow the
  // look, so they pass; layout widths and 1 px hairline widths are not checked.
  for (const file of ["chat.css", "composer.css", "panels.css", "screens.css", "terminal.css"])
    test(`${file}: no literal colour, radius, font or font size in px or rem`, () => {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
      const bad: string[] = [];
      for (const b of blocks(css))
        for (const [prop, value] of b.props) {
          const v = value.replace(/var\([^)]*\)/g, "");
          if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b/i.test(v)) bad.push(`${b.selector} ${prop}: ${value} (colour)`);
          if (/radius/.test(prop) && !/var\(--r-/.test(value) && /\d/.test(v.replace(/(^|\s)0(?=\s|$)/g, " "))) bad.push(`${b.selector} ${prop}: ${value} (radius)`);
          if (prop === "font-family" || prop === "font") if (!/^var\(--font-|^inherit$/.test(value)) bad.push(`${b.selector} ${prop}: ${value} (font)`);
          if (prop === "font-size" && /\d(px|rem)\b/.test(v) && !/^min\(var\(--fs-[a-z0-9-]+\), \d+px\)$/.test(value)) bad.push(`${b.selector} ${prop}: ${value} (font size)`);
        }
      expect(bad).toEqual([]);
    });
  test("every token base.css and layout.css read is defined", () => {
    const local = new Set(["--seg-count", "--seg-index", "--group-inset", "--sheet-pad-l", "--sheet-pad-r", "--under-bar"]);
    const used = new Set([...(read("base.css") + read("layout.css")).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((t) => !defined.has(t) && !local.has(t))).toEqual([]);
  });
});

/** A #rrggbb colour's hue (degrees) and HSL saturation. */
function hueSat(value: string | undefined): [number, number] {
  const [r, g, b] = hex(value).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return [0, 0];
  const l = (max + min) / 2;
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, sat];
}

describe("colour roles (DESIGN.md 6.13)", () => {
  const ROLES = ["--accent-ui", "--attn", "--attn-dot", "--attn-rim", "--composer-focus-edge", "--composer-focus-shadow"];
  for (const look of LOOKS)
    test(`${look}: text buttons, the needs-you state and the composer's focus each have their token`, () => {
      for (const theme of ["light", "dark"] as const) {
        const p = palette(look, theme);
        for (const t of ROLES) expect([t, p.has(t)]).toEqual([t, true]);
        const mono = look === "mono";
        // mono's chrome has no blue: text buttons are --text, and its composer keeps its hairline.
        expect(p.get("--accent-ui")).toBe(mono ? "var(--text)" : "var(--accent-text)");
        expect(p.get("--composer-focus-edge")).toBe(mono ? "var(--hairline-strong)" : "var(--ring)");
      }
    });
  // Row 116: Claude needs you in a warm colour of its own in every look and theme, never the accent: the dot
  // (--attn-dot), the words Needs input, the badge's number and the waiting card's icon (--attn), and the pulse
  // (--attn-rim, the dot's own colour). A gold-amber: far from each look's accent, --ok-fill, --warn and --danger.
  for (const look of LOOKS)
    test(`${look}: needs you is a warm gold-amber of its own, with its pulse in the dot's colour`, () => {
      for (const theme of ["light", "dark"] as const) {
        const p = palette(look, theme);
        for (const t of ["--attn", "--attn-dot"]) {
          const v = p.get(t);
          expect([look, theme, t, /^#[0-9a-f]{6}$/i.test(v ?? "")]).toEqual([look, theme, t, true]);
          const [h, sat] = hueSat(v);
          expect([look, theme, t, h >= 35 && h <= 55 && sat >= 0.6]).toEqual([look, theme, t, true]);
          for (const other of ["--accent", "--accent-text", "--ring", "--ok-fill", "--warn", "--warn-fill", "--danger"]) expect([look, theme, t, other, v === p.get(other)]).toEqual([look, theme, t, other, false]);
          for (const other of ["--accent", "--ok-fill", "--danger"]) {
            const [ho] = hueSat(p.get(other));
            const apart = Math.min(Math.abs(h - ho), 360 - Math.abs(h - ho));
            // A grey accent (mono, editor) has no hue to be near.
            if (hueSat(p.get(other))[1] > 0.2) expect([look, theme, t, other, apart >= 15]).toEqual([look, theme, t, other, true]);
          }
        }
        const [r, g, b] = hex(p.get("--attn-dot"));
        expect([look, theme, p.get("--attn-rim")]).toEqual([look, theme, expect.stringMatching(new RegExp(`^rgba\\(${r}, ${g}, ${b}, 0\\.\\d+\\)$`))]);
      }
    });
  test("base.css: selection checks in --accent, text buttons in --accent-ui, the needs-you dot and its pulse, the unread dot", () => {
    const css = blocks(read("base.css"));
    const prop = (selector: string, name: string) => css.find((b) => sel(b).includes(selector) && b.props.has(name))?.props.get(name);
    expect([prop(".menu-check", "color"), prop(".group-check", "color")]).toEqual(["var(--accent)", "var(--accent)"]);
    expect([prop(".btn.plain", "color"), prop(".btn.sheet-done", "color")]).toEqual(["var(--accent-ui)", "var(--accent-ui)"]);
    expect(prop(".dot.waiting", "background")).toBe("var(--attn-dot)");
    expect(prop(".dot.waiting", "animation")).toBe("needs-you 2.4s var(--ease) infinite");
    expect(read("base.css")).toContain("0 0 0 5px var(--attn-rim)");
    // Reduce motion (the system's, and Settings' On) stops the pulse; the dot stays a still warm dot.
    expect(css.find((b) => b.media === "(prefers-reduced-motion: reduce)" && sel(b).includes(".dot.waiting"))?.props.get("animation")).toBe("none");
    expect(prop(".dot.unread", "background")).toBe("var(--unread-dot)");
    expect(css.some((b) => sel(b).includes(".dot.unread") && b.props.has("animation"))).toBe(false);
    // The unread dot is the look's accent: the alias block, and one override block (with its System copy) that draws
    // glass dark's in --ring, the system blue, because the --accent that D40 lifted for its white label misses 3:1 on
    // the open chat's --selected row. No look block sets its own, and the needs-you dot is no longer an alias.
    const alias = TOKENS.find((b) => sel(b).includes("[data-look]") && b.props.has("--unread-dot"));
    expect(alias?.props.get("--unread-dot")).toBe("var(--accent)");
    expect(alias?.props.has("--attn-dot")).toBe(false);
    for (const look of LOOKS) expect([look, lightBlock(look).props.has("--unread-dot"), darkBlock(look).props.has("--unread-dot")]).toEqual([look, false, false]);
    for (const look of LOOKS)
      for (const theme of ["light", "dark"] as const) {
        const want = look === "glass" && theme === "dark" ? palette(look, theme).get("--ring") : look === "paper" ? palette(look, theme).get("--text") : palette(look, theme).get("--accent");
        expect([look, theme, resolved(look, theme, "--unread-dot")]).toEqual([look, theme, want]);
      }
    const system = TOKENS.filter((b) => b.media === DARK_MEDIA && b.props.size === 1 && b.props.has("--unread-dot"));
    expect(system.map((b) => [sel(b), b.props.get("--unread-dot")])).toEqual([[[':root:not([data-look]):not([data-theme="light"])', '[data-look="glass"]:not([data-theme="light"])'], "var(--ring)"]]);
    // Paper's in its ink (its clay accent is too near its Failed red): one block for both themes.
    expect(TOKENS.filter((b) => !b.media && sel(b).join() === '[data-look="paper"]' && b.props.size === 1).map((b) => b.props.get("--unread-dot"))).toEqual(["var(--text)"]);
    expect(TOKENS.filter((b) => b.props.has("--unread-dot")).length).toBe(4);
  });
  test("screens.css: the count badge is the needs-you number on a --fill pill (no wash: DESIGN-R116 4.2)", () => {
    const css = blocks(read("screens.css"));
    const badge = css.find((b) => sel(b).includes(".scr-group-needs"));
    expect([badge?.props.get("background"), badge?.props.get("color")]).toEqual(["var(--fill)", "var(--attn)"]);
    const lead = css.find((b) => sel(b).includes(".scr-lead") && b.props.has("color"));
    expect(lead?.props.get("color")).toBe("var(--attn)");
  });
});

describe("the tab icon (index.html)", () => {
  test("is kitespan's own mark in every look: no look's accent, light and dark from the device", () => {
    const html = readFileSync(join(STYLES, "..", "index.html"), "utf8");
    const icons = [...html.matchAll(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!));
    expect(icons.length).toBe(1);
    const svg = icons[0]!.toLowerCase();
    expect(svg).toContain("@media (prefers-color-scheme:dark)");
    for (const look of LOOKS)
      for (const theme of ["light", "dark"] as const) {
        const accent = palette(look, theme).get("--accent")!.toLowerCase();
        // mono and editor's accents are greys; the mark's graphite (#1d1d1f) and light grey (#f5f5f7) are glass's text and ground.
        expect([look, theme, svg.includes(accent)]).toEqual([look, theme, false]);
      }
  });
});
