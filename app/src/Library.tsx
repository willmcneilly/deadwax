import { listen } from "@tauri-apps/api/event";
import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  ALBUM_UPDATED,
  errorMessage,
  getCollection,
  getSession,
  type AlbumCard,
  type AlbumId,
  type Session,
} from "./api";
import ArtworkReport from "./ArtworkReport";
import Crate from "./Crate";
import CrateMeter, { type CrateHandle } from "./crate-spike/CrateMeter";
import {
  crateItems,
  indexOf,
  ORDERS,
  type CrateItem,
  type Order,
} from "./crateOrder";
import DevList from "./DevList";
import PlaybackBar from "./PlaybackBar";
import Search from "./Search";
import Sleeve from "./Sleeve";
import { installTextures } from "./textures";
import "./Library.css";

type Props = {
  name: string;
  /** Called when a Spotify call fails because you're no longer signed in. */
  onSignedOut: (session: Session) => void;
};

/** The record you've pulled out of the crate, and where it came from. */
type Out = {
  key: string;
  from: DOMRect;
  returning: boolean;
  /** Development builds' measuring: load its 1600 as if never seen. */
  bust?: number;
};

/** What's in front: kept by key, so it stays put when the crate re-sorts. */
type Focus = { key: string | null; index: number };

/** How many decoded 1600s to keep hold of. */
const DECODED = 4;

/**
 * The collection as a crate in a dark room. Scroll or use the arrow keys to
 * flip, click the record in front or press Enter to pull it out, and Escape
 * to put it back. The old search box opens from Find a record until DWX-24
 * replaces it, and the playback bar is at the bottom until DWX-22 does.
 */
