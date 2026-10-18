// The mocked Tauri back end UI tests run against (CLAUDE.md, "Code
// conventions"): never a real one.

import type { InvokeArgs } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { AlbumCard } from "./api";

export type Call = { cmd: string; args?: InvokeArgs };

/** A mocked back end: `replies` answers each command, and every call is logged. */
export function backEnd(
  replies: Record<string, (args?: InvokeArgs) => unknown>,
) {
  const calls: Call[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const reply = replies[cmd];
      if (!reply) throw new Error(`unexpected command ${cmd}`);
      return reply(args);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

/**
 * Nothing playing, and no devices. The playback bar is always on screen and
 * the album page lists devices, so most tests need these.
 */
export const NOTHING_PLAYING = {
  get_playback: () => null,
  get_devices: () => ({ devices: [], remembered: null }),
};

/**
 * An empty collection, with nothing playing. Development builds also ask
 * whether the dev list has albums to restore into it: here it has none.
 */
export const EMPTY_COLLECTION = {
  get_collection: () => [],
  dev_list_missing: () => 0,
  ...NOTHING_PLAYING,
};

/**
 * An album in the crate, named by its Deadwax ID, as Rust sends it before
 * the album job queue has run: Spotify's cover in every size, no wear, and
 * no genre, label or palette yet.
 */
export function card(n: number, extra: Partial<AlbumCard> = {}): AlbumCard {
  const spotify = `https://i.scdn.co/image/cover${n}`;
  return {
    id: `deadwax-${n}`,
    title: `Album ${n}`,
    artist: `Artist ${n}`,
    year: 2000 + n,
    genre: null,
    label: null,
    palette: null,
    covers: { small: spotify, medium: spotify, large: spotify },
    worn: false,
    ...extra,
  };
}

/** The sizes from disk (`cover://`) of an album whose cover is there. */
export const fromDisk = (id: string) => ({
  small: `cover://localhost/${id}/320`,
  medium: `cover://localhost/${id}/640`,
  large: `cover://localhost/${id}/1600`,
});
