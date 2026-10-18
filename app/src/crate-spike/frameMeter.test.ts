import { describe, expect, it } from "vitest";
import { frameStats } from "./frameMeter";

/** Frame times from a list of gaps, starting at 1000 ms. */
function times(gaps: number[]): number[] {
  const out = [1000];
  for (const gap of gaps) out.push(out[out.length - 1] + gap);
  return out;
}

describe("frameStats", () => {
  it("counts no dropped frames at a steady 60 fps", () => {
    const stats = frameStats(times(Array(60).fill(1000 / 60)));
    expect(stats.frames).toBe(60);
    expect(stats.fps).toBe(60);
    expect(stats.dropped).toBe(0);
  });

  it("counts a gap of two frames as one dropped and three as two", () => {
    const frame = 1000 / 60;
    const stats = frameStats(times([frame, frame * 2, frame, frame * 3, frame]));
    expect(stats.dropped).toBe(3);
    expect(stats.longestMs).toBe(50);
  });

  it("doesn't count the jitter of a frame that's a little late", () => {
    expect(frameStats(times([16, 18, 15, 20, 17])).dropped).toBe(0);
  });

  it("counts 120 Hz frames as on time against the 60 fps budget", () => {
    const stats = frameStats(times(Array(120).fill(1000 / 120)));
    expect(stats.dropped).toBe(0);
    expect(stats.fps).toBe(120);
  });

  it("gives the slowest gaps as percentiles", () => {
    const stats = frameStats(times([...Array(98).fill(16), 40, 100]));
    expect(stats.p95Ms).toBe(16);
    expect(stats.p99Ms).toBe(40);
    expect(stats.longestMs).toBe(100);
  });

  it("is empty for fewer than two frames", () => {
    expect(frameStats([5])).toMatchObject({ frames: 0, fps: 0, dropped: 0 });
  });
});
