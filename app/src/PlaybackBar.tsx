import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getPlayback,
  nextTrack,
  pausePlayback,
  previousTrack,
  resumePlayback,
  type NowPlaying,
} from "./api";

/**
 * How often the bar asks Spotify what's playing. Spotify doesn't push
 * changes, so this is how it follows a track skipped from your phone.
 */
const POLL_MS = 2000;

type Props = {
  /** Changes when Deadwax has started something, to ask again straight away. */
  started: number;
  onFailed: (error: unknown) => void;
};

/**
 * What Spotify is playing, with play/pause, next and previous. While the
 * window is showing, it asks Spotify every couple of seconds. It waits for
 * each answer before scheduling the next, so a slow reply (or a wait for a
 * rate limit) never stacks requests up.
 */
function PlaybackBar({ started, onFailed }: Props) {
  /** Undefined until Spotify first answers. Null when nothing is playing. */
  const [playback, setPlayback] = useState<NowPlaying | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      // A hidden window asks nothing, and catches up when it's shown.
      if (document.visibilityState !== "hidden") {
        try {
          const now = await getPlayback();
          if (stopped) return;
          setPlayback(now);
          setError(null);
        } catch (e) {
          if (stopped) return;
          setError(errorMessage(e));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [started]);

  /** Sends a control to Spotify. The next poll shows what it did. */
  async function control(send: () => Promise<void>, then?: () => void) {
    setBusy(true);
    try {
      await send();
      then?.();
    } catch (e) {
      failed.current(e);
    } finally {
      setBusy(false);
    }
  }

  const track = playback?.track ?? null;
  const playing = playback?.isPlaying ?? false;
  // Shown straight away: Spotify can take a moment to report the change.
  const toggled = () =>
    setPlayback((current) =>
      current ? { ...current, isPlaying: !current.isPlaying } : current,
    );

  return (
    <section className="playback-bar" aria-label="Playback">
      <div className="playback-controls">
        <button
          type="button"
          className="secondary"
          aria-label="Previous track"
          onClick={() => void control(previousTrack)}
          disabled={busy || !playback}
        >
          ⏮
        </button>
        <button
          type="button"
          aria-label={playing ? "Pause" : "Resume"}
          onClick={() =>
            void control(playing ? pausePlayback : resumePlayback, toggled)
          }
          disabled={busy || !playback}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          className="secondary"
          aria-label="Next track"
          onClick={() => void control(nextTrack)}
          disabled={busy || !playback}
        >
          ⏭
        </button>
      </div>
      <div className="playback-now" aria-live="polite">
        {error !== null ? (
          <span className="error">Couldn't check what's playing: {error}</span>
        ) : playback === undefined ? null : playback === null ? (
          <span className="playback-quiet">Nothing playing</span>
        ) : track === null ? (
          <span className="playback-quiet">
            Spotify is playing something it doesn't describe
          </span>
        ) : (
          <>
            <span className="playback-track">{track.title}</span>
            <span className="playback-meta">
              {track.artist}
              {track.album && ` · ${track.album}`}
              {playback.device && ` · on ${playback.device}`}
              {!playing && " · paused"}
            </span>
          </>
        )}
      </div>
    </section>
  );
}

export default PlaybackBar;
