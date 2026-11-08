// `scripts/crate-spike --put-back` (DWX-35): flies the record in front back
// into the crate many times in the running dev app, records the screen at
// 60 fps meanwhile, and looks at each landing, frame by frame, for anything
// showing where the record should be. The put-backs themselves are in the
// app (putBacks in src/crate-spike/CrateMeter.tsx).
//
// Why from a recording: a put-back hands the flying sleeve over to the
// crate's own copy of it, and the two are drawn on different clocks (the
// flight in Core Animation, the place by the page), so only what reached the
// screen shows whether the handover was seamless. The page's own view of
// itself would agree with itself even when the screen didn't.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FADE, FLY_BACK, LANDS_AT } from "../src/flight.ts";

/** What the app answers a putback run with. */
export type PutBackRun = {
  error?: string;
  /** When each was pulled out, and when it was put back, in epoch ms. */
  putBacks?: { pulledAt: number; at: number; floating: boolean }[];
  /** The record in front, in the page's pixels, once it's back. */
  place?: { left: number; top: number; width: number; height: number } | null;
  /** The screen's width in points, and where the page's top left is on it. */
  screen?: { width: number; left: number; top: number };
};

export type Region = { x: number; y: number; width: number; height: number };

/**
 * Where the record's place is in the recording: the page's rectangle, moved
 * onto the screen and scaled to the recording's pixels, and inset by a fifth
 * on each side, so the sleeves either side and the tabs behind don't count.
 */
export function region(run: PutBackRun, videoWidth: number): Region {
  const { place, screen } = run;
  if (!place || !screen) throw new Error("The app didn't say where the record is.");
  const scale = videoWidth / screen.width;
  const inset = (n: number) => n * 0.2;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return {
    x: even((screen.left + place.left + inset(place.width)) * scale),
    y: even((screen.top + place.top + inset(place.height)) * scale),
    width: even(place.width * 0.6 * scale),
    height: even(place.height * 0.6 * scale),
  };
}

/** How far two frames are apart, 0 to 255 per pixel, on average. */
function apart(frames: Buffer, size: number, a: number, b: number): number {
  let sum = 0;
  for (let p = 0; p < size; p++) sum += Math.abs(frames[a * size + p] - frames[b * size + p]);
  return sum / size;
}

export type Landing = {
  /** Which put-back, from 0, and whether it was floating. */
  index: number;
  floating: boolean;
  /** The frame it's read against: its place, at rest. */
  settled: number;
  /**
   * How far each frame of its landing is from that: falling as the sleeve
   * fades into its place, and, where something showed through, rising again
   * for a frame or two.
   */
  settling: number[];
  /** Frames that rose against that fall: something showing through. */
  through: number[];
};

/** A frame moving: this far from the one before, per pixel. */
export const MOVING = 1;
/** Showing through: this much further from rest than an earlier frame. */
export const RISE = 3;

/**
 * How many frames after the app's clock the recording runs: the recording
 * starts a little after its process does. Every pull and every flight back
 * starts something moving after a still moment, at a time the app gave; the
 * one offset that lines up the most of them, most closely, is it. Pulls are
 * in the fit as well as flights, so a flight can't be lined up with the next
 * pull. Each may be a frame or two out; one dead on counts for most.
 */
export function offset(moving: boolean[], events: number[]): number {
  const onsets = new Set<number>();
  for (let f = 1; f < moving.length; f++) if (moving[f] && !moving[f - 1]) onsets.add(f);
  const near = [0, -1, 1, -2, 2];
  let best = { at: 0, score: -1 };
  for (let at = -60; at <= 360; at++) {
    let score = 0;
    for (const e of events) {
      const d = near.find((n) => onsets.has(e + at + n));
      if (d !== undefined) score += 3 - Math.abs(d);
    }
    if (score > best.score) best = { at, score };
  }
  return best.at;
}

/**
 * Reads each put-back's landing: from a sixth of a second before the sleeve
 * is over its place (`lands`), so the recording can be lined up a few frames
 * out, to past the end of its hold and fade, each frame against
 * one taken later still, with everything at rest. Over that, the distance
 * should only fall: the sleeve fading into its place and the room's light
 * going with it. A frame that rises above the lowest before it by RISE is
 * something showing through.
 */
