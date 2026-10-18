// The sleeve you've pulled out of the crate (RFC-002, "4. The UI"). It flies
// out from its place, shows its cover large, and turns over to its back: the
// tracklist in sides, the year and the label, Open in Spotify and a quiet way
// to take it out of the crate. Picking a track plays the album from there, on
// the device chosen below it.
//
// Kept to DESIGN.md's rules: no CSS filter on the cover (rule 3), the back is
// built the first time it's turned over (rule 4), and the 1600 the crate
// decoded ahead comes in over the 640 already on screen (rule 5).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import AlbumColours from "./AlbumColours";
import {
  errorMessage,
  getAlbum,
  openAlbumInSpotify,
  playAlbum,
  refreshAlbum,
  removeAlbum,
  type AlbumCard,
  type AlbumDetails,
  type AlbumId,
  type AlbumTrack,
} from "./api";
import { SleeveFront } from "./Crate";
import DevicePicker from "./DevicePicker";
import { duration, sides } from "./sides";
import { wearStyle } from "./textures";
import useDevices from "./useDevices";
import "./Sleeve.css";

const FLY_OUT = { duration: 760, easing: "cubic-bezier(.2,.75,.15,1)" };
const FLY_BACK = {
  duration: 620,
  delay: 260,
  easing: "cubic-bezier(.5,0,.3,1)",
  fill: "forwards" as const,
};

type Props = {
  album: AlbumCard;
  /** Its place in the crate, on screen: it flies out from there, and back. */
  from: DOMRect;
  /** How many times it's been turned over: odd shows the back. */
  turns: number;
  onTurn: () => void;
  /** Going back into the crate. */
  returning: boolean;
  /** It's back in its place. */
  onReturned: () => void;
  /** It has left the collection. */
  onRemoved: (id: AlbumId) => void;
  /** Spotify has started playing it. */
  onPlayed: () => void;
  onFailed: (error: unknown) => void;
  /** The 1600 is decoded and on top (the crate spike's measuring). */
  onLargeReady?: () => void;
};

function Sleeve({
  album,
  from,
  turns,
  onTurn,
  returning,
  onReturned,
  onRemoved,
  onPlayed,
  onFailed,
  onLargeReady,
}: Props) {
  const lift = useRef<HTMLDivElement>(null);
  const [details, setDetails] = useState<AlbumDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const devices = useDevices(onFailed);
  // The latest handlers, so new ones from the parent don't load it again.
  const failed = useRef(onFailed);
  const returned = useRef(onReturned);
  useEffect(() => {
    failed.current = onFailed;
    returned.current = onReturned;
  });
  const back = turns % 2 === 1;
  const id = album.id;

  // The tracklist, from the cache, then fetched again if it's over a week
  // old, as Spotify's terms ask (RFC-001, "The collection").
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const cached = await getAlbum(id);
        if (!current) return;
        setDetails(cached);
      } catch (e) {
        if (current) setError(errorMessage(e));
        return;
      }
      try {
        const fresh = await refreshAlbum(id);
        if (current && fresh) setDetails(fresh);
      } catch (e) {
        // The cached tracklist stays: it's still worth showing.
        if (current) failed.current(e);
      }
    })();
    return () => {
      current = false;
    };
  }, [id]);

  /**
   * The transform that puts the sleeve over its place in the crate. It's
   * worked out from where the sleeve sits without any flight on it (its
   * layout box, not getBoundingClientRect), so a flight already running
   * can't throw it off. React runs this effect twice in development, and the
   * second run used to measure the first flight's start, fly nowhere, and
   * replace it: the sleeve just appeared.
   */
  const toCrate = () => {
    const el = lift.current;
    const parent = el?.offsetParent?.getBoundingClientRect();
    if (!el || !parent || !el.offsetWidth) return "none";
    const left = parent.left + el.offsetLeft;
    const top = parent.top + el.offsetTop;
    const dx = from.left + from.width / 2 - (left + el.offsetWidth / 2);
    const dy = from.top + from.height / 2 - (top + el.offsetHeight / 2);
    return `translate(${dx}px, ${dy}px) scale(${from.width / el.offsetWidth})`;
  };

  useLayoutEffect(() => {
    lift.current?.animate([{ transform: toCrate() }, { transform: "none" }], FLY_OUT);
    // Only when it first comes out.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- from is where it came from, fixed while it's out
  }, []);

  useEffect(() => {
    if (!returning) return;
    // Its place in the crate shows again under it as it flies back, and it
    // fades over the last stretch, rather than a flat sleeve being swapped
    // for the crate's tilted one at the end, which snapped.
    const to = toCrate();
    const flight = lift.current?.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: to, opacity: 1, offset: 0.8 },
        { transform: to, opacity: 0 },
      ],
      FLY_BACK,
    );
    if (!flight) {
      returned.current();
      return;
    }
    flight.onfinish = () => returned.current();
    return () => flight.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toCrate reads the fixed `from`
  }, [returning]);

  /**
   * Plays the album from this track on the chosen device. If Spotify isn't
   * listing the device, the picker below says so.
   */
  async function play(trackId: string) {
    if (devices.selected === null) return;
    setStarting(true);
    try {
      const outcome = await playAlbum(id, devices.selected, trackId);
      devices.setDevices(outcome.devices);
      if (outcome.state === "playing") onPlayed();
    } catch (e) {
      onFailed(e);
    } finally {
      setStarting(false);
    }
  }
  const canPlay = devices.selected !== null && !starting;

  const large = album.covers?.large;
  const medium = album.covers?.medium;

  return (
    <div className={`sleeve-out ${returning ? "returning" : ""}`}>
      <div className="sleeve-lift" ref={lift}>
        <div
          className="sleeve-flipper"
          style={{ transform: `rotateY(${turns * 180}deg)` }}
        >
          <div
            className="sleeve-side front"
            aria-hidden={back}
            role="button"
            aria-label={`Turn ${album.title} over`}
            onClick={() => !back && onTurn()}
          >
            <SleeveFront album={album} src={medium}>
              {large && large !== medium && (
                <img
                  className={`large ${ready ? "ready" : ""}`}
                  src={large}
                  alt=""
                  draggable={false}
                  onLoad={(e) => {
                    void e.currentTarget
                      .decode()
                      .catch(() => {})
                      .then(() => {
                        setReady(true);
                        onLargeReady?.();
                      });
                  }}
                />
              )}
            </SleeveFront>
          </div>
          <div
            className="sleeve-side back"
            aria-hidden={!back}
            onClick={(e) => {
              if (back && !(e.target as HTMLElement).closest("button, a")) {
                onTurn();
              }
            }}
          >
            {turns > 0 && (
              <SleeveBack
                album={album}
                details={details}
                error={error}
                onPlay={canPlay ? (track) => void play(track) : null}
                onRemoved={onRemoved}
                onFailed={onFailed}
              />
            )}
          </div>
        </div>
      </div>
      <div className="sleeve-desk">
        <DevicePicker
          devices={devices.devices}
          selected={devices.selected}
          refreshing={devices.refreshing}
          onChoose={devices.choose}
          onRefresh={devices.refresh}
        />
        {starting && <p className="device-note">Starting…</p>}
      </div>
    </div>
  );
}

