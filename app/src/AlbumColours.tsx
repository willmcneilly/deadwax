// An album's colours on the page (RFC-002, "6. `DESIGN.md` starts here").
//
// A sleeve's printed colours and its glow come from each cover, so they're
// data, not design tokens, and can't live in theme.css. Rust works them out
// (the album job queue's palette step), and this is the one component that
// writes them into a `style` prop, as CSS custom properties. Every other
// stylesheet uses only these properties and theme.css. The lint allows a
// colour in a `style` prop in this file and nowhere else (eslint.config.js,
// proved by app/scripts/colourLint.test.ts).

import type { CSSProperties, ReactNode } from "react";
import type { Palette } from "./api";

/** How many of the palette's key colours the glow uses. */
const GLOW_COLOURS = 5;

/**
 * The custom properties for a palette: `--album-ground`, `--album-rear`,
 * `--album-ink`, `--album-muted`, `--album-accent`, `--album-deep`, and the
 * glow's `--album-glow-1` to `--album-glow-5` (the key colours, repeated if
 * there are fewer). None for an album whose palette isn't worked out yet:
 * the CSS falls back to theme.css's `--sleeve-*` colours.
 */
function albumColours(palette: Palette | null): CSSProperties {
  if (palette === null) return {};
  const style: Record<string, string> = {
    "--album-ground": palette.ground,
    "--album-rear": palette.rear,
    "--album-ink": palette.ink,
    "--album-muted": palette.muted,
    "--album-accent": palette.accent,
    "--album-deep": palette.deep,
  };
  if (palette.key.length > 0) {
    for (let i = 0; i < GLOW_COLOURS; i++) {
      style[`--album-glow-${i + 1}`] = palette.key[i % palette.key.length];
    }
  }
  return style as CSSProperties;
}

type Props = {
  palette: Palette | null;
  className?: string;
  /** Any other style, such as which wear a sleeve has. */
  style?: CSSProperties;
  children?: ReactNode;
};

/** A `div` with the album's colours set on it, for everything inside. */
function AlbumColours({ palette, className, style, children }: Props) {
  return (
    <div className={className} style={{ ...style, ...albumColours(palette) }}>
      {children}
    </div>
  );
}

export default AlbumColours;
