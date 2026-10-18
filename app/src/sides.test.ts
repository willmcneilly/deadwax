import { describe, expect, it } from "vitest";
import type { AlbumTrack } from "./api";
import { duration, sides } from "./sides";

const track = (disc: number, number: number, minutes: number): AlbumTrack => ({
  spotifyId: `t${disc}-${number}`,
  disc,
  number,
  title: `Track ${disc}.${number}`,
  durationMs: minutes * 60_000,
});

const names = (tracks: AlbumTrack[]) =>
  sides(tracks).map((side) => `${side.name}: ${side.tracks.map((t) => t.number).join(" ")}`);

describe("A record's sides", () => {
  it("splits a disc where its running time passes halfway", () => {
    const disc = [track(1, 1, 4), track(1, 2, 4), track(1, 3, 2), track(1, 4, 6), track(1, 5, 4)];
    expect(names(disc)).toEqual(["A: 1 2 3", "B: 4 5"]);
  });

  it("gives each disc two sides, lettered on from the last", () => {
    const tracks = [track(1, 1, 5), track(1, 2, 5), track(2, 1, 5), track(2, 2, 5)];
    expect(names(tracks)).toEqual(["A: 1", "B: 2", "C: 1", "D: 2"]);
  });

  it("makes one side of a disc with a single track", () => {
    expect(names([track(1, 1, 20)])).toEqual(["A: 1"]);
  });

  it("times each track in minutes and seconds", () => {
    expect(duration(237_293)).toBe("3:57");
    expect(duration(60_000)).toBe("1:00");
  });
});
