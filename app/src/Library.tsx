import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  ALBUM_UPDATED,
  errorMessage,
  getCollection,
  getSession,
  type AlbumCard,
  type AlbumId,
  type Session,
} from "./api";
import AlbumPage from "./AlbumPage";
import ArtworkReport from "./ArtworkReport";
import DevList from "./DevList";
import Grid from "./Grid";
import PlaybackBar from "./PlaybackBar";
import Search from "./Search";
import "./Library.css";

type Props = {
  name: string;
  /** Called when a Spotify call fails because you're no longer signed in. */
  onSignedOut: (session: Session) => void;
};

/**
 * The collection, with the search box above it, or one album's page. The
 * playback bar is always at the bottom.
 */
function Library({ name, onSignedOut }: Props) {
  const [albums, setAlbums] = useState<AlbumCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The album whose page is open, if any. */
  const [open, setOpen] = useState<AlbumId | null>(null);
  /** Counts albums started, so the playback bar asks again straight away. */
  const [started, setStarted] = useState(0);

  const load = useCallback(() => {
    getCollection().then(setAlbums, (e: unknown) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);

  // When an album's cover is on disk, the grid loads again, so its card
  // swaps Spotify's cover for its own in place.
  useEffect(() => {
    const unlisten = listen(ALBUM_UPDATED, () => load());
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [load]);

  const added = (album: AlbumCard) =>
    setAlbums((current) => [
      album,
      ...(current ?? []).filter((a) => a.id !== album.id),
    ]);

  function openAlbum(id: AlbumId) {
    setError(null);
    setOpen(id);
  }

  // Back to the grid, loaded again: opening an album may have refreshed it.
  function closeAlbum() {
    setError(null);
    setOpen(null);
    load();
  }

  function removed(id: AlbumId) {
    setAlbums((current) => current?.filter((a) => a.id !== id) ?? null);
    closeAlbum();
  }

  // A failed Spotify call may mean the sign-in has expired. If so, go back
  // to the sign-in screen with what Rust said, rather than an error here.
  async function failed(e: unknown) {
    const message = errorMessage(e);
    const session = await getSession().catch(() => null);
    if (session?.state === "signedOut") {
      onSignedOut({ state: "signedOut", message });
    } else if (session && session.state !== "signedIn") {
      onSignedOut(session);
    } else {
      setError(message);
    }
  }

  return (
    <div className="library">
      <header className="library-header">
        <p className="signed-in">Signed in as {name}</p>
      </header>
      {open === null && (
        <Search
          onAdded={added}
          onFailed={failed}
          onStarted={() => setError(null)}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {import.meta.env.DEV && <ArtworkReport onFailed={failed} />}
      {open !== null ? (
        <AlbumPage
          key={open}
          id={open}
          onBack={closeAlbum}
          onRemoved={removed}
          onPlayed={() => setStarted((n) => n + 1)}
          onFailed={failed}
        />
      ) : (
        <>
          {import.meta.env.DEV && (
            <DevList
              empty={albums?.length === 0}
              onChanged={load}
              onFailed={failed}
            />
          )}
          {albums && <Grid albums={albums} onOpen={openAlbum} />}
        </>
      )}
      <PlaybackBar started={started} onFailed={failed} />
    </div>
  );
}

export default Library;
