import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NowPlaying } from "./api";
import { backEnd } from "./mockBackEnd";
import PlaybackBar from "./PlaybackBar";

const playing = (
  title: string,
  more: Partial<NowPlaying> = {},
): NowPlaying => ({
  isPlaying: true,
  device: "Living Room",
  progressMs: 61_480,
  track: {
    title,
    artist: "Radiohead",
    album: "In Rainbows",
    albumId: "5vkqYmiPBYLaalcmjujWxK",
    durationMs: 255_386,
    coverUrl: null,
  },
  ...more,
});

const bar = () => screen.getByRole("region", { name: "Playback" });
const button = (name: string) => screen.getByRole("button", { name });

/** Lets the bar's timers and the mocked back end's replies run. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("The playback bar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the current track, where it's playing and the controls", async () => {
    backEnd({ get_playback: () => playing("Nude") });
    render(<PlaybackBar started={0} onFailed={() => {}} />);
    await wait(0);

    expect(bar()).toHaveTextContent("Nude");
    expect(bar()).toHaveTextContent("Radiohead · In Rainbows · on Living Room");
    expect(button("Previous track")).toBeEnabled();
    expect(button("Pause")).toBeEnabled();
    expect(button("Next track")).toBeEnabled();
  });

  it("asks Spotify every couple of seconds, so it follows a change made elsewhere", async () => {
    let now = playing("Nude");
    const calls = backEnd({ get_playback: () => now });
    render(<PlaybackBar started={0} onFailed={() => {}} />);
    await wait(0);
    expect(bar()).toHaveTextContent("Nude");

    // Skipped from your phone.
    now = playing("Weird Fishes/Arpeggi");
    await wait(1900);
    expect(bar()).toHaveTextContent("Nude");
    await wait(100);
    expect(bar()).toHaveTextContent("Weird Fishes/Arpeggi");

    // And paused from it.
    now = playing("Weird Fishes/Arpeggi", { isPlaying: false });
    await wait(2000);
    expect(bar()).toHaveTextContent("· paused");
    expect(button("Resume")).toBeEnabled();
    expect(calls.filter((c) => c.cmd === "get_playback")).toHaveLength(3);
  });

  it("waits for each answer before asking again", async () => {
    let answer: (now: NowPlaying) => void = () => {};
    const calls = backEnd({
      get_playback: () => new Promise((resolve) => (answer = resolve)),
    });
    render(<PlaybackBar started={0} onFailed={() => {}} />);

    await wait(10_000);
    expect(calls).toHaveLength(1);

    answer(playing("Nude"));
    await wait(2000);
    expect(calls).toHaveLength(2);
  });

  it("asks nothing while the window is hidden", async () => {
    const calls = backEnd({ get_playback: () => playing("Nude") });
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    render(<PlaybackBar started={0} onFailed={() => {}} />);

    await wait(10_000);
    expect(calls).toHaveLength(0);

    visibility.mockReturnValue("visible");
    await wait(2000);
    expect(calls).toHaveLength(1);
    expect(bar()).toHaveTextContent("Nude");
  });

  it("asks straight away when Deadwax starts something", async () => {
    const calls = backEnd({ get_playback: () => playing("15 Step") });
    const { rerender } = render(
      <PlaybackBar started={0} onFailed={() => {}} />,
    );
    await wait(0);

    rerender(<PlaybackBar started={1} onFailed={() => {}} />);
    await wait(0);

    expect(calls).toHaveLength(2);
  });

  it("says when nothing is playing, with the controls off", async () => {
    backEnd({ get_playback: () => null });
    render(<PlaybackBar started={0} onFailed={() => {}} />);
    await wait(0);

    expect(bar()).toHaveTextContent("Nothing playing");
    expect(button("Resume")).toBeDisabled();
    expect(button("Next track")).toBeDisabled();
  });

  it("sends play/pause, next and previous to Spotify", async () => {
    const calls = backEnd({
      get_playback: () => playing("Nude"),
      pause_playback: () => null,
      resume_playback: () => null,
      next_track: () => null,
      previous_track: () => null,
    });
    render(<PlaybackBar started={0} onFailed={() => {}} />);
    await wait(0);

    fireEvent.click(button("Pause"));
    await wait(0);
    // Shown as paused straight away: Spotify can be slow to say so.
    expect(button("Resume")).toBeEnabled();
    fireEvent.click(button("Resume"));
    await wait(0);
    fireEvent.click(button("Next track"));
    await wait(0);
    fireEvent.click(button("Previous track"));
    await wait(0);

    expect(
      calls.map((c) => c.cmd).filter((cmd) => cmd !== "get_playback"),
    ).toEqual([
      "pause_playback",
      "resume_playback",
      "next_track",
      "previous_track",
    ]);
  });

  it("passes on a failed control", async () => {
    const failed = vi.fn();
    backEnd({
      get_playback: () => playing("Nude"),
      next_track: () => {
        throw "Spotify replied 403 Forbidden to skipping to the next track: Restriction violated";
      },
    });
    render(<PlaybackBar started={0} onFailed={failed} />);
    await wait(0);

    fireEvent.click(button("Next track"));
    await wait(0);

    expect(failed).toHaveBeenCalledWith(
      "Spotify replied 403 Forbidden to skipping to the next track: Restriction violated",
    );
    expect(button("Next track")).toBeEnabled();
  });

  it("shows a failure to ask what's playing, and keeps asking", async () => {
    let fail = true;
    backEnd({
      get_playback: () => {
        if (fail) throw "couldn't reach Spotify";
        return playing("Nude");
      },
    });
    render(<PlaybackBar started={0} onFailed={() => {}} />);
    await wait(0);

    expect(bar()).toHaveTextContent(
      "Couldn't check what's playing: couldn't reach Spotify",
    );

    fail = false;
    await wait(2000);
    expect(bar()).toHaveTextContent("Nude");
    expect(bar()).not.toHaveTextContent("Couldn't check");
  });
});
