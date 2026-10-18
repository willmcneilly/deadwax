// Now playing (RFC-002, "4. The UI"): the line under the floating record,
// and the chip that stands for it when the record is back in the crate.
//
// The clock counts on from Spotify's last answer by itself, writing only its
// own text and bar, so nothing else redraws while it runs (PR #16's advice,
// DESIGN.md rule 8). It holds at 0:00 while the needle drops.

import { useLayoutEffect, useRef } from "react";
import { openAlbumInSpotify, type AlbumTrack } from "./api";
import { time, type Live } from "./playing";
import { sides } from "./sides";
import "./NowLine.css";

/** How often the clock moves. Its bar eases each step, so it moves smoothly. */
const TICK_MS = 250;

/** "Side B · 3" for a record whose tracklist is known. */
function where(live: Live, tracks: AlbumTrack[] | null): string {
  if (live.kind === "advert") return "Spotify";
  if (live.kind === "stranger") return "Not in your crate";
  for (const side of sides(tracks ?? [])) {
    const at = side.tracks.findIndex(
      (t) =>
        (live.trackId !== null && t.spotifyId === live.trackId) ||
        (t.disc === live.disc && t.number === live.number),
    );
    if (at >= 0) return `Side ${side.name} · ${at + 1}`;
  }
  return "Playing";
}

type Props = {
  live: Live;
  /** The record's tracklist, to say which side the track is on. */
  tracks: AlbumTrack[] | null;
  /** Offered for a stranger's record. */
  onAdd?: () => void;
  adding?: boolean;
  onFailed: (error: unknown) => void;
};

/** The line under the floating record: where it is, the track and the clock. */
export function NowLine({ live, tracks, onAdd, adding = false, onFailed }: Props) {
  const state = live.starting ? " · starting" : live.paused ? " · paused" : "";
  return (
    <section
      className={`now-line ${live.starting ? "starting" : ""}`}
      aria-label="Now playing"
    >
      <p className="now-side" aria-live="polite">
        {where(live, tracks)}
        {state}
      </p>
      <h1 className="now-title" aria-live="polite">
        {live.title}
      </h1>
      {live.kind !== "advert" && (
        <p className="now-album">
          {live.artist}
          {live.album && ` — ${live.album}`}
          {live.device && ` · on ${live.device}`}
        </p>
      )}
      {live.durationMs > 0 && <Clock live={live} />}
      <p className="now-links">
        {onAdd && (
          <button type="button" onClick={onAdd} disabled={adding}>
            {adding ? "Adding…" : "Add to the crate"}
          </button>
        )}
        {live.spotifyAlbumId !== null && (
          <OpenInSpotify spotifyId={live.spotifyAlbumId} onFailed={onFailed} />
        )}
      </p>
    </section>
  );
}

/**
 * How far through the track it is. Between Spotify's answers it counts on
 * by itself, straight into its own text and bar, so a tick redraws nothing
 * in React.
 */
function Clock({ live }: { live: Live }) {
  const elapsed = useRef<HTMLSpanElement>(null);
  const left = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const moving = !live.starting && !live.paused;
    const draw = () => {
      const counted = live.starting
        ? 0
        : live.positionMs + (moving ? Math.max(0, Date.now() - live.at) : 0);
      const at = Math.min(counted, live.durationMs);
      if (elapsed.current) elapsed.current.textContent = time(at);
      if (left.current) left.current.textContent = `−${time(live.durationMs - at)}`;
      if (fill.current) {
        fill.current.style.transform = `scaleX(${at / live.durationMs})`;
      }
    };
    draw();
    if (!moving) return;
    const timer = setInterval(draw, TICK_MS);
    return () => clearInterval(timer);
  }, [live]);

  return (
    <div className="now-bar" role="timer" aria-label="Clock">
      <span ref={elapsed} className="now-elapsed" />
      <div className="now-track">
        <div ref={fill} />
      </div>
      <span ref={left} className="now-left" />
    </div>
  );
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

/**
 * What's playing, small, at the bottom right of the crate. Clicking it
 * brings the record out: from its place in the crate, or a stranger's from
 * below.
 */
export function Chip({
  live,
  cover,
  onOpen,
}: {
  live: Live;
  /** A small cover: the record's 320, or Spotify's for a stranger's. */
  cover: string | null;
  onOpen: () => void;
}) {
  const advert = live.kind === "advert";
  return (
    <section
      className={`chip ${live.kind === "stranger" ? "stranger" : ""}`}
      aria-label="Playing"
    >
      <button
        type="button"
        className="chip-open"
        onClick={onOpen}
        disabled={advert}
        aria-label={advert ? "An advert" : `Bring out ${live.album ?? live.title}`}
      >
        {!advert && cover && <img src={cover} alt="" />}
        <span>
          <strong>{live.title}</strong>
          {advert ? "Spotify" : live.artist}
          {live.paused && " · paused"}
        </span>
      </button>
      {live.device && <span className="chip-device">{live.device}</span>}
    </section>
  );
}