export function landings(
  frames: Buffer,
  size: number,
  putBacks: { lands: number; floating: boolean }[],
  watch: number,
): Landing[] {
  const count = Math.floor(frames.length / size);
  return putBacks.flatMap(({ lands, floating }, index) => {
    const from = lands - 10;
    const to = lands + watch;
    const settled = to + 10;
    if (from < 0 || settled >= count) return [];
    const settling: number[] = [];
    const through: number[] = [];
    let lowest = Infinity;
    for (let f = from; f <= to; f++) {
      const d = apart(frames, size, f, settled);
      settling.push(Math.round(d * 10) / 10);
      if (d > lowest + RISE) through.push(f);
      lowest = Math.min(lowest, d);
    }
    return [{ index, floating, settled, settling, through }];
  });
}

const SIDE = 48;

/** The place's square in every frame, 48 by 48, in grey. */
function placeFrames(video: string, r: Region): Buffer {
  return execFileSync(
    "ffmpeg",
    [
      "-loglevel", "error", "-i", video,
      "-vf", `fps=60,crop=${r.width}:${r.height}:${r.x}:${r.y},scale=${SIDE}:${SIDE},format=gray`,
      "-f", "rawvideo", "-",
    ],
    { maxBuffer: 1 << 30 },
  );
}

function videoWidth(video: string): number {
  return Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", video],
      { encoding: "utf8" },
    ).trim(),
  );
}

export type Report = { run: PutBackRun; region: Region; landings: Landing[]; dir: string };

/** When a put-back's flight starts moving, after the app says it began. */
const FLIGHT_STARTS = FLY_BACK.delay;

/**
 * Records the screen while the app puts the record back `times` times, then
 * reads each landing. The recording is kept in `dir` only with `keep`.
 */
export async function putBackCheck(port: number, times: number, dir: string, keep: boolean): Promise<Report> {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error("--put-back needs ffmpeg (brew install ffmpeg).");
  }
  mkdirSync(dir, { recursive: true });
  const video = join(dir, "put-back.mov");
  // Long enough for every put-back (CrateMeter's waits) and the start.
  const seconds = Math.ceil(times * 4.6 + 10);
  const recording = spawn("screencapture", ["-v", "-V", String(seconds), "-x", video], { stdio: "ignore" });
  const startedAt = Date.now();
  const recorded = new Promise<void>((resolve, reject) => {
    recording.on("exit", () => resolve());
    recording.on("error", reject);
  });
  const res = await fetch(`http://localhost:${port}/__crate-spike/run`, {
    method: "POST",
    body: JSON.stringify({ target: "crate", scenario: "putback", many: false, effects: {}, times }),
  });
  const run = (await res.json()) as PutBackRun;
  await recorded;
  if (run.error) throw new Error(run.error);
  const r = region(run, videoWidth(video));
  const size = SIDE * SIDE;
  const frames = placeFrames(video, r);
  const count = Math.floor(frames.length / size);
  const moving = [false];
  for (let f = 1; f < count; f++) moving.push(apart(frames, size, f, f - 1) > MOVING);
  const frameAt = (ms: number) => Math.round(((ms - startedAt) / 1000) * 60);
  const putBacks = run.putBacks ?? [];
  const shift = offset(
    moving,
    putBacks.flatMap((p) => [frameAt(p.pulledAt), frameAt(p.at + FLIGHT_STARTS)]),
  );
  const found = landings(
    frames,
    size,
    putBacks.map((p) => ({ lands: frameAt(p.at + LANDS_AT) + shift, floating: p.floating })),
    // The hold and the fade, and a fifth of a second more.
    Math.round(((FADE.delay + FADE.duration - LANDS_AT) / 1000) * 60) + 12,
  );
  writeFileSync(join(dir, "landings.json"), JSON.stringify({ region: r, run, startedAt, shift, landings: found }, null, 1));
  if (!keep) rmSync(video);
  return { run, region: r, landings: found, dir };
}

/** What `--put-back` prints. */
export function summary(report: Report, times: number): string {
  const { landings: found } = report;
  const lines = [
    `Put back ${times} times (every other one floating, as if playing); read ${found.length} landings in the recording.`,
  ];
  if (found.length !== times) {
    lines.push("  Not one for each put-back: was the window covered, or the screen locked?");
  }
  const bad = found.filter((l) => l.through.length > 0);
  const kind = (l: Landing) => `${l.index + 1}${l.floating ? " (floating)" : ""}`;
  lines.push(
    bad.length === 0
      ? "  Nothing showed through at any of them."
      : `  Something showed through at ${bad.length}: ${bad.map((l) => `${kind(l)}, ${l.through.length} frames`).join("; ")}.`,
  );
  lines.push(`  Each landing, frame by frame: ${join(report.dir, "landings.json")}`);
  return lines.join("\n");
}
