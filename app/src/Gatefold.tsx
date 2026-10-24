// The liner notes, opened like a gatefold (RFC-002, "5. Liner notes in the
// app"), ported from prototypes/crate/src/Gatefold.tsx. The sleeve's cover
// swings open to a title page, and the essay flows in columns across an
// accordion of panels that keeps unfolding to the right as you read. While
// the album plays, its track is marked wherever the essay mentions it, and
// the bar at the bottom right turns to the first mention.
//
// Five type styles, picked at the bottom left and remembered: Liner notes,
// Magazine, Archive, Album colours, and Album × Archive (Archive's layout in
// the album's colours, which Will chose in PR #9, so it opens on that). Each
// is set in Serif or Grotesk, also remembered.
//
// The panels move by transforms only (DESIGN.md, rule 7). The reading
// position is written straight to a CSS custom property, so React doesn't
// render while they move.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import AlbumColours from "./AlbumColours";
import type { AlbumCard, AlbumTrack, Notes } from "./api";
import { SleeveFront } from "./Crate";
import { plainTitle, STYLES, type NotesStyle } from "./notes";
import "./fonts.css";
import "./Gatefold.css";

const STYLE_CLASS: Record<NotesStyle, string> = {
  liner: "style-liner",
  magazine: "style-magazine",
  archive: "style-archive",
  album: "style-album",
  // Archive's structure, printed in the album's colours.
  "album-archive": "style-archive in-album-colours",
};

type Typeface = "serif" | "grotesk";

/** Where the chosen style and type are remembered, in this browser only. */
const STYLE_KEY = "gatefold-style";
const TYPE_KEY = "gatefold-type";

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (allowed.includes(value as T)) return value as T;
  } catch {
    // No storage: the default.
  }
  return fallback;
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Fine without it.
  }
}

/** How long the cover takes to swing open, and closed. */
const COVER_MS = 1000;

type Props = {
  album: AlbumCard;
  notes: Notes;
  /** The album's tracklist, for finding the tracks the essay mentions. */
  tracks: AlbumTrack[];
  /** The Spotify ID of the track playing, when it's on this album. */
  current: string | null;
  /** Where the sleeve's front was, to come out of. Null to simply appear. */
  from: DOMRect | null;
  /** Folding back up: the cover closes, then `onClosed`. */
  closing: boolean;
  /** You've asked to close it: Escape, or Close. */
  onClose: () => void;
  onClosed: () => void;
};

