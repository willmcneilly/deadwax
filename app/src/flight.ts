// When a flight reaches one of its keyframes. A Web Animation's easing bends
// its whole progress, and keyframe offsets are measured in that bent
// progress, so the keyframe at 0.8 isn't reached at 80% of the duration.

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
