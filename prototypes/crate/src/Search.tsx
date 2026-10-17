import { useEffect, useRef, useState } from "react";
import { addAlbum, errorMessage, searchAlbums, type SearchResult } from "./connect/api";
import { cleanTitle } from "./types";

type Results = { query: string; results: SearchResult[]; nextOffset: number | null };

// Finding records to add: a full-screen overlay over everything, with a wall
// of artwork, best match first. It doesn't play at being a crate. It's
// minimal, so the covers do the talking. Adding is one click: the cover
// slides off down toward the crate behind, and the tile says it's in.
export function Search({
  open,
  firstRun,
  onClose,
  onAdded,
  onFailed,
}: {
  open: boolean;
  firstRun: boolean;
  onClose: () => void;
  onAdded: (id: string) => void;
  onFailed: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState<"search" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Added since the search ran: the back end's `inCollection` is older. */
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef(0);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 60);
  }, [open]);

  // Search as you type, a moment after you stop.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setLoading(null);
      setError(null);
      return;
    }
    const t = setTimeout(async () => {
      const n = ++asked.current;
      setLoading("search");
      try {
        const page = await searchAlbums(q, 0);
        if (n !== asked.current) return;
        setResults({ query: q, ...page });
        setError(null);
      } catch (e) {
        if (n !== asked.current) return;
        setError(errorMessage(e));
      } finally {
        if (n === asked.current) setLoading(null);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open, onClose]);

  const more = async () => {
    if (!results?.nextOffset) return;
    const n = ++asked.current;
    setLoading("more");
    try {
      const page = await searchAlbums(results.query, results.nextOffset);
      if (n !== asked.current) return;
      setResults((r) => r && { ...r, results: [...r.results, ...page.results], nextOffset: page.nextOffset });
    } catch (e) {
      if (n === asked.current) setError(errorMessage(e));
    } finally {
      if (n === asked.current) setLoading(null);
    }
  };

  const add = async (id: string, img: HTMLImageElement | null) => {
    setAdding((s) => new Set(s).add(id));
    try {
      await addAlbum(id);
      if (img) slideToCrate(img);
      setAdded((s) => new Set(s).add(id));
      onAdded(id);
    } catch (e) {
      onFailed(errorMessage(e));
    } finally {
      setAdding((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const q = query.trim();

  return (
    <div className={`search ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="search-top">
        {firstRun && <p className="search-first">Your crate is empty. Find the first record for it.</p>}
        <input
          ref={input}
          className="search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a record"
          spellCheck={false}
          autoComplete="off"
        />
        <p className="search-status">
          {loading === "search"
            ? "Looking…"
            : error
              ? error
              : results && q && !results.results.length
                ? `Nothing on Spotify matches “${results.query}”.`
                : results
                  ? `Albums on Spotify · best match first`
                  : "An artist or an album"}
        </p>
        <button className="search-close" onClick={onClose}>
          esc
        </button>
      </div>

      <div className={`wall ${loading === "search" ? "stale" : ""}`}>
        {results?.results.map(({ album, inCollection }) => {
          const ours = inCollection || added.has(album.id);
          return (
            <figure key={album.id} className={`tile ${ours ? "ours" : ""}`}>
              <div className="tile-art">
                {album.coverUrl && <img src={album.coverUrl} alt="" loading="lazy" decoding="async" draggable={false} />}
                {!ours && (
                  <button
                    className="tile-add"
                    disabled={adding.has(album.id)}
                    onClick={(e) =>
                      add(album.id, e.currentTarget.parentElement!.querySelector("img"))
                    }
                  >
                    {adding.has(album.id) ? "Adding…" : "+ Add"}
                  </button>
                )}
              </div>
              <figcaption>
                <span className="tile-artist">{album.artist}</span>
                <span className="tile-title">
                  {cleanTitle(album.title)}
                  {album.year && <span> · {album.year}</span>}
                </span>
                {ours && <span className="tile-ours">In your crate</span>}
              </figcaption>
            </figure>
          );
        })}
      </div>

      {results?.nextOffset != null && (
        <button className="search-more" onClick={more} disabled={loading === "more"}>
          {loading === "more" ? "Looking…" : "More"}
        </button>
      )}
    </div>
  );
}

// The flourish: a copy of the cover drops down off the screen, toward the
// crate behind the overlay.
function slideToCrate(img: HTMLImageElement) {
  const r = img.getBoundingClientRect();
  const ghost = img.cloneNode() as HTMLImageElement;
  ghost.className = "ghost";
  Object.assign(ghost.style, {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  document.body.appendChild(ghost);
  const dx = innerWidth / 2 - (r.left + r.width / 2);
  const dy = innerHeight + r.height - r.top;
  ghost
    .animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translate(${dx * 0.35}px, -18px) rotate(-2deg) scale(1.04)`, opacity: 1, offset: 0.25 },
        { transform: `translate(${dx}px, ${dy}px) rotate(4deg) scale(0.6)`, opacity: 0.9 },
      ],
      { duration: 700, easing: "cubic-bezier(.5,0,.6,1)" },
    )
    .finished.finally(() => ghost.remove());
}
