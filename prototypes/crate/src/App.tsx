import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ambient } from "./Ambient";
import { Crate } from "./Crate";
import { Gatefold } from "./Gatefold";
import { Hero } from "./Hero";
import { NEUTRAL, paletteFor, type Palette } from "./palette";
import { Hud } from "./Hud";
import { setTypeface } from "./typeface";
import {
  albumKey,
  cleanTitle,
  cover,
  formatTime,
  sides,
  type Album,
  slug,
  type CrateItem,
  type Notes,
  type Playback,
} from "./types";

type View = "crate" | "back" | "playing";

type Order = "genre" | "artist" | "decade";
const ORDERS: { id: Order; label: string }[] = [
  { id: "genre", label: "Genre" },
  { id: "artist", label: "Artist A–Z" },
  { id: "decade", label: "Decade" },
];

const sortName = (artist: string) => artist.replace(/^the\s+/i, "");
const byArtist = (a: Album, b: Album) =>
  sortName(a.artist).localeCompare(sortName(b.artist)) || (a.year ?? 0) - (b.year ?? 0);

// The crate, sorted and split by dividers. Each order decides what a section
// is (a genre, a letter, a decade) and the order inside it.
function buildCrate(albums: Album[], order: Order): CrateItem[] {
  const section = (a: Album) =>
    order === "genre"
      ? a.genre
      : order === "artist"
        ? (/[a-z]/i.test(sortName(a.artist)[0]) ? sortName(a.artist)[0].toUpperCase() : "#")
        : a.year
          ? `${Math.floor(a.year / 10) * 10}s`
          : "Undated";
  const sorted = [...albums].sort((a, b) =>
    order === "decade"
      ? (a.year ?? 9999) - (b.year ?? 9999) || byArtist(a, b)
      : section(a).localeCompare(section(b)) || byArtist(a, b),
  );
  const items: CrateItem[] = [];
  let current: string | null = null;
  let divider: Extract<CrateItem, { kind: "divider" }> | null = null;
  let n = 0;
  for (const album of sorted) {
    const label = section(album);
    if (label !== current) {
      current = label;
      divider = { kind: "divider", id: `divider-${order}-${label}`, label, count: 0, tab: n++ % 3 };
      items.push(divider);
    }
    divider!.count++;
    items.push({ kind: "album", id: albumKey(album), album });
  }
  return items;
}

