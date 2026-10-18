// The app's end of the crate spike's line from the shell
// (app/scripts/crateSpikeServer.ts). Vite's hot-reload socket brings each run,
// and the result goes back to the dev server. Development builds only.

import type { Effects } from "./effects";

/** A measurement `scripts/crate-spike` asks for. */
export type Run = {
  id: string;
  scenario: "idle" | "flip" | "pull" | "glow" | "search";
  /** The 400-record crate instead of the real collection. */
  many: boolean;
  effects: Partial<Effects>;
  /** For pull: load the large cover as if it had never been seen. */
  cold?: boolean;
  /** For flip: the time between flips, and how many. */
  stepMs?: number;
  steps?: number;
  /** For idle and glow: how long to measure. */
  seconds?: number;
};

/** Must match RUN_EVENT in app/scripts/crateSpikeServer.ts. */
const RUN_EVENT = "crate-spike:run";

export function onRun(handler: (run: Run) => void): () => void {
  const hot = import.meta.hot;
  if (!hot) return () => {};
  hot.on(RUN_EVENT, handler);
  return () => hot.off(RUN_EVENT, handler);
}

export function postResult(result: object): Promise<unknown> {
  return fetch("/__crate-spike/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
}
