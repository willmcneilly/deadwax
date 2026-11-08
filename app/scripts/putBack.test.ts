import { describe, expect, it } from "vitest";
import { landings, offset, region, RISE } from "./putBack.ts";

/** Frames of one pixel each, with these values. */
const frames = (values: number[]) => Buffer.from(values);
/**
 * A landing at frame 13: ten frames of the sleeve on its way, as far from
 * rest as `values` starts, then `values` from three frames before it lands.
 */
const landing = (values: number[]) => frames([...Array(10).fill(values[0]), ...values]);
const LANDS = 13;

describe("The put-back check", () => {
  it("finds the record's place in the recording, inset from its edges", () => {
    const r = region(
      {
        place: { left: 400, top: 200, width: 500, height: 600 },
        screen: { width: 1500, height: 1000, x: 0, y: 30, chrome: 30 },
      },
      3000,
    );
    // Twice the screen's points; a fifth in from each side; 60% of each side.
    expect(r).toEqual({ x: 1000, y: 760, width: 600, height: 720 });
  });

  it("lines the recording up with the app's clock by its pulls and flights", () => {
    const moving = Array.from({ length: 400 }, () => false);
    // Things start moving at 110, 190 and 300: the app's 100, 180 and 290, ten frames late.
    for (const start of [110, 190, 300]) for (let f = start; f < start + 20; f++) moving[f] = true;
    expect(offset(moving, [100, 180, 290])).toBe(10);
  });

  it("passes a landing that only falls towards its place at rest", () => {
    // The sleeve arrives, sits, fades: the distance from rest only falls.
    const clean = [9, 6, 4, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const [read] = landings(landing(clean), 1, [{ lands: LANDS, floating: false }], 2);
    expect(read.through).toEqual([]);
    expect(read.settling.slice(-6)).toEqual([9, 6, 4, 2, 2, 2]);
  });

  it("catches a frame or two where what's behind the place shows through", () => {
    // Arrived, then the divider behind shows through the fading sleeve.
    const late = [9, 2, 2, 2 + RISE + 9, 2 + RISE + 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const [read] = landings(landing(late), 1, [{ lands: LANDS, floating: true }], 3);
    expect(read.through).toEqual([13, 14]);
    expect(read.floating).toBe(true);
  });

  it("doesn't count the flicker of a place already at rest", () => {
    const noise = [3, 1, 1, 2, 1, 2, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0];
    expect(landings(landing(noise), 1, [{ lands: LANDS, floating: false }], 2)[0].through).toEqual([]);
  });

  it("skips a landing the recording doesn't hold all of", () => {
    expect(landings(landing([5, 4, 3]), 1, [{ lands: LANDS, floating: false }], 5)).toEqual([]);
  });
});
