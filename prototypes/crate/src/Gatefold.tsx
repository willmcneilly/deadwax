import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { accentOn, css, type Palette, type RGB } from "./palette";
import { SleeveFront } from "./Sleeve";
import { setTypeface, useTypeface } from "./typeface";
import { cleanTitle, type Album, type Notes } from "./types";

const LIGHT: RGB = [246, 244, 239];

export const THEMES = [
  { id: "liner", label: "Liner notes" },
  { id: "magazine", label: "Magazine" },
  { id: "archive", label: "Archive" },
  { id: "album", label: "Album colours" },
  { id: "album-archive", label: "Album × Archive" },
] as const;
type Theme = (typeof THEMES)[number]["id"];
const THEME_CLASS: Record<Theme, string> = {
  liner: "theme-liner",
  magazine: "theme-magazine",
  archive: "theme-archive",
  album: "theme-album",
  // Archive's structure, printed in the album's colours.
  "album-archive": "theme-archive in-album-colours",
};

function savedTheme(): Theme {
  try {
    const t = localStorage.getItem("gatefold-theme");
    if (THEMES.some((x) => x.id === t)) return t as Theme;
  } catch {
    // no storage: use the default
  }
  return "liner";
}

// The sleeve opens like a gatefold: the cover swings left to show a title page,
// and the essay flows in columns across an accordion of panels that keeps
// unfolding to the right as you read. One copy of the essay is laid out per
// panel, each shifted to show its own stretch of columns.
export function Gatefold({
  album,
  notes,
  palette,
  current,
  from,
  closing,
  onClosed,
}: {
  album: Album;
  notes: Notes;
  palette: Palette;
  current: number | null;
  from: DOMRect | null;
  closing: boolean;
  onClosed: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const typeface = useTypeface();
  const [pages, setPages] = useState(1);
  const [anchors, setAnchors] = useState<Map<number, number>>(new Map());
  const [open, setOpen] = useState(false);
  const [spread, setSpread] = useState(0);
  const s = useRef(0);
  const target = useRef(0);
  const relaid = useRef(true); // panels were re-rendered: re-mark the tucked ones
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
    const m = measure.current!;
    const run = () => {
      const gap = parseFloat(getComputedStyle(m.firstElementChild!).columnGap) || 0;
      const stride = m.clientWidth + gap;
      const left = m.getBoundingClientRect().left;
      const found = new Map<number, number>();
      let last = 0;
      m.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width) last = Math.max(last, r.left - left);
        const t = el.dataset.track;
        if (t !== undefined && !found.has(+t)) found.set(+t, Math.floor((r.left - left) / stride));
      });
      setPages(Math.floor(last / stride) + 1);
      setAnchors(found);
    };
    run();
    document.fonts.ready.then(run);
    addEventListener("resize", run);
    return () => removeEventListener("resize", run);
  }, [theme, notes, typeface]);

  // Arrive from where the sleeve was, then open the cover.
  useLayoutEffect(() => {
    const el = stage.current!;
    if (from) {
      const r = el.querySelector(".gf-strip")!.getBoundingClientRect();
      const dx = from.left + from.width / 2 - (r.left + r.width / 2);
      const dy = from.top + from.height / 2 - (r.top + r.height / 2);
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px) scale(${from.width / r.width})` }, { transform: "none" }],
        { duration: 500, easing: "cubic-bezier(.2,.75,.15,1)" },
      );
    }
    const t = setTimeout(() => setOpen(true), 380);
    return () => clearTimeout(t);
    // Only on arrival.
  }, []);

  // Fold back to the start, close the cover, then hand back to the sleeve.
  const closed = useRef(onClosed);
  closed.current = onClosed;
  useEffect(() => {
    if (!closing) return;
    target.current = 0;
    const wait = Math.min(900, 250 + s.current * 220);
    const t1 = setTimeout(() => setOpen(false), wait);
    const t2 = setTimeout(() => closed.current(), wait + 1000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [closing]);

  // Ease the reading position toward its target. Written straight to a CSS
  // variable, so React doesn't re-render while the panels move.
  useEffect(() => {
    let raf = 0;
    let shown = -1;
    let reach = -1;
    const tick = () => {
      s.current += (target.current - s.current) * 0.14;
      if (Math.abs(target.current - s.current) < 0.0005) s.current = target.current;
      if (s.current !== shown) {
        root.current?.style.setProperty("--s", s.current.toFixed(4));
        shown = s.current;
      }
      // Panels still folded flat behind the next one aren't drawn: lying
      // almost on top of each other, they'd flicker through the open page.
      const next = Math.ceil(s.current - 0.0001) + 1;
      if (next !== reach || relaid.current) {
        reach = next;
        relaid.current = false;
        root.current?.querySelectorAll<HTMLElement>(".gf-stage .gf-panel").forEach((p) => {
          p.classList.toggle("tucked", Number(p.dataset.i) > next);
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The wheel unfolds the next panel; when you stop, it settles on a spread.
  useEffect(() => {
    let settle = 0;
    let from = Math.round(target.current);
    const wheel = (e: WheelEvent) => {
      if (!open || closing) return;
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      // A mouse notch turns one spread; a trackpad drags the fold with you.
      if (e.deltaMode === 1 || (Math.abs(delta) >= 50 && Number.isInteger(delta))) {
        clearTimeout(settle);
        go(Math.round(target.current) + Math.sign(delta));
        from = Math.round(target.current);
        return;
      }
      const w = root.current!.querySelector(".gf-strip")!.clientWidth;
      target.current = Math.max(0, Math.min(maxSpread, target.current + delta / (w * 0.9)));
      clearTimeout(settle);
      // When the swipe stops, finish turning in the direction it was going.
      settle = window.setTimeout(() => {
        const moved = target.current - from;
        go(Math.abs(moved) < 0.12 ? from : moved > 0 ? Math.ceil(target.current) : Math.floor(target.current));
        from = Math.round(target.current);
      }, 120);
    };
    const key = (e: KeyboardEvent) => {
      if (!open || closing) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") go(Math.round(target.current) + 1);
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(Math.round(target.current) - 1);
    };
    addEventListener("wheel", wheel, { passive: true });
    addEventListener("keydown", key);
    return () => {
      removeEventListener("wheel", wheel);
      removeEventListener("keydown", key);
      clearTimeout(settle);
    };
  }, [open, closing, maxSpread, go]);

  useLayoutEffect(() => {
    relaid.current = true;
  }, [pages, theme, typeface]);

  const pickTheme = (t: Theme) => {
    setTheme(t);
    go(0);
    try {
      localStorage.setItem("gatefold-theme", t);
    } catch {
      // fine without it
    }
  };

  const style = {
    "--album-ground": css(palette.ground),
    "--album-rear": css(palette.rear),
    "--album-ink": css(palette.ink),
    "--album-muted": css(palette.muted),
    "--album-accent": css(palette.accent),
    "--album-on-light": css(accentOn(LIGHT, palette)),
    "--open": open ? 1 : 0,
  } as CSSProperties;

  // Panel 1 is the right-hand side of the opened sleeve; every further panel
  // hangs off the right edge of the one before, folded back behind it.
  const panel = (i: number): ReactNode =>
    i > pages ? null : (
      <div className="gf-panel" data-i={i} style={{ "--i": i } as CSSProperties}>
        <div className="gf-face">
          <div className="gf-window">
            <Essay notes={notes} album={album} current={current} page={i - 1} />
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

  return (
    <div className={`gatefold ${THEME_CLASS[theme]} ${open ? "open" : ""} ${closing ? "closing" : ""}`} ref={root} style={style}>
      <div className="gf-stage" ref={stage}>
        <div className="gf-opener">
          <div className="gf-strip">
            <div className="gf-cover">
              <div className="gf-cover-out">
                <SleeveFront album={album} size="lg" />
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
          <Essay notes={notes} album={album} current={null} page={0} />
        </div>
      </div>

      <div className="gf-bar">
        <div className="gf-controls">
          <nav className="gf-themes">
            {THEMES.map((t) => (
              <button key={t.id} className={t.id === theme ? "on" : undefined} onClick={() => pickTheme(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <nav className="gf-type">
            <span>Type</span>
            {(["serif", "grotesk"] as const).map((t) => (
              <button key={t} className={t === typeface ? "on" : undefined} onClick={() => setTypeface(t)}>
                {t === "serif" ? "Serif" : "Grotesk"}
              </button>
            ))}
          </nav>
        </div>
        <div className="gf-dots">
          {Array.from({ length: maxSpread + 1 }, (_, i) => (
            <button key={i} className={i === spread ? "on" : undefined} onClick={() => go(i)} aria-label={`Spread ${i + 1}`} />
          ))}
        </div>
        <div className="gf-now">
          {current !== null && (
            <button disabled={now === undefined} onClick={() => now !== undefined && go(now)}>
              <span>Now playing</span> {cleanTitle(album.tracks[current].title)}
              {now !== undefined ? " · find it in the notes →" : ""}
            </button>
          )}
        </div>
      </div>
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
      <p className="gf-byline">Researched and written by Claude · {notes.sources.length} sources, listed at the end</p>
    </div>
  );
}

// *x* is italic, on the title page.
function italics(text: string) {
  return text
    .split(/(\*[^*]+\*)/g)
    .map((part, k) => (part.startsWith("*") && part.length > 2 ? <em key={k}>{part.slice(1, -1)}</em> : part));
}

// [[Track]] marks a track, *x* is italic.
function rich(text: string, album: Album, current: number | null) {
  return text.split(/(\[\[[^\]]+\]\]|\*[^*]+\*)/g).map((part, k) => {
    if (part.startsWith("[[")) {
      const name = part.slice(2, -2);
      const index = album.tracks.findIndex((t) => cleanTitle(t.title).toLowerCase() === name.toLowerCase());
      return (
        <span key={k} className={`gf-track ${index === current ? "gf-track-playing" : ""}`} data-track={index >= 0 ? index : undefined}>
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
  album,
  current,
  page,
}: {
  notes: Notes;
  album: Album;
  current: number | null;
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
                <p className={i === 0 && j === 0 ? "gf-p gf-first" : "gf-p"}>{rich(p, album, current)}</p>
                {j === 0 && section.pullQuote && (
                  <blockquote className="gf-pull">{rich(section.pullQuote.text, album, current)}</blockquote>
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
          These notes were researched and written by Claude from the sources above. Lyrics are not reproduced.
        </p>
      </section>
    </article>
  );
});
