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
  pollRedraw: true,
};

/** The classes on .crate-spike that turn effects off (crateSpike.css). */
export function effectClasses(e: Effects): string {
  return [
    `grain-${e.grain}`,
    `glow-${e.glow}`,
    `under-${e.under}`,
    e.wear ? "" : "no-wear",
    e.shade ? "" : "no-shade",
    e.backdrop ? "" : "no-backdrop",
    e.filter ? "" : "no-filter",
  ]
    .filter(Boolean)
    .join(" ");
}
