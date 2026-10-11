// The analog texture, drawn once at startup into plain images. Anything the
// browser has to paint per sleeve (gradients, SVG noise, blend modes) gets
// repainted as the crate's perspective rescales each sleeve, which made
// flipping stutter. A finished image only has to be scaled, which is free.

const rand = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

// A tile of transparent specks for the whole-screen grain.
export function grainTile(size = 256) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const light = Math.random() > 0.5 ? 255 : 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = light;
    img.data[i + 3] = Math.random() * Math.random() * 46;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// Wear for one sleeve: printed grain, ring wear where the record inside has
// rubbed through (uneven, strongest at a couple of points), a fainter ring from
// the label, scuffed edges, a soft sheen and a warm cast.
export function wearImage(seed: number, size = 768) {
  const r = rand(seed * 7919 + 1);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
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

  // Ring wear: many short arcs whose strength drifts around the circle.
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

  // Edges: darker towards the border, with the odd lighter scuff.
  const edge = ctx.createRadialGradient(c, c, size * 0.45, c, c, size * 0.72);
  edge.addColorStop(0, "rgb(0 0 0 / 0)");
  edge.addColorStop(1, "rgb(0 0 0 / 0.28)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgb(255 255 255 / 0.08)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  for (let i = 0; i < 14; i++) {
    const along = r() * size;
    const side = Math.floor(r() * 4);
    const len = size * (0.02 + r() * 0.08);
    ctx.strokeStyle = `rgb(255 255 255 / ${0.05 + r() * 0.1})`;
    ctx.lineWidth = 1 + r() * 2;
    ctx.beginPath();
    if (side === 0) ctx.moveTo(along, 1.5), ctx.lineTo(along + len, 1.5);
    if (side === 1) ctx.moveTo(size - 1.5, along), ctx.lineTo(size - 1.5, along + len);
    if (side === 2) ctx.moveTo(along, size - 1.5), ctx.lineTo(along + len, size - 1.5);
    if (side === 3) ctx.moveTo(1.5, along), ctx.lineTo(1.5, along + len);
    ctx.stroke();
  }

  // Printed grain.
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
  return canvas.toDataURL("image/png");
}

export const WEAR_VARIANTS = 6;

export function installTextures() {
  const root = document.documentElement.style;
  root.setProperty("--grain", `url(${grainTile()})`);
  for (let i = 0; i < WEAR_VARIANTS; i++) root.setProperty(`--wear-${i}`, `url(${wearImage(i + 1)})`);
}
