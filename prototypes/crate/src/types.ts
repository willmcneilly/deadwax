export interface Track {
  disc: number;
  number: number;
  title: string;
  durationMs: number;
}

export interface Album {
  id: string;
  genre: string;
  title: string;
  artist: string;
  year: number | null;
  label: string | null;
  tracks: Track[];
  key?: string; // set when `?many` repeats an album
  coverUrl?: string; // set for a record from outside the collection
}

export const albumKey = (album: Album) => album.key ?? album.id;

export type CrateItem =
  | { kind: "divider"; id: string; label: string; count: number; tab: number }
  | { kind: "album"; id: string; album: Album };

export const cover = (album: Album, size: "sm" | "lg") => album.coverUrl ?? `/covers/${album.id}-${size}.jpg`;

// Store titles carry reissue noise: "(Remastered 2011)", "[Deluxe Edition]".
const NOISE = /\s*[([][^)\]]*(re-?master|deluxe|edition|version|anniversary|expanded|mono|stereo)[^)\]]*[)\]]/gi;
export const cleanTitle = (title: string) =>
  title
    .replace(/([([])\1+/g, "$1") // some store titles double their brackets: "((Remastered))"
    .replace(/([)\]])\1+/g, "$1")
    .replace(NOISE, "").replace(/\s+-\s+.*(re-?master|version|mono|stereo).*$/i, "").trim();

export function formatTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// A record has two sides per disc: split each disc where its running time
// passes the halfway mark.
export function sides(tracks: Track[]) {
  const discs = new Map<number, { track: Track; index: number }[]>();
  tracks.forEach((track, index) => {
    const list = discs.get(track.disc) ?? [];
    list.push({ track, index });
    discs.set(track.disc, list);
  });
  const out: { name: string; tracks: { track: Track; index: number }[] }[] = [];
  let letter = 65;
  for (const list of discs.values()) {
    const total = list.reduce((sum, t) => sum + t.track.durationMs, 0);
    let run = 0;
    let cut = list.length;
    for (let i = 0; i < list.length; i++) {
      run += list[i].track.durationMs;
      if (run >= total / 2) {
        cut = i + 1;
        break;
      }
    }
    if (list.length === 1) cut = 1;
    out.push({ name: String.fromCharCode(letter++), tracks: list.slice(0, cut) });
    if (cut < list.length) out.push({ name: String.fromCharCode(letter++), tracks: list.slice(cut) });
  }
  return out;
}

export function hash(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000; // 0..1
}

// Liner notes: a researched long-form essay about one album.
export interface Notes {
  albumTitle: string;
  artist: string;
  headline: string;
  standfirst: string;
  sections: {
    heading: string;
    paragraphs: string[];
    pullQuote?: { text: string; attribution: string | null };
  }[];
  quotes: { text: string; who: string; sourceIndex: number }[];
  facts: { figure: string; label: string }[];
  credits: { role: string; names: string[] }[];
  sources: { title: string; publisher: string; url: string; year: number | null }[];
}

export const slug = (album: Album) =>
  cleanTitle(album.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
