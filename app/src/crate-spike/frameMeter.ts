// Counts frames the way the Frames timeline shows them: every
// requestAnimationFrame is one frame, and a gap longer than the display's
// interval is a frame that was missed. WebKit drives requestAnimationFrame
// from the display, and holds it back while the page's rendering is late, so
// a missed frame shows up here as a long gap (DWX-20).
//
// Development builds only: the crate spike uses it, behind import.meta.env.DEV.

/** What one stretch of frames looked like. */
export type FrameStats = {
  /** Frames drawn. */
  frames: number;
  /** How long the stretch lasted, in milliseconds. */
  durationMs: number;
  /** Frames drawn per second. */
  fps: number;
  /** The display's interval: 16.7 at 60 Hz. */
  intervalMs: number;
  /** Frames the display had time for that weren't drawn. */
  dropped: number;
  /** Gaps more than half a frame late: the hitches you see. */
  late: number;
  /** The longest gap between two frames. */
  longestMs: number;
  /** The 95th and 99th percentile gaps. */
  p95Ms: number;
  p99Ms: number;
};

/** The display's interval at 60 Hz. The budget is a steady 60 fps. */
export const FRAME_MS = 1000 / 60;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * The stats for frames drawn at these times (requestAnimationFrame's
 * timestamps, in milliseconds). Dropped frames are the frames the stretch had
 * time for, at `intervalMs`, less the frames drawn, so a frame that's a little
 * late and the next a little early count as none. A gap more than half a
 * frame longer than `intervalMs` is late: at 60 Hz, a gap of 33 ms is one late
 * frame, and so is 50 ms.
 */
export function frameStats(times: number[], intervalMs = FRAME_MS): FrameStats {
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const durationMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const dropped = Math.max(0, Math.round(durationMs / intervalMs) - gaps.length);
  const late = gaps.filter((gap) => gap > intervalMs * 1.5).length;
  return {
    frames: gaps.length,
    durationMs: round(durationMs),
    fps: durationMs ? round((gaps.length * 1000) / durationMs) : 0,
    intervalMs: round(intervalMs),
    dropped,
    late,
    longestMs: round(sorted[sorted.length - 1] ?? 0),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
  };
}

/** Records every frame from now until `stop` is called. */
export function recordFrames(): { stop: () => number[] } {
  const times: number[] = [];
  let id = requestAnimationFrame(function tick(t) {
    times.push(t);
    id = requestAnimationFrame(tick);
  });
  return {
    stop: () => {
      cancelAnimationFrame(id);
      return times;
    },
  };
}

/** Resolves on the frame after the next one: by then, what changed is on screen. */
export function painted(): Promise<number> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame((t) => resolve(t))),
  );
}
