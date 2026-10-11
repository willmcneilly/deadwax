// Pulls an album's key colours out of its artwork, then derives the colours
// for the back of the sleeve and the liner notes, and the now-playing glow.
//
// The printed colours are derived, not lifted: the cover's main colour is
// pushed to a deep dark or a pale light (never a mid-tone), and text colours
// are walked in lightness, keeping their hue, until they reach a contrast
// target. Body text reaches 7:1 (WCAG AAA: this is long reading); the accent
// and secondary text reach 4.5:1.

export type RGB = [number, number, number];

export interface Palette {
  key: RGB[]; // up to 5, most characterful first
  ground: RGB; // the paper: back of the sleeve, inside of the gatefold
  rear: RGB; // the paper's reverse, a shade off
  ink: RGB; // body text, 7:1 on ground
  muted: RGB; // secondary text, 4.5:1
  accent: RGB; // the album's colour, 4.5:1
  dark: boolean;
  deep: RGB; // the room behind the glow
}

export const css = ([r, g, b]: RGB, a = 1) => `rgb(${r | 0} ${g | 0} ${b | 0} / ${a})`;

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const saturation = ([r, g, b]: RGB) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};
const distance = (a: RGB, b: RGB) =>
  Math.hypot((a[0] - b[0]) * 0.3, (a[1] - b[1]) * 0.59, (a[2] - b[2]) * 0.11) * 2;

const PAPER: RGB = [238, 230, 214];
const SOOT: RGB = [20, 17, 14];

export const NEUTRAL: Palette = {
  key: [
    [70, 60, 50],
    [40, 34, 30],
    [90, 78, 64],
  ],
  ground: [30, 26, 22],
  rear: [24, 21, 18],
  ink: PAPER,
  muted: [176, 166, 150],
  accent: [200, 170, 120],
  dark: true,
  deep: [16, 13, 11],
};

const cache = new Map<string, Promise<Palette>>();

export function paletteFor(src: string): Promise<Palette> {
  let p = cache.get(src);
  if (!p) {
    p = extract(src).catch(() => NEUTRAL);
    cache.set(src, p);
  }
  return p;
}

async function extract(src: string): Promise<Palette> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const n = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, n, n);
  const data = ctx.getImageData(0, 0, n, n).data;

  const bins = new Map<number, { sum: RGB; count: number }>();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { sum: [0, 0, 0], count: 0 };
    bin.sum[0] += r;
    bin.sum[1] += g;
    bin.sum[2] += b;
    bin.count++;
    bins.set(key, bin);
  }
  const colours = [...bins.values()]
    .map((b) => ({ rgb: b.sum.map((v) => v / b.count) as RGB, count: b.count }))
    .sort((a, b) => b.count - a.count);

  // Merge near neighbours so one big flat area doesn't fill every slot.
  const merged: { rgb: RGB; count: number }[] = [];
  for (const c of colours) {
    const near = merged.find((m) => distance(m.rgb, c.rgb) < 46);
    if (near) near.count += c.count;
    else merged.push({ ...c });
  }
  merged.sort((a, b) => b.count - a.count);

  const dominant = merged[0].rgb;
  const key = merged
    .slice(0, 12)
    .map((m) => ({ rgb: m.rgb, score: Math.sqrt(m.count) * (0.35 + saturation(m.rgb)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((m) => m.rgb);

  const printed = printColours(
    dominant,
    merged.slice(0, 12).filter((m) => m.count >= n * n * 0.015).map((m) => m.rgb),
  );

  // The glow wants colour, not mud: lift dark keys a little, cap bright ones.
  const glow = key.map((c) => {
    const l = luminance(c);
    if (l < 0.02) return mix(c, dominant, 0.3);
    if (l > 0.55) return mix(c, SOOT, 0.35);
    return c;
  });
  while (glow.length < 3) glow.push(mix(glow[0] ?? dominant, SOOT, 0.4));

  return { key: glow, ...printed, deep: mix(dominant, SOOT, 0.82) };
}

// ---------- OKLCH, for changing lightness without changing the colour ----------

type LCH = [number, number, number];

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklch([R, G, B]: RGB): LCH {
  const r = toLin(R / 255);
  const g = toLin(G / 255);
  const b = toLin(B / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, Bb), Math.atan2(Bb, A)];
}

function rawRgb([L, C, h]: LCH): [number, number, number] {
  const A = C * Math.cos(h);
  const Bb = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * Bb) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * Bb) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * Bb) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// Back to sRGB, giving up chroma (never lightness or hue) to stay in gamut.
function rgb([L, C, h]: LCH): RGB {
  let c = C;
  for (let i = 0; i < 40; i++) {
    const v = rawRgb([L, c, h]);
    if (v.every((x) => x >= -0.0005 && x <= 1.0005)) break;
    c *= 0.9;
  }
  const v = rawRgb([L, c, h]);
  return v.map((x) => Math.round(fromLin(Math.min(1, Math.max(0, x))) * 255)) as RGB;
}

// Walk a colour's lightness away from the paper until it reaches the target.
function reach(colour: LCH, paper: RGB, target: number, dark: boolean): RGB {
  let [L] = colour;
  const step = dark ? 0.01 : -0.01;
  let out = rgb([L, colour[1], colour[2]]);
  while (contrast(out, paper) < target && L >= 0 && L <= 1) {
    L += step;
    out = rgb([L, colour[1], colour[2]]);
  }
  return out;
}

function printColours(dominant: RGB, candidates: RGB[]) {
  const [L, C, h] = oklch(dominant);
  const dark = L < 0.62;
  // Paper: the main colour, taken to a deep dark or a pale light, keeping its
  // hue and some of its colour.
  const ground = rgb(dark ? [Math.min(Math.max(L, 0.17), 0.25), Math.min(C, 0.08), h] : [Math.max(L, 0.93), Math.min(C, 0.045), h]);
  const rear = rgb(dark ? [Math.min(Math.max(L, 0.17), 0.25) - 0.035, Math.min(C, 0.07), h] : [Math.max(L, 0.93) - 0.05, Math.min(C, 0.04), h]);

  // Ink: almost white or almost black, tinted with the paper's hue.
  const ink = reach([dark ? 0.9 : 0.3, 0.015, h], ground, 7, dark);

  // Accent: the most colourful of the cover's main colours, as is if it reads,
  // otherwise moved in lightness only. Grey covers fall back to the ink's hue.
  const colourful = candidates
    .map(oklch)
    .filter((c) => c[1] > 0.06)
    .sort((a, b) => b[1] - a[1])[0];
  const accent = colourful ? reach(colourful, ground, 4.5, dark) : reach([dark ? 0.75 : 0.45, 0.03, h], ground, 4.5, dark);

  // Secondary text: between ink and paper, as quiet as 4.5:1 allows.
  let muted = ink;
  for (let t = 0; t <= 1; t += 0.02) {
    const next = mix(ink, ground, t);
    if (contrast(next, ground) < 4.6) break;
    muted = next;
  }

  return { ground, rear, ink, muted, accent, dark };
}

export const ratio = (a: RGB, b: RGB) => Math.round(contrast(a, b) * 10) / 10;

// The album's colour on some other paper (the magazine style's off-white).
export function accentOn(paper: RGB, palette: Palette): RGB {
  const dark = oklch(paper)[0] < 0.62;
  const colourful = [palette.accent, ...palette.key].map(oklch).sort((a, b) => b[1] - a[1])[0];
  return reach(colourful, paper, 4.5, dark);
}
