// What `scripts/crate-spike` measures (DWX-20): the runs, the CPU around each
// one, and the Markdown line it prints for each. crateSpikeCli.ts is its
// command line.

import { execFileSync } from "node:child_process";
import { FINAL } from "../src/crate-spike/effects.ts";

export type Effects = Record<string, string | boolean | number>;

export type Plan = {
  label: string;
  /** The spike, or the app's own crate (DWX-21), which ignores `effects`. */
  target?: "spike" | "crate";
  scenario: "idle" | "flip" | "pull" | "glow" | "search";
  many: boolean;
  effects: Effects;
  cold?: boolean;
  stepMs?: number;
  steps?: number;
  seconds?: number;
};

// What DWX-20 kept: the prototype with only the cuts that bought frames or
// time (DESIGN.md, "The final cuts"). The glow's gradients, the blur, the
// moving grain, the crate under search and redrawing on each poll all stay,
// because they cost none. The panel's Final cuts button is the same set.
export { FINAL };

/** Flipping's later runs each change one thing on top of these two. */
const AHEAD: Effects = { textures: "blob", decodeAhead: true };

/** Every run: each scenario as the prototype had it, then simplified. */
export const PLANS: Plan[] = [
  { label: "idle", scenario: "idle", many: false, effects: {} },

  ...[false, true].flatMap((many) =>
    [100, 40].flatMap((stepMs): Plan[] => {
      const base = { scenario: "flip" as const, many, stepMs, steps: many ? 80 : 40 };
      const name = `flip ${many ? "400" : "real"} ${stepMs}ms`;
      return [
        { ...base, label: `${name}: prototype`, effects: {} },
        { ...base, label: `${name}: + blob textures`, effects: { textures: "blob" } },
        { ...base, label: `${name}: + decode ahead`, effects: AHEAD },
        { ...base, label: `${name}: + one size`, effects: { ...AHEAD, sizes: "640" } },
        { ...base, label: `${name}: + still grain`, effects: { ...AHEAD, grain: "still" } },
        { ...base, label: `${name}: + no grain`, effects: { ...AHEAD, grain: "off" } },
        { ...base, label: `${name}: + no wear`, effects: { ...AHEAD, wear: false } },
        { ...base, label: `${name}: + no shade`, effects: { ...AHEAD, shade: false } },
        { ...base, label: `${name}: + 6 behind`, effects: { ...AHEAD, behind: 6 } },
        { ...base, label: `${name}: + no transitions`, effects: { ...AHEAD, motion: "none" } },
        { ...base, label: `${name}: + flat`, effects: { ...AHEAD, scene: "flat" } },
        { ...base, label: `${name}: final`, effects: FINAL },
      ];
    }),
  ),

  ...[false, true].flatMap((many): Plan[] => {
    const base = { scenario: "pull" as const, many };
    const name = `pull ${many ? "400" : "real"}`;
    return [
      { ...base, label: `${name}: cold`, cold: true, effects: {} },
      { ...base, label: `${name}: cold, no filter`, cold: true, effects: { filter: false } },
      { ...base, label: `${name}: warm`, effects: {} },
      { ...base, label: `${name}: decode ahead`, effects: { decodeAhead: true } },
      { ...base, label: `${name}: decode ahead, no filter`, effects: { decodeAhead: true, filter: false } },
      { ...base, label: `${name}: decode ahead, no filter, no flight`, effects: { decodeAhead: true, filter: false, flight: false } },
      { ...base, label: `${name}: decode ahead, no filter, lazy back`, effects: { decodeAhead: true, filter: false, lazyBack: true } },
      { ...base, label: `${name}: decode ahead, no filter, no deep shadow`, effects: { decodeAhead: true, filter: false, heroShadow: false } },
      { ...base, label: `${name}: decode ahead, no filter, large first`, effects: { decodeAhead: true, filter: false, largeFirst: true } },
      { ...base, label: `${name}: final`, effects: FINAL },
      { ...base, label: `${name}: final, no deep shadow`, effects: { ...FINAL, heroShadow: false } },
    ];
  }),

  ...(
    [
      ["prototype", {}],
      ["no backdrop blur", { backdrop: false }],
      ["still grain", { grain: "still" }],
      ["no grain", { grain: "off" }],
      ["glow images", { glow: "images" }],
      ["no poll redraw", { pollRedraw: false }],
      ["glow images, still grain", { glow: "images", grain: "still" }],
      ["no glow", { glow: "off" }],
      ["final", FINAL],
    ] as const
  ).map(([name, effects]): Plan => ({
    label: `glow: ${name}`,
    scenario: "glow",
    many: false,
    seconds: 10,
    effects,
  })),

  ...(
    [
      ["prototype", {}],
      ["crate hidden", { under: "hidden" }],
      ["no grain", { grain: "off" }],
      ["final", FINAL],
    ] as const
  ).map(([name, effects]): Plan => ({
    label: `search 400: ${name}`,
    scenario: "search",
    many: true,
    effects,
  })),
];

/**
 * The app's own crate (DWX-21), measured as the spike's final cuts were:
 * flipping the real collection and the 400-record crate at both speeds, and
 * pulling records out, warm and cold. `scripts/crate-spike --crate` runs these.
 */
