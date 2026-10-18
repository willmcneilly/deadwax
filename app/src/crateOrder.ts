// How the crate is sorted, and where its dividers go (RFC-002, "4. The UI").
// Each order decides what a section is (a genre, a letter, a decade) and the
// order inside it: by artist, ignoring a leading "The", then by year.

import type { AlbumCard } from "./api";

export type Order = "genre" | "artist" | "decade";

export const ORDERS: { order: Order; label: string }[] = [
  { order: "genre", label: "Genre" },
  { order: "artist", label: "Artist A–Z" },
  { order: "decade", label: "Decade" },
];

/** The section for albums with no genre, at the back of the crate. */
export const UNSORTED = "Unsorted";
/** The section for albums with no year, at the back of the crate. */
export const UNDATED = "Undated";

/** A handwritten card in front of each section, with how many it holds. */
export type Divider = {
  kind: "divider";
  key: string;
  label: string;
  count: number;
  /** Where its tab sits along the top: 0, 1 or 2, in turn. */
  tab: number;
};

/**
 * An album in the crate. `key` is its place in the crate, which is its
 * Deadwax ID except in the development build's 400-record crate, where the
 * collection repeats.
 */
export type CrateAlbum = { kind: "album"; key: string; album: AlbumCard };

export type CrateItem = Divider | CrateAlbum;

/** "The Beatles" sorts as "Beatles". */
const sortName = (artist: string) => artist.replace(/^the\s+/i, "");

function section(album: AlbumCard, order: Order): string {
  switch (order) {
    case "genre":
      return album.genre ?? UNSORTED;
    case "artist": {
      const first = sortName(album.artist).charAt(0);
      return /\p{L}/u.test(first) ? first.toLocaleUpperCase() : "#";
    }
    case "decade":
      return album.year === null
        ? UNDATED
        : `${Math.floor(album.year / 10) * 10}s`;
  }
}

/** Sections in order, with Unsorted and Undated at the back. */
function bySection(a: string, b: string): number {
  const last = (label: string) => label === UNSORTED || label === UNDATED;
  return Number(last(a)) - Number(last(b)) || a.localeCompare(b);
}

const byArtist = (a: AlbumCard, b: AlbumCard) =>
  sortName(a.artist).localeCompare(sortName(b.artist)) ||
  (a.year ?? 0) - (b.year ?? 0) ||
  a.title.localeCompare(b.title);

/**
 * The crate in this order: each section's divider, then its albums. `keys`
 * gives each album its place, when it isn't the album's ID.
 */
export function crateItems(
  albums: AlbumCard[],
  order: Order,
  keys?: string[],
): CrateItem[] {
  const placed = albums.map((album, i) => ({
    album,
    key: keys?.[i] ?? album.id,
    label: section(album, order),
  }));
  placed.sort(
    (a, b) =>
      (order === "decade"
        ? (a.album.year ?? Infinity) - (b.album.year ?? Infinity)
        : 0) ||
      bySection(a.label, b.label) ||
      byArtist(a.album, b.album),
  );
  const items: CrateItem[] = [];
  let divider = null as Divider | null;
  for (const { album, key, label } of placed) {
    if (divider?.label !== label) {
      divider = {
        kind: "divider",
        key: `divider-${order}-${label}`,
        label,
        count: 0,
        tab: items.filter((i) => i.kind === "divider").length % 3,
      };
      items.push(divider);
    }
    divider.count++;
    items.push({ kind: "album", key, album });
  }
  return items;
}

/** Where `key` is in the crate, or -1. */
export const indexOf = (items: CrateItem[], key: string) =>
  items.findIndex((item) => item.key === key);
