import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getPlayback,
  nextTrack,
  pausePlayback,
  previousTrack,
  resumePlayback,
  type NowPlaying as Playback,
} from "./api";
import NowPlaying from "./NowPlaying";

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
 * What Spotify is playing, with play/pause, next and previous, and a button
 * that opens now playing over everything. While the window is showing, it
 * asks Spotify every couple of seconds, for itself or for now playing. It
 * waits for each answer before scheduling the next, so a slow reply (or a
 * wait for a rate limit) never stacks requests up.
 */
function PlaybackBar({ started, onFailed }: Props) {
  /** Undefined until Spotify first answers. Null when nothing is playing. */
  const [playback, setPlayback] = useState<Playback | null | undefined>(
    undefined,
  );
  /** When `playback` arrived, so now playing can move the progress on. */
  const [polledAt, setPolledAt] = useState(0);
  const [nowPlaying, setNowPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The last control or now playing call that failed. Now playing covers the
   * Library's alert, so it shows this itself.
   */
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  /** Set when now playing closes, to put focus back on its button. */
  const refocus = useRef(false);
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });

  useEffect(() => {
    if (!nowPlaying && refocus.current) {
      refocus.current = false;
      openButton.current?.focus();
    }
  }, [nowPlaying]);

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
          setPolledAt(Date.now());
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

  /** Passes a failure on, and keeps it for now playing to show. */
  function report(e: unknown) {
    setFailure(errorMessage(e));
    failed.current(e);
  }

  /** Sends a control to Spotify. The next poll shows what it did. */
  async function control(send: () => Promise<void>, then?: () => void) {
    setBusy(true);
    try {
      await send();
      setFailure(null);
      then?.();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }

  const track = playback?.track ?? null;
  const playing = playback?.isPlaying ?? false;
  // Shown straight away: Spotify can take a moment to report the change.
  // The progress so far becomes the new starting point, so now playing's bar
  // stops or starts where it is instead of jumping back to the last poll.
  const toggled = () => {
    const at = Date.now();
    setPlayback((current) => {
      if (!current) return current;
      const counted =
        current.isPlaying && current.progressMs !== null
          ? current.progressMs + Math.max(0, at - polledAt)
          : current.progressMs;
      return {
        ...current,
        isPlaying: !current.isPlaying,
        progressMs:
          counted === null || !current.track
            ? counted
            : Math.min(counted, current.track.durationMs),
      };
    });
    setPolledAt(at);
  };

  const controls = (
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
  );

  if (nowPlaying) {
    return (
      <NowPlaying
        playback={playback}
        polledAt={polledAt}
        error={error}
        failure={failure}
        controls={controls}
        onClose={() => {
          refocus.current = true;
          setNowPlaying(false);
        }}
        onFailed={report}
      />
    );
  }

  return (
    <section className="playback-bar" aria-label="Playback">
      {controls}
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
      <button
        ref={openButton}
        type="button"
        className="secondary playback-open"
        onClick={() => {
          setFailure(null);
          setNowPlaying(true);
        }}
        disabled={track === null}
      >
        Now playing
      </button>
    </section>
  );
}

export default PlaybackBar;
