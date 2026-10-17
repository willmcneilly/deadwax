import { useRef, useState, type FormEvent } from "react";
import {
  addAlbum,
  searchAlbums,
  type AlbumCard,
  type SearchResult,
} from "./api";
import Cover from "./Cover";

type Props = {
  onAdded: (album: AlbumCard) => void;
  onFailed: (error: unknown) => void;
  /** Called when a search or an add starts, to clear an earlier error. */
  onStarted: () => void;
};

type Results = {
  /** The query these results are for, which "More" asks for again. */
  query: string;
  results: SearchResult[];
  nextOffset: number | null;
};

/** Searches Spotify's albums, ten at a time, each with an Add button. */
function Search({ onAdded, onFailed, onStarted }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  // Counts searches, so a slow one that finishes after a newer one is ignored.
  const latest = useRef(0);

  async function search(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    const current = ++latest.current;
    onStarted();
    setSearching(true);
    try {
      const page = await searchAlbums(q, 0);
      if (current === latest.current) setResults({ query: q, ...page });
    } catch (e) {
      if (current === latest.current) onFailed(e);
    } finally {
      if (current === latest.current) setSearching(false);
    }
  }

  async function more() {
    if (!results || results.nextOffset === null) return;
    const current = ++latest.current;
    onStarted();
    setSearching(true);
    try {
      const page = await searchAlbums(results.query, results.nextOffset);
      if (current !== latest.current) return;
      // Built from the current results, not the ones captured above, so an
      // Add that finished meanwhile keeps its mark. Spotify's ranking can
      // shift between pages, so an album already shown may come back: show
      // it once.
      setResults((now) => {
        if (!now) return now;
        const shown = new Set(now.results.map((r) => r.album.spotifyId));
        return {
          ...now,
          results: [
            ...now.results,
            ...page.results.filter((r) => !shown.has(r.album.spotifyId)),
          ],
          nextOffset: page.nextOffset,
        };
      });
    } catch (e) {
      if (current === latest.current) onFailed(e);
    } finally {
      if (current === latest.current) setSearching(false);
    }
  }

  /** Adds a search result, by its Spotify ID. */
  async function add(spotifyId: string) {
    onStarted();
    setAdding((ids) => new Set(ids).add(spotifyId));
    try {
      const album = await addAlbum(spotifyId);
      setResults(
        (current) =>
          current && {
            ...current,
            results: current.results.map((r) =>
              r.album.spotifyId === spotifyId
                ? { ...r, inCollection: true }
                : r,
            ),
          },
      );
      onAdded(album);
    } catch (e) {
      onFailed(e);
    } finally {
      setAdding((ids) => {
        const next = new Set(ids);
        next.delete(spotifyId);
        return next;
      });
    }
  }

  return (
    <section className="search" aria-label="Search Spotify">
      <form className="search-form" onSubmit={search} role="search">
        <input
          type="search"
          aria-label="Search Spotify for albums"
          placeholder="Search Spotify for albums"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={searching || !query.trim()}>
          Search
        </button>
      </form>
      {results && (
        <>
          {results.results.length === 0 ? (
            <p>No albums found for “{results.query}”.</p>
          ) : (
            <ul className="results" aria-label="Search results">
              {results.results.map(({ album, inCollection }) => (
                <li key={album.spotifyId} className="result">
                  <Cover album={album} className="result-cover" />
                  <div className="result-text">
                    <span className="result-title">{album.title}</span>
                    <span className="result-meta">
                      {album.artist}
                      {album.year !== null && ` · ${album.year}`}
                    </span>
                  </div>
                  {inCollection ? (
                    <span className="in-collection">In your collection</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => add(album.spotifyId)}
                      disabled={adding.has(album.spotifyId)}
                      aria-label={`Add ${album.title} by ${album.artist}`}
                    >
                      {adding.has(album.spotifyId) ? "Adding…" : "Add"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {results.nextOffset !== null && (
            <button
              type="button"
              className="secondary more"
              onClick={more}
              disabled={searching}
            >
              More
            </button>
          )}
        </>
      )}
    </section>
  );
}

export default Search;
