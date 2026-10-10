import { useEffect, useState } from "react";
import {
  errorMessage,
  getCollection,
  getSession,
  type AlbumCard,
  type Session,
} from "./api";
import Grid from "./Grid";
import Search from "./Search";
import "./Library.css";

type Props = {
  name: string;
  /** Called when a Spotify call fails because you're no longer signed in. */
  onSignedOut: (session: Session) => void;
};

/** The collection, with the search box above it. */
function Library({ name, onSignedOut }: Props) {
  const [albums, setAlbums] = useState<AlbumCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCollection().then(setAlbums, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const added = (album: AlbumCard) =>
    setAlbums((current) => [
      album,
      ...(current ?? []).filter((a) => a.id !== album.id),
    ]);

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
      <Search
        onAdded={added}
        onFailed={failed}
        onStarted={() => setError(null)}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {albums && <Grid albums={albums} />}
    </div>
  );
}

export default Library;