export const CRATE_PLANS: Plan[] = [false, true].flatMap((many): Plan[] => {
  const crate = many ? "400" : "real";
  const base = { target: "crate" as const, many, effects: {} };
  return [
    ...[100, 40].map((stepMs): Plan => ({
      ...base,
      label: `crate: flip ${crate} ${stepMs}ms`,
      scenario: "flip",
      stepMs,
      steps: many ? 80 : 40,
    })),
    { ...base, label: `crate: pull ${crate}`, scenario: "pull" },
    { ...base, label: `crate: pull ${crate}, cold`, scenario: "pull", cold: true },
  ];
});

type Frames = { fps: number; dropped: number; late: number; longestMs: number; p95Ms: number; p99Ms: number };
export type Result = {
  error?: string;
  frames?: Frames;
  longestCommitMs?: number;
  largeMs?: number[];
  largeWorstMs?: number;
  largeSteps?: { loaded: number; decoded: number; painted: number; first: number }[];
  flightDropped?: number;
  flightLongestMs?: number;
  flipWorkMs?: { median: number; longest: number; reactMedian: number };
  opening?: Frames;
  scrolling?: Frames;
  window?: { width: number; height: number; dpr: number };
  /** Average CPU over the whole run, in percent of one core. */
  cpu?: Cpu;
};

// WebKit runs CSS animations of transform and opacity in Core Animation, out
// of the page's reach, so a frame it drops there may not show in the page's
// frames. What those processes spend is measured alongside: WebKit's GPU
// process draws the layers, and the WindowServer puts them on screen.
const PROCESSES = {
  gpu: /com\.apple\.WebKit\.GPU$/,
  web: /com\.apple\.WebKit\.WebContent$/,
  windowServer: /\/WindowServer$/,
};
type Cpu = Record<keyof typeof PROCESSES, number>;

/** `ps`'s TIME, such as 1:02.50 or 1-02:03:04, in seconds. */
export function seconds(time: string): number {
  const [days, rest] = time.includes("-") ? time.split("-") : ["0", time];
  return (
    Number(days) * 86400 +
    rest
      .split(":")
      .map(Number)
      .reduce((sum, part) => sum * 60 + part, 0)
  );
}

/** The CPU time each kind of process has used so far, in seconds. */
function cpuTimes(): Cpu {
  const out = execFileSync("ps", ["-axo", "time=,comm="], { encoding: "utf8" });
  const total: Cpu = { gpu: 0, web: 0, windowServer: 0 };
  for (const line of out.split("\n")) {
    const match = /^\s*(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    for (const [name, pattern] of Object.entries(PROCESSES)) {
      if (pattern.test(match[2])) total[name as keyof Cpu] += seconds(match[1]);
    }
  }
  return total;
}

export async function measure(port: number, plan: Plan): Promise<Result> {
  const before = cpuTimes();
  const started = Date.now();
  const res = await fetch(`http://localhost:${port}/__crate-spike/run`, {
    method: "POST",
    body: JSON.stringify(plan),
  });
  const result = (await res.json()) as Result;
  const after = cpuTimes();
  const wall = (Date.now() - started) / 1000;
  const percent = (key: keyof Cpu) => Math.round(((after[key] - before[key]) / wall) * 100);
  return { ...result, cpu: { gpu: percent("gpu"), web: percent("web"), windowServer: percent("windowServer") } };
}

const frames = (f: Frames | undefined) =>
  f ? `${f.fps} fps, ${f.dropped} dropped, ${f.late} late, longest ${f.longestMs} ms` : "";

/** One line of the table for a run's repeats. */
export function row(plan: Plan, results: Result[]): string {
  const failed = results.find((r) => r.error);
  if (failed) return `| ${plan.label} | error: ${failed.error} |`;
  const each = (f: (r: Result) => string) => results.map(f).join(" · ");
  const cpu = ` CPU GPU ${each((r) => `${r.cpu?.gpu}`)}% · web ${each((r) => `${r.cpu?.web}`)}% · WindowServer ${each((r) => `${r.cpu?.windowServer}`)}% |`;
  return describe(plan, results, each) + cpu;
}

function describe(plan: Plan, results: Result[], each: (f: (r: Result) => string) => string): string {
  switch (plan.scenario) {
    case "flip":
      return `| ${plan.label} | dropped ${each((r) => String(r.frames?.dropped))} | late ${each((r) => String(r.frames?.late))} | longest ${each((r) => `${r.frames?.longestMs}`)} ms | ${each((r) => `${r.frames?.fps}`)} fps | flip work ${each((r) => `${r.flipWorkMs?.median}/${r.flipWorkMs?.longest} (React ${r.flipWorkMs?.reactMedian})`)} ms |`;
    case "idle":
    case "glow":
      return `| ${plan.label} | dropped ${each((r) => String(r.frames?.dropped))} | late ${each((r) => String(r.frames?.late))} | longest ${each((r) => `${r.frames?.longestMs}`)} ms | ${each((r) => `${r.frames?.fps}`)} fps | commit ${each((r) => `${r.longestCommitMs ?? "-"}`)} ms |`;
    case "pull":
      return `| ${plan.label} | large worst ${each((r) => `${r.largeWorstMs}`)} ms | all ${results.map((r) => r.largeMs?.join("/")).join(" · ")} | first frame ${results.map((r) => r.largeSteps?.map((t) => t.first).join("/")).join(" · ")} ms | flight dropped ${each((r) => `${r.flightDropped}`)} |`;
    case "search":
      return `| ${plan.label} | opening ${each((r) => frames(r.opening))} | scrolling ${each((r) => frames(r.scrolling))} |`;
  }
}
