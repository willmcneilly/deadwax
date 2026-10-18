import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlbumCard, AlbumTrack, NowPlaying, PlayOutcome } from "./api";
import { COLLECTION, IN_RAINBOWS, IN_RAINBOWS_DETAILS, PINK_MOON } from "./crateFixtures";
import Library from "./Library";
import { backEnd, card } from "./mockBackEnd";
import { POLL_MS } from "./playing";

const LIVING_ROOM = { name: "Living Room", kind: "Speaker", isActive: true, canPlay: true };
const track = (n: number) => IN_RAINBOWS_DETAILS.tracks[n - 1];
const NUDE = track(3);
const RECKONER = track(7);

const PINK_MOON_DETAILS = {
  id: PINK_MOON.id,
  spotifyId: PINK_MOON.spotifyId,
  title: "Pink Moon",
  artist: "Nick Drake",
  year: 1972,
  coverUrl: null,
  tracks: [{ spotifyId: "pm1", disc: 1, number: 1, title: "Pink Moon", durationMs: 125_000 }],
};

/** What the mocked Spotify is playing. It moves on with the (fake) clock. */
type Playing = {
  album: AlbumCard | null;
  track: AlbumTrack | null;
  isPlaying: boolean;
  /** Where it was at `since`. */
  from: number;
  since: number;
} | null;

let playing: Playing = null;

function play(album: AlbumCard | null, t: AlbumTrack | null, isPlaying = true) {
  playing = { album, track: t, isPlaying, from: 0, since: Date.now() };
}

/** Spotify's answer: an album in the crate, a stranger's, or an advert. */
function answer(): NowPlaying | null {
  if (!playing) return null;
  const { album, track: t, isPlaying, from, since } = playing;
  return {
    isPlaying,
    device: "Living Room",
    progressMs: from + (isPlaying ? Date.now() - since : 0),
    track: t && {
      spotifyId: t.spotifyId,
      disc: t.disc,
      number: t.number,
      title: t.title,
      artist: album?.artist ?? "Someone",
      album: album?.title ?? null,
      albumId: album && COLLECTION.some((a) => a.id === album.id) ? album.id : null,
      spotifyAlbumId: album?.spotifyId ?? null,
      durationMs: t.durationMs,
      coverUrl: album?.covers?.large ?? null,
    },
  };
}

function playingBackEnd(replies: Record<string, (args?: unknown) => unknown> = {}) {
  return backEnd({
    get_collection: () => COLLECTION,
    dev_list_missing: () => 0,
    get_album: (args) =>
      (args as { id: string }).id === PINK_MOON.id ? PINK_MOON_DETAILS : IN_RAINBOWS_DETAILS,
    refresh_album: () => null,
    get_playback: answer,
    get_session: () => ({ state: "signedIn", name: "Will" }),
    get_devices: () => ({ devices: [LIVING_ROOM], remembered: "Living Room" }),
    choose_device: () => null,
    play_album: (): PlayOutcome => ({ state: "playing", devices: [LIVING_ROOM] }),
    pause_playback: () => {
      if (playing) playing = { ...playing, isPlaying: false, from: answer()?.progressMs ?? 0, since: Date.now() };
      return null;
    },
    resume_playback: () => null,
    next_track: () => null,
    previous_track: () => null,
    open_album_in_spotify: () => null,
    ...replies,
  });
}

/** One poll's wait, for a change made elsewhere to be heard. */
const poll = () => act(() => vi.advanceTimersByTimeAsync(POLL_MS));

const nowLine = () => screen.getByRole("region", { name: "Now playing" });
const side = () => nowLine().querySelector(".now-side")?.textContent;
const clock = () => within(nowLine()).getByRole("timer", { name: "Clock" });
const frontSide = () => document.querySelector(".sleeve-side.front") as HTMLElement;
const glow = () => document.querySelector(".glow") as HTMLElement;
const playingOnBack = () =>
  screen
    .getByRole("group", { name: "The back of In Rainbows", hidden: true })
    .querySelector("[aria-current]")
    ?.getAttribute("aria-label");

/** Pulls out In Rainbows and turns it over to its tracklist. */
async function turnOverInRainbows() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));
  await screen.findByRole("button", { name: "Play 15 Step" });
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Device" })).toHaveValue("Living Room"),
  );
}

