// What Spotify is playing, as the crate follows it (RFC-002, "4. The UI":
// the needle drop, now playing and a stranger's record). Spotify doesn't
// push changes, so the crate asks every couple of seconds, and keeps the
// last answer when a new one says nothing new, so nothing redraws
// (DESIGN.md, rule 8). The clock counts on from the last answer by itself.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getPlayback,
  type AlbumCard,
  type AlbumId,
  type AlbumTrack,
  type NowPlaying,
} from "./api";

/** How often to ask Spotify what's playing. */
export const POLL_MS = 2000;

/**
 * How far Spotify's position can be from where the clock has counted it to
 * and still be no news: a poll's own delay, give or take.
 */
const DRIFT_MS = 1500;

/** Spotify's last answer, and when it came, from `Date.now()`. */
export type Heard = { now: NowPlaying | null; at: number };

/** Where the track is at `t`, counted on from the answer. */
export function positionAt(heard: Heard, t: number): number | null {
  const now = heard.now;
  if (!now || now.progressMs === null) return null;
  const counted = now.progressMs + (now.isPlaying ? Math.max(0, t - heard.at) : 0);
  return now.track ? Math.min(counted, now.track.durationMs) : counted;
}

/**
 * The new answer, or the last one if the new one says nothing new: the same
 * track, state and device, with the position where the clock had counted it
 * to. Keeping the last one means nothing redraws.
 */
export function settle(
  last: Heard | undefined,
  now: NowPlaying | null,
  at: number,
): Heard {
  if (!last) return { now, at };
  if (last.now === null || now === null) {
    return last.now === now ? last : { now, at };
  }
  const without = (n: NowPlaying) => JSON.stringify({ ...n, progressMs: null });
  if (without(last.now) !== without(now)) return { now, at };
  const counted = positionAt(last, at);
  if (counted === null || now.progressMs === null) {
    return counted === now.progressMs ? last : { now, at };
  }
  return Math.abs(counted - now.progressMs) <= DRIFT_MS ? last : { now, at };
}

/**
 * Asks Spotify what's playing every couple of seconds while the window is
 * showing. It waits for each answer before asking again, so a slow reply,
 * or a wait for a rate limit, never stacks requests up. `onNews` hears each
 * answer that says something new.
 */
