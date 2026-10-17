import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ambient } from "./Ambient";
import { Crate } from "./Crate";
import { DeviceSheet, type SheetReason } from "./Devices";
import { Gatefold } from "./Gatefold";
import { Hero } from "./Hero";
import { NEUTRAL, paletteFor, type Palette } from "./palette";
import { Hud } from "./Hud";
import { Search } from "./Search";
import { setTypeface } from "./typeface";
import {
  addAlbum,
  errorMessage,
  getCollection,
  getDevices,
  getPlayback,
  nextTrack,
  pausePlayback,
  playAlbum,
  previousTrack,
  resumePlayback,
  type NowPlaying as Spotify,
} from "./connect/api";
import { fixtureAlbum, subscribe } from "./connect/fake";
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
} from "./types";

type View = "crate" | "back" | "playing";

type Order = "genre" | "artist" | "decade";
const ORDERS: { id: Order; label: string }[] = [
  { id: "genre", label: "Genre" },
  { id: "artist", label: "Artist A–Z" },
  { id: "decade", label: "Decade" },
];

/** How often to ask Spotify what's playing, like the app's playback bar. */
const POLL_MS = 2000;

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

// `?many` repeats the collection to about 400 records, to feel how the crate
// copes with a big collection.
function stretch(albums: Album[]): Album[] {
  if (!albums.length || !new URLSearchParams(location.search).has("many")) return albums;
  const out: Album[] = [];
  for (let copy = 0; out.length < 400; copy++) {
    for (const a of albums) out.push({ ...a, key: `${a.id}~${copy}` });
  }
  return out;
}

/** The collection, from the back end, with what the crate needs on top. */
async function loadCollection(): Promise<Album[]> {
  const cards = await getCollection();
  return cards.flatMap((c) => {
    const a = fixtureAlbum(c.id);
    return a ? [a] : [];
  });
}

/**
 * What's playing, as the sleeve and the now-playing line draw it: Spotify's
 * last answer, or the record you've just asked for while Spotify gets going.
 * The now-playing line moves the position on by itself between answers.
 */
export type Live = {
  album: Album;
  /** It isn't in the collection: a stranger's record. */
  stranger: boolean;
  /** The track on the sleeve's back, or null if it can't be found there. */
  index: number | null;
  title: string;
  durationMs: number;
  /** Where it was when Spotify answered, at `at`. */
  positionMs: number;
  at: number;
  paused: boolean;
  /** Play was pressed and Spotify hasn't started yet. */
  starting: boolean;
  advert: boolean;
  device: string | null;
};

/** A record from outside the collection, from what Spotify says about it. */
function strangerAlbum(track: NonNullable<Spotify["track"]>): Album {
  return {
    id: track.albumId ?? `stranger-${track.album ?? track.title}`,
    genre: "",
    title: track.album ?? track.title,
    artist: track.artist,
    year: null,
    label: null,
    tracks: [],
    coverUrl: track.coverUrl ?? undefined,
  };
}

type Pending = { album: Album; index: number; device: string; resolvedAt: number | null };

