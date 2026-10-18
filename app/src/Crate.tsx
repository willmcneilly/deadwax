// The crate: your collection as records you flip through, with a handwritten
// divider in front of each section (RFC-002, "4. The UI"). The prototype's
// (prototypes/crate), with what DWX-20 measured kept to (DESIGN.md, "Rules"):
// only the 6 sleeves behind the one in front and the 3 already flipped past
// are drawn, the front two draw the 640 and the rest the 320, and nothing in
// the 3D scene has a CSS filter.

import { memo, type CSSProperties, type ReactNode } from "react";
import type { AlbumCard } from "./api";
import type { CrateItem } from "./crateOrder";
import { hash, wearStyle } from "./textures";
import "./Crate.css";

/** How many records are drawn behind the one in front (DESIGN.md, rule 2). */
export const BEHIND = 6;
/** And how many already flipped past. */
export const AHEAD = 3;

/**
 * Where a record sits relative to the one in front (d = 0). Further back
 * leans the top away; flipped past tips toward you and drops out of sight.
 */
function place(d: number, jitter: number): CSSProperties {
  if (d < 0) {
    return {
      transform: `translate3d(${jitter * 6}px, 4%, 60px) rotateX(-72deg) rotateZ(${jitter * 1.2}deg)`,
      opacity: 0,
    };
  }
  if (d === 0) return { transform: "translate3d(0, 0, 0) rotateX(5deg)" };
  return {
    transform: `translate3d(${jitter * 5}px, 0, ${-14 - d * 20}px) rotateX(${13 + Math.min(d, 8) * 0.6}deg) rotateZ(${jitter * 0.9}deg)`,
    opacity: d > BEHIND - 1 ? 0 : 1,
  };
}

/** The size a sleeve at `d` draws: the front two the 640, the rest the 320. */
const sizeAt = (album: AlbumCard, d: number) =>
  d <= 1 ? album.covers?.medium : album.covers?.small;

/**
 * A sleeve's front: its cover as it is, with wear over it only if it isn't
 * Spotify's (RFC-002, resolved open question 1). An album with no cover is
 * plain paper with its title.
 */
export function SleeveFront({
  album,
  src,
  children,
}: {
  album: AlbumCard;
  src: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="sleeve-face" style={album.worn ? wearStyle(album.id) : undefined}>
      {src ? (
        <img src={src} alt="" draggable={false} decoding="async" />
      ) : (
        <span className="sleeve-blank">{album.title}</span>
      )}
      {children}
      {album.worn && <div className="wear" />}
    </div>
  );
}

type Props = {
  items: CrateItem[];
  /** The index of the record or divider in front. */
  focus: number;
  /** The record pulled out, whose place in the crate stays empty. */
  hiddenKey: string | null;
  /** Dimmed and out of reach while a sleeve is out or search is open. */
  dim: boolean;
  /** A click: the record in front comes out, any other comes to the front. */
  onPick: (index: number) => void;
};

function label(item: CrateItem, front: boolean): string {
  if (item.kind === "divider") {
    const records = `${item.count} ${item.count === 1 ? "record" : "records"}`;
    return front ? `${item.label}, ${records}` : `Flip to ${item.label}`;
  }
  const name = `${item.album.title} by ${item.album.artist}`;
  return front ? `Pull out ${name}` : `Flip to ${name}`;
}

const Crate = memo(function Crate({
  items,
  focus,
  hiddenKey,
  dim,
  onPick,
}: Props) {
  const slots = [];
  const last = Math.min(items.length - 1, focus + BEHIND);
  for (let i = Math.max(0, focus - AHEAD); i <= last; i++) {
    const item = items[i];
    const d = i - focus;
    const jitter = (hash(item.key) - 0.5) * 2;
    slots.push(
      <div
        key={item.key}
        role="button"
        aria-label={label(item, d === 0)}
        aria-hidden={d < 0 || d > BEHIND - 1 || undefined}
        className={`crate-slot ${item.kind} ${d < 0 ? "past" : ""}`}
        data-front={d === 0 || undefined}
        onClick={() => onPick(i)}
        style={{
          ...place(d, jitter),
          zIndex: 100 - d,
          visibility: item.key === hiddenKey ? "hidden" : undefined,
          ["--shade" as string]:
            d > 0 ? Math.min(0.08 + d * 0.055, 0.75) : d < 0 ? 0.55 : 0,
        }}
      >
        {item.kind === "album" ? (
          <>
            <SleeveFront album={item.album} src={sizeAt(item.album, d)} />
            <div className="sleeve-rear" />
          </>
        ) : (
          <div
            className="divider-card"
            style={{ ["--tab" as string]: `${6 + item.tab * 35}%` }}
          >
            <div className="divider-tab">{item.label}</div>
            <div className="divider-body">
              <span className="divider-big">{item.label}</span>
              <span className="divider-count">
                {item.count} {item.count === 1 ? "record" : "records"}
              </span>
            </div>
          </div>
        )}
        <div className="crate-shade" />
      </div>,
    );
  }
  return (
    <div
      className={`crate ${dim ? "dim" : ""}`}
      role="region"
      aria-label="Your crate"
    >
      <div className="crate-stack">{slots}</div>
    </div>
  );
});

export default Crate;
