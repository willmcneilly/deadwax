// Opens the crate spike (DWX-20) when the Develop menu's Crate spike item or
// `scripts/crate-spike` asks for it. main.tsx imports this only behind
// import.meta.env.DEV, so a release build has none of it.

import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import CrateSpike from "./CrateSpike";
import { onRun, type Run } from "./remote";

/** The event the Develop menu's item sends (app/src-tauri/src/commands/dev.rs). */
export const CRATE_SPIKE = "crate-spike";

export default function CrateSpikeHost() {
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    const unlisten = listen(CRATE_SPIKE, () => setOpen(true));
    const stop = onRun((next) => {
      setOpen(true);
      setRun(next);
    });
    return () => {
      stop();
      void unlisten.then((f) => f());
    };
  }, []);

  if (!open) return null;
  return <CrateSpike run={run} onClose={() => setOpen(false)} />;
}