export function App({ albums }: { albums: Album[] }) {
  const [order, setOrder] = useState<Order>("genre");
  const items = useMemo(() => buildCrate(albums, order), [albums, order]);
  const [focus, setFocus] = useState(1);
  const [view, setView] = useState<View>("crate");
  const [hero, setHero] = useState<Album | null>(null);
  const [turns, setTurns] = useState(0);
  const [returning, setReturning] = useState(false);
  const [palette, setPalette] = useState<Palette>(NEUTRAL);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const fromRect = useRef<DOMRect | null>(null);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [gatefold, setGatefold] = useState<"closed" | "open" | "closing">("closed");
  const gatefoldFrom = useRef<DOMRect | null>(null);

  const focused = items[focus];

  // Warm the big artwork and the palette for whatever's at the front.
  useEffect(() => {
    if (focused.kind !== "album") return;
    const t = setTimeout(() => {
      new Image().src = cover(focused.album, "lg");
      paletteFor(cover(focused.album, "sm"));
    }, 120);
    return () => clearTimeout(t);
  }, [focused]);

  useEffect(() => {
    if (!hero) return;
    let live = true;
    paletteFor(cover(hero, "sm")).then((p) => live && setPalette(p));
    return () => {
      live = false;
    };
  }, [hero]);

  const reorder = (next: Order) => {
    if (next === order) return;
    const keep = focused.kind === "album" ? focused.id : null;
    const nextItems = buildCrate(albums, next);
    const at = keep ? nextItems.findIndex((i) => i.id === keep) : 1;
    setOrder(next);
    setFocus(Math.max(0, at));
  };

  // Jump to the next or previous divider.
  const jump = useCallback(
    (dir: 1 | -1) =>
      setFocus((f) => {
        for (let i = f + dir; i >= 0 && i < items.length; i += dir) {
          if (items[i].kind === "divider") return i;
        }
        return dir === 1 ? items.length - 1 : 0;
      }),
    [items],
  );

  useEffect(() => {
    setNotes(null);
    if (!hero) return;
    let live = true;
    fetch(`/notes/${slug(hero)}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((n: Notes | null) => live && setNotes(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hero]);

  const openGatefold = () => {
    if (!hero || !notes || gatefold !== "closed") return;
    const show = () => {
      gatefoldFrom.current = document.querySelector(".hero .face.front")?.getBoundingClientRect() ?? null;
      setGatefold("open");
    };
    // The gatefold opens from the front, so turn the sleeve over first.
    if (turns % 2) {
      setTurns((t) => t + 1);
      setTimeout(show, 750);
    } else show();
  };

  const step = useCallback(
    (by: number) => setFocus((f) => Math.max(0, Math.min(items.length - 1, f + by))),
    [items.length],
  );

  const pullOut = useCallback(
    (album: Album, to: View) => {
      const el = document.querySelector('.slot[data-focused] .sleeve-face, .slot[data-focused] .divider-card');
      if (!el) return;
      fromRect.current = el.getBoundingClientRect();
      setTurns(0);
      setHero(album);
      setView(to);
      if (to === "back") requestAnimationFrame(() => requestAnimationFrame(() => setTurns(1)));
    },
    [],
  );

  const putBack = useCallback(() => {
    if (!hero || returning) return;
    setTurns((t) => (t % 2 ? t + 1 : t));
    setView("crate");
    setReturning(true);
  }, [hero, returning]);

  const select = useCallback(() => {
    if (focused.kind === "album") pullOut(focused.album, "back");
    else step(1);
  }, [focused, pullOut, step]);

  const pick = (index: number) => {
    if (!hero) return;
    setPlayback({ album: hero, index, positionMs: 0, paused: false });
    setTurns((t) => t + 1);
    setView("playing");
  };

  const turnOver = () => {
    setTurns((t) => t + 1);
    setView("back");
  };

  const reopenPlaying = () => {
    if (!playback || hero) return;
    const at = items.findIndex((i) => i.id === albumKey(playback.album));
    setFocus(at);
    setTimeout(() => pullOut(playback.album, "playing"), 300);
  };

  // The scroll wheel flips through the crate. Trackpads send lots of small
  // deltas and mice send big ones, so accumulate and step every so often.
  useEffect(() => {
    let acc = 0;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (view !== "crate" || hero) return;
      if (e.shiftKey) {
        acc += e.deltaY || e.deltaX;
        if (Math.abs(acc) > 80) {
          jump(acc > 0 ? 1 : -1);
          acc = 0;
        }
        return;
      }
      // A mouse notch is one record; a trackpad builds up.
      const notch = e.deltaMode === 1 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      acc += notch ? Math.sign(e.deltaY) * 36 : e.deltaY;
      const steps = Math.trunc(acc / 36);
      if (steps) {
        acc -= steps * 36;
        step(steps);
      }
    };
    addEventListener("wheel", wheel, { passive: false });
    return () => removeEventListener("wheel", wheel);
  }, [view, hero, step, jump]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "t" && !e.metaKey && !e.ctrlKey) {
        setTypeface(document.documentElement.classList.contains("type-grotesk") ? "serif" : "grotesk");
      } else if (e.key === "Escape") {
        if (gatefold === "open") setGatefold("closing");
        else if (gatefold === "closed") putBack();
      } else if (gatefold !== "closed") {
        if (e.key === " ") {
          e.preventDefault();
          setPlayback((p) => p && { ...p, paused: !p.paused });
        }
      }
      else if (e.key === " ") {
        e.preventDefault();
        setPlayback((p) => p && { ...p, paused: !p.paused });
      } else if (view === "crate" && !hero) {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") step(-1);
        else if (e.key === "Enter") select();
        else if (e.key === "PageDown" || e.key === "]") jump(1);
        else if (e.key === "PageUp" || e.key === "[") jump(-1);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [view, hero, step, jump, select, putBack, gatefold]);

  // Pretend playback: a clock that walks through the tracks.
  useEffect(() => {
    const tick = setInterval(() => {
      setPlayback((p) => {
        if (!p || p.paused) return p;
        const pos = p.positionMs + 250;
        if (pos < p.album.tracks[p.index].durationMs) return { ...p, positionMs: pos };
        if (p.index + 1 < p.album.tracks.length) return { ...p, index: p.index + 1, positionMs: 0 };
        return null;
      });
    }, 250);
    return () => clearInterval(tick);
  }, []);

  const heroIsPlaying = !!hero && !!playback && albumKey(playback.album) === albumKey(hero);
  const ambientOn = heroIsPlaying && !returning;
  const crateState = view === "crate" ? "rest" : ambientOn || gatefold !== "closed" ? "gone" : "dim";

  return (
    <div className="room">
      <Ambient palette={palette} on={ambientOn} />

      <Crate
        items={items}
        focus={focus}
        hiddenId={hero ? albumKey(hero) : null}
        state={crateState}
        onFocus={setFocus}
        onSelect={select}
      />

      <Caption item={focused} hidden={view !== "crate" || !!hero} />

      <nav className={`orders ${view !== "crate" || hero ? "hidden" : ""}`}>
        {ORDERS.map((o) => (
          <button key={o.id} className={o.id === order ? "on" : undefined} onClick={() => reorder(o.id)}>
            {o.label}
          </button>
        ))}
      </nav>

      {hero && fromRect.current && (
        <Hero
          album={hero}
          palette={palette}
          turns={turns}
          floating={view === "playing"}
          current={heroIsPlaying ? playback!.index : null}
          fromRect={fromRect.current}
          returning={returning}
          onReturned={() => {
            setHero(null);
            setReturning(false);
          }}
          onPick={pick}
          onTurn={turnOver}
          away={gatefold !== "closed"}
        />
      )}

      {hero && notes && (
        <button
          className={`notes-btn ${view !== "crate" && !returning && gatefold === "closed" ? "on" : ""}`}
          onClick={openGatefold}
        >
          Liner notes ↗
        </button>
      )}

      {hero && notes && gatefold !== "closed" && (
        <Gatefold
          album={hero}
          notes={notes}
          palette={palette}
          current={heroIsPlaying ? playback!.index : null}
          from={gatefoldFrom.current}
          closing={gatefold === "closing"}
          onClosed={() => setGatefold("closed")}
        />
      )}

      {playback && (
        <NowPlaying
          playback={playback}
          big={view === "playing" && heroIsPlaying && !returning && gatefold === "closed"}
          chip={!hero && view === "crate"}
          onOpen={reopenPlaying}
        />
      )}

      <p className={`hint ${gatefold !== "closed" ? "playing" : view}`}>
        {view === "crate"
          ? "scroll to flip · shift-scroll or [ ] to jump · click to pull out"
          : view === "back"
            ? "pick a track · esc to put it back"
            : "click the sleeve to turn it over · space to pause · esc for the crate"}
      </p>
      <div className="grain" />
      <Hud />
    </div>
  );
}

function Caption({ item, hidden }: { item: CrateItem; hidden: boolean }) {
  return (
    <div className={`caption ${hidden ? "hidden" : ""}`}>
      {item.kind === "album" ? (
        <>
          <p className="caption-artist">{item.album.artist}</p>
          <p className="caption-title">
            {cleanTitle(item.album.title)}
            {item.album.year && <span> · {item.album.year}</span>}
          </p>
        </>
      ) : (
        <p className="caption-genre">{item.label}</p>
      )}
    </div>
  );
}

function NowPlaying({
  playback,
  big,
  chip,
  onOpen,
}: {
  playback: Playback;
  big: boolean;
  chip: boolean;
  onOpen: () => void;
}) {
  const { album, index, positionMs, paused } = playback;
  const track = album.tracks[index];
  const side = sides(album.tracks).find((s) => s.tracks.some((t) => t.index === index))!;
  const n = side.tracks.findIndex((t) => t.index === index) + 1;
  const progress = positionMs / track.durationMs;

  return (
    <>
      <div className={`now ${big ? "on" : ""}`} key={`${albumKey(album)}-${index}`}>
        <p className="now-side">
          Side {side.name} · {n}
          {paused && " · paused"}
        </p>
        <h1 className="now-title">{cleanTitle(track.title)}</h1>
        <p className="now-album">
          {album.artist} — {cleanTitle(album.title)}
        </p>
        <div className="now-bar">
          <span>{formatTime(positionMs)}</span>
          <div className="now-line">
            <div style={{ transform: `scaleX(${progress})` }} />
          </div>
          <span>−{formatTime(track.durationMs - positionMs)}</span>
        </div>
      </div>
      <button className={`chip ${chip ? "on" : ""}`} onClick={onOpen}>
        <img src={cover(album, "sm")} alt="" />
        <span>
          <strong>{cleanTitle(track.title)}</strong>
          {album.artist}
        </span>
      </button>
    </>
  );
}
