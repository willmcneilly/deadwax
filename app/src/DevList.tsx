// The dev list's part of the UI: the offer to restore when the collection is
// empty, and the Develop menu's Reset collection and Restore from dev list.
// See RFC-001, "A dev list that survives resets".
//
// Development builds only. Library renders this behind import.meta.env.DEV,
// so Vite leaves it out of a release build, as Rust leaves out its commands.

import { listen } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** The events the Develop menu's items send (app/src-tauri/src/commands/dev.rs). */
export const RESET_COLLECTION = "reset-collection";
export const RESTORE_FROM_DEV_LIST = "restore-from-dev-list";

export type RestoreReport = {
  restored: number;
  /**
   * Albums Spotify couldn't give us, by Spotify ID: they never got a Deadwax
   * ID. They stay in the dev list.
   */
  failed: { spotifyId: string; message: string }[];
};

const devListMissing = () => invoke<number>("dev_list_missing");
const resetCollection = () => invoke<void>("reset_collection");
const restoreFromDevList = () => invoke<RestoreReport>("restore_from_dev_list");

type Props = {
  /** Whether the collection has loaded and is empty. */
  empty: boolean;
  /** Called after the collection changed, to load it again. */
  onChanged: () => void;
  onFailed: (error: unknown) => void;
};

type State =
  | { kind: "idle" }
  | { kind: "offer"; missing: number }
  | { kind: "restoring" }
  | { kind: "restored"; report: RestoreReport };

const albums = (n: number) => (n === 1 ? "1 album" : `${n} albums`);

function DevList({ empty, onChanged, onFailed }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const failedEvent = useEffectEvent(onFailed);

  // An empty collection offers to restore, if the dev list has albums.
  useEffect(() => {
    if (!empty) return;
    let current = true;
    devListMissing().then(
      (missing) => {
        if (current && missing > 0) setState({ kind: "offer", missing });
      },
      (e: unknown) => failedEvent(e),
    );
    return () => {
      current = false;
    };
  }, [empty]);

  const reset = useEffectEvent(async () => {
    try {
      await resetCollection();
      setState({ kind: "idle" });
      onChanged();
    } catch (e) {
      onFailed(e);
    }
  });
  const restoreEvent = useEffectEvent(() => void restore());

  useEffect(() => {
    const unlisten = [
      listen(RESET_COLLECTION, () => void reset()),
      listen(RESTORE_FROM_DEV_LIST, () => restoreEvent()),
    ];
    return () => {
      for (const stop of unlisten) void stop.then((f) => f());
    };
  }, []);

  async function restore() {
    // The menu can ask again while a restore is running: one is enough.
    if (state.kind === "restoring") return;
    setState({ kind: "restoring" });
    try {
      const report = await restoreFromDevList();
      setState({ kind: "restored", report });
      onChanged();
    } catch (e) {
      setState({ kind: "idle" });
      onFailed(e);
    }
  }

  switch (state.kind) {
    case "idle":
      return null;
    case "offer":
      return (
        <section className="notice" aria-label="Dev list">
          <p>
            Your dev list has {albums(state.missing)} that{" "}
            {state.missing === 1 ? "isn't" : "aren't"} in this collection.
            Restore {state.missing === 1 ? "it" : "them"}?
          </p>
          <button type="button" onClick={() => void restore()}>
            Restore
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setState({ kind: "idle" })}
          >
            Not now
          </button>
        </section>
      );
    case "restoring":
      return (
        <section className="notice" aria-label="Dev list">
          <p>Restoring from the dev list…</p>
        </section>
      );
    case "restored":
      return (
        <section className="notice" aria-label="Dev list">
          <p>Restored {albums(state.report.restored)} from the dev list.</p>
          {state.report.failed.length > 0 && (
            <>
              <p className="error" role="alert">
                Couldn't restore {albums(state.report.failed.length)}:
              </p>
              <ul>
                {state.report.failed.map((f) => (
                  <li key={f.spotifyId}>
                    {f.spotifyId}: {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => setState({ kind: "idle" })}
          >
            OK
          </button>
        </section>
      );
  }
}

export default DevList;
