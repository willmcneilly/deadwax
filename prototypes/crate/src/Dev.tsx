import { useEffect, useReducer, useState } from "react";
import {
  elsewhere,
  fixtureAlbum,
  forgetDevice,
  peek,
  remembered,
  scenario,
  setAccount,
  setAwake,
  setCollection,
  setScenario,
  subscribe,
  type Failure,
} from "./connect/fake";
import { cleanTitle } from "./types";

const FAILURES: { id: Failure; label: string }[] = [
  { id: "slow", label: "429, waited out (5 s)" },
  { id: "rateLimited", label: "429, too long" },
  { id: "serverError", label: "502" },
  { id: "network", label: "No network" },
];

// The dev panel: puts the pretend Spotify into each state the design has to
// cover. Press ` (backtick) to open it. Development builds only, like the
// app's Develop menu.
export function Dev() {
  const [open, setOpen] = useState(new URLSearchParams(location.search).has("dev"));
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "`" && !(e.target as HTMLElement).closest?.("input")) setOpen((o) => !o);
    };
    addEventListener("keydown", key);
    const off = subscribe(redraw);
    const t = setInterval(redraw, 1000);
    return () => {
      removeEventListener("keydown", key);
      off();
      clearInterval(t);
    };
  }, []);

  if (!import.meta.env.DEV || !open) return null;
  const { play } = peek();
  const album = play && fixtureAlbum(play.albumId);

  return (
    <aside className="dev" aria-label="Dev panel">
      <header>
        <strong>Pretend Spotify</strong>
        <button onClick={() => setOpen(false)}>×</button>
      </header>

      <section>
        <h4>Account</h4>
        <div className="dev-row">
          <button onClick={() => setAccount("needsClientId")}>No client ID</button>
          <button onClick={() => setAccount("signedOut")}>Signed out</button>
          <button onClick={() => setAccount("expired")}>Expired</button>
          <button onClick={() => setAccount("signedIn")}>Signed in</button>
        </div>
        <label>
          <input
            type="checkbox"
            checked={scenario.signInFails}
            onChange={(e) => setScenario({ signInFails: e.target.checked })}
          />
          Sign-in fails in the browser
        </label>
      </section>

      <section>
        <h4>Collection</h4>
        <div className="dev-row">
          <button onClick={() => setCollection("empty")}>Empty (first run)</button>
          <button onClick={() => setCollection("full")}>The fixture's</button>
        </div>
      </section>

      <section>
        <h4>Devices · Spotify lists the awake ones</h4>
        {scenario.devices.map((d) => (
          <label key={d.name}>
            <input type="checkbox" checked={d.awake} onChange={(e) => setAwake(d.name, e.target.checked)} />
            {d.name}
            <em>
              {d.kind}
              {!d.canPlay && " · can't be controlled"}
              {play?.device === d.name && " · playing"}
            </em>
          </label>
        ))}
        <div className="dev-row">
          <span>Remembered: {remembered() ?? "none"}</span>
          <button onClick={forgetDevice} disabled={!remembered()}>
            Forget
          </button>
        </div>
        <label>
          <input
            type="checkbox"
            checked={scenario.slowStart}
            onChange={(e) => setScenario({ slowStart: e.target.checked })}
          />
          Slow to start (5–7 s, not 1–3)
        </label>
      </section>

      <section>
        <h4>Someone on their phone</h4>
        <div className="dev-row">
          <button onClick={elsewhere.skip} disabled={!play}>
            Skip
          </button>
          <button onClick={elsewhere.pause} disabled={!play}>
            {play?.playing ? "Pause" : "Resume"}
          </button>
          <button onClick={elsewhere.playAnother}>Another album</button>
          <button onClick={elsewhere.playStranger}>Not in the crate</button>
          <button onClick={elsewhere.advert}>Advert</button>
          <button onClick={() => elsewhere.moveTo("Will's iPhone")} disabled={!play}>
            Move to iPhone
          </button>
          <button onClick={elsewhere.stop} disabled={!play}>
            Stop
          </button>
        </div>
      </section>

      <section>
        <h4>Spotify</h4>
        <label>
          <input
            type="checkbox"
            checked={scenario.spotifyDown}
            onChange={(e) => setScenario({ spotifyDown: e.target.checked })}
          />
          Down: every call fails
        </label>
        <p className="dev-small">The next action (play, search, add, a control) gets:</p>
        <div className="dev-row">
          {FAILURES.map((f) => (
            <button
              key={f.id}
              className={scenario.failNext === f.id ? "on" : undefined}
              onClick={() => setScenario({ failNext: scenario.failNext === f.id ? null : f.id })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </section>

      <footer>
        {play
          ? play.advertUntil
            ? `Advert on ${play.device}`
            : `${play.playing ? "Playing" : "Paused"}: ${album ? cleanTitle(album.tracks[play.index].title) : "?"} on ${play.device}`
          : "Nothing playing"}
        <br />
        The app asks every 2 s.
      </footer>
    </aside>
  );
}
