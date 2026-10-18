// What the crate spike measures (DWX-20), each run against the frame budget:
// a steady 60 fps while flipping, a pulled-out sleeve's large artwork drawn
// within 100 ms, and the glow's drift dropping no frames.

import { frameStats, recordFrames, type FrameStats } from "./frameMeter";
import type { LargeTimes } from "./CrateSpike";
import type { Run } from "./remote";

/** What a scenario can do to the spike. */
export type Controller = {
  count: () => number;
  /**
   * Flips to this record now, and says how long the page's own work took, in
   * ms: React's update, then the style and layout it caused.
   */
  flip: (index: number) => { react: number; style: number };
  /** The albums in the crate, without its dividers. */
  records: () => number;
  setFocus: (index: number) => void;
  /** Pulls the record in front out, timing it from now. */
  pull: (cold: boolean) => void;
  putBack: () => void;
  setPlaying: (on: boolean) => void;
  setSearch: (on: boolean) => void;
  /** Scrolls the search overlay by this many pixels. */
  scrollSearch: (by: number) => void;
  /** Resolves with the milliseconds from the pull to the large cover loaded, decoded and painted. */
  largePainted: () => Promise<LargeTimes>;
  /** The longest React commit since the last call, in milliseconds. */
  takeLongestCommit: () => number;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(ms: number, during?: () => Promise<void>): Promise<FrameStats> {
  const frames = recordFrames();
  if (during) await during();
  else await wait(ms);
  return frameStats(frames.stop());
}

/** Flips one record at a time, there and back, as a fast scroll wheel does. */
async function flip(c: Controller, run: Run) {
  const stepMs = run.stepMs ?? 100;
  const steps = run.steps ?? 60;
  const last = c.count() - 1;
  let at = 0;
  let by = 1;
  const work: number[] = [];
  const react: number[] = [];
  c.setFocus(0);
  await wait(600);
  c.takeLongestCommit();
  const frames = await measure(0, async () => {
    for (let i = 0; i < steps; i++) {
      if (at + by > last || at + by < 0) by = -by;
      at += by;
      const ms = c.flip(at);
      react.push(ms.react);
      work.push(ms.react + ms.style);
      await wait(stepMs);
    }
    await wait(300);
  });
  work.sort((a, b) => a - b);
  react.sort((a, b) => a - b);
  return {
    frames,
    stepMs,
    steps,
    longestCommitMs: c.takeLongestCommit(),
    flipWorkMs: {
      median: Math.round(work[Math.floor(work.length / 2)] * 10) / 10,
      longest: Math.round(work[work.length - 1] * 10) / 10,
      reactMedian: Math.round(react[Math.floor(react.length / 2)] * 10) / 10,
    },
  };
}

/** Pulls records out one after another, timing the large cover and the flight. */
async function pull(c: Controller, run: Run) {
  const times: number[] = [];
  const steps: LargeTimes[] = [];
  const flights: FrameStats[] = [];
  const count = c.count();
  const tries = Math.min(8, count);
  for (let i = 0; i < tries; i++) {
    // Spread through the crate, and land on a record rather than a divider:
    // the spike skips dividers when pulling.
    c.setFocus(Math.floor((i * count) / tries));
    await wait(700);
    const large = c.largePainted();
    const flight = recordFrames();
    c.pull(run.cold ?? false);
    const step = await large;
    steps.push(step);
    times.push(step.painted);
    await wait(900);
    flights.push(frameStats(flight.stop()));
    c.putBack();
    await wait(1000);
  }
  return {
    largeMs: times,
    largeWorstMs: Math.max(...times),
    largeSteps: steps,
    flightDropped: flights.reduce((sum, f) => sum + f.dropped, 0),
    flightLongestMs: Math.max(...flights.map((f) => f.longestMs)),
  };
}

/** A record pulled out and playing, floating in its glow. */
async function glow(c: Controller, run: Run) {
  c.setFocus(Math.min(1, c.count() - 1));
  await wait(600);
  c.pull(false);
  await wait(1200);
  c.setPlaying(true);
  // Let the glow fade in and the sleeve settle before measuring the drift.
  await wait(3000);
  c.takeLongestCommit();
  const frames = await measure((run.seconds ?? 10) * 1000);
  const longestCommitMs = c.takeLongestCommit();
  c.setPlaying(false);
  c.putBack();
  await wait(1000);
  return { frames, longestCommitMs };
}

/** Search open over the crate: opening it, then scrolling the covers. */
async function search(c: Controller) {
  c.setFocus(Math.min(3, c.count() - 1));
  await wait(600);
  const opening = await measure(0, async () => {
    c.setSearch(true);
    await wait(1200);
  });
  const scrolling = await measure(0, async () => {
    for (let i = 0; i < 180; i++) {
      c.scrollSearch(i < 90 ? 6 : -6);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
  c.setSearch(false);
  await wait(1200);
  return { opening, scrolling };
}

export async function runScenario(c: Controller, run: Run): Promise<object> {
  switch (run.scenario) {
    case "idle":
      return { frames: await measure((run.seconds ?? 3) * 1000) };
    case "flip":
      return flip(c, run);
    case "pull":
      return pull(c, run);
    case "glow":
      return glow(c, run);
    case "search":
      return search(c);
  }
}