export function App() {
  const [collection, setCollection] = useState<Album[] | null>(null);
  const albums = useMemo(() => stretch(collection ?? []), [collection]);
  const owned = useMemo(() => new Set((collection ?? []).map((a) => a.id)), [collection]);
  const [order, setOrder] = useState<Order>("genre");
  const items = useMemo(() => buildCrate(albums, order), [albums, order]);
  const [focus, setFocus] = useState(1);
  const [view, setView] = useState<View>("crate");
  const [hero, setHero] = useState<Album | null>(null);
  const [turns, setTurns] = useState(0);
  const [returning, setReturning] = useState(false);
  const [palette, setPalette] = useState<Palette>(NEUTRAL);
  const fromRect = useRef<DOMRect | null>(null);
  const [notes, setNotes] = useState<Notes | null>(null);
  const [gatefold, setGatefold] = useState<"closed" | "open" | "closing">("closed");
  const gatefoldFrom = useRef<DOMRect | null>(null);
  const [searching, setSearching] = useState(false);
  const lastAdded = useRef<string | null>(null);

  // Spotify's side.
  const [spotify, setSpotify] = useState<{ now: Spotify | null; at: number } | null>(null);
  /** Polls that failed in a row. One is noise; two in a row is worth a line. */
  const [pollFailures, setPollFailures] = useState(0);
  const [pollNow, setPollNow] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ reason: SheetReason; retry: { album: Album; index: number } | null } | null>(
    null,
  );
  /** A record to bring out once the one floating has gone back. */
  const queued = useRef<Album | null>(null);

  const focused: CrateItem | undefined = items[focus];

  // The collection, and again whenever the dev panel resets it.
  useEffect(() => {
    let live = true;
    const reload = () =>
      loadCollection().then((next) => {
        if (!live) return;
        setCollection((current) =>
          current && current.length === next.length && current.every((a, i) => a.id === next[i].id)
            ? current
            : next,
        );
      });
    void reload();
    const off = subscribe(() => void reload());
    return () => {
      live = false;
      off();
    };
  }, []);

  // First run: nothing to flip through, so go straight to search.
  const firstRun = collection !== null && collection.length === 0;
  useEffect(() => {
    if (firstRun) setSearching(true);
  }, [firstRun]);

  useEffect(() => {
    if (focus >= items.length && items.length) setFocus(items.length - 1);
  }, [items.length, focus]);

  // Ask Spotify what's playing every couple of seconds, waiting for each
  // answer before asking again, as the app's playback bar does.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const now = await getPlayback();
        if (stopped) return;
        setSpotify({ now, at: Date.now() });
        setPollFailures(0);
      } catch {
        if (stopped) return;
        setPollFailures((n) => n + 1);
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pollNow]);

  // A quiet line fades on its own.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // Play was pressed, Spotify said yes, and now it's playing that record: the
  // needle is down.
  useEffect(() => {
    if (!pending?.resolvedAt || !spotify || spotify.at < pending.resolvedAt) return;
    if (spotify.now?.track?.albumId === pending.album.id || spotify.at - pending.resolvedAt > 6000) {
      setPending(null);
    }
  }, [spotify, pending]);

  const live: Live | null = useMemo(() => {
    if (pending) {
      const t = pending.album.tracks[pending.index];
      return {
        album: pending.album,
        stranger: false,
        index: pending.index,
        title: t.title,
        durationMs: t.durationMs,
        positionMs: 0,
        at: 0,
        paused: false,
        starting: true,
        advert: false,
        device: pending.device,
      };
    }
    const now = spotify?.now;
    if (!now) return null;
    if (!now.track) {
      return {
        album: { id: "advert", genre: "", title: "", artist: "", year: null, label: null, tracks: [] },
        stranger: true,
        index: null,
        title: "An advert",
        durationMs: 30000,
        positionMs: now.progressMs ?? 0,
        at: spotify!.at,
        paused: !now.isPlaying,
        starting: false,
        advert: true,
        device: now.device,
      };
    }
    const track = now.track;
    const ours = track.albumId && owned.has(track.albumId) ? fixtureAlbum(track.albumId) : null;
    const album = ours ?? strangerAlbum(track);
    // Spotify says which track by name, not by number.
    const index = ours ? ours.tracks.findIndex((t) => t.title === track.title) : -1;
    return {
      album,
      stranger: !ours,
      index: index >= 0 ? index : null,
      title: track.title,
      durationMs: track.durationMs,
      positionMs: now.progressMs ?? 0,
      at: spotify!.at,
      paused: !now.isPlaying,
      starting: false,
      advert: false,
      device: now.device,
    };
  }, [pending, spotify, owned]);

  const heroIsPlaying = !!hero && !!live && !live.advert && live.album.id === hero.id;
  const heroIsStranger = !!hero && !owned.has(hero.id);

  // Warm the big artwork and the palette for whatever's at the front.
  useEffect(() => {
    if (focused?.kind !== "album") return;
    const t = setTimeout(() => {
      new Image().src = cover(focused.album, "lg");
      paletteFor(cover(focused.album, "sm"));
    }, 120);
    return () => clearTimeout(t);
  }, [focused]);

  // The glow takes the record's colours. A stranger's record doesn't get any.
  useEffect(() => {
    if (!hero) return;
    if (heroIsStranger) {
      setPalette(NEUTRAL);
      return;
    }
    let live = true;
    paletteFor(cover(hero, "sm")).then((p) => live && setPalette(p));
    return () => {
      live = false;
    };
  }, [hero, heroIsStranger]);

  const reorder = (next: Order) => {
    if (next === order || !focused) return;
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
    if (!hero || heroIsStranger) return;
    let live = true;
    fetch(`/notes/${slug(hero)}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((n: Notes | null) => live && setNotes(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [hero, heroIsStranger]);

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

  const pullOut = useCallback((album: Album, to: View) => {
    const el = document.querySelector('.slot[data-focused] .sleeve-face, .slot[data-focused] .divider-card');
    if (!el) return;
    fromRect.current = el.getBoundingClientRect();
    setTurns(0);
    setHero(album);
    setView(to);
    if (to === "back") requestAnimationFrame(() => requestAnimationFrame(() => setTurns(1)));
  }, []);

  // A stranger's record has no slot in the crate: it rises from below.
  const bringStranger = useCallback((album: Album) => {
    const w = Math.min(innerWidth, innerHeight) * 0.3;
    fromRect.current = new DOMRect(innerWidth / 2 - w / 2, innerHeight + 40, w, w);
    setTurns(0);
    setHero(album);
    setView("playing");
  }, []);

  const putBack = useCallback(() => {
    if (!hero || returning) return;
    setTurns((t) => (t % 2 ? t + 1 : t));
    setView("crate");
    setReturning(true);
  }, [hero, returning]);

  const select = useCallback(() => {
    if (!focused) return;
    if (focused.kind === "album") pullOut(focused.album, "back");
    else step(1);
  }, [focused, pullOut, step]);

  // Bring out what's playing: from its slot in the crate, or from below.
  const bringOut = useCallback(
    (album: Album, stranger: boolean) => {
      if (stranger) return bringStranger(album);
      const at = items.findIndex((i) => i.kind === "album" && i.album.id === album.id);
      if (at < 0) return;
      setFocus(at);
      setTimeout(() => pullOut(album, "playing"), 300);
    },
    [items, pullOut, bringStranger],
  );

  // The record floating isn't the one playing any more (someone changed it
  // from their phone): put it back and bring out the one that is.
  useEffect(() => {
    if (!hero || view !== "playing" || returning || pending || !live || live.advert || gatefold !== "closed") return;
    if (live.album.id === hero.id) return;
    queued.current = live.album;
    putBack();
  }, [hero, view, returning, pending, live, putBack, gatefold]);

  const turnBack = () => {
    setTurns((t) => (t % 2 ? t : t + 1));
    setView("back");
  };

  // The music stopped under a floating record (the speaker fell asleep, or
  // someone pressed stop): it turns over to its tracklist, ready to go again.
  const wasPlaying = useRef(false);
  useEffect(() => {
    const stopped = wasPlaying.current && !heroIsPlaying && spotify?.now === null;
    wasPlaying.current = heroIsPlaying;
    if (stopped && hero && view === "playing" && !returning && !heroIsStranger && gatefold === "closed") turnBack();
  }, [heroIsPlaying, spotify, hero, view, returning, heroIsStranger, gatefold]);

  /** Plays the record on a device, and waits for the needle to drop. */
  const start = async (album: Album, index: number, device: string) => {
    setSheet(null);
    setPending({ album, index, device, resolvedAt: null });
    const out = hero?.id === album.id;
    if (out) {
      setTurns((t) => (t % 2 ? t + 1 : t));
      setView("playing");
    }
    const t = album.tracks[index];
    try {
      const outcome = await playAlbum(album.id, device, `${album.id}:${t.disc}:${t.number}`);
      if (outcome.state === "deviceMissing") {
        setPending(null);
        if (out) turnBack();
        setSheet({ reason: { kind: "missing", device }, retry: { album, index } });
        return;
      }
      setPending((p) => p && { ...p, resolvedAt: Date.now() });
      setPollNow((n) => n + 1);
    } catch (e) {
      setPending(null);
      if (out) turnBack();
      setNotice(errorMessage(e));
    }
  };

  const pick = async (index: number) => {
    if (!hero || pending) return;
    try {
      const { devices, remembered } = await getDevices();
      if (remembered === null) {
        // The first play: ask once where it should go.
        setSheet({ reason: { kind: devices.length ? "first" : "none" }, retry: { album: hero, index } });
        return;
      }
      void start(hero, index, remembered);
    } catch (e) {
      setNotice(errorMessage(e));
    }
  };

  const turnOver = () => {
    if (heroIsStranger) return;
    setTurns((t) => t + 1);
    setView("back");
  };

  const reopenPlaying = () => {
    if (!live || hero || live.advert) return;
    bringOut(live.album, live.stranger);
  };

  /** Sends play/pause, next or previous. The next answer shows what it did. */
  const control = async (send: () => Promise<void>, optimistic?: () => void) => {
    optimistic?.();
    try {
      await send();
    } catch (e) {
      setNotice(errorMessage(e));
    }
    setPollNow((n) => n + 1);
  };

  const togglePause = () => {
    if (!spotify?.now || pending) return;
    const playing = spotify.now.isPlaying;
    control(playing ? pausePlayback : resumePlayback, () => {
      // Shown straight away, from where the line is now.
      const at = Date.now();
      setSpotify((s) =>
        s?.now
          ? {
              at,
              now: {
                ...s.now,
                isPlaying: !playing,
                progressMs: (s.now.progressMs ?? 0) + (playing ? at - s.at : 0),
              },
            }
          : s,
      );
    });
  };

  // The scroll wheel flips through the crate. Trackpads send lots of small
  // deltas and mice send big ones, so accumulate and step every so often.
  useEffect(() => {
    let acc = 0;
    const wheel = (e: WheelEvent) => {
      if (searching) return;
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
  }, [view, hero, step, jump, searching]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (searching || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest?.("input, .dev")) return;
      if (e.key === "t") {
        setTypeface(document.documentElement.classList.contains("type-grotesk") ? "serif" : "grotesk");
      } else if (e.key === "d") {
        setSheet((s) => (s ? null : { reason: { kind: "choose" }, retry: null }));
      } else if (e.key === "Escape") {
        if (sheet) setSheet(null);
        else if (gatefold === "open") setGatefold("closing");
        else if (gatefold === "closed") putBack();
      } else if (e.key === " ") {
        e.preventDefault();
        togglePause();
      } else if (gatefold !== "closed") {
        return;
      } else if (view === "playing" && heroIsPlaying && !pending && !live?.stranger) {
        if (e.key === "ArrowRight") void control(nextTrack);
        else if (e.key === "ArrowLeft") void control(previousTrack);
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
  });

  const closeSearch = () => {
    setSearching(false);
    // Show the last record you added, in its place in the crate.
    const id = lastAdded.current;
    lastAdded.current = null;
    if (!id) return;
    const at = items.findIndex((i) => i.kind === "album" && i.album.id === id);
    if (at >= 0) setFocus(at);
  };

  const added = (id: string) => {
    lastAdded.current = id;
    const album = fixtureAlbum(id);
    if (!album) return;
    setCollection((c) => (c && !c.some((a) => a.id === id) ? [...c, album] : c));
  };

  // A stranger's record, added while it plays: it becomes one of yours, and
  // the glow takes its colours.
  const [addingLive, setAddingLive] = useState(false);
  const addStranger = async (album: Album) => {
    setAddingLive(true);
    try {
      await addAlbum(album.id);
      const real = fixtureAlbum(album.id);
      if (real && hero?.id === album.id) setHero(real);
      added(album.id);
      lastAdded.current = null;
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setAddingLive(false);
    }
  };

  const ambient = heroIsPlaying && !returning ? (live!.starting ? "warming" : live!.paused ? "paused" : "on") : "off";
  const crateState =
    view === "crate" ? "rest" : heroIsPlaying || heroIsStranger || gatefold !== "closed" ? "gone" : "dim";
  const spotifyQuiet =
    notice ?? (pollFailures >= 2 ? "Spotify isn't answering. Deadwax will keep trying." : null);

  if (collection === null) return <div className="room" />;

  return (
    <div className="room">
      <Ambient palette={palette} level={ambient} />

      {focused && (
        <Crate
          items={items}
          focus={focus}
          hiddenId={hero ? albumKey(hero) : null}
          state={crateState}
          onFocus={setFocus}
          onSelect={select}
        />
      )}

      {focused ? (
        <Caption item={focused} hidden={view !== "crate" || !!hero} pushed={!!spotifyQuiet} />
      ) : (
        <div className={`empty-crate ${searching ? "hidden" : ""}`}>
          <p>Nothing in the crate yet.</p>
          <button onClick={() => setSearching(true)}>Find a record</button>
        </div>
      )}

      <nav className={`orders ${view !== "crate" || hero || !focused ? "hidden" : ""}`}>
        {ORDERS.map((o) => (
          <button key={o.id} className={o.id === order ? "on" : undefined} onClick={() => reorder(o.id)}>
            {o.label}
          </button>
        ))}
      </nav>

      <button
        className={`find ${hero || searching ? "hidden" : ""}`}
        onClick={() => setSearching(true)}
        aria-label="Find a record"
        title="Find a record"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      {hero && fromRect.current && (
        <Hero
          album={hero}
          palette={palette}
          turns={turns}
          floating={view === "playing"}
          current={heroIsPlaying ? live!.index : null}
          fromRect={fromRect.current}
          returning={returning}
          stranger={heroIsStranger}
          starting={heroIsPlaying && live!.starting}
          onReturned={() => {
            setHero(null);
            setReturning(false);
            const next = queued.current;
            queued.current = null;
            if (next) setTimeout(() => bringOut(next, !owned.has(next.id)), 200);
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
          current={heroIsPlaying ? live!.index : null}
          from={gatefoldFrom.current}
          closing={gatefold === "closing"}
          onClosed={() => setGatefold("closed")}
        />
      )}

      {live && (
        <NowPlaying
          live={live}
          big={view === "playing" && heroIsPlaying && !returning && gatefold === "closed"}
          chip={!hero && view === "crate" && !searching}
          onOpen={reopenPlaying}
          onDevice={() => setSheet({ reason: { kind: "choose" }, retry: null })}
          onAdd={live.stranger && !live.advert && fixtureAlbum(live.album.id) ? () => addStranger(live.album) : null}
          adding={addingLive}
        />
      )}

      {sheet && (
        <DeviceSheet
          reason={sheet.reason}
          onClose={() => setSheet(null)}
          onChosen={(device) => {
            setSheet(null);
            if (sheet.retry) void start(sheet.retry.album, sheet.retry.index, device);
            // Moving a record from the crate to another device: there's no
            // transfer command yet, so play the track again over there.
            else if (live && !live.stranger && live.index !== null && live.device !== device) {
              void start(live.album, live.index, device);
            }
          }}
          onFailed={setNotice}
        />
      )}

      <p className={`quiet ${spotifyQuiet ? "on" : ""}`} role="status">
        {spotifyQuiet}
      </p>

      <p className={`hint ${gatefold !== "closed" || searching || !focused ? "playing" : view}`}>
        {view === "crate"
          ? "scroll to flip · shift-scroll or [ ] to jump · click to pull out"
          : view === "back"
            ? heroIsStranger
              ? "esc to put it back"
              : "pick a track · esc to put it back"
            : heroIsStranger
              ? "space to pause · esc for the crate"
              : "click the sleeve to turn it over · space to pause · ← → to skip · esc for the crate"}
      </p>

      <Search
        open={searching}
        firstRun={firstRun}
        onClose={closeSearch}
        onAdded={added}
        onFailed={setNotice}
      />

      <div className="grain" />
      <Hud />
    </div>
  );
}

function Caption({ item, hidden, pushed }: { item: CrateItem; hidden: boolean; pushed: boolean }) {
  return (
    <div className={`caption ${hidden ? "hidden" : ""} ${pushed ? "pushed" : ""}`}>
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
  live,
  big,
  chip,
  onOpen,
  onDevice,
  onAdd,
  adding,
}: {
  live: Live;
  big: boolean;
  chip: boolean;
  onOpen: () => void;
  onDevice: () => void;
  /** Offered for a stranger's record. */
  onAdd: (() => void) | null;
  adding: boolean;
}) {
  const { album, index, paused, starting, stranger, advert, durationMs } = live;
  // The clock between Spotify's answers, kept here so only this line redraws.
  const [clock, setClock] = useState(Date.now());
  const moving = !paused && !starting;
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(t);
  }, [moving]);
  const positionMs = starting
    ? 0
    : Math.min(durationMs, live.positionMs + (moving ? Math.max(0, clock - live.at) : 0));
  const side = index === null ? null : sides(album.tracks).find((s) => s.tracks.some((t) => t.index === index))!;
  const n = side ? side.tracks.findIndex((t) => t.index === index) + 1 : 0;
  const where = side ? `Side ${side.name} · ${n}` : stranger && !advert ? "Not in your crate" : "Spotify";
  const state = starting ? " · starting" : paused ? " · paused" : "";
  const progress = starting ? 0 : Math.min(1, positionMs / durationMs);
  const device = live.device && (
    <>
      {" · "}
      <button className="now-device" onClick={onDevice} title="Play somewhere else">
        on {live.device}
      </button>
    </>
  );

  return (
    <>
      <div
        className={`now ${big ? "on" : ""} ${starting ? "starting" : ""}`}
        key={`${album.id}-${index ?? live.title}`}
      >
        <p className="now-side">
          {where}
          {state}
          {onAdd && (
            <button className="add-now" onClick={onAdd} disabled={adding}>
              {adding ? "Adding…" : "Add to the crate"}
            </button>
          )}
        </p>
        <h1 className="now-title">{cleanTitle(live.title)}</h1>
        <p className="now-album">
          {advert ? "Spotify will be back in a moment" : `${album.artist} — ${cleanTitle(album.title)}`}
          {device}
        </p>
        <div className="now-bar">
          <span>{formatTime(starting ? 0 : positionMs)}</span>
          <div className="now-line">
            <div style={{ transform: `scaleX(${progress})` }} />
          </div>
          <span>−{formatTime(durationMs - (starting ? 0 : positionMs))}</span>
        </div>
      </div>
      <div className={`chip ${chip ? "on" : ""} ${stranger ? "stranger" : ""}`}>
        <button className="chip-open" onClick={onOpen} disabled={advert}>
          {!advert && <img src={cover(album, "sm")} alt="" />}
          <span>
            <strong>{cleanTitle(live.title)}</strong>
            {advert ? "Spotify" : album.artist}
            {paused && " · paused"}
          </span>
        </button>
        {live.device && (
          <button className="chip-device" onClick={onDevice} title="Play somewhere else">
            {live.device}
          </button>
        )}
      </div>
    </>
  );
}