function Library({ name, onSignedOut }: Props) {
  const [albums, setAlbums] = useState<AlbumCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order>("genre");
  // The first record, behind the first divider.
  const [focus, setFocus] = useState<Focus>({ key: null, index: 1 });
  const [pulled, setPulled] = useState<Out | null>(null);
  const [turns, setTurns] = useState(0);
  const [searching, setSearching] = useState(false);
  /** Counts albums started, so the playback bar asks again straight away. */
  const [started, setStarted] = useState(0);
  /** Development builds' 400-record crate, for measuring. */
  const [many, setMany] = useState(false);
  const room = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    getCollection().then(setAlbums, (e: unknown) => setError(errorMessage(e)));
  }, []);

  useEffect(load, [load]);
  useEffect(() => void installTextures(), []);

  // When an album's cover is on disk, or its palette, genre and label are
  // found, the crate loads again, so its sleeve changes in place.
  useEffect(() => {
    const unlisten = listen(ALBUM_UPDATED, () => load());
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [load]);

  const items = useMemo(() => {
    if (!albums) return [];
    if (import.meta.env.DEV && many) {
      const { stretched, keys } = stretch(albums);
      return crateItems(stretched, order, keys);
    }
    return crateItems(albums, order);
  }, [albums, order, many]);

  const found = focus.key === null ? -1 : indexOf(items, focus.key);
  const index = Math.max(
    0,
    found >= 0 ? found : Math.min(focus.index, items.length - 1),
  );
  const front: CrateItem | undefined = items[index];
  const outItem = pulled ? items[indexOf(items, pulled.key)] : undefined;
  const outAlbum = outItem?.kind === "album" ? outItem.album : null;
  // A record that has left the crate while out (the Develop menu's Reset,
  // say) isn't out any more.
  const out = outAlbum ? pulled : null;

  const itemsRef = useRef(items);
  const indexRef = useRef(index);
  useLayoutEffect(() => {
    itemsRef.current = items;
    indexRef.current = index;
  });

  const flipTo = useCallback((to: number) => {
    const list = itemsRef.current;
    const at = Math.max(0, Math.min(list.length - 1, to));
    // Two flips in one frame each count, before React has drawn the first.
    indexRef.current = at;
    setFocus({ key: list[at]?.key ?? null, index: at });
  }, []);
  const step = useCallback(
    (by: number) => flipTo(indexRef.current + by),
    [flipTo],
  );

  /** To the next or previous divider. */
  const jump = useCallback(
    (dir: 1 | -1) => {
      const list = itemsRef.current;
      for (let i = indexRef.current + dir; i >= 0 && i < list.length; i += dir) {
        if (list[i].kind === "divider") return flipTo(i);
      }
      flipTo(dir === 1 ? list.length - 1 : 0);
    },
    [flipTo],
  );

  /** Pulls out the record in front. A divider in front flips past instead. */
  const pull = useCallback(
    (bust?: number) => {
      const item = itemsRef.current[indexRef.current];
      if (!item) return;
      if (item.kind === "divider") return step(1);
      const el = room.current?.querySelector(
        ".crate-slot[data-front] .sleeve-face",
      );
      const from =
        el?.getBoundingClientRect() ??
        new DOMRect(innerWidth / 2 - 200, innerHeight / 2, 400, 400);
      setTurns(0);
      setPulled({ key: item.key, from, returning: false, bust });
    },
    [step],
  );

  const pick = useCallback(
    (at: number) => (at === indexRef.current ? pull() : flipTo(at)),
    [flipTo, pull],
  );

  const putBack = useCallback(() => {
    setTurns((t) => (t % 2 ? t + 1 : t));
    setPulled((o) => (o && !o.returning ? { ...o, returning: true } : o));
  }, []);

  const reorder = (next: Order) => {
    if (next === order) return;
    setOrder(next);
    // Keep the record in front; a divider gives way to the first record.
    setFocus(
      front?.kind === "album"
        ? { key: front.key, index }
        : { key: null, index: 1 },
    );
  };

  // Decode the 1600 of the record in front ahead, and keep hold of it, so
  // pulling it out never waits on the disk (DESIGN.md, rule 5).
  const decoded = useRef(new Map<string, HTMLImageElement>());
  const frontLarge =
    front?.kind === "album" ? front.album.covers?.large : undefined;
  useEffect(() => {
    if (!frontLarge) return;
    const cache = decoded.current;
    const kept = cache.get(frontLarge);
    cache.delete(frontLarge);
    if (kept) {
      cache.set(frontLarge, kept);
      return;
    }
    const img = new Image();
    img.src = frontLarge;
    img.decode().catch(() => {});
    cache.set(frontLarge, img);
    while (cache.size > DECODED) {
      cache.delete(cache.keys().next().value as string);
    }
  }, [frontLarge]);

  // The scroll wheel flips: a mouse notch is one record, and a trackpad's
  // small deltas add up to one. With Shift, it jumps between dividers. Only
  // over the room, so the panels and the playback bar scroll as usual.
  useEffect(() => {
    const el = room.current;
    if (!el) return;
    let acc = 0;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (out || searching) return;
      if (e.shiftKey) {
        acc += e.deltaY || e.deltaX;
        if (Math.abs(acc) > 80) {
          jump(acc > 0 ? 1 : -1);
          acc = 0;
        }
        return;
      }
      const notch =
        e.deltaMode === 1 ||
        (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      acc += notch ? Math.sign(e.deltaY) * 36 : e.deltaY;
      const steps = Math.trunc(acc / 36);
      if (!steps) return;
      acc -= steps * 36;
      step(steps);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [out, searching, step, jump]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // Now playing and the crate spike cover the crate, with keys of their own.
      if (document.querySelector('[aria-modal="true"], .crate-spike')) return;
      const target = e.target as HTMLElement;
      if (target.closest?.("input, select, textarea")) {
        if (e.key === "Escape" && searching) setSearching(false);
        return;
      }
      const onControl = !!target.closest?.("button, a");
      if (e.key === "Escape") {
        if (searching) setSearching(false);
        else if (out) putBack();
      } else if (searching) {
        return;
      } else if (out) {
        if (e.key === "Enter" && !onControl) setTurns((t) => t + 1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Enter" && !onControl) {
        pull();
      } else if (e.key === "PageDown" || e.key === "]") {
        jump(1);
      } else if (e.key === "PageUp" || e.key === "[") {
        jump(-1);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [out, searching, step, jump, pull, putBack]);

  const added = (album: AlbumCard) =>
    setAlbums((current) => [
      album,
      ...(current ?? []).filter((a) => a.id !== album.id),
    ]);

  function removed(id: AlbumId) {
    setPulled(null);
    setAlbums((current) => current?.filter((a) => a.id !== id) ?? null);
    load();
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

  // The crate spike's measuring (DWX-20), in development builds only. The
  // handle reads the crate through refs, so it's made once.
  const meter = useRef<CrateHandle | null>(null);
  const largeReady = useRef<(() => void) | null>(null);
  const longestCommit = useRef(0);
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    meter.current = {
      count: () => itemsRef.current.length,
      records: () => itemsRef.current.filter((i) => i.kind === "album").length,
      setMany,
      setFocus: flipTo,
      albumAt: (at) => {
        const list = itemsRef.current;
        for (let i = at; i < list.length; i++) if (list[i].kind === "album") return i;
        for (let i = at; i >= 0; i--) if (list[i].kind === "album") return i;
        return at;
      },
      flip: (to) => {
        const start = performance.now();
        flushSync(() => flipTo(to));
        const committed = performance.now();
        room.current?.querySelector(".crate-stack")?.getBoundingClientRect();
        return { react: committed - start, style: performance.now() - committed };
      },
      pull: (cold) => pull(cold ? performance.now() : undefined),
      putBack: () => setPulled(null),
      onLargeReady: (f) => (largeReady.current = f),
      takeLongestCommit: () => {
        const ms = longestCommit.current;
        longestCommit.current = 0;
        return Math.round(ms * 10) / 10;
      },
    };
  }, [flipTo, pull]);

  const empty = albums?.length === 0;
  const pulledOut = !!out && !out.returning;

  return (
    <div className="library">
      <div className="room" ref={room}>
        <Profiler
          id="crate"
          onRender={(_id, _phase, ms) => {
            longestCommit.current = Math.max(longestCommit.current, ms);
          }}
        >
          <Crate
            items={items}
            focus={index}
            hiddenKey={out && !out.returning ? out.key : null}
            dim={pulledOut || searching}
            onPick={pick}
          />
          {out && outAlbum && (
            <>
              <div className="sleeve-backdrop" onClick={putBack} />
              <Sleeve
                key={out.key}
                album={bust(outAlbum, out.bust)}
                from={out.from}
                turns={turns}
                onTurn={() => setTurns((t) => t + 1)}
                returning={out.returning}
                onReturned={() => setPulled(null)}
                onRemoved={removed}
                onPlayed={() => setStarted((n) => n + 1)}
                onFailed={failed}
                onLargeReady={() => largeReady.current?.()}
              />
            </>
          )}
        </Profiler>
        {front && (
          <Caption item={front} hidden={pulledOut || searching} />
        )}
        {empty && !searching && (
          <div className="crate-empty">
            <p>Your crate is empty.</p>
            <button type="button" onClick={() => setSearching(true)}>
              Find a record
            </button>
          </div>
        )}
        <div className="room-grain" />
      </div>

      <nav
        className={`orders ${pulledOut || searching || empty ? "hidden" : ""}`}
        aria-label="Sort the crate"
      >
        {ORDERS.map((o) => (
          <button
            key={o.order}
            type="button"
            aria-pressed={o.order === order}
            onClick={() => reorder(o.order)}
          >
            {o.label}
          </button>
        ))}
      </nav>

      <header className="library-header">
        <p className="signed-in">Signed in as {name}</p>
        {albums !== null && !searching && !empty && (
          <button
            type="button"
            className="find"
            onClick={() => setSearching(true)}
          >
            Find a record
          </button>
        )}
      </header>

      <div className="library-panels">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {import.meta.env.DEV && <ArtworkReport onFailed={failed} />}
        {import.meta.env.DEV && (
          <DevList empty={empty} onChanged={load} onFailed={failed} />
        )}
        {searching && (
          <section className="search-panel" aria-label="Find a record">
            <button
              type="button"
              className="secondary close"
              onClick={() => setSearching(false)}
            >
              Back to the crate
            </button>
            <Search
              onAdded={added}
              onFailed={failed}
              onStarted={() => setError(null)}
            />
          </section>
        )}
      </div>

      <PlaybackBar started={started} onFailed={failed} />
      {import.meta.env.DEV && <CrateMeter crate={meter} />}
    </div>
  );
}

/** The artist and title of the record in front, or the divider's section. */
function Caption({ item, hidden }: { item: CrateItem; hidden: boolean }) {
  return (
    <div className={`caption ${hidden ? "hidden" : ""}`} aria-live="polite">
      {item.kind === "album" ? (
        <>
          <p className="caption-artist">{item.album.artist}</p>
          <p className="caption-title">
            {item.album.title}
            {item.album.year !== null && <span> · {item.album.year}</span>}
          </p>
        </>
      ) : (
        <p className="caption-section">{item.label}</p>
      )}
    </div>
  );
}

/**
 * The album with its 1600 loaded as if never seen, for measuring a cold
 * pull. Unchanged unless `n` is given.
 */
function bust(album: AlbumCard, n: number | undefined): AlbumCard {
  if (n === undefined || !album.covers) return album;
  const large = `${album.covers.large}${album.covers.large.includes("?") ? "&" : "?"}pull=${n}`;
  return { ...album, covers: { ...album.covers, large } };
}

/**
 * Development builds' 400-record crate: the collection repeated, each copy
 * with its own cover URLs (`?copy=n`), so WebKit loads and decodes every one
 * as a different image, as it would 400 different albums.
 */
function stretch(albums: AlbumCard[]): {
  stretched: AlbumCard[];
  keys: string[];
} {
  const stretched: AlbumCard[] = [];
  const keys: string[] = [];
  const copy = (url: string, n: number) =>
    `${url}${url.includes("?") ? "&" : "?"}copy=${n}`;
  for (let n = 0; albums.length && stretched.length < 400; n++) {
    for (const album of albums) {
      const { covers } = album;
      stretched.push({
        ...album,
        covers: covers && {
          small: copy(covers.small, n),
          medium: copy(covers.medium, n),
          large: copy(covers.large, n),
        },
      });
      keys.push(`${album.id}~${n}`);
    }
  }
  return { stretched, keys };
}

export default Library;
