// When a flight reaches one of its keyframes. A Web Animation's easing bends
// its whole progress, and keyframe offsets are measured in that bent
// progress, so the keyframe at 0.8 isn't reached at 80% of the duration.
// The put-back flight's timing lives here too, so its tests can read it.

export type Timing = { duration: number; delay?: number; easing: string };

/**
 * The milliseconds after a flight starts at which it reaches `offset`, for
 * an easing written as `cubic-bezier(x1, y1, x2, y2)` whose curve only ever
 * rises, as every easing of Deadwax's flights does.
 */
export function reaches({ duration, delay = 0, easing }: Timing, offset: number): number {
  const numbers = /^cubic-bezier\(([^)]*)\)$/.exec(easing.replace(/\s/g, ""));
  const [x1, y1, x2, y2] = (numbers?.[1] ?? "").split(",").map(Number);
  if (!numbers || [x1, y1, x2, y2].some((n) => !Number.isFinite(n))) {
    throw new Error(`Not a cubic-bezier easing: ${easing}`);
  }
  const bezier = (a: number, b: number, s: number) =>
    3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
  // The curve's parameter where it has eased to the offset, by halving.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (bezier(y1, y2, mid) < offset) low = mid;
    else high = mid;
  }
  return delay + bezier(x1, x2, (low + high) / 2) * duration;
}

/** A sleeve's flight back into its place in the crate (Sleeve.tsx). */
export const FLY_BACK = {
  duration: 620,
  delay: 260,
  easing: "cubic-bezier(.5,0,.3,1)",
  fill: "forwards" as const,
};
/** Where on the flight back it's over its place. */
export const LANDS = 0.8;
/**
 * When that is, in milliseconds after the flight back starts: its place in
 * the crate shows from then, under the sleeve.
 */
export const LANDS_AT = reaches(FLY_BACK, LANDS);
/**
 * How long the sleeve sits over its place, opaque, before it fades into it:
 * the handover's slack. The place shows at the start of it, but showing it
 * is the page's work, and a busy page can do it a frame or two late; under
 * an opaque sleeve that can't be seen, where under a fading one what was
 * behind the place showed through (DWX-35). Seven frames at 60 fps.
 * DESIGN.md has the sleeve fade over the last fifth of the flight, with no
 * hold: provisional: D-2.
 */
export const HOLD = 120;
/** The sleeve's fade into the crate's copy of it, once it has sat there. */
export const FADE = {
  delay: LANDS_AT + HOLD,
  duration: 260,
  easing: "cubic-bezier(.2,.6,.3,1)",
  fill: "forwards" as const,
};
