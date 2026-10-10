import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getAlbum,
  openAlbumInSpotify,
  refreshAlbum,
  removeAlbum,
  type AlbumDetails,
  type AlbumTrack,
} from "./api";
import Cover from "./Cover";
import "./AlbumPage.css";

type Props = {
  id: string;
  /** Back to the grid. */
  onBack: () => void;
  /** The album has left the collection. */
  onRemoved: (id: string) => void;
  onFailed: (error: unknown) => void;
};

/**
 * One album: the cover, title, artist, year and tracklist, from the cache.
 * A cache over a week old is fetched again, and the page updates when it
 * arrives.
 */
function AlbumPage({ id, onBack, onRemoved, onFailed }: Props) {
  const [album, setAlbum] = useState<AlbumDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
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
                href={`https://open.spotify.com/album/${album.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  openAlbumInSpotify(album.id).catch(onFailed);
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
            <Tracklist tracks={album.tracks} />
          </div>
        </div>
      )}
    </article>
  );
}

/** The tracks in order, under a heading per disc when there's more than one. */
function Tracklist({ tracks }: { tracks: AlbumTrack[] }) {
  const discs = [...new Set(tracks.map((track) => track.disc))];
  if (discs.length <= 1) return <Tracks tracks={tracks} label="Tracks" />;
  return (
    <>
      {discs.map((disc) => (
        <section key={disc}>
          <h2 className="disc">Disc {disc}</h2>
          <Tracks
            tracks={tracks.filter((track) => track.disc === disc)}
            label={`Disc ${disc}`}
          />
        </section>
      ))}
    </>
  );
}

function Tracks({ tracks, label }: { tracks: AlbumTrack[]; label: string }) {
  return (
    <ol className="tracks" aria-label={label}>
      {tracks.map((track) => (
        <li key={track.id} className="track">
          <span className="track-number">{track.number}</span>
          <span className="track-title">{track.title}</span>
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
