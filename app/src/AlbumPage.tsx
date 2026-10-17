import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import {
  ALBUM_UPDATED,
  errorMessage,
  getAlbum,
  openAlbumInSpotify,
  playAlbum,
  refreshAlbum,
  removeAlbum,
  type AlbumDetails,
  type AlbumId,
  type AlbumTrack,
} from "./api";
import Cover from "./Cover";
import DevicePicker from "./DevicePicker";
import useDevices from "./useDevices";
import "./AlbumPage.css";

type Props = {
  id: AlbumId;
  /** Back to the grid. */
  onBack: () => void;
  /** The album has left the collection. */
  onRemoved: (id: AlbumId) => void;
  /** Spotify has started playing the album. */
  onPlayed: () => void;
  onFailed: (error: unknown) => void;
};

/**
 * One album: the cover, title, artist, year and tracklist, from the cache.
 * A cache over a week old is fetched again, and the page updates when it
 * arrives. So does the cover, when Rust has it on disk.
 */
function AlbumPage({ id, onBack, onRemoved, onPlayed, onFailed }: Props) {
  const [album, setAlbum] = useState<AlbumDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [starting, setStarting] = useState(false);
  const devices = useDevices(onFailed);
  // The latest handler, so a new one from the parent doesn't load the page
  // again.
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const cached = await getAlbum(id);
        if (!current) return;
        setAlbum(cached);
      } catch (e) {
        if (current) setError(errorMessage(e));
        return;
      }
      try {
        const fresh = await refreshAlbum(id);
        if (current && fresh) setAlbum(fresh);
      } catch (e) {
        // The cached page stays: it's still worth showing.
        if (current) failed.current(e);
      }
    })();
    return () => {
      current = false;
    };
  }, [id]);

  // Rust downloads the cover in the background, and says when it's on disk.
  useEffect(() => {
    let current = true;
    const unlisten = listen<string>(ALBUM_UPDATED, (event) => {
      if (event.payload !== id) return;
      getAlbum(id).then(
        (found) => {
          if (current) setAlbum(found);
        },
        (e: unknown) => {
          if (current) failed.current(e);
        },
      );
    });
    return () => {
      current = false;
      void unlisten.then((stop) => stop());
    };
  }, [id]);

  /**
   * Plays the album on the chosen device, from the first track or `trackId`.
   * Rust asks Spotify for its devices first. If the device isn't listed, the
   * picker says so.
   */
  async function play(trackId: string | null) {
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

  async function remove() {
    setRemoving(true);
    try {
      await removeAlbum(id);
      onRemoved(id);
    } catch (e) {
      setRemoving(false);
      onFailed(e);
    }
  }

  return (
    <article className="album-page">
      <button type="button" className="secondary back" onClick={onBack}>
        ← Your collection
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {album && (
        <div className="album">
          <Cover album={album} className="album-cover" />
          <div className="album-details">
            <h1 className="album-title">{album.title}</h1>
            <p className="album-meta">
              {album.artist}
              {album.year !== null && ` · ${album.year}`}
            </p>
            <div className="album-actions">
              {/* Spotify's developer policy wants every album page to link
                  back to it (RFC-001, "Spotify's attribution rules"). Rust
                  opens it, in the browser or the Spotify app. */}
              <a
                href={`https://open.spotify.com/album/${album.spotifyId}`}
                onClick={(event) => {
                  event.preventDefault();
                  openAlbumInSpotify(album.spotifyId).catch(onFailed);
                }}
              >
                Open in Spotify
              </a>
              <button
                type="button"
                className="secondary"
                onClick={() => void remove()}
                disabled={removing}
              >
                {removing ? "Removing…" : "Remove from collection"}
              </button>
            </div>
            <div className="album-play">
              <button
                type="button"
                onClick={() => void play(null)}
                disabled={!canPlay}
              >
                {starting ? "Starting…" : "Play"}
              </button>
              <DevicePicker
                devices={devices.devices}
                selected={devices.selected}
                refreshing={devices.refreshing}
                onChoose={devices.choose}
                onRefresh={devices.refresh}
              />
            </div>
            <Tracklist
              tracks={album.tracks}
              onPlay={canPlay ? (track) => void play(track) : null}
            />
          </div>
        </div>
      )}
    </article>
  );
}

type TracksProps = {
  tracks: AlbumTrack[];
  /** Plays the album from the track with this ID. Null when it can't. */
  onPlay: ((trackId: string) => void) | null;
};

/**
 * The tracks in order, under a heading per disc when there's more than one.
 * Clicking a track plays the album from there.
 */
function Tracklist({ tracks, onPlay }: TracksProps) {
  const discs = [...new Set(tracks.map((track) => track.disc))];
  if (discs.length <= 1)
    return <Tracks tracks={tracks} label="Tracks" onPlay={onPlay} />;
  return (
    <>
      {discs.map((disc) => (
        <section key={disc}>
          <h2 className="disc">Disc {disc}</h2>
          <Tracks
            tracks={tracks.filter((track) => track.disc === disc)}
            label={`Disc ${disc}`}
            onPlay={onPlay}
          />
        </section>
      ))}
    </>
  );
}

function Tracks({
  tracks,
  label,
  onPlay,
}: TracksProps & {
  label: string;
}) {
  return (
    <ol className="tracks" aria-label={label}>
      {tracks.map((track, index) => (
        <li key={track.spotifyId || index} className="track">
          <span className="track-number">{track.number}</span>
          {/* A track Spotify gave no ID (a local file) can't be played. */}
          {track.spotifyId ? (
            <button
              type="button"
              className="track-title"
              aria-label={`Play ${track.title}`}
              onClick={() => onPlay?.(track.spotifyId)}
              disabled={!onPlay}
            >
              {track.title}
            </button>
          ) : (
            <span className="track-title">{track.title}</span>
          )}
          <span className="track-duration">{duration(track.durationMs)}</span>
        </li>
      ))}
    </ol>
  );
}

/** 237293 → "3:57". */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}:${rest.toString().padStart(2, "0")}`;
}

export default AlbumPage;
