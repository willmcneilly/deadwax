// The crate's textures: the paper grain over the room and the wear on each
// sleeve, drawn once into plain images (the prototype's grain.ts). Anything
// the browser had to paint per sleeve (gradients, noise, blend modes) would
// be repainted as the crate's perspective rescales it; a finished image only
// has to be scaled.
//
// They go to CSS as short `blob:` URLs in custom properties on the root
// (`--grain`, `--wear-0` to `--wear-5`), never as `data:` URLs: WebKit
// resolves a custom property again on every style change, and a whole PNG
// written out as text cost 30 to 60 ms a flip (DESIGN.md, rule 1).
//
// Canvas colours are drawing instructions, not the UI's colours, so they're
// written here rather than in theme.css.

import type { CSSProperties } from "react";

/** How many different wear images the sleeves share. */
export const WEAR_VARIANTS = 6;

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

/** A tile of transparent specks for the whole-room grain. */
export function drawGrain(size = 256): HTMLCanvasElement {
  const { el, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const r = rand(17);
  for (let i = 0; i < img.data.length; i += 4) {
    const light = r() > 0.5 ? 255 : 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = light;
    img.data[i + 3] = r() * r() * 46;
  }
  ctx.putImageData(img, 0, 0);
  return el;
}

/**
 * Wear for one sleeve: a warm cast, a sheen, ring wear, scuffed edges and
 * printed grain. The prototype's, unchanged.
 */
export function drawWear(seed: number, size = 768): HTMLCanvasElement {
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
      const alpha =
        strength * scale * (0.25 + near * 0.75) * (0.7 + r() * 0.3);
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
  return el;
}

function blobUrl(el: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) =>
    el.toBlob((blob) =>
      blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("No PNG")),
    ),
  );
}

let installed: Promise<void> | null = null;

/**
 * Draws the grain and the wear once, and sets them on the root as `blob:`
 * URLs. They're kept for as long as the app runs. Without a canvas (as in
 * tests), the sleeves simply show no wear and the room no grain.
 */
export function installTextures(): Promise<void> {
  installed ??= (async () => {
    const root = document.documentElement.style;
    root.setProperty("--grain", `url(${await blobUrl(drawGrain())})`);
    for (let i = 0; i < WEAR_VARIANTS; i++) {
      const url = await blobUrl(drawWear(i + 1));
      root.setProperty(`--wear-${i}`, `url(${url})`);
    }
  })().catch(() => {});
  return installed;
}

/**
 * Which of the wear images an album's sleeve wears, the same every time, as
 * a style setting `--wear`.
 */
export function wearStyle(id: string): CSSProperties {
  return {
    "--wear": `var(--wear-${Math.floor(hash(id) * WEAR_VARIANTS)})`,
  } as CSSProperties;
}

/** A number from 0 to 1 for this text, the same every time. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}
