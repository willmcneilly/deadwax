import type { CSSProperties } from "react";
import { WEAR_VARIANTS } from "./grain";
import { css, type Palette } from "./palette";
import { cleanTitle, cover, formatTime, hash, sides, type Album } from "./types";

// Each sleeve wears differently: one of a few pre-drawn wear images.
export function wear(album: Album): CSSProperties {
  return { "--wear": `var(--wear-${Math.floor(hash(album.id) * WEAR_VARIANTS)})` } as CSSProperties;
}

export function SleeveFront({ album, size }: { album: Album; size: "sm" | "lg" }) {
  return (
    <div className="sleeve-face" style={wear(album)}>
      <img src={cover(album, size)} alt="" draggable={false} decoding="async" />
      <div className="wear" />
    </div>
  );
}

// A record from outside the collection, as Spotify shows it: its cover in a
// plain paper sleeve, with none of the crate's wear.
export function StrangerFront({ album }: { album: Album }) {
  return (
    <div className="sleeve-face stranger">
      <img src={cover(album, "lg")} alt="" draggable={false} decoding="async" />
    </div>
  );
}

export function SleeveBack({
  album,
  palette,
  current,
  onPick,
}: {
  album: Album;
  palette: Palette;
  current: number | null;
  onPick: (index: number) => void;
}) {
  const n = album.tracks.length;
  const scale = n > 18 ? 0.019 : n > 13 ? 0.023 : n > 9 ? 0.027 : 0.031;
  const style = {
    ...wear(album),
    "--ground": css(palette.ground),
    "--ink": css(palette.ink),
    "--muted": css(palette.muted),
    "--accent": css(palette.accent),
    "--fs": scale,
  } as CSSProperties;
  const label = album.label?.replace(/^[℗©]\s*\d{4}\s*/, "") ?? null;

  return (
    <div className="sleeve-face back" style={style}>
      <div className="back-inner">
        <header>
          <p className="back-artist">{album.artist}</p>
          <h2 className="back-title">{cleanTitle(album.title)}</h2>
        </header>
        <div className="back-sides">
          {sides(album.tracks).map((side) => (
            <section key={side.name}>
              <h3>Side {side.name}</h3>
              <ol>
                {side.tracks.map(({ track, index }, i) => (
                  <li key={index}>
                    <button
                      className={index === current ? "playing" : undefined}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPick(index);
                      }}
                    >
                      <span className="num">
                        {side.name}
                        {i + 1}
                      </span>
                      <span className="name">{cleanTitle(track.title)}</span>
                      <span className="dur">{formatTime(track.durationMs)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
        <footer>
          <span>{[album.year, label].filter(Boolean).join(" · ")}</span>
          <span>33⅓ RPM · Stereo</span>
        </footer>
      </div>
      <div className="wear" />
    </div>
  );
}
