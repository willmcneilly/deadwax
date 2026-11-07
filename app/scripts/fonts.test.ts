// The hand is Caveat, bundled with the app (DWX-28): the crate concept's
// handwriting, which the prototype fetched from Google Fonts.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(import.meta.dirname, "../src");
const read = (file: string) => readFileSync(resolve(src, file), "utf8");
const require = createRequire(import.meta.url);

describe("the hand", () => {
  it("puts Caveat first in --font-hand, with Bradley Hand as the fallback", () => {
    const hand = read("theme.css").match(/--font-hand:\s*([^;]+);/)?.[1];
    expect(hand).toBe('"Caveat", "Bradley Hand", "Noteworthy", cursive');
  });

  it("bundles Caveat's two weights from Fontsource, with nothing fetched from the web", () => {
    const fonts = read("fonts.css");
    for (const weight of ["500", "700"]) {
      const file = `@fontsource/caveat/${weight}.css`;
      expect(fonts).toContain(`@import "${file}";`);
      expect(existsSync(require.resolve(file))).toBe(true);
    }
    expect(fonts).not.toMatch(/https?:/);
  });

  it("is imported by the crate and the search wall, which write in it", () => {
    for (const file of ["Crate.tsx", "SearchWall.tsx"]) {
      expect(read(file)).toContain('import "./fonts.css";');
    }
  });
});
