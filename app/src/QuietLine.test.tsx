import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTION, IN_RAINBOWS, IN_RAINBOWS_DETAILS } from "./crateFixtures";
import Library from "./Library";
import { backEnd, SPOTIFY_SAYS } from "./mockBackEnd";
import { POLL_MS } from "./playing";
import { UNANSWERED } from "./notice";

/** Spotify's answer to what's playing: it fails while `down` is set. */
let down = false;

function crate(replies: Record<string, () => unknown> = {}) {
  return backEnd({
    get_collection: () => COLLECTION,
    dev_list_missing: () => 0,
    get_remembered_device: () => "Living Room",
    get_playback: () => {
      if (down) throw SPOTIFY_SAYS.network;
      return null;
    },
    get_album: () => IN_RAINBOWS_DETAILS,
    refresh_album: () => null,
    get_notes: () => null,
    open_album_in_spotify: () => {
      throw SPOTIFY_SAYS.network;
    },
    ...replies,
  });
}

const line = () => screen.queryByRole("alert");
/** How long an error shows (the ticket's 8 seconds), written out so the tests pin it. */
const QUIET_MS = 8000;
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const poll = () => wait(POLL_MS);

/** Pulls In Rainbows out and presses Open in Spotify, which fails. */
async function failToOpen() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));
  fireEvent.click(await screen.findByRole("link", { name: "Open in Spotify" }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  down = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("The quiet line", () => {
  it("shows an error as one line at the top, and fades it after 8 seconds", async () => {
    crate();
    render(<Library name="Will" />);
    await failToOpen();

    await waitFor(() => expect(line()).toHaveTextContent(SPOTIFY_SAYS.network));
    expect(line()).toHaveClass("quiet-line", "on");
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    await wait(QUIET_MS - 500);
    expect(line()).toHaveClass("on");
    await wait(500);
    // It fades out with its words still showing, then it's gone.
    expect(line()).toHaveTextContent(SPOTIFY_SAYS.network);
    expect(line()).not.toHaveClass("on");
    await wait(500);
    expect(line()).toBeNull();
  });

  it("starts the 8 seconds again for a new error, even in the same words", async () => {
    crate();
    render(<Library name="Will" />);
    await failToOpen();
    await waitFor(() => expect(line()).toHaveTextContent(SPOTIFY_SAYS.network));

    await wait(QUIET_MS - 1000);
    fireEvent.click(screen.getByRole("link", { name: "Open in Spotify" }));
    // Its failure is said before the first one's 8 seconds are up.
    await wait(0);
    await wait(2000);

    expect(line()).toHaveClass("on");
    await wait(QUIET_MS);
    expect(line()).not.toHaveClass("on");
  });

  it("clears an error when a new search starts", async () => {
    crate({ search_albums: () => new Promise(() => {}) });
    render(<Library name="Will" />);
    await failToOpen();
    await waitFor(() => expect(line()).toHaveTextContent(SPOTIFY_SAYS.network));
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(await screen.findByRole("button", { name: "Find a record" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "pink moon" } });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });

    await waitFor(() => expect(line()).not.toHaveClass("on"));
  });

  it("says nothing after one failed poll, and that Spotify isn't answering after two in a row", async () => {
    crate();
    render(<Library name="Will" />);
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" });

    down = true;
    await poll();
    expect(line()).toBeNull();
    // One that works in between starts the count again.
    down = false;
    await poll();
    down = true;
    await poll();
    expect(line()).toBeNull();

    await poll();
    expect(line()).toHaveTextContent(UNANSWERED);
    expect(line()).toHaveClass("on");
    // It stays while Spotify isn't answering: it isn't an error that fades.
    await wait(QUIET_MS * 2);
    expect(line()).toHaveTextContent(UNANSWERED);

    down = false;
    await poll();
    expect(line()).not.toHaveClass("on");
    await wait(500);
    expect(line()).toBeNull();
  });

  it("shows an error over Spotify not answering, then goes back to saying so", async () => {
    crate();
    render(<Library name="Will" />);
    down = true;
    await failToOpen();
    await waitFor(() => expect(line()).toHaveTextContent(SPOTIFY_SAYS.network));
    await poll();
    await poll();
    expect(line()).toHaveTextContent(SPOTIFY_SAYS.network);

    await wait(QUIET_MS);

    expect(line()).toHaveTextContent(UNANSWERED);
    expect(line()).toHaveClass("on");
  });

  // The prototype's dev panel failed "the next action" with each of these.
  // A 429 Rust can wait out is only slow, so it never reaches the UI:
  // `retries_a_429_after_its_retry_after_and_only_then` covers it.
  it.each([
    ["no network", SPOTIFY_SAYS.network],
    ["a 429 too long to wait out", SPOTIFY_SAYS.rateLimited],
    ["a 502", SPOTIFY_SAYS.serverError],
  ])(
    "says what Spotify said, for %s, when a pause, a skip, a play, a search or an add fails",
    async (_, sentence) => {
      /** Fails the next call to Spotify, then works again. */
      let failNext = false;
      const once = <T,>(reply: () => T) => () => {
        if (!failNext) return reply();
        failNext = false;
        throw sentence;
      };
      const calls = crate({
        get_playback: () => ({
          isPlaying: true,
          device: "Living Room",
          progressMs: 1000,
          track: {
            spotifyId: IN_RAINBOWS_DETAILS.tracks[0].spotifyId,
            disc: 1,
            number: 1,
            title: "15 Step",
            artist: "Radiohead",
            album: "In Rainbows",
            albumId: IN_RAINBOWS.id,
            spotifyAlbumId: IN_RAINBOWS.spotifyId,
            durationMs: 237_293,
            coverUrl: null,
          },
        }),
        pause_playback: once(() => null),
        next_track: once(() => null),
        play_album: once(() => ({ state: "playing", devices: [] })),
        search_albums: once(() => ({
          results: [
            {
              album: {
                spotifyId: "pink-moon",
                title: "Pink Moon",
                artist: "Nick Drake",
                year: 1972,
                coverUrl: null,
              },
              inCollection: false,
            },
          ],
          nextOffset: null,
        })),
        add_album: once(() => null),
      });
      render(<Library name="Will" />);
      // What's playing comes out of the crate, floating, so ← → skip.
      fireEvent.click(await screen.findByRole("button", { name: "Bring out In Rainbows" }));
      await screen.findByRole("region", { name: "Now playing" });

      /** Does `act` with the next call failing, and waits for the line to say so and fade. */
      async function fails(cmd: string, act: () => void | Promise<void>) {
        failNext = true;
        await act();
        await waitFor(() => expect(calls.map((c) => c.cmd)).toContain(cmd));
        await waitFor(() => expect(line()).toHaveTextContent(sentence));
        expect(failNext).toBe(false);
        await wait(QUIET_MS + 500);
        expect(line()?.classList.contains("on") ?? false).toBe(false);
      }

      await fails("pause_playback", () => {
        fireEvent.keyDown(window, { key: " " });
      });
      await fails("next_track", () => {
        fireEvent.keyDown(window, { key: "ArrowRight" });
      });
      await fails("play_album", async () => {
        fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));
        fireEvent.click(await screen.findByRole("button", { name: "Play Nude" }));
      });
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.click(await screen.findByRole("button", { name: "Find a record" }));
      await fails("search_albums", () => {
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "pink moon" } });
        fireEvent.submit(screen.getByRole("searchbox"));
      });
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nick drake" } });
      fireEvent.submit(screen.getByRole("searchbox"));
      const add = await screen.findByRole("button", { name: "Add Pink Moon by Nick Drake" });
      await fails("add_album", () => {
        fireEvent.click(add);
      });
    },
  );

  it("leaves the crate and the sleeves working while Spotify isn't answering", async () => {
    down = true;
    crate();
    render(<Library name="Will" />);
    await poll();
    await poll();
    expect(line()).toHaveTextContent(UNANSWERED);

    // The crate flips, and a record comes out and turns over to its tracklist.
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(
        document.querySelector(".crate [data-front]")?.getAttribute("aria-label"),
      ).not.toBe("Pull out In Rainbows by Radiohead"),
    );
    fireEvent.keyDown(window, { key: "ArrowUp" });
    await failToOpen();
    expect(await screen.findByRole("button", { name: "Play 15 Step" })).toBeInTheDocument();
  });
});
