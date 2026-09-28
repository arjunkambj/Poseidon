import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The colour tokens live in the shared stylesheet. These tests pin the colour
// roles: a quiet purple-tinted neutral ladder, one calm purple accent for
// primary actions and focus, and readable text on every surface.
const css = readFileSync(
  new URL("../../../../packages/ui/src/styles/globals.css", import.meta.url),
  "utf8",
);

function tokenBlock(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

const themes = { light: tokenBlock(":root"), dark: tokenBlock(".dark") };

interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha: boolean;
}

function oklch(value: string): Oklch {
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)( \/ [\d.]+%?)?\)$/.exec(value);
  if (!match) throw new Error(`not an oklch value: ${value}`);
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
    alpha: match[4] !== undefined,
  };
}

// OKLCH -> OKLab -> linear sRGB (Ottosson's matrices), clamped to the gamut,
// then WCAG relative luminance.
function luminance(value: string): number {
  const { l, c, h } = oklch(value);
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const r = clamp(4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1);
  const g = clamp(-1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1);
  const bl = clamp(-0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(one: string, two: string): number {
  const [hi, lo] = [luminance(one), luminance(two)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function token(theme: Map<string, string>, name: string): string {
  const value = theme.get(name);
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

const neutralLadder = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "sidebar",
  "sidebar-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "hover",
  "header",
  "strong",
];

const readablePairs: ReadonlyArray<readonly [string, string]> = [
  ["primary", "primary-foreground"],
  ["foreground", "background"],
  ["foreground", "card"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
];

const accentTokens = ["primary", "ring", "sidebar-primary", "sidebar-ring", "chart-1"];

describe("theme tokens", () => {
  it("defines the same colour tokens in light and dark", () => {
    // --radius is shared, so only the light block declares it.
    const colours = (theme: Map<string, string>) =>
      [...theme.keys()].filter((name) => name !== "radius").sort();
    expect(colours(themes.dark)).toEqual(colours(themes.light));
  });

  for (const [name, theme] of Object.entries(themes)) {
    describe(name, () => {
      it.each(readablePairs)("%s on %s meets WCAG AA", (fg, bg) => {
        expect(contrast(token(theme, fg), token(theme, bg))).toBeGreaterThanOrEqual(4.5);
      });

      it.each(neutralLadder)("--%s is a purple-tinted neutral", (tokenName) => {
        const value = oklch(token(theme, tokenName));
        if (value.alpha) return;
        expect(value.c).toBeLessThanOrEqual(0.02);
        if (value.c > 0.002) {
          expect(value.h).toBeGreaterThanOrEqual(285);
          expect(value.h).toBeLessThanOrEqual(305);
        }
      });

      it("keeps the hover surfaces neutral and the accent purple", () => {
        expect(oklch(token(theme, "accent")).c).toBeLessThanOrEqual(0.02);
        expect(oklch(token(theme, "sidebar-accent")).c).toBeLessThanOrEqual(0.02);
        const primary = oklch(token(theme, "primary"));
        expect(primary.c).toBeGreaterThanOrEqual(0.08);
        expect(primary.h).toBeGreaterThanOrEqual(285);
        expect(primary.h).toBeLessThanOrEqual(305);
        for (const name of accentTokens) expect(token(theme, name)).toBe(token(theme, "primary"));
      });
    });
  }

  it("steps the dark surfaces from sidebar up to the raised ones", () => {
    const l = (name: string) => oklch(token(themes.dark, name)).l;
    expect(l("sidebar")).toBeLessThan(l("background"));
    expect(l("background")).toBeLessThan(l("card"));
    expect(l("card")).toBeLessThan(l("popover"));
    expect(l("popover")).toBeLessThan(l("muted"));
    expect(l("accent")).toBe(l("muted"));
  });
});