/** Drops the needle on Nude, and Spotify confirms it. */
async function playNude(calls = playingBackEnd()) {
  render(<Library name="Will" onSignedOut={() => {}} />);
  await turnOverInRainbows();
  fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));
  await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("play_album"));
  play(IN_RAINBOWS, NUDE);
  await poll();
  await waitFor(() => expect(side()).toBe("Side A · 3"));
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  playing = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Dropping the needle", () => {
  it("shows starting with the clock at 0:00 until the mocked playback confirms", async () => {
    const calls = playingBackEnd();
    render(<Library name="Will" onSignedOut={() => {}} />);
    await turnOverInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "Play Reckoner" }));

    // The record turns to its front and floats, and the glow warms.
    expect(frontSide()).not.toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".sleeve-out")).toHaveClass("floating", "starting");
    expect(glow()).toHaveClass("warming");
    expect(side()).toBe("Side B · 2 · starting");
    expect(within(nowLine()).getByRole("heading", { name: "Reckoner" })).toBeInTheDocument();
    expect(clock()).toHaveTextContent("0:00");
    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "play_album",
        args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: RECKONER.spotifyId },
      }),
    );

    // Spotify hasn't started yet: it says nothing is playing, then it's
    // still playing the track from before.
    await poll();
    expect(side()).toBe("Side B · 2 · starting");
    expect(clock()).toHaveTextContent("0:00");
    play(IN_RAINBOWS, track(1));
    await poll();
    expect(side()).toBe("Side B · 2 · starting");
    expect(glow()).toHaveClass("warming");

    play(IN_RAINBOWS, RECKONER);
    await poll();

    await waitFor(() => expect(side()).toBe("Side B · 2"));
    expect(glow()).toHaveClass("on");
    // Spotify was 2 seconds in when it answered, and the clock runs on.
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(clock()).toHaveTextContent("0:05");
  });

  it("highlights the playing track on the sleeve's back by its Spotify ID", async () => {
    await playNude();

    // Spotify says Nude by its ID, at a place on the album that's another
    // track's: the ID wins.
    play(IN_RAINBOWS, { ...NUDE, number: 9 });
    await poll();

    await waitFor(() => expect(playingOnBack()).toBe("Play Nude"));
    expect(side()).toBe("Side A · 3");
  });

  it("highlights it by its disc and number when Spotify relinked it to another ID", async () => {
    await playNude();

    play(IN_RAINBOWS, { ...track(4), spotifyId: "relinked" });
    await poll();

    await waitFor(() => expect(playingOnBack()).toBe("Play Weird Fishes/Arpeggi"));
    expect(side()).toBe("Side A · 4");
  });

  it("is confirmed by the track's Spotify ID", async () => {
    playingBackEnd();
    render(<Library name="Will" onSignedOut={() => {}} />);
    await turnOverInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Play Reckoner" }));
    await waitFor(() => expect(glow()).toHaveClass("warming"));

    // Reckoner by its ID, with Spotify placing it elsewhere on the album.
    play(IN_RAINBOWS, { ...RECKONER, number: 1 });
    await poll();

    await waitFor(() => expect(glow()).toHaveClass("on"));
  });

  it("isn't cut short by an earlier needle drop's wait", async () => {
    playingBackEnd();
    render(<Library name="Will" onSignedOut={() => {}} />);
    await turnOverInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));
    await waitFor(() => expect(side()).toBe("Side A · 3 · starting"));

    // Two seconds later, Nude goes back and Pink Moon comes out instead.
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Turn In Rainbows over" })).toBeNull(),
    );
    for (const key of ["]", "]", "Enter", "Enter"]) fireEvent.keyDown(window, { key });
    fireEvent.click(screen.getByRole("button", { name: "Turn Pink Moon over" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Device" })).toHaveValue("Living Room"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Play Pink Moon" }));
    await waitFor(() => expect(side()).toBe("Side A · 1 · starting"));

    // Past the time Nude's wait would have ended, Pink Moon is still dropping.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(side()).toBe("Side A · 1 · starting");
    expect(screen.getByRole("button", { name: "Turn Pink Moon over" })).toBeInTheDocument();
  });

  it("turns back to the tracklist, saying so, when the device is missing", async () => {
    playingBackEnd({
      play_album: (): PlayOutcome => ({ state: "deviceMissing", devices: [] }),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);
    await turnOverInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));

    await waitFor(() => expect(frontSide()).toHaveAttribute("aria-hidden", "true"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Living Room isn't showing up",
    );
    expect(glow()).toHaveClass("off");
  });

  it("pauses with Space and skips with ← →", async () => {
    const calls = await playNude(
      // Spotify hasn't caught up with the pause yet.
      playingBackEnd({ pause_playback: () => null }),
    );

    fireEvent.keyDown(window, { key: " " });
    await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("pause_playback"));
    expect(side()).toBe("Side A · 3 · paused");
    expect(glow()).toHaveClass("paused");

    // Spotify takes a moment: its next answers still say playing, and the
    // pause stays shown.
    await poll();
    expect(side()).toBe("Side A · 3 · paused");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(calls.map((c) => c.cmd)).toEqual(
        expect.arrayContaining(["next_track", "previous_track"]),
      ),
    );
  });

  it("has Open in Spotify on now playing", async () => {
    const calls = await playNude();

    fireEvent.click(within(nowLine()).getByRole("link", { name: "Open in Spotify" }));

    expect(calls).toContainEqual({
      cmd: "open_album_in_spotify",
      args: { spotifyId: IN_RAINBOWS.spotifyId },
    });
  });
});

