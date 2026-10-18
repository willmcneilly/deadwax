// The crate spike's textures, drawn once into plain images (DWX-20). From the
// prototype's grain.ts: anything the browser has to paint per sleeve
// (gradients, noise, blend modes) is repainted as the crate's perspective
// rescales each sleeve, and a finished image only has to be scaled.
//
// The glow's pools are here too, as small images the GPU stretches, so the
// spike can measure them against the prototype's live radial gradients.
//
// The grain and wear are the crate's own (src/textures.ts), drawn the same
// way. Development builds only. Canvas colours are drawing instructions, not the
// UI's colours, so they're written here rather than in theme.css.

import { drawGrain, drawWear, WEAR_VARIANTS } from "../textures";

function canvas(width: number, height = width) {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  const ctx = el.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas");
  return { el, ctx };
}

/** A tile of transparent specks for the whole-screen grain, as a `data:` URL. */
export const grainTile = (size = 256): string => drawGrain(size).toDataURL("image/png");

/** Wear for one sleeve, the crate's own (src/textures.ts), as a `data:` URL. */
export const wearImage = (seed: number, size = 768): string => drawWear(seed, size).toDataURL("image/png");

export { WEAR_VARIANTS };

/**
 * One pool of the glow: the colour fading to nothing at the edge, as the
 * prototype's `radial-gradient(closest-side, colour, transparent)`. It's
 * blurry, so 128 pixels stretched to the whole screen looks the same.
 */
export function poolImage(colour: string, size = 128): string {
  const { el, ctx } = canvas(size);
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, colour);
  g.addColorStop(1, "transparent");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return el.toDataURL("image/png");
}

/** The glow's vignette, darkening the edges, as one stretched image. */
export function vignetteImage(width = 160, height = 100): string {
  const { el, ctx } = canvas(width, height);
  ctx.scale(1, height / width);
  const g = ctx.createRadialGradient(width / 2, width * 0.45, width * 0.18, width / 2, width * 0.45, width * 0.6);
  g.addColorStop(0, "rgb(0 0 0 / 0)");
  g.addColorStop(1, "rgb(0 0 0 / 0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, width);
  return el.toDataURL("image/png");
}

const drawn: { grain?: string; wear?: string[] } = {};
const blobs = new Map<string, string>();

async function asBlob(dataUrl: string): Promise<string> {
  const kept = blobs.get(dataUrl);
  if (kept) return kept;
  const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
  blobs.set(dataUrl, url);
  return url;
}

/**
 * Sets the grain and wear images as CSS variables on the root, as the
 * prototype does: as `data:` URLs (the prototype's, each a whole PNG written
 * out as text) or as short `blob:` URLs to the same images.
 */
export async function installTextures(kind: "data" | "blob"): Promise<void> {
  drawn.grain ??= grainTile();
  drawn.wear ??= Array.from({ length: WEAR_VARIANTS }, (_, i) => wearImage(i + 1));
  const url = (dataUrl: string) => (kind === "data" ? Promise.resolve(dataUrl) : asBlob(dataUrl));
  const root = document.documentElement.style;
  root.setProperty("--spike-grain", `url(${await url(drawn.grain)})`);
  for (const [i, wear] of drawn.wear.entries()) {
    root.setProperty(`--spike-wear-${i}`, `url(${await url(wear)})`);
  }
}

/**
 * Takes the textures off the root and lets their `blob:` URLs go, so the rest
 * of the app doesn't pay for them once the spike has closed.
 */
export function removeTextures(): void {
  const root = document.documentElement.style;
  root.removeProperty("--spike-grain");
  for (let i = 0; i < WEAR_VARIANTS; i++) root.removeProperty(`--spike-wear-${i}`);
  for (const url of blobs.values()) URL.revokeObjectURL(url);
  blobs.clear();
}
