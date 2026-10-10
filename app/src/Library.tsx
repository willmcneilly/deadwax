import { useCallback, useEffect, useState } from "react";
import {
  errorMessage,
  getCollection,
  getSession,
  type AlbumCard,
  type Session,
} from "./api";
import AlbumPage from "./AlbumPage";
import DevList from "./DevList";
import Grid from "./Grid";
import Search from "./Search";
import "./Library.css";

type Props = {
  name: string;
  /** Called when a Spotify call fails because you're no longer signed in. */
  onSignedOut: (session: Session) => void;
};

/** The collection, with the search box above it, or one album's page. */
function Library({ name, onSignedOut }: Props) {
  const [albums, setAlbums] = useState<AlbumCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The album whose page is open, if any. */
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    getCollection().then(setAlbums, (e: unknown) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);

  const added = (album: AlbumCard) =>
    setAlbums((current) => [
      album,
      ...(current ?? []).filter((a) => a.id !== album.id),
    ]);

  function openAlbum(id: string) {
    setError(null);
    setOpen(id);
  }

  // Back to the grid, loaded again: opening an album may have refreshed it.
  function closeAlbum() {
    setError(null);
    setOpen(null);
    load();
  }

  function removed(id: string) {
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
      {open !== null ? (
        <AlbumPage
          key={open}
          id={open}
          onBack={closeAlbum}
          onRemoved={removed}
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
    </div>
  );
}

export default Library;
