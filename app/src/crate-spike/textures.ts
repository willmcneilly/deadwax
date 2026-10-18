// The crate spike's textures, drawn once into plain images (DWX-20). From the
// prototype's grain.ts: anything the browser has to paint per sleeve
// (gradients, noise, blend modes) is repainted as the crate's perspective
// rescales each sleeve, and a finished image only has to be scaled.
//
// The glow's pools are here too, as small images the GPU stretches, so the
// spike can measure them against the prototype's live radial gradients.
//
// Development builds only. Canvas colours are drawing instructions, not the
// UI's colours, so they're written here rather than in theme.css.

const rand = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

function canvas(width: number, height = width) {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  const ctx = el.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas");
  return { el, ctx };
}

/** A tile of transparent specks for the whole-screen grain. */
export function grainTile(size = 256): string {
  const { el, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const r = rand(17);
  for (let i = 0; i < img.data.length; i += 4) {
    const light = r() > 0.5 ? 255 : 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = light;
    img.data[i + 3] = r() * r() * 46;
  }
  ctx.putImageData(img, 0, 0);
  return el.toDataURL("image/png");
}

/**
 * Wear for one sleeve: a warm cast, a sheen, ring wear, scuffed edges and
 * printed grain. The prototype's, unchanged.
 */
export function wearImage(seed: number, size = 768): string {
  const r = rand(seed * 7919 + 1);
  const { el, ctx } = canvas(size);
  const c = size / 2;

  ctx.fillStyle = "rgb(255 236 200 / 0.05)";
  ctx.fillRect(0, 0, size, size);

  const sheen = ctx.createLinearGradient(0, 0, size, size * 0.8);
  sheen.addColorStop(0, "rgb(255 255 255 / 0.1)");
  sheen.addColorStop(0.35, "rgb(255 255 255 / 0)");
  sheen.addColorStop(0.7, "rgb(0 0 0 / 0)");
  sheen.addColorStop(1, "rgb(0 0 0 / 0.2)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);

  const cx = c + (r() - 0.5) * size * 0.05;
  const cy = c + (r() - 0.5) * size * 0.05;
  const strength = 0.05 + r() * 0.12;
  const peaks = [r() * Math.PI * 2, r() * Math.PI * 2];
  for (const [radius, width, scale] of [
    [size * 0.462, size * 0.012, 1],
    [size * 0.17, size * 0.006, 0.5],
  ]) {
    for (let a = 0; a < Math.PI * 2; a += 0.03) {
      const near = Math.max(...peaks.map((p) => Math.cos(a - p))) * 0.5 + 0.5;
      const alpha = strength * scale * (0.25 + near * 0.75) * (0.7 + r() * 0.3);
      ctx.strokeStyle = `rgb(255 255 255 / ${alpha})`;
      ctx.lineWidth = width * (0.7 + r() * 0.6);
      ctx.beginPath();
      ctx.arc(cx, cy, radius + (r() - 0.5) * size * 0.003, a, a + 0.035);
      ctx.stroke();
    }
  }

  const edge = ctx.createRadialGradient(c, c, size * 0.45, c, c, size * 0.72);
  edge.addColorStop(0, "rgb(0 0 0 / 0)");
  edge.addColorStop(1, "rgb(0 0 0 / 0.28)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgb(255 255 255 / 0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);

  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = r();
    if (k > 0.55) continue;
    const light = k > 0.27 ? 255 : 0;
    const a = r() * r() * 40;
    const t = a / 255;
    d[i] = d[i] * (1 - t) + light * t;
    d[i + 1] = d[i + 1] * (1 - t) + light * t;
    d[i + 2] = d[i + 2] * (1 - t) + light * t;
    d[i + 3] = Math.min(255, d[i + 3] + a);
  }
  ctx.putImageData(img, 0, 0);
  return el.toDataURL("image/png");
}

export const WEAR_VARIANTS = 6;

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
 * prototype does: as `data:` URLs (the prototype's, each up to a megabyte of
 * text) or as short `blob:` URLs to the same images.
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
