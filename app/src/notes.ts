// The gatefold's type styles, and finding the tracks its liner notes
// mention (Gatefold.tsx).

/**
 * The type styles at the bottom left of the gatefold, from the prototype
 * (PR #9). Album × Archive is Archive's layout printed in the album's
 * colours: Will's choice, so the gatefold opens on it.
 */
export const STYLES = [
  { id: "liner", label: "Liner notes" },
  { id: "magazine", label: "Magazine" },
  { id: "archive", label: "Archive" },
  { id: "album", label: "Album colours" },
  { id: "album-archive", label: "Album × Archive" },
] as const;
export type NotesStyle = (typeof STYLES)[number]["id"];

/**
 * A store's additions to a track's title, which the essay leaves out:
 * "(Remastered)", "[Mono]" (the prototype's `cleanTitle`).
 */
const NOISE =
  /\s*[([][^)\]]*(re-?master|deluxe|edition|version|anniversary|expanded|mono|stereo)[^)\]]*[)\]]/gi;

/**
 * A track's title as the essay would write it, to match `[[Track]]` to the
 * tracklist: without a store's additions ("(Remastered)", "- 2009
 * Remaster"), and in lower case.
 */
export function plainTitle(title: string) {
  return title
    .replace(NOISE, "")
    .replace(/\s+-\s+.*(re-?master|version|mono|stereo).*$/i, "")
    .trim()
    .toLowerCase();
}
