// Finding records to add (RFC-002, "4. The UI"): a full-screen overlay with
// a wall of covers, best match first, as the prototype has it
// (prototypes/crate/src/Search.tsx). It doesn't play at being a crate, so
// the covers do the talking. Records already in the crate are dimmed, and
// adding is one click: a copy of the cover drops toward the crate behind.

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  addAlbum,
  searchAlbums,
  type AlbumCard,
  type SearchResult,
  type SearchResults,
} from "./api";
import Cover from "./Cover";
import "./SearchWall.css";

type Props = {
  open: boolean;
  /** The collection is empty: say so over the search. */
  empty: boolean;
  /** The Spotify IDs of the records in the crate, which are dimmed. */
  owned: ReadonlySet<string>;
  onClose: () => void;
  onAdded: (album: AlbumCard) => void;
  onFailed: (error: unknown) => void;
  /** Called when a search or an add starts, to clear an earlier error. */
  onStarted: () => void;
  /** Development builds' measuring: a wall to show without searching. */
  pretend?: SearchResults | null;
};

type Results = {
  /** The query these results are for, which More asks for again. */
  query: string;
  results: SearchResult[];
  nextOffset: number | null;
};

/** How long after you stop typing it searches. */
const TYPING_MS = 280;

function SearchWall({
  open,
  empty,
  owned,
  onClose,
  onAdded,
  onFailed,
  onStarted,
  pretend,
}: Props) {
  const [query, setQuery] = useState("");
  const [found, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState<"search" | "more" | null>(null);
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  // Counts searches, so a slow one that finishes after a newer one is ignored.
  const latest = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  const results: Results | null =
    import.meta.env.DEV && pretend ? { query: "", ...pretend } : found;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  async function search(q: string) {
    const current = ++latest.current;
    onStarted();
    setLoading("search");
    try {
      const page = await searchAlbums(q, 0);
      if (current === latest.current) setResults({ query: q, ...page });
    } catch (e) {
      if (current === latest.current) onFailed(e);
    } finally {
      if (current === latest.current) setLoading(null);
    }
  }

  /** Searches as you type, a moment after you stop. */
  function type(text: string) {
    setQuery(text);
    clearTimeout(typing.current);
    const q = text.trim();
    if (q) {
      typing.current = setTimeout(() => void search(q), TYPING_MS);
      return;
    }
    latest.current++;
    setResults(null);
    setLoading(null);
  }

  /** Enter searches straight away. */
  function submit(event: FormEvent) {
    event.preventDefault();
    clearTimeout(typing.current);
    const q = query.trim();
    if (q && q !== results?.query) void search(q);
  }

  async function more() {
    if (!results || results.nextOffset === null) return;
    const current = ++latest.current;
    onStarted();
    setLoading("more");
    try {
      const page = await searchAlbums(results.query, results.nextOffset);
      if (current !== latest.current) return;
      // Spotify's ranking can shift between pages, so an album already
      // shown may come back: show it once.
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
      if (current === latest.current) setLoading(null);
    }
  }

  /** Adds a search result, by its Spotify ID, and sends its cover to the crate. */
  async function add(spotifyId: string, cover: HTMLImageElement | null) {
    onStarted();
    setAdding((ids) => new Set(ids).add(spotifyId));
    try {
      const album = await addAlbum(spotifyId);
      if (cover) dropToCrate(cover);
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

  const status =
    loading === "search"
      ? "Looking…"
      : results && results.results.length === 0
        ? `Nothing on Spotify matches “${results.query}”.`
        : results
          ? "Albums on Spotify · best match first"
          : "An artist or an album";

  return (
    <div
      className={`search-wall ${open ? "open" : ""}`}
      role="dialog"
      aria-label="Find a record"
      aria-hidden={!open || undefined}
      inert={!open}
    >
      <div className="search-top">
        {empty && open && (
          <p className="search-first">
            Your crate is empty. Find the first record for it.
          </p>
        )}
        <form role="search" onSubmit={submit}>
          <input
            ref={input}
            type="search"
            className="search-input"
            aria-label="Find a record"
            placeholder="Find a record"
            value={query}
            onChange={(e) => type(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </form>
        <p className="search-status" aria-live="polite">
          {status}
        </p>
        <button
          type="button"
          className="search-close"
          onClick={onClose}
          aria-label="Back to the crate"
        >
          esc
        </button>
      </div>

      {results && results.results.length > 0 && (
        // Keyed by the query, so each search's wall rises in afresh.
        <div key={results.query} className="wall-in">
          <ul
            className={`wall ${loading === "search" ? "stale" : ""}`}
            aria-label="Search results"
          >
            {results.results.map(({ album, inCollection }) => {
              const ours = inCollection || owned.has(album.spotifyId);
              const busy = adding.has(album.spotifyId);
              return (
                <li key={album.spotifyId} className={`tile ${ours ? "ours" : ""}`}>
                  <Cover album={album} className="tile-cover" />
                  <div className="tile-text">
                    <span className="tile-artist">{album.artist}</span>
                    <span className="tile-title">
                      {album.title}
                      {album.year !== null && <span> · {album.year}</span>}
                    </span>
                    {ours ? (
                      <span className="tile-ours">In your crate</span>
                    ) : (
                      <button
                        type="button"
                        className="tile-add"
                        disabled={busy}
                        aria-label={`Add ${album.title} by ${album.artist}`}
                        onClick={(e) =>
                          void add(
                            album.spotifyId,
                            e.currentTarget
                              .closest(".tile")
                              ?.querySelector("img") ?? null,
                          )
                        }
                      >
                        {busy ? "Adding…" : "+ Add"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {results && results.nextOffset !== null && (
        <button
          type="button"
          className="search-more"
          onClick={() => void more()}
          disabled={loading !== null}
        >
          {loading === "more" ? "Looking…" : "More"}
        </button>
      )}
    </div>
  );
}

/**
 * The flourish: a copy of the cover lifts a little, then drops off the
 * bottom of the screen toward the crate behind, by transform and opacity
 * only (DESIGN.md, rule 7). The cover itself stays where it is, unaltered.
 */
function dropToCrate(cover: HTMLImageElement) {
  const r = cover.getBoundingClientRect();
  const ghost = cover.cloneNode() as HTMLImageElement;
  ghost.className = "search-ghost";
  ghost.alt = "";
  Object.assign(ghost.style, {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  document.body.appendChild(ghost);
  if (typeof ghost.animate !== "function") {
    ghost.remove();
    return;
  }
  const dx = innerWidth / 2 - (r.left + r.width / 2);
  const dy = innerHeight + r.height - r.top;
  ghost
    .animate(
      [
        { transform: "none", opacity: 1 },
        {
          transform: `translate(${dx * 0.35}px, -18px) rotate(-2deg) scale(1.04)`,
          opacity: 1,
          offset: 0.25,
        },
        {
          transform: `translate(${dx}px, ${dy}px) rotate(4deg) scale(0.6)`,
          opacity: 0.9,
        },
      ],
      { duration: 700, easing: "cubic-bezier(.5, 0, .6, 1)" },
    )
    .finished.catch(() => {})
    .finally(() => ghost.remove());
}

export default SearchWall;
