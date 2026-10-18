// The crate spike (DWX-20): the prototype's crate, its pulled-out sleeve and
// the glow, on the real collection's local artwork and palettes, so they can
// be measured in WebKit against the frame budget (RFC-002, "4. The UI").
//
// It isn't the app's UI: ticket 5 builds the crate for real from what this
// measured (DESIGN.md). Development builds only, opened from the Develop menu
// or by `scripts/crate-spike`.
//
// Keys: ← → flip, Enter pulls the record out, P plays (the glow), S opens
// search over the crate, Esc puts the record back or closes search.

import { invoke } from "@tauri-apps/api/core";
import {
  memo,
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { flushSync } from "react-dom";
import { getAlbum, type AlbumTrack } from "../api";
import type { Palette, Report } from "../ArtworkReport";
import { effectClasses, FINAL, PROTOTYPE, type Effects } from "./effects";
import { painted } from "./frameMeter";
import { postResult, type Run } from "./remote";
import { runScenario, type Controller } from "./scenarios";
import { installTextures, poolImage, vignetteImage, WEAR_VARIANTS } from "./textures";
import "./crateSpike.css";

const AHEAD = 3; // records drawn already flipped past
const MANY = 400; // the stress test's crate

type Album = {
  id: string;
  /** Unique in the crate: the 400-record crate repeats the collection. */
  key: string;
  /** Which repeat this is, so each one's covers are different URLs. */
  copy: number | null;
  title: string;
  artist: string;
  genre: string;
  palette: Palette;
  tracks: AlbumTrack[];
};

type Divider = { kind: "divider"; key: string; label: string; count: number; tab: number };
type Item = Divider | { kind: "album"; key: string; album: Album };

/** For an album whose palette step hasn't run yet. */
const NEUTRAL: Palette = {
  key: ["#6b6158", "#4a423b", "#8a7d70"],
  ground: "#efe7d8",
  rear: "#e2d8c6",
  ink: "#1e1a16",
  muted: "#5c544b",
  accent: "#7a4b2a",
  dark: false,
  deep: "#14110e",
};

/**
 * One size of the album's cover from disk. Each repeat in the 400-record
 * crate gets its own URL, so WebKit treats it as a different image, as it
 * would 400 different albums.
 */
function cover(album: Album, size: "320" | "640" | "1600", bust?: number): string {
  const query = [
    album.copy === null ? "" : `copy=${album.copy}`,
    bust === undefined ? "" : `pull=${bust}`,
  ].filter(Boolean);
  return `cover://localhost/${album.id}/${size}${query.length ? `?${query.join("&")}` : ""}`;
}

function hash(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

const wear = (album: Album) =>
  ({ "--wear": `var(--spike-wear-${Math.floor(hash(album.id) * WEAR_VARIANTS)})` }) as CSSProperties;

/** The collection with its palettes and genres, from the Artwork report. */
async function loadCollection(): Promise<Album[]> {
  const report = await invoke<Report>("artwork_report");
  return Promise.all(
    report.albums.map(async (row) => {
      const tracks = await getAlbum(row.id).then(
        (album) => album.tracks,
        () => [],
      );
      return {
        id: row.id,
        key: row.id,
        copy: null,
        title: row.title,
        artist: row.artist,
        genre: row.genre ?? "Unsorted",
        palette: row.palette ?? NEUTRAL,
        tracks,
      };
    }),
  );
}

function stretch(albums: Album[]): Album[] {
  const out: Album[] = [];
  for (let copy = 0; albums.length && out.length < MANY; copy++) {
    for (const a of albums) out.push({ ...a, key: `${a.id}~${copy}`, copy });
  }
  return out;
}

/** Sorted by genre, with a divider in front of each. */
function crateItems(albums: Album[]): Item[] {
  const sorted = [...albums].sort(
    (a, b) => a.genre.localeCompare(b.genre) || a.artist.localeCompare(b.artist),
  );
  const items: Item[] = [];
  let divider = null as Divider | null;
  for (const album of sorted) {
    if (divider?.label !== album.genre) {
      divider = {
        kind: "divider",
        key: `divider-${album.genre}`,
        label: album.genre,
        count: 0,
        tab: items.filter((i) => i.kind === "divider").length % 3,
      };
      items.push(divider);
    }
    divider.count++;
    items.push({ kind: "album", key: album.key, album });
  }
  return items;
}

// Where a record sits relative to the one in front (d = 0), in 2D: each one
// further back a little higher and smaller, as the 3D crate looks from the front.
function placeFlat(d: number, jitter: number, behind: number): CSSProperties {
  if (d < 0) return { transform: `translate(${jitter * 6}px, 30%) scale(1.05)`, opacity: 0 };
  return {
    transform: `translate(${jitter * 5}px, ${-d * 2.2}%) scale(${1 - d * 0.035}) rotate(${d ? jitter * 0.9 : 0}deg)`,
    opacity: d > behind - 1 ? 0 : 1,
  };
}

// Where a record sits relative to the one in front (d = 0). The prototype's.
function place(d: number, jitter: number, behind: number): CSSProperties {
  if (d < 0) {
    return {
      transform: `translate3d(${jitter * 6}px, 4%, 60px) rotateX(-72deg) rotateZ(${jitter * 1.2}deg)`,
      opacity: 0,
    };
  }
  if (d === 0) return { transform: "translate3d(0, 0, 0) rotateX(5deg)" };
  return {
    transform: `translate3d(${jitter * 5}px, 0, ${-14 - d * 20}px) rotateX(${13 + Math.min(d, 8) * 0.6}deg) rotateZ(${jitter * 0.9}deg)`,
    opacity: d > behind - 1 ? 0 : 1,
  };
}

/** The size a slot draws: the front two get the 640, the rest the 320. */
const slotSize = (d: number, sizes: Effects["sizes"]) => (sizes === "640" || d <= 1 ? "640" : "320");

const Crate = memo(function Crate({
  items,
  focus,
  hiddenKey,
  state,
  behind,
  sizes,
  scene,
}: {
  items: Item[];
  focus: number;
  hiddenKey: string | null;
  state: "rest" | "dim";
  behind: number;
  sizes: Effects["sizes"];
  scene: Effects["scene"];
}) {
  const slots = [];
  for (let i = Math.max(0, focus - AHEAD); i <= Math.min(items.length - 1, focus + behind); i++) {
    const item = items[i];
    const d = i - focus;
    const jitter = (hash(item.key) - 0.5) * 2;
    slots.push(
      <div
        key={item.key}
        className={`spike-slot ${item.kind} ${d < 0 ? "past" : ""}`}
        data-front={d === 0 || undefined}
        style={{
          ...(scene === "flat" ? placeFlat : place)(d, jitter, behind),
          zIndex: 100 - d,
          visibility: item.key === hiddenKey ? "hidden" : undefined,
          ["--shade" as string]: d > 0 ? Math.min(0.08 + d * 0.055, 0.75) : d < 0 ? 0.55 : 0,
        }}
      >
        {item.kind === "album" ? (
          <>
            <div className="spike-face" style={wear(item.album)}>
              <img src={cover(item.album, slotSize(d, sizes))} alt="" draggable={false} decoding="async" />
              <div className="spike-wear" />
            </div>
            <div className="spike-rear" />
          </>
        ) : (
          <div className="spike-divider" style={{ ["--tab" as string]: `${6 + item.tab * 35}%` }}>
            <div className="spike-divider-tab">{item.label}</div>
            <div className="spike-divider-body">
              <span className="spike-divider-big">{item.label}</span>
              <span className="spike-divider-count">
                {item.count} {item.count === 1 ? "record" : "records"}
              </span>
            </div>
          </div>
        )}
        <div className="spike-shade" />
      </div>,
    );
  }
  return (
    <div className={`spike-crate ${state}`}>
      <div className="spike-stack">{slots}</div>
    </div>
  );
});

function Hero({
  album,
  largeUrl,
  from,
  floating,
  flight,
  lazyBack,
  largeFirst,
  onLargePainted,
}: {
  album: Album;
  largeUrl: string;
  from: DOMRect;
  floating: boolean;
  flight: boolean;
  /** Build the back only once the sleeve is first turned over. */
  lazyBack: boolean;
  /** Draw the 1600 from the first frame, rather than the 640 until the 1600 is decoded. */
  largeFirst: boolean;
  onLargePainted: (at: { loaded: number; decoded: number; painted: number; first: number }) => void;
}) {
  const lift = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(largeFirst);
  const [turns, setTurns] = useState(0);
  // When the sleeve's first frame is on screen.
  const [firstFrame] = useState(painted);

  useEffect(() => {
    const el = lift.current;
    if (!el || !flight) return;
    const r = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (r.left + r.width / 2);
    const dy = from.top + from.height / 2 - (r.top + r.height / 2);
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${from.width / r.width})` }, { transform: "none" }],
      { duration: 760, easing: "cubic-bezier(.2,.75,.15,1)" },
    );
  }, [from, flight]);

  const p = album.palette;
  const back = {
    ...wear(album),
    "--ground": p.ground,
    "--ink": p.ink,
    "--muted": p.muted,
    "--accent": p.accent,
  } as CSSProperties;

  return (
    <div className={`spike-hero ${floating ? "floating" : ""}`}>
      <div className="spike-hero-lift" ref={lift}>
        <div className="spike-hero-offset">
          <div className="spike-hero-float">
            <div
              className="spike-flipper"
              style={{ transform: `rotateY(${turns * 180}deg)` }}
              onClick={() => setTurns((t) => t + 1)}
            >
              <div className="spike-hero-face">
                <div className="spike-face" style={wear(album)}>
                  {!largeFirst && <img src={cover(album, "640")} alt="" draggable={false} />}
                  <img
                    className={`large ${ready ? "ready" : ""}`}
                    src={largeUrl}
                    alt=""
                    draggable={false}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      const loaded = performance.now();
                      let decoded = loaded;
                      void img
                        .decode()
                        .catch(() => {})
                        .then(() => {
                          decoded = performance.now();
                          setReady(true);
                          return Promise.all([painted(), firstFrame]);
                        })
                        .then(([shown, first]) => onLargePainted({ loaded, decoded, painted: shown, first }));
                    }}
                  />
                  <div className="spike-wear" />
                </div>
              </div>
              <div className="spike-hero-face back">
                {(!lazyBack || turns > 0) && (
                <div className="spike-face back" style={back}>
                  <div className="spike-back">
                    <p>{album.artist}</p>
                    <h2>{album.title}</h2>
                    <ol>
                      {album.tracks.map((t) => (
                        <li key={t.spotifyId}>
                          <span>{t.title}</span>
                          <span>{Math.round(t.durationMs / 60000)}′</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="spike-wear" />
                </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const POOLS = 5;

function Ambient({ palette, on, glow }: { palette: Palette; on: boolean; glow: Effects["glow"] }) {
  const colours = Array.from({ length: POOLS }, (_, i) => palette.key[i % palette.key.length]);
  const images = useMemo(
    () => (glow === "images" ? { pools: colours.map((c) => poolImage(c)), vignette: vignetteImage() } : null),
    // The colours are the palette's; they change only with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- colours derives from palette
    [palette, glow],
  );
  if (glow === "off") return null;
  return (
    <div className={`spike-ambient ${on ? "on" : ""}`} style={{ "--deep": palette.deep } as CSSProperties}>
      {colours.map((c, i) => (
        <div key={i} className={`spike-pool p${i}`} style={{ "--c": c } as CSSProperties}>
          {images && <img src={images.pools[i]} alt="" />}
        </div>
      ))}
      {images ? <img className="spike-vignette" src={images.vignette} alt="" /> : <div className="spike-vignette" />}
    </div>
  );
}

/**
 * Milliseconds from pulling a record out to its large cover loaded, decoded
 * and on screen, and to the sleeve's own first frame on screen.
 */
export type LargeTimes = { loaded: number; decoded: number; painted: number; first: number };

/** What the pretend poll returns while "playing". */
type Playback = { title: string; progressMs: number };

export default function CrateSpike({ run, onClose }: { run: Run | null; onClose: () => void }) {
  const [collection, setCollection] = useState<Album[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [many, setMany] = useState(false);
  const [effects, setEffects] = useState<Effects>(PROTOTYPE);
  const [focus, setFocus] = useState(0);
  const [hero, setHero] = useState<{ item: number; from: DOMRect; largeUrl: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [searching, setSearching] = useState(false);
  const [, setPlayback] = useState<Playback | null>(null);
  const [status, setStatus] = useState("");

  const searchRef = useRef<HTMLDivElement>(null);
  const pulledAt = useRef(0);
  const largeWaiters = useRef<((ms: LargeTimes) => void)[]>([]);
  const longestCommit = useRef(0);
  const decoded = useRef(new Map<string, HTMLImageElement>());
  const busts = useRef(0);

  useEffect(() => {
    loadCollection().then(setCollection, (e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    void installTextures(effects.textures);
  }, [effects.textures]);

  const items = useMemo(
    () => (collection ? crateItems(many ? stretch(collection) : collection) : []),
    [collection, many],
  );

  const albumAt = useCallback(
    (from: number) => {
      for (let i = from; i < items.length; i++) if (items[i].kind === "album") return i;
      for (let i = from; i >= 0; i--) if (items[i].kind === "album") return i;
      return -1;
    },
    [items],
  );

  const pull = useCallback(
    (cold: boolean) => {
      const at = albumAt(focus);
      if (at < 0) return;
      setFocus(at);
      const item = items[at];
      if (item.kind !== "album") return;
      const slot = document.querySelector(".spike-slot[data-front]");
      const from = slot?.getBoundingClientRect() ?? new DOMRect(innerWidth / 2 - 200, innerHeight / 2, 400, 400);
      pulledAt.current = performance.now();
      setHero({ item: at, from, largeUrl: cover(item.album, "1600", cold ? ++busts.current : undefined) });
    },
    [albumAt, focus, items],
  );

  const putBack = useCallback(() => {
    setPlaying(false);
    setHero(null);
  }, []);

  // Decode ahead: the covers the next flips will draw, and the large cover of
  // the record in front, before they're needed.
  useEffect(() => {
    if (!effects.decodeAhead) return;
    const urls: string[] = [];
    for (let i = Math.max(0, focus - AHEAD); i <= Math.min(items.length - 1, focus + effects.behind + 4); i++) {
      const item = items[i];
      if (item.kind !== "album") continue;
      const d = i - focus;
      urls.push(cover(item.album, slotSize(d, effects.sizes)), cover(item.album, slotSize(d - 1, effects.sizes)));
      if (d >= 0 && d <= 1) urls.push(cover(item.album, "1600"));
    }
    const cache = decoded.current;
    for (const url of urls) {
      const kept = cache.get(url);
      cache.delete(url);
      if (kept) {
        cache.set(url, kept);
        continue;
      }
      const img = new Image();
      img.src = url;
      img.decode().catch(() => {});
      cache.set(url, img);
    }
    while (cache.size > 48) cache.delete(cache.keys().next().value as string);
  }, [effects.decodeAhead, effects.behind, effects.sizes, focus, items]);

  // The pretend poll: every 2 seconds while playing, as the app asks Spotify.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const next = { title: "The same track", progressMs: 0 };
      setPlayback((prev) =>
        !effects.pollRedraw && prev && prev.title === next.title ? prev : next,
      );
    }, 2000);
    return () => clearInterval(id);
  }, [playing, effects.pollRedraw]);

  // Keys, for trying it by hand.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (searching) setSearching(false);
        else if (hero) putBack();
        else onClose();
      } else if (searching) {
        return;
      } else if (hero) {
        if (e.key === "p") setPlaying((p) => !p);
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        setFocus((f) => Math.min(items.length - 1, f + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        setFocus((f) => Math.max(0, f - 1));
      } else if (e.key === "Enter") {
        pull(false);
      } else if (e.key === "s") {
        setSearching(true);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [hero, items.length, onClose, pull, putBack, searching]);

  // The controller scenarios drive, kept current every render.
  const controller = useRef<Controller | null>(null);
  useLayoutEffect(() => {
    controller.current = {
      count: () => items.length,
      flip: (index) => {
        // React's update, then the style and layout it causes, done now and
        // timed: the part of a flip's frame that's the page's own work.
        const start = performance.now();
        flushSync(() => setFocus(index));
        const committed = performance.now();
        document.querySelector(".spike-stack")?.getBoundingClientRect();
        return { react: committed - start, style: performance.now() - committed };
      },
      records: () => items.filter((i) => i.kind === "album").length,
      setFocus,
      pull,
      putBack,
      setPlaying,
      setSearch: setSearching,
      scrollSearch: (by) => searchRef.current?.scrollBy(0, by),
      largePainted: () => new Promise((resolve) => largeWaiters.current.push(resolve)),
      takeLongestCommit: () => {
        const ms = longestCommit.current;
        longestCommit.current = 0;
        return Math.round(ms * 10) / 10;
      },
    };
  }, [items, pull, putBack]);

  // A run from `scripts/crate-spike`: set it up, let it settle, measure.
  useEffect(() => {
    if (!run || !collection) return;
    const go = async () => {
      await Promise.resolve();
      setMany(run.many);
      setEffects({ ...PROTOTYPE, ...run.effects });
      setHero(null);
      setPlaying(false);
      setSearching(false);
      setFocus(0);
      setStatus(`Measuring ${run.scenario}…`);
      // WebKit stops drawing a covered window, so keep it in front.
      await invoke("crate_spike_keep_in_front", { on: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const c = controller.current;
      if (!c) return;
      const result = await runScenario(c, run).catch((e: unknown) => ({ error: String(e) }));
      await invoke("crate_spike_keep_in_front", { on: false });
      await postResult({
        id: run.id,
        run,
        records: c.records(),
        window: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          visible: document.visibilityState,
          focused: document.hasFocus(),
        },
        ...result,
      });
      setStatus(`Measured ${run.scenario}.`);
    };
    go().catch((e: unknown) => postResult({ id: run.id, run, error: String(e) }));
  }, [run, collection]);

  const onLargePainted = useCallback((at: { loaded: number; decoded: number; painted: number; first: number }) => {
    const since = (t: number) => Math.round(t - pulledAt.current);
    const times = {
      loaded: since(at.loaded),
      decoded: since(at.decoded),
      painted: since(at.painted),
      first: since(at.first),
    };
    for (const resolve of largeWaiters.current.splice(0)) resolve(times);
  }, []);

  if (error) return <div className="crate-spike">{error}</div>;
  if (!collection) return <div className="crate-spike" />;

  const heroItem = hero ? items[hero.item] : null;
  const heroAlbum = heroItem?.kind === "album" ? heroItem.album : null;

  return (
    <Profiler
      id="crate-spike"
      onRender={(_id, _phase, duration) => {
        longestCommit.current = Math.max(longestCommit.current, duration);
      }}
    >
      <div className={`crate-spike ${effectClasses(effects)}`}>
        <div className="spike-room" />
        {heroAlbum && <Ambient palette={heroAlbum.palette} on={playing} glow={effects.glow} />}
        <Crate
          items={items}
          focus={focus}
          hiddenKey={heroItem?.key ?? null}
          state={searching || hero ? "dim" : "rest"}
          behind={effects.behind}
          sizes={effects.sizes}
          scene={effects.scene}
        />
        {hero && heroAlbum && (
          <Hero
            key={hero.largeUrl}
            album={heroAlbum}
            largeUrl={hero.largeUrl}
            from={hero.from}
            floating={playing}
            flight={effects.flight}
            lazyBack={effects.lazyBack}
            largeFirst={effects.largeFirst}
            onLargePainted={onLargePainted}
          />
        )}
        {playing && heroAlbum && (
          <div className="spike-chip">
            <img src={cover(heroAlbum, "320")} alt="" />
            <span>
              {heroAlbum.title} · on Kitchen
            </span>
          </div>
        )}
        {searching && (
          <div className="spike-search" ref={searchRef}>
            {items.map((item) =>
              item.kind === "album" ? <img key={item.key} src={cover(item.album, "320")} alt="" loading="lazy" /> : null,
            )}
          </div>
        )}
        <div className="spike-grain" />
        <div className="spike-panel">
          <strong>Crate spike (DWX-20)</strong>
          <label>
            <input type="checkbox" checked={many} onChange={(e) => setMany(e.target.checked)} />
            400 records
          </label>
          <label>
            textures
            <select
              value={effects.textures}
              onChange={(e) => setEffects({ ...effects, textures: e.target.value as Effects["textures"] })}
            >
              <option>data</option>
              <option>blob</option>
            </select>
          </label>
          <label>
            behind
            <select value={effects.behind} onChange={(e) => setEffects({ ...effects, behind: Number(e.target.value) })}>
              <option>11</option>
              <option>6</option>
            </select>
          </label>
          {(
            ["wear", "shade", "backdrop", "filter", "lazyBack", "heroShadow", "decodeAhead", "pollRedraw"] as const
          ).map((name) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={effects[name]}
                onChange={(e) => setEffects({ ...effects, [name]: e.target.checked })}
              />
              {name}
            </label>
          ))}
          <label>
            grain
            <select value={effects.grain} onChange={(e) => setEffects({ ...effects, grain: e.target.value as Effects["grain"] })}>
              <option>animated</option>
              <option>still</option>
              <option>off</option>
            </select>
          </label>
          <label>
            glow
            <select value={effects.glow} onChange={(e) => setEffects({ ...effects, glow: e.target.value as Effects["glow"] })}>
              <option>gradients</option>
              <option>images</option>
              <option>off</option>
            </select>
          </label>
          <label>
            under search
            <select value={effects.under} onChange={(e) => setEffects({ ...effects, under: e.target.value as Effects["under"] })}>
              <option>dim</option>
              <option>hidden</option>
            </select>
          </label>
          <button type="button" onClick={() => setEffects({ ...PROTOTYPE, ...FINAL })}>
            Final cuts
          </button>
          <button type="button" onClick={() => setEffects(PROTOTYPE)}>
            Prototype
          </button>
          <output>
            {items.filter((i) => i.kind === "album").length} records · ← → Enter P S Esc{status && `\n${status}`}
          </output>
        </div>
      </div>
    </Profiler>
  );
}
