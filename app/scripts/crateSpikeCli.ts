// `scripts/crate-spike`: measures the crate spike in the running dev app
// against the frame budget (DWX-20), and prints what it found as Markdown.
// The app must be open (`scripts/dev-app start`), with its window in front:
// WebKit slows a hidden window's frames, which would spoil the numbers.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const HELP = `Usage: scripts/crate-spike [--port <n>] [--only <text>] [--repeat <n>]

Measures the crate spike (Develop › Crate spike) in this checkout's running
dev app, one run at a time, and prints a Markdown table per scenario. Each
result is also kept in .dev-data/crate-spike/results.jsonl.

  --port <n>     the dev app's port (scripts/dev-app status says; 1440)
  --only <text>  only the runs whose label contains this
  --repeat <n>   how many times to measure each run (3)
  --list         list the runs, and measure nothing`;

type Effects = Record<string, string | boolean | number>;

type Plan = {
  label: string;
  scenario: "idle" | "flip" | "pull" | "glow" | "search";
  many: boolean;
  effects: Effects;
  cold?: boolean;
  stepMs?: number;
  steps?: number;
  seconds?: number;
};

// Simplifications, in the order the runs apply them on top of the prototype.
const FINAL: Effects = {
  textures: "blob",
  grain: "still",
  glow: "images",
  backdrop: false,
  under: "hidden",
  decodeAhead: true,
  pollRedraw: false,
};

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
      { ...base, label: `${name}: final`, effects: FINAL },
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

type Frames = { fps: number; dropped: number; late: number; longestMs: number; p95Ms: number; p99Ms: number };
type Result = {
  error?: string;
  frames?: Frames;
  longestCommitMs?: number;
  largeMs?: number[];
  largeWorstMs?: number;
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

async function measure(port: number, plan: Plan): Promise<Result> {
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
function row(plan: Plan, results: Result[]): string {
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
      return `| ${plan.label} | large worst ${each((r) => `${r.largeWorstMs}`)} ms | all ${results.map((r) => r.largeMs?.join("/")).join(" · ")} | flight dropped ${each((r) => `${r.flightDropped}`)} |`;
    case "search":
      return `| ${plan.label} | opening ${each((r) => frames(r.opening))} | scrolling ${each((r) => frames(r.scrolling))} |`;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "1440" },
      only: { type: "string" },
      repeat: { type: "string", default: "3" },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const plans = PLANS.filter((p) => !values.only || p.label.includes(values.only));
  if (values.list) {
    for (const p of plans) console.log(p.label);
    return;
  }
  const port = Number(values.port);
  const repeat = Number(values.repeat);
  for (const plan of plans) {
    const results: Result[] = [];
    for (let i = 0; i < repeat; i++) results.push(await measure(port, plan));
    console.log(row(plan, results));
    if (results[0]?.window && plan === plans[0]) {
      const w = results[0].window;
      console.log(`  (window ${w.width}×${w.height} at ${w.dpr}x)`);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
