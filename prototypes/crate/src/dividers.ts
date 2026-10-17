// What the crate's dividers are made of, switchable while we decide (from
// the dev panel): ink, paper or acrylic. A class on <html> picks the colours
// in styles.css.

export const MATERIALS = ["ink", "paper", "acrylic"] as const;
export type Material = (typeof MATERIALS)[number];

export function setDividers(m: Material) {
  for (const x of MATERIALS) document.documentElement.classList.toggle(`dividers-${x}`, x === m);
  try {
    localStorage.setItem("dividers", m);
  } catch {
    // fine without it
  }
}

export function currentDividers(): Material {
  return MATERIALS.find((m) => document.documentElement.classList.contains(`dividers-${m}`)) ?? "ink";
}

export function restoreDividers() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("dividers");
  } catch {
    // fine without it
  }
  setDividers(MATERIALS.find((m) => m === saved) ?? "ink");
}