export function usePlayback(onNews: (heard: Heard) => void) {
  /** Undefined until Spotify first answers. */
  const [heard, setHeard] = useState<Heard | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const last = useRef<Heard | undefined>(undefined);
  const news = useRef(onNews);
  useEffect(() => {
    news.current = onNews;
  });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      // A hidden window asks nothing, and catches up when it's shown.
      if (document.visibilityState !== "hidden") {
        try {
          const now = await getPlayback();
          if (stopped) return;
          const next = settle(last.current, now, Date.now());
          setError(null);
          if (next !== last.current) {
            last.current = next;
            setHeard(next);
            news.current(next);
          }
        } catch (e) {
          if (stopped) return;
          setError(errorMessage(e));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [asked]);

  /** Asks again straight away, after Deadwax has changed something. */
  const askNow = useCallback(() => setAsked((n) => n + 1), []);

  /**
   * Pause or resume, shown straight away: Spotify can take a moment to
   * report it. The clock stops or starts where it is.
   */
  const toggled = useCallback(() => {
    const was = last.current;
    if (!was?.now) return;
    const at = Date.now();
    last.current = {
      at,
      now: {
        ...was.now,
        isPlaying: !was.now.isPlaying,
        progressMs: positionAt(was, at),
      },
    };
    setHeard(last.current);
  }, []);

  /** Spotify's latest answer, for a callback that needs it now. */
  const latest = useCallback(() => last.current, []);

  return { heard, error, askNow, toggled, latest };
}

/** A track you've pressed, while Spotify gets going: the needle is dropping. */
export type Pending = {
  album: AlbumCard;
  track: AlbumTrack;
  device: string;
  /** When Spotify said yes, or null until it has. */
  resolvedAt: number | null;
};

/**
 * What's playing, as the sleeve, its now playing line and the glow draw it:
 * the track you've just pressed while Spotify gets going, or Spotify's last
 * answer.
 */
export type Live = {
  /**
   * A record in the crate, a stranger's record (one outside the
   * collection), or an advert, which Spotify doesn't describe.
   */
  kind: "record" | "stranger" | "advert";
  /** The album's Deadwax ID, for a record in the crate. */
  albumId: AlbumId | null;
  /** Where Open in Spotify and Add to the crate go. */
  spotifyAlbumId: string | null;
  album: string | null;
  artist: string;
  title: string;
  coverUrl: string | null;
  /** The track's Spotify ID, which the sleeve highlights it by. */
  trackId: string | null;
  disc: number;
  number: number;
  durationMs: number;
  /** Where it was at `at`, from `Date.now()`, for the clock to count on. */
  positionMs: number;
  at: number;
  paused: boolean;
  /** Play was pressed and Spotify hasn't confirmed it yet. */
  starting: boolean;
  device: string | null;
};

/** What's playing, from the track pressed or Spotify's answer. Null for nothing. */
export function liveFrom(
  pending: Pending | null,
  heard: Heard | undefined,
  albums: AlbumCard[] | null,
): Live | null {
  if (pending) {
    const { album, track } = pending;
    return {
      kind: "record",
      albumId: album.id,
      spotifyAlbumId: album.spotifyId,
      album: album.title,
      artist: album.artist,
      title: track.title,
      coverUrl: album.covers?.large ?? null,
      trackId: track.spotifyId,
      disc: track.disc,
      number: track.number,
      durationMs: track.durationMs,
      positionMs: 0,
      at: 0,
      paused: false,
      starting: true,
      device: pending.device,
    };
  }
  const now = heard?.now;
  if (!heard || !now) return null;
  const common = {
    positionMs: now.progressMs ?? 0,
    at: heard.at,
    paused: !now.isPlaying,
    starting: false,
    device: now.device,
  };
  const track = now.track;
  if (!track) {
    return {
      ...common,
      kind: "advert",
      albumId: null,
      spotifyAlbumId: null,
      album: null,
      artist: "",
      title: "An advert",
      coverUrl: null,
      trackId: null,
      disc: 0,
      number: 0,
      durationMs: 0,
    };
  }
  // Rust names an album in the collection by its Deadwax ID. One added
  // since that answer is found by its Spotify ID.
  const ours =
    albums?.find(
      (a) =>
        (track.albumId !== null && a.id === track.albumId) ||
        (track.spotifyAlbumId !== null && a.spotifyId === track.spotifyAlbumId),
    ) ?? null;
  return {
    ...common,
    kind: ours ? "record" : "stranger",
    albumId: ours?.id ?? null,
    spotifyAlbumId: track.spotifyAlbumId,
    album: track.album,
    artist: track.artist,
    title: track.title,
    coverUrl: track.coverUrl,
    trackId: track.spotifyId,
    disc: track.disc,
    number: track.number,
    durationMs: track.durationMs,
  };
}

/**
 * Whether Spotify's answer is playing the track pressed: by its ID, or by
 * its place on the same album, since Spotify can play a track relinked to
 * another ID.
 */
export function confirms(pending: Pending, now: NowPlaying | null): boolean {
  const track = now?.track;
  if (!now?.isPlaying || !track) return false;
  if (track.spotifyId !== null && track.spotifyId === pending.track.spotifyId) {
    return true;
  }
  const sameAlbum =
    track.albumId === pending.album.id ||
    track.spotifyAlbumId === pending.album.spotifyId;
  return (
    sameAlbum &&
    track.disc === pending.track.disc &&
    track.number === pending.track.number
  );
}

/**
 * The Spotify ID of the track on the sleeve's back that's playing: matched
 * by ID, or by its place on the album if no ID matches. Null if none is.
 */
export function playingTrack(tracks: AlbumTrack[], live: Live | null): string | null {
  if (!live || live.kind !== "record") return null;
  const byId = tracks.find((t) => t.spotifyId && t.spotifyId === live.trackId);
  const found =
    byId ?? tracks.find((t) => t.disc === live.disc && t.number === live.number);
  return found?.spotifyId || null;
}

/** Milliseconds as minutes and seconds, like 4:15. */
export function time(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
