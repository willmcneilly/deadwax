import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying } from "./api";
import { backEnd } from "./mockBackEnd";
import PlaybackBar from "./PlaybackBar";

const IN_RAINBOWS = "5vkqYmiPBYLaalcmjujWxK";
const HIGH_RES = "https://is1-ssl.mzstatic.com/image/thumb/x/10000x10000bb.jpg";

const playing = (
  title: string,
  more: Partial<NowPlaying> = {},
): NowPlaying => ({
  isPlaying: true,
  device: "Living Room",
  progressMs: 60_000,
  track: {
    title,
    artist: "Radiohead",
    album: "In Rainbows",
    albumId: IN_RAINBOWS,
    durationMs: 240_000,
    coverUrl: HIGH_RES,
  },
  ...more,
});

const nowPlaying = () => screen.getByRole("dialog", { name: "Now playing" });
const progress = () => screen.getByRole("progressbar", { name: "Progress" });
const elapsed = () => Number(progress().getAttribute("aria-valuenow"));

/** Lets the timers and the mocked back end's replies run. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** The back end every test here needs, with what Spotify says is playing. */
function spotify(now: () => NowPlaying | null, more = {}) {
  return backEnd({
    get_playback: now,
    set_now_playing_fullscreen: () => null,
    open_album_in_spotify: () => null,
    ...more,
  });
}

/** The playback bar, with now playing opened from it. */
async function open() {
  render(<PlaybackBar started={0} onFailed={() => {}} />);
  await wait(0);
  fireEvent.click(screen.getByRole("button", { name: "Now playing" }));
  await wait(0);
}

describe("Now playing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("can't be opened while nothing is playing", async () => {
    spotify(() => null);
    render(<PlaybackBar started={0} onFailed={() => {}} />);
    await wait(0);

    expect(screen.getByRole("button", { name: "Now playing" })).toBeDisabled();
  });

  it("opens from the playback bar, simply fullscreen, and Escape leaves it", async () => {
    const calls = spotify(() => playing("Nude"));
    await open();

    expect(nowPlaying()).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Playback" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await wait(0);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Playback" })).toBeVisible();
    expect(
      calls
        .filter((c) => c.cmd === "set_now_playing_fullscreen")
        .map((c) => c.args),
    ).toEqual([{ fullscreen: true }, { fullscreen: false }]);
  });

  it("also has a button to leave it", async () => {
    const calls = spotify(() => playing("Nude"));
    await open();

    fireEvent.click(screen.getByRole("button", { name: "Leave now playing" }));
    await wait(0);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.at(-1)).toEqual({
      cmd: "set_now_playing_fullscreen",
      args: { fullscreen: false },
    });
  });

  it("shows the high-res cover as it is, the track, the album and an Open in Spotify link", async () => {
    const calls = spotify(() => playing("Nude"));
    await open();

    const cover = screen.getByRole("img", { name: "Cover of In Rainbows" });
    expect(cover).toHaveAttribute("src", HIGH_RES);
    expect(nowPlaying()).toHaveTextContent("Nude");
    expect(nowPlaying()).toHaveTextContent("Radiohead · In Rainbows");
    expect(nowPlaying()).toHaveTextContent("On Living Room");
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next track" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Previous track" }),
    ).toBeEnabled();
    expect(elapsed()).toBe(60_000);
    expect(progress()).toHaveAttribute("aria-valuemax", "240000");
    expect(nowPlaying()).toHaveTextContent("1:00 / 4:00");

    const link = screen.getByRole("link", { name: "Open in Spotify" });
    expect(link).toHaveAttribute(
      "href",
      `https://open.spotify.com/album/${IN_RAINBOWS}`,
    );
    fireEvent.click(link);
    await wait(0);
    expect(calls.at(-1)).toEqual({
      cmd: "open_album_in_spotify",
      args: { id: IN_RAINBOWS },
    });
  });

  it("follows a track change made on another device within a couple of seconds", async () => {
    let now = playing("Nude");
    spotify(() => now);
    await open();
    expect(nowPlaying()).toHaveTextContent("Nude");

    // Skipped from your phone, to a track on another album.
    now = playing("Idioteque", {
      progressMs: 1_000,
      track: {
        title: "Idioteque",
        artist: "Radiohead",
        album: "Kid A",
        albumId: "6GjwtEZcfenmOf6l18N7T7",
        durationMs: 309_000,
        coverUrl: "https://i.scdn.co/image/kid-a-640.jpg",
      },
    });
    await wait(2000);

    expect(nowPlaying()).toHaveTextContent("Idioteque");
    expect(nowPlaying()).toHaveTextContent("Radiohead · Kid A");
    expect(screen.getByRole("img", { name: "Cover of Kid A" })).toHaveAttribute(
      "src",
      "https://i.scdn.co/image/kid-a-640.jpg",
    );
    expect(elapsed()).toBe(1_000);
  });

  it("moves the progress bar smoothly between polls", async () => {
    let now = playing("Nude");
    spotify(() => now);
    await open();
    expect(elapsed()).toBe(60_000);

    // Between polls it counts on by itself, in small steps.
    await wait(100);
    expect(elapsed()).toBe(60_100);
    await wait(900);
    expect(elapsed()).toBe(61_000);

    // Spotify's next answer is where it starts from again.
    now = playing("Nude", { progressMs: 62_500 });
    await wait(1000);
    expect(elapsed()).toBe(62_500);
    await wait(500);
    expect(elapsed()).toBe(63_000);
  });

  it("stands still while paused, and never runs past the end", async () => {
    let now = playing("Nude", { isPlaying: false });
    spotify(() => now);
    await open();

    await wait(1500);
    expect(elapsed()).toBe(60_000);
    expect(nowPlaying()).toHaveTextContent("On Living Room · Paused");

    now = playing("Nude", { progressMs: 239_000 });
    await wait(2000);
    await wait(1900);
    expect(elapsed()).toBe(240_000);
  });

  it("stays open, saying so, when the music stops", async () => {
    let now: NowPlaying | null = playing("Nude");
    spotify(() => now);
    await open();

    now = null;
    await wait(2000);

    expect(nowPlaying()).toHaveTextContent("Nothing playing");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("passes on a failure to go fullscreen", async () => {
    const failed = vi.fn();
    backEnd({
      get_playback: () => playing("Nude"),
      set_now_playing_fullscreen: () => {
        throw "Couldn't change fullscreen: no window";
      },
    });
    render(<PlaybackBar started={0} onFailed={failed} />);
    await wait(0);
    fireEvent.click(screen.getByRole("button", { name: "Now playing" }));
    await wait(0);

    expect(failed).toHaveBeenCalledWith(
      "Couldn't change fullscreen: no window",
    );
    expect(nowPlaying()).toBeInTheDocument();
  });
});
