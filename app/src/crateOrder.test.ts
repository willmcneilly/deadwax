import { describe, expect, it } from "vitest";
import type { AlbumCard } from "./api";
import { crateItems, type CrateItem } from "./crateOrder";
import { card } from "./mockBackEnd";

const ALBUMS: AlbumCard[] = [
  card(1, { title: "In Rainbows", artist: "Radiohead", year: 2007, genre: "Alternative" }),
  card(2, { title: "Kind of Blue", artist: "Miles Davis", year: 1959, genre: "Jazz" }),
  card(3, { title: "A Love Supreme", artist: "John Coltrane", year: 1965, genre: "Jazz" }),
  card(4, { title: "Pink Moon", artist: "Nick Drake", year: 1972, genre: null }),
  card(5, {
    title: "The Velvet Underground & Nico",
    artist: "The Velvet Underground",
    year: 1967,
    genre: "Rock",
  }),
  card(6, { title: "Untitled", artist: "!!!", year: null, genre: "Dance" }),
];

/** Each item as a line: a divider's label and count, or an album's title. */
const lines = (items: CrateItem[]) =>
  items.map((item) =>
    item.kind === "divider"
      ? `${item.label} (${item.count})`
      : `  ${item.album.title}`,
  );

describe("The crate's order", () => {
  it("sorts by genre, then artist, with Unsorted for albums with no genre at the back", () => {
    expect(lines(crateItems(ALBUMS, "genre"))).toEqual([
      "Alternative (1)",
      "  In Rainbows",
      "Dance (1)",
      "  Untitled",
      "Jazz (2)",
      "  A Love Supreme",
      "  Kind of Blue",
      "Rock (1)",
      "  The Velvet Underground & Nico",
      "Unsorted (1)",
      "  Pink Moon",
    ]);
  });

  it("sorts by artist under each first letter, ignoring a leading The, with symbols under #", () => {
    expect(lines(crateItems(ALBUMS, "artist"))).toEqual([
      "# (1)",
      "  Untitled",
      "J (1)",
      "  A Love Supreme",
      "M (1)",
      "  Kind of Blue",
      "N (1)",
      "  Pink Moon",
      "R (1)",
      "  In Rainbows",
      "V (1)",
      "  The Velvet Underground & Nico",
    ]);
  });

  it("sorts by decade, oldest first, with Undated at the back", () => {
    expect(lines(crateItems(ALBUMS, "decade"))).toEqual([
      "1950s (1)",
      "  Kind of Blue",
      "1960s (2)",
      "  A Love Supreme",
      "  The Velvet Underground & Nico",
      "1970s (1)",
      "  Pink Moon",
      "2000s (1)",
      "  In Rainbows",
      "Undated (1)",
      "  Untitled",
    ]);
  });

  it("moves each divider's tab along, so neighbouring tabs don't hide each other", () => {
    const tabs = crateItems(ALBUMS, "genre").flatMap((item) =>
      item.kind === "divider" ? [item.tab] : [],
    );
    expect(tabs).toEqual([0, 1, 2, 0, 1]);
  });

  it("gives each album its own key, or the one it's given", () => {
    const keys = crateItems(ALBUMS.slice(0, 2), "genre", ["a~0", "b~0"])
      .filter((item) => item.kind === "album")
      .map((item) => item.key);
    expect(keys).toEqual(["a~0", "b~0"]);
    expect(
      crateItems(ALBUMS.slice(0, 1), "genre").map((item) => item.key),
    ).toEqual(["divider-genre-Alternative", "deadwax-1"]);
  });
});
