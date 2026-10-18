import { describe, expect, it } from "vitest";
import type { NowPlaying } from "./api";
import { IN_RAINBOWS, IN_RAINBOWS_DETAILS } from "./crateFixtures";
import { confirms, liveFrom, playingTrack, settle, type Pending } from "./playing";

const NUDE = IN_RAINBOWS_DETAILS.tracks[2];

function nude(extra: Partial<NowPlaying> = {}): NowPlaying {
  return {
    isPlaying: true,
    device: "Living Room",
    progressMs: 10_000,
    track: {
      spotifyId: NUDE.spotifyId,
      disc: 1,
      number: 3,
      title: "Nude",
      artist: "Radiohead",
      album: "In Rainbows",
      albumId: IN_RAINBOWS.id,
      spotifyAlbumId: IN_RAINBOWS.spotifyId,
      durationMs: NUDE.durationMs,
      coverUrl: null,
    },
    ...extra,
  };
}

describe("settle", () => {
  it("keeps the last answer when the new one is where the clock has counted to", () => {
    const last = settle(undefined, nude(), 1_000);
    // Two seconds on, Spotify says 12.3 s: within a poll's delay of 12 s.
    expect(settle(last, nude({ progressMs: 12_300 }), 3_000)).toBe(last);
    // Paused, and still paused where it was.
    const paused = settle(undefined, nude({ isPlaying: false }), 1_000);
    expect(settle(paused, nude({ isPlaying: false }), 3_000)).toBe(paused);
    // Nothing playing, still nothing.
    const nothing = settle(undefined, null, 1_000);
    expect(settle(nothing, null, 3_000)).toBe(nothing);
  });

  it("takes the new answer when the track, state, device or position changed", () => {
    const last = settle(undefined, nude(), 1_000);
    expect(settle(last, nude({ isPlaying: false }), 3_000)).not.toBe(last);
    expect(settle(last, nude({ device: "Kitchen" }), 3_000)).not.toBe(last);
    // Sought back to the start.
    expect(settle(last, nude({ progressMs: 0 }), 3_000)).not.toBe(last);
    expect(settle(last, null, 3_000)).toEqual({ now: null, at: 3_000 });
  });
});

describe("liveFrom", () => {
  const pending: Pending = {
    album: IN_RAINBOWS,
    track: NUDE,
    device: "Living Room",
    resolvedAt: null,
  };

  it("is the track pressed, starting at 0:00, while the needle drops", () => {
    const live = liveFrom(pending, { now: null, at: 1 }, [IN_RAINBOWS]);
    expect(live).toMatchObject({
      kind: "record",
      albumId: IN_RAINBOWS.id,
      title: "Nude",
      trackId: NUDE.spotifyId,
      positionMs: 0,
      starting: true,
    });
  });

  it("is a record in the crate, a stranger's record, or an advert", () => {
    expect(liveFrom(null, { now: nude(), at: 1 }, [IN_RAINBOWS])?.kind).toBe("record");
    expect(liveFrom(null, { now: nude(), at: 1 }, [])?.kind).toBe("stranger");
    expect(liveFrom(null, { now: nude({ track: null }), at: 1 }, [])).toMatchObject({
      kind: "advert",
      title: "An advert",
    });
    expect(liveFrom(null, { now: null, at: 1 }, [IN_RAINBOWS])).toBeNull();
  });

  it("finds an album added since Spotify's answer by its Spotify ID", () => {
    const answer = nude();
    answer.track = { ...answer.track!, albumId: null };
    expect(liveFrom(null, { now: answer, at: 1 }, [IN_RAINBOWS])).toMatchObject({
      kind: "record",
      albumId: IN_RAINBOWS.id,
    });
  });
});

describe("confirms", () => {
  const pending: Pending = { album: IN_RAINBOWS, track: NUDE, device: "Living Room", resolvedAt: 1 };

  it("when Spotify plays the track pressed, by its ID or its place on the album", () => {
    expect(confirms(pending, nude())).toBe(true);
    const relinked = nude();
    relinked.track = { ...relinked.track!, spotifyId: "relinked" };
    expect(confirms(pending, relinked)).toBe(true);
  });

  it("not while it's still the track before, paused, or nothing", () => {
    const before = nude();
    before.track = { ...before.track!, spotifyId: "track-1", number: 1 };
    expect(confirms(pending, before)).toBe(false);
    expect(confirms(pending, nude({ isPlaying: false }))).toBe(false);
    expect(confirms(pending, null)).toBe(false);
  });
});

describe("playingTrack", () => {
  const live = liveFrom(null, { now: nude(), at: 1 }, [IN_RAINBOWS]);

  it("is the track on the back with the playing track's Spotify ID", () => {
    expect(playingTrack(IN_RAINBOWS_DETAILS.tracks, live)).toBe(NUDE.spotifyId);
  });

  it("falls back to its disc and number when Spotify relinked it to another ID", () => {
    expect(
      playingTrack(IN_RAINBOWS_DETAILS.tracks, live && { ...live, trackId: "relinked" }),
    ).toBe(NUDE.spotifyId);
  });

  it("is none for a stranger's record or an advert", () => {
    expect(playingTrack(IN_RAINBOWS_DETAILS.tracks, live && { ...live, kind: "stranger" })).toBeNull();
    expect(playingTrack(IN_RAINBOWS_DETAILS.tracks, null)).toBeNull();
  });
});
