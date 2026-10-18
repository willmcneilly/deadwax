// The command line for `scripts/crate-spike`, which measures the crate spike
// in the running dev app against the frame budget (DWX-20) and prints what it
// found as Markdown. The runs and the measuring are in crateSpike.ts.
// The app must be open (`scripts/dev-app start`). While it measures, it holds
// its window in front and filling the screen: WebKit stops drawing a covered
// window, which would spoil the numbers.

import { parseArgs } from "node:util";
import { measure, PLANS, row, type Result } from "./crateSpike.ts";

const HELP = `Usage: scripts/crate-spike [--port <n>] [--only <text>] [--repeat <n>]

Measures the crate spike (Develop › Crate spike) in this checkout's running
dev app, one run at a time, and prints a Markdown line for each. Each result
is also kept in .dev-data/crate-spike/results.jsonl. The app's window comes
to the front and fills the screen while it measures.

  --port <n>     the dev app's port (scripts/dev-app status says; 1440)
  --only <text>  only the runs whose label contains this
  --repeat <n>   how many times to measure each run (3)
  --list         list the runs, and measure nothing`;

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
