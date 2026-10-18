// A small crate for the crate's and the sleeve's UI tests, as the mocked
// back end sends it.

import type { AlbumDetails, Palette } from "./api";
import { card, fromDisk } from "./mockBackEnd";

/** In Rainbows' palette, as Rust sends it. */
export const PALETTE: Palette = {
  key: ["#3a6ea5", "#d9482b", "#f2c14e"],
  ground: "#f4ecdc",
  rear: "#e8dfcc",
  ink: "#1b1712",
  muted: "#5a5046",
  accent: "#a3361d",
  dark: false,
  deep: "#101418",
};

/** From iTunes, on disk, with everything found. */
export const IN_RAINBOWS = card(1, {
  id: "0b1c7e1e-6a0e-4c43-9f1e-2b8f6f1d9a01",
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
  genre: "Alternative",
  label: "XL Recordings",
  palette: PALETTE,
  covers: fromDisk("0b1c7e1e-6a0e-4c43-9f1e-2b8f6f1d9a01"),
  worn: true,
});

export const KIND_OF_BLUE = card(2, {
  title: "Kind of Blue",
  artist: "Miles Davis",
  year: 1959,
  genre: "Jazz",
  label: "Columbia",
  covers: fromDisk("deadwax-2"),
  worn: true,
});

export const A_LOVE_SUPREME = card(3, {
  title: "A Love Supreme",
  artist: "John Coltrane",
  year: 1965,
  genre: "Jazz",
  covers: fromDisk("deadwax-3"),
  worn: true,
});

/** Only Spotify had its cover, so it's on disk but never worn. No genre yet. */
export const PINK_MOON = card(4, {
  title: "Pink Moon",
  artist: "Nick Drake",
  year: 1972,
  covers: fromDisk("deadwax-4"),
  worn: false,
});

/** The crate, sorted by genre: Alternative, Jazz (2), then Unsorted. */
export const COLLECTION = [PINK_MOON, KIND_OF_BLUE, IN_RAINBOWS, A_LOVE_SUPREME];

/** In Rainbows' tracklist, from the cache: one disc, two sides. */
export const IN_RAINBOWS_DETAILS: AlbumDetails = {
  id: IN_RAINBOWS.id,
  spotifyId: "5vkqYmiPBYLaalcmjujWxK",
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
  coverUrl: IN_RAINBOWS.covers?.large ?? null,
  tracks: [
    ["15 Step", 237_293],
    ["Bodysnatchers", 242_013],
    ["Nude", 255_386],
    ["Weird Fishes/Arpeggi", 318_186],
    ["All I Need", 228_640],
    ["Faust Arp", 129_680],
    ["Reckoner", 290_213],
    ["House of Cards", 328_293],
    ["Jigsaw Falling into Place", 249_200],
    ["Videotape", 279_640],
  ].map(([title, durationMs], i) => ({
    spotifyId: `track-${i + 1}`,
    disc: 1,
    number: i + 1,
    title: title as string,
    durationMs: durationMs as number,
  })),
};
