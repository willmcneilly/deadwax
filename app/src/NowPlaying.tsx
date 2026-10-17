import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  openAlbumInSpotify,
  setNowPlayingFullscreen,
  type NowPlaying as Playback,
} from "./api";
import Cover from "./Cover";
import "./NowPlaying.css";

/**
 * How often the progress bar moves between polls. Its CSS eases each step,
 * so it moves smoothly.
 */
const TICK_MS = 100;

type Props = {
  /** Undefined until Spotify first answers. Null when nothing is playing. */
  playback: Playback | null | undefined;
  /** When `playback` arrived, from `Date.now()`, to move the progress on. */
  polledAt: number;
  /** Why Spotify couldn't say what's playing, if it couldn't. */
  error: string | null;
  /** The last control, link or fullscreen call that failed, if one did. */
  failure: string | null;
  /** The playback bar's controls. */
  controls: ReactNode;
  onClose: () => void;
  onFailed: (error: unknown) => void;
};

/**
 * The cover filling the screen, with the album, the track, a progress bar
 * and the controls (RFC-001, "Now playing"). It goes fullscreen while it's
 * open, and Escape leaves it. The playback bar polls Spotify and passes
 * down what it hears, so this follows a change made on another device too.
 */
function NowPlaying({
  playback,
  polledAt,
  error,
  failure,
  controls,
  onClose,
  onFailed,
}: Props) {
  const failed = useRef(onFailed);
  const close = useRef(onClose);
  useEffect(() => {
    failed.current = onFailed;
    close.current = onClose;
  });
  const leave = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  // Everything else on the page is covered, so it's taken out of the tab
  // order and the accessibility tree until now playing closes.
  useEffect(() => {
    const covered = [...document.body.children].filter(
      (element) => element !== dialog.current && !element.hasAttribute("inert"),
    );
    for (const element of covered) element.setAttribute("inert", "");
    return () => {
      for (const element of covered) element.removeAttribute("inert");
    };
  }, []);

  useEffect(() => {
    setNowPlayingFullscreen(true).catch((e: unknown) => failed.current(e));
    leave.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      setNowPlayingFullscreen(false).catch((e: unknown) => failed.current(e));
    };
  }, []);

  const track = playback?.track ?? null;

  // On the body, outside the app, so the rest of the page can be made inert.
  return createPortal(
    <div
      ref={dialog}
      className="now-playing"
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
    >
      <button
        ref={leave}
        type="button"
        className="secondary now-playing-leave"
        onClick={onClose}
      >
        Leave now playing
      </button>
      {failure !== null && (
        <p className="error now-playing-failure" role="alert">
          {failure}
        </p>
      )}
      {track === null ? (
        <p className="now-playing-quiet" aria-live="polite">
          {error !== null
            ? `Couldn't check what's playing: ${error}`
            : playback === undefined
              ? null
              : playback === null
                ? "Nothing playing"
                : "Spotify is playing something it doesn't describe"}
        </p>
      ) : (
        <>
          <Cover
            album={{
              title: track.album ?? track.title,
              coverUrl: track.coverUrl,
            }}
            className="now-playing-cover"
          />
          <div className="now-playing-details">
            <p className="now-playing-track" aria-live="polite">
              {track.title}
            </p>
            <p className="now-playing-meta">
              {track.artist}
              {track.album && ` · ${track.album}`}
            </p>
            <p className="now-playing-meta">
              {[
                playback?.device && `On ${playback.device}`,
                playback?.isPlaying === false && "Paused",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {error !== null && (
              <p className="error">Couldn't check what's playing: {error}</p>
            )}
            <Progress
              progressMs={playback?.progressMs ?? null}
              durationMs={track.durationMs}
              playing={playback?.isPlaying ?? false}
              polledAt={polledAt}
            />
            {controls}
            {track.spotifyAlbumId !== null && (
              <OpenInSpotify
                spotifyId={track.spotifyAlbumId}
                onFailed={onFailed}
              />
            )}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}

type ProgressProps = {
  progressMs: number | null;
  durationMs: number;
  playing: boolean;
  polledAt: number;
};

/**
 * How far through the track it is. Spotify is only asked every couple of
 * seconds, so while it's playing the bar counts on from the last answer.
 */
function Progress({
  progressMs,
  durationMs,
  playing,
  polledAt,
}: ProgressProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playing) return;
    // Until the first tick, `now` is from before this answer, which counts
    // as no time since it.
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [playing]);

  if (progressMs === null || durationMs <= 0) return null;
  const elapsed = Math.min(
    durationMs,
    progressMs + (playing ? Math.max(0, now - polledAt) : 0),
  );
  const percent = (elapsed / durationMs) * 100;

  return (
    <div className="now-playing-progress">
      <div
        className="now-playing-bar"
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={durationMs}
        aria-valuenow={Math.round(elapsed)}
        aria-valuetext={`${time(elapsed)} of ${time(durationMs)}`}
      >
        <div
          className="now-playing-bar-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="now-playing-time">
        {time(elapsed)} / {time(durationMs)}
      </span>
    </div>
  );
}

/** Milliseconds as minutes and seconds, like 4:15. */
function time(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Spotify's developer policy wants covers and metadata to link back to the
 * album on Spotify (RFC-001, "Spotify's attribution rules"). Rust opens it,
 * in the browser or the Spotify app.
 */
function OpenInSpotify({
  spotifyId,
  onFailed,
}: {
  spotifyId: string;
  onFailed: (error: unknown) => void;
}) {
  return (
    <a
      className="now-playing-spotify"
      href={`https://open.spotify.com/album/${spotifyId}`}
      onClick={(event) => {
        event.preventDefault();
        openAlbumInSpotify(spotifyId).catch(onFailed);
      }}
    >
      Open in Spotify
    </a>
  );
}

export default NowPlaying;
