// The command line for `scripts/crate-spike`, which measures the crate spike
// in the running dev app against the frame budget (DWX-20) and prints what it
// found as Markdown. The runs and the measuring are in crateSpike.ts.
// The app must be open (`scripts/dev-app start`). While it measures, it holds
// its window in front and filling the screen: WebKit stops drawing a covered
// window, which would spoil the numbers.

import { parseArgs } from "node:util";
import { join } from "node:path";
import { CRATE_PLANS, measure, PLANS, row, type Result } from "./crateSpike.ts";
import { putBackCheck, summary } from "./putBack.ts";

const HELP = `Usage: scripts/crate-spike [--crate] [--port <n>] [--only <text>] [--repeat <n>]
       scripts/crate-spike --put-back [--times <n>] [--keep-video] [--port <n>]

Measures the crate spike (Develop › Crate spike) in this checkout's running
dev app, one run at a time, and prints a Markdown line for each. With
--crate, it measures the app's own crate instead (DWX-21), on the crate's
screen: sign in first. Each result
is also kept in .dev-data/crate-spike/results.jsonl. The app's window comes
to the front and fills the screen while it measures.

  --crate        the app's own crate, not the spike
  --port <n>     the dev app's port (scripts/dev-app status says; 1440)
  --only <text>  only the runs whose label contains this
  --repeat <n>   how many times to measure each run (3)
  --list         list the runs, and measure nothing

  --put-back     puts the record in front back into the app's own crate,
                 --times times (20), every other one floating as if
                 playing, while recording the screen at 60 fps, and says
                 at which landings anything showed through where the
                 record should be (DWX-35). Needs ffmpeg. The frame by
                 frame numbers go in .dev-data/crate-spike/put-back-*/
  --keep-video   keep that recording there too (about 10 MB a second)`;

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "1440" },
      only: { type: "string" },
      repeat: { type: "string", default: "3" },
      list: { type: "boolean", default: false },
      crate: { type: "boolean", default: false },
      "put-back": { type: "boolean", default: false },
      times: { type: "string", default: "20" },
      "keep-video": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values["put-back"]) {
    const times = Number(values.times);
    const dir = join(
      import.meta.dirname,
      "../../.dev-data/crate-spike",
      `put-back-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    const report = await putBackCheck(Number(values.port), times, dir, values["keep-video"]);
    console.log(summary(report, times));
    if (report.landings.some((l) => l.through.length > 0)) process.exitCode = 1;
    return;
  }
  const plans = (values.crate ? CRATE_PLANS : PLANS).filter((p) => !values.only || p.label.includes(values.only));
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
