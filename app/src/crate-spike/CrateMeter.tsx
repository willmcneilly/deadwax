// Measures the real crate (DWX-21) the way the crate spike is measured
// (DWX-20): `scripts/crate-spike --crate` sends its runs here instead of to
// the spike, and the same scenarios flip and pull records in the app's own
// crate, against the frame budget (DESIGN.md).
//
// Development builds only: Library renders this behind import.meta.env.DEV.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, type RefObject } from "react";
import type { LargeTimes } from "./CrateSpike";
import { painted } from "./frameMeter";
import { onRun, postResult } from "./remote";
import { runScenario, type Controller } from "./scenarios";

/** What the crate lets a measurement do to it. */
export type CrateHandle = {
  count: () => number;
  records: () => number;
  setMany: (on: boolean) => void;
  setFocus: (index: number) => void;
  /** The record nearest `index`, skipping dividers. */
  albumAt: (index: number) => number;
  flip: (index: number) => { react: number; style: number };
  /** Pulls out the record in front, loading its 1600 as never seen if `cold`. */
  pull: (cold: boolean) => void;
  /** Puts it straight back, without the flight. */
  putBack: () => void;
  /** Pretends Spotify is playing the record out, or stops pretending. */
  setPlaying: (on: boolean) => void;
  /** Opens the search wall over the crate with a tile for each record, or closes it. */
  setSearch: (on: boolean) => void;
  /** Scrolls the search wall by this many pixels. */
  scrollSearch: (by: number) => void;
  /** Calls `f` when the pulled-out sleeve's 1600 is decoded and on top. */
  onLargeReady: (f: () => void) => void;
  takeLongestCommit: () => number;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The spike's controller, on the real crate. */
function controller(crate: CrateHandle): Controller {
  let pulledAt = 0;
  let first: Promise<number> = Promise.resolve(0);
  let waiting: ((times: LargeTimes) => void) | null = null;
  crate.onLargeReady(() => {
    const decoded = performance.now();
    const resolve = waiting;
    waiting = null;
    if (!resolve) return;
    void Promise.all([painted(), first]).then(([shown, sleeve]) => {
      const since = (t: number) => Math.round(t - pulledAt);
      resolve({
        loaded: since(decoded),
        decoded: since(decoded),
        painted: since(shown),
        first: since(sleeve),
      });
    });
  });
  return {
    count: crate.count,
    records: crate.records,
    // Scenarios pull from wherever they land: on a record, not a divider.
    setFocus: (index) => crate.setFocus(crate.albumAt(index)),
    flip: crate.flip,
    pull: (cold) => {
      pulledAt = performance.now();
      first = painted();
      crate.pull(cold);
    },
    putBack: crate.putBack,
    largePainted: () => new Promise((resolve) => (waiting = resolve)),
    takeLongestCommit: crate.takeLongestCommit,
    setPlaying: crate.setPlaying,
    setSearch: crate.setSearch,
    scrollSearch: crate.scrollSearch,
  };
}

export default function CrateMeter({
  crate,
}: {
  crate: RefObject<CrateHandle | null>;
}) {
  useEffect(
    () =>
      onRun((run) => {
        if (run.target !== "crate") return;
        void (async () => {
          const handle = crate.current;
          if (!handle) throw new Error("The crate isn't open.");
          handle.putBack();
          handle.setMany(run.many);
          handle.setFocus(0);
          // WebKit stops drawing a covered window, so keep it in front.
          await invoke("crate_spike_keep_in_front", { on: true });
          await wait(1500);
          const result = await runScenario(controller(handle), run).catch(
            (e: unknown) => ({ error: String(e) }),
          );
          const records = handle.records();
          await invoke("crate_spike_keep_in_front", { on: false });
          handle.setMany(false);
          await postResult({
            id: run.id,
            run,
            records,
            window: {
              width: innerWidth,
              height: innerHeight,
              dpr: devicePixelRatio,
              visible: document.visibilityState,
              focused: document.hasFocus(),
            },
            ...result,
          });
        })().catch((e: unknown) =>
          postResult({ id: run.id, run, error: String(e) }),
        );
      }),
    [crate],
  );
  return null;
}
