// Makes the test images for the Rust palette's parity tests (DWX-19), and
// runs the prototype's own palette.ts on each, unchanged, to record what it
// gives. The Rust port must match within 2 units on each RGB channel.
//
// Each image is the 64 × 64 pixels palette.ts reads from its canvas, as raw
// RGB, so both sides start from exactly the same pixels. The canvas is
// replaced with one that hands those pixels over.
//
//   node --experimental-strip-types prototypes/crate/scripts/palette-fixtures.ts
//
// writes crates/deadwax-core/src/palette/fixtures/<name>.rgb and <name>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 64;
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/deadwax-core/src/palette/fixtures",
);

// A small seeded random number generator (mulberry32), so the images are the
// same every run.
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pixel = (x: number, y: number, rand: () => number) => [number, number, number];

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

const images: Record<string, Pixel> = {
  // Near black, with a dim navy shape and grain.
  "very-dark": (x, y, rand) => {
    const inShape = (x - 40) ** 2 + (y - 24) ** 2 < 220;
    const grain = rand() * 10;
    return inShape ? [10 + grain, 14 + grain, 42 + grain] : [6 + grain, 5 + grain, 8 + grain];
  },
  // Off-white paper with a pale pink band and a grey rule.
  "very-light": (x, y, rand) => {
    const grain = rand() * 6;
    if (y > 40 && y < 52) return [244 + grain / 2, 214 + grain, 220 + grain];
    if (x === 12) return [180, 180, 178];
    return [246 + grain / 2, 243 + grain / 2, 236 + grain];
  },
  // Greys only: a diagonal gradient with grain.
  monochrome: (x, y, rand) => {
    const v = 30 + ((x + y) / (2 * N)) * 180 + rand() * 12;
    return [v, v, v];
  },
  // Four blocks of fully saturated colour.
  saturated: (x, y) => {
    if (x < 32 && y < 32) return [255, 0, 0];
    if (x >= 32 && y < 32) return [0, 255, 255];
    if (x < 32) return [255, 230, 0];
    return [200, 0, 255];
  },
  // Something like a cover: an orange sky over a dark blue sea, with a black
  // silhouette.
  mixed: (x, y, rand) => {
    const grain = rand() * 14 - 7;
    if (Math.abs(x - 22) < 4 && y > 18 && y < 50) return [12 + grain, 10 + grain, 12 + grain];
    if (y < 36) {
      const t = y / 36;
      return [250 - 30 * t + grain, 150 - 70 * t + grain, 60 + 20 * t + grain];
    }
    return [20 + grain, 50 + grain, 100 + (y - 36) * 2 + grain];
  },
};

function pixels(pixel: Pixel, seed: number): Uint8ClampedArray {
  const rand = random(seed);
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const [r, g, b] = pixel(x, y, rand);
      const i = (y * N + x) * 4;
      data[i] = clamp(r);
      data[i + 1] = clamp(g);
      data[i + 2] = clamp(b);
      data[i + 3] = 255;
    }
  }
  return data;
}

// palette.ts draws the image on a canvas and reads its pixels back. These
// stand-ins hand over the current test image instead.
let current = new Uint8ClampedArray(N * N * 4);
const g = globalThis as Record<string, unknown>;
g.Image = class {
  src = "";
  decode() {
    return Promise.resolve();
  }
};
g.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
      getImageData: () => ({ data: current }),
    }),
  }),
};

const { paletteFor } = await import("../src/palette.ts");

mkdirSync(out, { recursive: true });
let seed = 1;
for (const [name, pixel] of Object.entries(images)) {
  current = pixels(pixel, seed++);
  const rgb = Buffer.alloc(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    rgb[i * 3] = current[i * 4];
    rgb[i * 3 + 1] = current[i * 4 + 1];
    rgb[i * 3 + 2] = current[i * 4 + 2];
  }
  writeFileSync(join(out, `${name}.rgb`), rgb);
  const palette = await paletteFor(name);
  writeFileSync(join(out, `${name}.json`), JSON.stringify(palette, null, 2) + "\n");
  console.log(name);
}