type BackProps = {
  album: AlbumCard;
  details: AlbumDetails | null;
  error: string | null;
  /** Plays the album from the track with this Spotify ID. Null when it can't. */
  onPlay: ((trackId: string) => void) | null;
  onRemoved: (id: AlbumId) => void;
  onFailed: (error: unknown) => void;
};

/**
 * The back of the sleeve, printed in the album's own colours: the artist and
 * title, the tracklist in sides, the year and label, then Open in Spotify,
 * and under it a quiet way to take the album out of the crate, which asks
 * first (RFC-002, resolved open question 1).
 */
function SleeveBack({
  album,
  details,
  error,
  onPlay,
  onRemoved,
  onFailed,
}: BackProps) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const tracks = details?.tracks ?? [];
  // Long tracklists set smaller, so they fit on the sleeve.
  const n = tracks.length;
  const scale = n > 18 ? 0.019 : n > 13 ? 0.023 : n > 9 ? 0.027 : 0.031;

  async function remove() {
    setRemoving(true);
    try {
      await removeAlbum(album.id);
      onRemoved(album.id);
    } catch (e) {
      setRemoving(false);
      onFailed(e);
    }
  }

  return (
    <AlbumColours
      palette={album.palette}
      className="sleeve-face back"
      style={album.worn ? wearStyle(album.id) : undefined}
    >
      <div
        className="back-inner"
        style={{ ["--fs" as string]: scale }}
        aria-label={`The back of ${album.title}`}
        role="group"
      >
        <header>
          <p className="back-artist">{album.artist}</p>
          <h2 className="back-title">{album.title}</h2>
        </header>
        {error ? (
          <p className="back-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="back-sides">
            {sides(tracks).map((side) => (
              <section key={side.name} aria-label={`Side ${side.name}`}>
                <h3>Side {side.name}</h3>
                <ol>
                  {side.tracks.map((track, i) => (
                    <li key={track.spotifyId || `${side.name}${i}`}>
                      {/* A track Spotify gave no ID (a local file) can't be played. */}
                      {track.spotifyId ? (
                        <button
                          type="button"
                          className="track"
                          aria-label={`Play ${track.title}`}
                          disabled={!onPlay}
                          onClick={() => onPlay?.(track.spotifyId)}
                        >
                          <TrackLine side={side.name} at={i} track={track} />
                        </button>
                      ) : (
                        <span className="track">
                          <TrackLine side={side.name} at={i} track={track} />
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
        <footer>
          <span>{[album.year, album.label].filter(Boolean).join(" · ")}</span>
          <span>33⅓ RPM · Stereo</span>
        </footer>
        <div className="back-foot">
          {/* Spotify's developer policy wants every album to link back to
              it (RFC-001, "Spotify's attribution rules"). Rust opens it, in
              the browser or the Spotify app. */}
          <a
            href={`https://open.spotify.com/album/${album.spotifyId}`}
            onClick={(event) => {
              event.preventDefault();
              openAlbumInSpotify(album.spotifyId).catch(onFailed);
            }}
          >
            Open in Spotify
          </a>
          {confirming ? (
            <span className="back-confirm" role="group" aria-label="Take it out of the crate?">
              Take it out of the crate?
              <button type="button" onClick={() => void remove()} disabled={removing}>
                {removing ? "Taking it out…" : "Take it out"}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={removing}>
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" className="back-quiet" onClick={() => setConfirming(true)}>
              Take it out of the crate
            </button>
          )}
        </div>
      </div>
      {album.worn && <div className="wear" />}
    </AlbumColours>
  );
}

/** A track's place on its side ("A3"), its title and how long it is. */
function TrackLine({
  side,
  at,
  track,
}: {
  side: string;
  at: number;
  track: AlbumTrack;
}) {
  return (
    <>
      <span className="num">
        {side}
        {at + 1}
      </span>
      <span className="name">{track.title}</span>
      <span className="dur">{duration(track.durationMs)}</span>
    </>
  );
}

export default Sleeve;
