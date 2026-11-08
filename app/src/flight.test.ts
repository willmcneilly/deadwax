import { describe, expect, it } from "vitest";
import { FADE, FLY_BACK, HOLD, LANDS_AT, reaches } from "./flight";

describe("When a flight reaches a keyframe", () => {
  it("is the offset's share of the duration when the easing is linear", () => {
    const linear = "cubic-bezier(0, 0, 1, 1)";
    expect(reaches({ duration: 1000, easing: linear }, 0.8)).toBeCloseTo(800, 3);
    expect(reaches({ duration: 1000, delay: 200, easing: linear }, 0.5)).toBeCloseTo(700, 3);
  });

  it("comes earlier under an easing that has done most of its moving by then", () => {
    // The put-back flight's: it has eased to 0.8 at about 58% of its time.
    expect(FLY_BACK).toMatchObject({ duration: 620, delay: 260 });
    expect(LANDS_AT).toBeCloseTo(260 + 0.5817 * 620, 0);
    expect(reaches(FLY_BACK, 0)).toBeCloseTo(260, 3);
    expect(reaches(FLY_BACK, 1)).toBeCloseTo(880, 3);
  });

  it("refuses an easing it can't read", () => {
    expect(() => reaches({ duration: 100, easing: "ease-in-out" }, 0.5)).toThrow(
      "Not a cubic-bezier easing",
    );
  });
});

describe("The sleeve's fade into its place", () => {
  it("waits, opaque over its place, for some frames after its place shows", () => {
    // The place shows at LANDS_AT; a busy page can show it a frame or two
    // late, which an opaque sleeve hides and a fading one didn't (DWX-35).
    expect(FADE.delay).toBe(LANDS_AT + HOLD);
    expect(HOLD).toBeGreaterThanOrEqual(100);
  });
});

