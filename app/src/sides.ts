// A record's sides, for the back of its sleeve.

import type { AlbumTrack } from "./api";

export type Side = {
  /** "A", "B", "C" and so on. */
  name: string;
  tracks: AlbumTrack[];
};

/**
 * A record has two sides per disc: each disc is split where its running
 * time passes the halfway mark (the prototype's). A disc of one track is a
 * side of its own.
 */
export function sides(tracks: AlbumTrack[]): Side[] {
  const discs = new Map<number, AlbumTrack[]>();
  for (const track of tracks) {
    discs.set(track.disc, [...(discs.get(track.disc) ?? []), track]);
  }
  const out: Side[] = [];
  const next = () => String.fromCharCode(65 + out.length);
  for (const disc of [...discs.keys()].sort((a, b) => a - b)) {
    const list = discs.get(disc) ?? [];
    const total = list.reduce((sum, t) => sum + t.durationMs, 0);
    let run = 0;
    let cut = list.length;
    for (let i = 0; i < list.length; i++) {
      run += list[i].durationMs;
      if (run >= total / 2) {
        cut = i + 1;
        break;
      }
    }
    out.push({ name: next(), tracks: list.slice(0, cut) });
    if (cut < list.length) out.push({ name: next(), tracks: list.slice(cut) });
  }
  return out;
}

/** 237293 → "3:57". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}:${rest.toString().padStart(2, "0")}`;
}