function Gatefold({ album, notes, tracks, current, from, closing, onClose, onClosed }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<NotesStyle>(() =>
    remembered(STYLE_KEY, STYLES.map((s) => s.id), "album-archive"),
  );
  const [typeface, setTypeface] = useState<Typeface>(() =>
    remembered(TYPE_KEY, ["serif", "grotesk"], "serif"),
  );
  const [pages, setPages] = useState(1);
  const [anchors, setAnchors] = useState<Map<string, number>>(new Map());
  const [open, setOpen] = useState(false);
  const [spread, setSpread] = useState(0);
  // The reading position, easing toward its target.
  const s = useRef(0);
  const target = useRef(0);
  // The panels were drawn again: mark the tucked ones again.
  const relaid = useRef(true);
  const maxSpread = Math.max(0, pages - 1);

  const go = useCallback(
    (to: number) => {
      target.current = Math.max(0, Math.min(maxSpread, to));
      setSpread(Math.round(target.current));
    },
    [maxSpread],
  );

  // Lay the essay out once, off screen, to count its panels and find which
  // panel each track is first mentioned on.
  useLayoutEffect(() => {
    const m = measure.current;
    if (!m) return;
    const run = () => {
      const flow = m.firstElementChild;
      const gap = flow ? parseFloat(getComputedStyle(flow).columnGap) || 0 : 0;
      const stride = m.clientWidth + gap;
      if (!stride) return;
      const left = m.getBoundingClientRect().left;
      const found = new Map<string, number>();
      let last = 0;
      m.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width) last = Math.max(last, r.left - left);
        const t = el.dataset.track;
        if (t !== undefined && !found.has(t)) found.set(t, Math.floor((r.left - left) / stride));
      });
      setPages(Math.floor(last / stride) + 1);
      setAnchors(found);
    };
    run();
    // The bundled fonts change the layout once they've loaded.
    void document.fonts?.ready.then(run);
    addEventListener("resize", run);
    return () => removeEventListener("resize", run);
  }, [style, typeface, notes, tracks]);

  // Arrive from where the sleeve was, then open the cover.
  useLayoutEffect(() => {
    const el = stage.current;
    const strip = el?.querySelector(".gf-strip")?.getBoundingClientRect();
    if (el && from && strip?.width) {
      const dx = from.left + from.width / 2 - (strip.left + strip.width / 2);
      const dy = from.top + from.height / 2 - (strip.top + strip.height / 2);
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${from.width / strip.width})` },
          { transform: "none" },
        ],
        { duration: 500, easing: "cubic-bezier(.2,.75,.15,1)" },
      );
    }
    const t = setTimeout(() => setOpen(true), 380);
    return () => clearTimeout(t);
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- from is where it came from, fixed while it's open
  }, []);

  // Fold back to the start, close the cover, then hand back to the sleeve.
  const closed = useRef(onClosed);
  useEffect(() => {
    closed.current = onClosed;
  });
  useEffect(() => {
    if (!closing) return;
    target.current = 0;
    const wait = Math.min(900, 250 + s.current * 220);
    const t1 = setTimeout(() => setOpen(false), wait);
    const t2 = setTimeout(() => closed.current(), wait + COVER_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [closing]);

  // Ease the reading position toward its target, written straight to a CSS
  // custom property, so React doesn't render while the panels move.
  useEffect(() => {
    let raf = 0;
    let shown = -1;
    let reach = -1;
    const tick = () => {
      s.current += (target.current - s.current) * 0.14;
      if (Math.abs(target.current - s.current) < 0.0005) s.current = target.current;
      if (s.current !== shown) {
        stage.current?.style.setProperty("--s", s.current.toFixed(4));
        shown = s.current;
      }
      // Panels still folded flat behind the next one aren't drawn: lying
      // almost on top of each other, they'd flicker through the open page.
      const next = Math.ceil(s.current - 0.0001) + 1;
      if (next !== reach || relaid.current) {
        reach = next;
        relaid.current = false;
        stage.current?.querySelectorAll<HTMLElement>(".gf-panel").forEach((p) => {
          p.classList.toggle("tucked", Number(p.dataset.i) > next);
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The wheel unfolds the next panel; when you stop, it settles on a spread.
  // The arrow keys turn a spread at a time, and Escape closes it.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let settle = 0;
    let start = Math.round(target.current);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!open || closing) return;
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      // A mouse notch turns one spread; a trackpad drags the fold with you.
      if (e.deltaMode === 1 || (Math.abs(delta) >= 50 && Number.isInteger(delta))) {
        clearTimeout(settle);
        go(Math.round(target.current) + Math.sign(delta));
        start = Math.round(target.current);
        return;
      }
      const w = el.querySelector(".gf-strip")?.clientWidth || 1;
      target.current = Math.max(0, Math.min(maxSpread, target.current + delta / (w * 0.9)));
      clearTimeout(settle);
      // When the swipe stops, finish turning in the direction it was going.
      settle = window.setTimeout(() => {
        const moved = target.current - start;
        go(
          Math.abs(moved) < 0.12
            ? start
            : moved > 0
              ? Math.ceil(target.current)
              : Math.floor(target.current),
        );
        start = Math.round(target.current);
      }, 120);
    };
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!closing) onClose();
        return;
      }
      if (!open || closing) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") {
        e.preventDefault();
        go(Math.round(target.current) + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        go(Math.round(target.current) - 1);
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    addEventListener("keydown", key);
    return () => {
      el.removeEventListener("wheel", wheel);
      removeEventListener("keydown", key);
      clearTimeout(settle);
    };
  }, [open, closing, maxSpread, go, onClose]);

  useLayoutEffect(() => {
    relaid.current = true;
  }, [pages, style, typeface]);

  const pickStyle = (next: NotesStyle) => {
    setStyle(next);
    go(0);
    remember(STYLE_KEY, next);
  };
  const pickTypeface = (next: Typeface) => {
    setTypeface(next);
    remember(TYPE_KEY, next);
  };

  // Panel 1 is the right-hand side of the opened sleeve; every further panel
  // hangs off the right edge of the one before, folded back behind it.
  const panel = (i: number): ReactNode =>
    i > pages ? null : (
      <div className="gf-panel" data-i={i} style={{ "--i": i } as CSSProperties}>
        <div className="gf-face">
          <div className="gf-window">
            <Essay notes={notes} tracks={tracks} current={current} page={i - 1} />
          </div>
          <span className="gf-folio">{i}</span>
          <div className="gf-crease" />
        </div>
        <div className="gf-rear" />
        <div className="gf-shade" />
        {panel(i + 1)}
      </div>
    );

  const now = current !== null ? anchors.get(current) : undefined;
  const playing = current !== null ? tracks.find((t) => t.spotifyId === current) : undefined;

  return (
    <div
      ref={root}
      className={`gatefold ${open ? "open" : ""} ${closing ? "closing" : ""} ${typeface === "grotesk" ? "type-grotesk" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Liner notes for ${album.title}`}
    >
      <AlbumColours palette={album.palette} className={`gf-print ${STYLE_CLASS[style]}`}>
        <div className="gf-stage" ref={stage}>
          <div className="gf-opener">
            <div className="gf-strip">
              <div className="gf-cover">
                <div className="gf-cover-out">
                  <SleeveFront album={album} src={album.covers?.large} />
                </div>
                <div className="gf-cover-in">
                  <TitlePage notes={notes} />
                  <div className="gf-crease" />
                </div>
              </div>
              {panel(1)}
            </div>
          </div>
        </div>

        <div className="gf-measure" aria-hidden>
          <div className="gf-window" ref={measure}>
            <Essay notes={notes} tracks={tracks} current={null} page={0} />
          </div>
        </div>

        <div className="gf-bar">
          <div className="gf-controls">
            <nav className="gf-styles" aria-label="Type style">
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={s.id === style}
                  onClick={() => pickStyle(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </nav>
            <nav className="gf-type" aria-label="Type">
              <span>Type</span>
              {(["serif", "grotesk"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={t === typeface}
                  onClick={() => pickTypeface(t)}
                >
                  {t === "serif" ? "Serif" : "Grotesk"}
                </button>
              ))}
            </nav>
          </div>
          <div className="gf-dots">
            {Array.from({ length: maxSpread + 1 }, (_, i) => (
              <button
                key={i}
                type="button"
                aria-pressed={i === spread}
                onClick={() => go(i)}
                aria-label={`Spread ${i + 1}`}
              />
            ))}
          </div>
          <div className="gf-now">
            {playing && (
              <button type="button" disabled={now === undefined} onClick={() => now !== undefined && go(now)}>
                <span>Now playing</span> {playing.title}
                {now !== undefined ? " · find it in the notes →" : ""}
              </button>
            )}
            <button type="button" className="gf-close" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </AlbumColours>
    </div>
  );
}

function TitlePage({ notes }: { notes: Notes }) {
  return (
    <div className="gf-title">
      <p className="gf-kicker">
        {notes.artist} · <em>{notes.albumTitle}</em>
      </p>
      <h1 className="gf-headline">{italics(notes.headline)}</h1>
      <p className="gf-standfirst">{italics(notes.standfirst)}</p>
      <dl className="gf-facts">
        {notes.facts.slice(0, 6).map((f) => (
          <div key={f.label}>
            <dt>{f.figure}</dt>
            <dd>{italics(f.label)}</dd>
          </div>
        ))}
      </dl>
      <p className="gf-byline">
        Researched and written by Claude · {notes.sources.length} sources, listed at the end
      </p>
    </div>
  );
}

/** `*x*` is italic. */
function italics(text: string) {
  return text
    .split(/(\*[^*]+\*)/g)
    .map((part, k) =>
      part.startsWith("*") && part.length > 2 ? <em key={k}>{part.slice(1, -1)}</em> : part,
    );
}

/** `[[Track]]` marks a track by its title, and `*x*` is italic. */
function rich(text: string, tracks: AlbumTrack[], current: string | null) {
  return text.split(/(\[\[[^\]]+\]\]|\*[^*]+\*)/g).map((part, k) => {
    if (part.startsWith("[[")) {
      const name = part.slice(2, -2);
      const track = tracks.find((t) => plainTitle(t.title) === plainTitle(name));
      const id = track?.spotifyId || undefined;
      return (
        <span
          key={k}
          className={`gf-track ${id !== undefined && id === current ? "gf-track-playing" : ""}`}
          data-track={id}
        >
          {name}
        </span>
      );
    }
    if (part.startsWith("*") && part.length > 2) return <em key={k}>{part.slice(1, -1)}</em>;
    return part;
  });
}

const Essay = memo(function Essay({
  notes,
  tracks,
  current,
  page,
}: {
  notes: Notes;
  tracks: AlbumTrack[];
  current: string | null;
  page: number;
}) {
  return (
    <article className="gf-flow" style={{ "--pi": page } as CSSProperties}>
      {notes.sections.map((section, i) => {
        const quote = notes.quotes[Math.floor(i / 2)];
        return (
          <section key={i}>
            <h2 className="gf-h">{section.heading}</h2>
            {section.paragraphs.map((p, j) => (
              <div key={j}>
                <p className={i === 0 && j === 0 ? "gf-p gf-first" : "gf-p"}>
                  {rich(p, tracks, current)}
                </p>
                {j === 0 && section.pullQuote && (
                  <blockquote className="gf-pull">
                    {rich(section.pullQuote.text, tracks, current)}
                  </blockquote>
                )}
              </div>
            ))}
            {i % 2 === 1 && quote && (
              <figure className="gf-quote">
                <p>“{quote.text}”</p>
                <figcaption>{quote.who}</figcaption>
              </figure>
            )}
          </section>
        );
      })}
      <section className="gf-end">
        <h2 className="gf-h">Credits</h2>
        <dl className="gf-credits">
          {notes.credits.map((c) => (
            <div key={c.role}>
              <dt>{c.role}</dt>
              <dd>{c.names.join(", ")}</dd>
            </div>
          ))}
        </dl>
        <h2 className="gf-h">Sources</h2>
        <ol className="gf-sources">
          {notes.sources.map((s, i) => (
            <li key={i}>
              {s.publisher}, “{s.title}”{s.year ? ` (${s.year})` : ""}
            </li>
          ))}
        </ol>
        <p className="gf-colophon">
          These notes were researched and written by Claude from the sources above. Lyrics are
          not reproduced.
        </p>
      </section>
    </article>
  );
});

export default Gatefold;