describe("Following changes made elsewhere", () => {
  it("moves the highlight when the track is skipped", async () => {
    await playNude();

    play(IN_RAINBOWS, track(4));
    await poll();

    await waitFor(() => expect(side()).toBe("Side A · 4"));
    expect(within(nowLine()).getByRole("heading", { name: "Weird Fishes/Arpeggi" })).toBeInTheDocument();
    expect(playingOnBack()).toBe("Play Weird Fishes/Arpeggi");
  });

  it("swaps the record for a new album", async () => {
    await playNude();

    play(PINK_MOON, PINK_MOON_DETAILS.tracks[0]);
    await poll();

    expect(
      await screen.findByRole("button", { name: "Turn Pink Moon over" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn In Rainbows over" })).toBeNull();
    await waitFor(() =>
      expect(within(nowLine()).getByRole("heading", { name: "Pink Moon" })).toBeInTheDocument(),
    );
    expect(document.querySelector(".sleeve-out")).toHaveClass("floating");
  });

  it("shows paused when it's paused", async () => {
    await playNude();

    if (playing) playing = { ...playing, isPlaying: false, from: 5_000, since: Date.now() };
    await poll();

    await waitFor(() => expect(side()).toBe("Side A · 3 · paused"));
  });

  it("turns the record back to its tracklist when the music stops", async () => {
    await playNude();

    playing = null;
    await poll();

    await waitFor(() => expect(frontSide()).toHaveAttribute("aria-hidden", "true"));
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Device" })).toBeInTheDocument();
  });

  it("shows an advert as An advert", async () => {
    await playNude();

    play(null, null);
    await poll();

    await waitFor(() =>
      expect(within(nowLine()).getByRole("heading", { name: "An advert" })).toBeInTheDocument(),
    );
    // The record stays out, waiting for the music to come back.
    expect(screen.getByRole("button", { name: "Turn In Rainbows over" })).toBeInTheDocument();

    // And in the crate, the chip says so too.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      await screen.findByRole("button", { name: "An advert" }),
    ).toBeDisabled();
  });
});

describe("What's playing, over the crate", () => {
  it("is a chip that brings the record out of its place, floating", async () => {
    playingBackEnd();
    play(IN_RAINBOWS, NUDE);
    render(<Library name="Will" onSignedOut={() => {}} />);

    const chip = await screen.findByRole("region", { name: "Playing" });
    expect(chip).toHaveTextContent("Nude");
    expect(chip.querySelector("img")).toHaveAttribute("src", IN_RAINBOWS.covers?.small);
    fireEvent.click(within(chip).getByRole("button", { name: "Bring out In Rainbows" }));

    expect(
      await screen.findByRole("button", { name: "Turn In Rainbows over" }),
    ).toBeInTheDocument();
    expect(document.querySelector(".sleeve-out")).toHaveClass("floating");
    expect(glow()).toHaveClass("on");
    expect(screen.queryByRole("region", { name: "Playing" })).toBeNull();
  });
});

describe("A stranger's record", () => {
  const STRANGER = card(9, {
    id: "deadwax-9",
    spotifyId: "stranger9",
    title: "Blue Lines",
    artist: "Massive Attack",
  });
  const SAFE = { spotifyId: "safe1", disc: 1, number: 1, title: "Safe from Harm", durationMs: 318_000 };

  it("rises in a plain sleeve with Spotify's cover, unaltered, a neutral glow and Add to the crate", async () => {
    const calls = playingBackEnd({ add_album: () => STRANGER });
    play(STRANGER, SAFE);
    render(<Library name="Will" onSignedOut={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Bring out Blue Lines" }));

    const sleeve = await screen.findByRole("img", {
      name: "Blue Lines by Massive Attack, not in your crate",
    });
    const cover = sleeve.querySelector("img") as HTMLImageElement;
    expect(cover).toHaveAttribute("src", STRANGER.covers?.large);
    expect(cover).not.toHaveAttribute("style");
    expect(sleeve.querySelector(".wear")).toBeNull();
    // The plain glow: no album colours.
    expect(glow()).toHaveClass("on");
    expect(glow().getAttribute("style") ?? "").not.toContain("--album-");
    expect(side()).toBe("Not in your crate");

    fireEvent.click(within(nowLine()).getByRole("button", { name: "Add to the crate" }));

    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: "add_album", args: { spotifyId: "stranger9" } }),
    );
    // It's a real sleeve now, which turns over, still floating and playing.
    expect(
      await screen.findByRole("button", { name: "Turn Blue Lines over" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /not in your crate/ })).toBeNull();
    expect(document.querySelector(".sleeve-out")).toHaveClass("floating");
    expect(within(nowLine()).queryByRole("button", { name: "Add to the crate" })).toBeNull();
  });
});

describe("Polling", () => {
  it("doesn't redraw when nothing changed, and the clock redraws only its own line", async () => {
    playingBackEnd();
    play(IN_RAINBOWS, NUDE);
    const commits = vi.fn();
    render(
      <Profiler id="library" onRender={commits}>
        <Library name="Will" onSignedOut={() => {}} />
      </Profiler>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Bring out In Rainbows" }));
    await waitFor(() => expect(side()).toBe("Side A · 3"));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const before = clock().textContent;
    commits.mockClear();

    // Three polls, each with Spotify a little further into the same track.
    await poll();
    await poll();
    await poll();

    expect(commits).not.toHaveBeenCalled();
    expect(clock().textContent).not.toBe(before);
    expect(clock()).toHaveTextContent("0:07");
  });
});
