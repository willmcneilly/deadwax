// The effects DWX-20 measures, each of which can be turned down or off.

export type Effects = {
  /** The whole-screen grain: moving, still, or none. */
  grain: "animated" | "still" | "off";
  /** The pre-drawn wear on each sleeve. */
  wear: boolean;
  /** The darkening on the sleeves further back. */
  shade: boolean;
  /** The glow's five pools: live radial gradients, pre-drawn images, or none. */
  glow: "gradients" | "images" | "off";
  /** The playing chip's backdrop-filter blur. */
  backdrop: boolean;
  /** The CSS filter on the pulled-out cover. */
  filter: boolean;
  /** Under the search overlay, the 3D crate stays drawn dimmed, or is hidden. */
  under: "dim" | "hidden";
  /** Decode the covers about to be drawn before they're needed. */
  decodeAhead: boolean;
  /** The crate's covers: the 640 for the front two and the 320 behind, or the 640 for all. */
  sizes: "mixed" | "640";
  /** How many records are drawn behind the one in front. */
  behind: number;
  /** The crate's sleeves move to their places with CSS transitions, or jump. */
  motion: "transition" | "none";
  /** The crate in 3D, as the prototype has it, or flat: the same places in 2D. */
  scene: "3d" | "flat";
  /** The pulled-out record flies out of the crate, or appears in place. */
  flight: boolean;
  /** The pulled-out sleeve's back is built only when it's first turned over. */
  lazyBack: boolean;
  /** The pulled-out sleeve draws the 1600 from its first frame, not the 640 until the 1600 is ready. */
  largeFirst: boolean;
  /** The pulled-out sleeve's deep shadow: a live 80px blur, or none. */
  heroShadow: boolean;
  /** The grain and wear images, as the prototype's `data:` URLs or as `blob:` URLs. */
  textures: "data" | "blob";
  /** Replace the playback state on every poll, even when nothing changed. */
  pollRedraw: boolean;
};

/** The prototype as PR #16 left it: every effect on. */
export const PROTOTYPE: Effects = {
  grain: "animated",
  wear: true,
  shade: true,
  glow: "gradients",
  backdrop: true,
  filter: true,
  under: "dim",
  decodeAhead: false,
  sizes: "mixed",
  behind: 11,
  motion: "transition",
  scene: "3d",
  textures: "data",
  flight: true,
  lazyBack: false,
  largeFirst: false,
  heroShadow: true,
  pollRedraw: true,
};

/**
 * What DWX-20 kept (DESIGN.md, "The final cuts"): only the changes that
 * bought frames or time. scripts/crate-spike's `final` runs are these.
 */
export const FINAL: Partial<Effects> = {
  textures: "blob",
  behind: 6,
  filter: false,
  lazyBack: true,
  decodeAhead: true,
};

/** The classes on .crate-spike that turn effects off (crateSpike.css). */
export function effectClasses(e: Effects): string {
  return [
    `grain-${e.grain}`,
    `glow-${e.glow}`,
    `under-${e.under}`,
    `motion-${e.motion}`,
    `scene-${e.scene}`,
    e.wear ? "" : "no-wear",
    e.shade ? "" : "no-shade",
    e.backdrop ? "" : "no-backdrop",
    e.filter ? "" : "no-filter",
    e.heroShadow ? "" : "no-hero-shadow",
  ]
    .filter(Boolean)
    .join(" ");
}
