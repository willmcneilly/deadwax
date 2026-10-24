import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it } from "vitest";
import { ALBUM_UPDATED, type AlbumDetails, type PlayOutcome } from "./api";
import {
  COLLECTION,
  IN_RAINBOWS,
  IN_RAINBOWS_DETAILS,
  PALETTE,
  PINK_MOON,
} from "./crateFixtures";
import Library from "./Library";
import { backEnd } from "./mockBackEnd";

const LIVING_ROOM = { name: "Living Room", kind: "Speaker", isActive: true, canPlay: true };

const PINK_MOON_DETAILS: AlbumDetails = {
  id: PINK_MOON.id,
  spotifyId: "5mwD9Jg8LqZ5N5ekmjzRGW",
  title: "Pink Moon",
  artist: "Nick Drake",
  year: 1972,
  coverUrl: null,
  tracks: [{ spotifyId: "pm1", disc: 1, number: 1, title: "Pink Moon", durationMs: 125_000 }],
};

function sleeveBackEnd(replies: Record<string, (args?: unknown) => unknown> = {}) {
  return backEnd({
    get_collection: () => COLLECTION,
    dev_list_missing: () => 0,
    get_album: (args) =>
      (args as { id: string }).id === PINK_MOON.id ? PINK_MOON_DETAILS : IN_RAINBOWS_DETAILS,
    refresh_album: () => null,
    get_playback: () => null,
    get_session: () => ({ state: "signedIn", name: "Will" }),
    get_remembered_device: () => "Living Room",
    get_devices: () => ({ devices: [LIVING_ROOM], remembered: "Living Room" }),
    choose_device: () => null,
    play_album: (): PlayOutcome => ({ state: "playing", devices: [LIVING_ROOM] }),
    open_album_in_spotify: () => null,
    remove_album: () => null,
    ...replies,
  });
}

const crate = () => screen.getByRole("region", { name: "Your crate" });
const front = () => crate().querySelector("[data-front]")?.getAttribute("aria-label");
/** The pulled-out sleeve's front, which is hidden while its back is showing. */
const frontSide = () => document.querySelector(".sleeve-side.front") as HTMLElement;
const back = () => screen.getByRole("group", { name: "The back of In Rainbows" });

/** Opens the crate and pulls out In Rainbows, the record in front. */
async function pullOutInRainbows() {
  render(<Library name="Will" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" }),
  );
}

/** ... and turns it over to its tracklist. */
async function turnOver() {
  fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));
  await screen.findByRole("button", { name: "Play 15 Step" });
}

describe("The sleeve", () => {
  it("pulls the record in front out of the crate, and flies back into its place with Escape", async () => {
    sleeveBackEnd();
    await pullOutInRainbows();

    expect(screen.getByRole("button", { name: "Turn In Rainbows over" })).toBeInTheDocument();
    // Its place in the crate stays empty while it's out.
    expect(crate().querySelector("[data-front]")).toHaveStyle({ visibility: "hidden" });

    fireEvent.keyDown(window, { key: "Escape" });

    // Its place shows again as it flies back, under it, before it's gone.
    expect(screen.getByRole("button", { name: "Turn In Rainbows over" })).toBeInTheDocument();
    expect(crate().querySelector("[data-front]")).not.toHaveStyle({ visibility: "hidden" });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Turn In Rainbows over" }),
      ).not.toBeInTheDocument(),
    );
    expect(front()).toBe("Pull out In Rainbows by Radiohead");
  });

  it("pulls out with Enter, and goes back when you click the room around it", async () => {
    sleeveBackEnd();
    render(<Library name="Will" />);
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" });

    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Turn In Rainbows over" })).toBeInTheDocument();

    fireEvent.click(document.querySelector(".sleeve-backdrop") as Element);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Turn In Rainbows over" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the large cover over the 640 once it's decoded, with no filter", async () => {
    sleeveBackEnd();
    await pullOutInRainbows();

    const face = screen.getByRole("button", { name: "Turn In Rainbows over" });
    const [medium, large] = face.querySelectorAll("img");
    expect(medium).toHaveAttribute("src", IN_RAINBOWS.covers?.medium);
    expect(large).toHaveAttribute("src", IN_RAINBOWS.covers?.large);
    expect(large).not.toHaveClass("ready");

    fireEvent.load(large);

    await waitFor(() => expect(large).toHaveClass("ready"));
    expect(large).not.toHaveAttribute("style");
  });

  it("builds its back only when it's first turned over", async () => {
    sleeveBackEnd();
    await pullOutInRainbows();

    // The back's side is there, hidden, but nothing is built on it.
    const backSide = document.querySelector(".sleeve-side.back") as HTMLElement;
    expect(backSide).toBeEmptyDOMElement();

    await turnOver();

    expect(back()).toBeInTheDocument();
    expect(backSide.querySelector(".back-inner")).toBe(back());
  });

  it("turns over to its tracklist in sides, with the year and the label", async () => {
    sleeveBackEnd();
    await pullOutInRainbows();
    await turnOver();

    expect(within(back()).getByRole("heading", { name: "In Rainbows" })).toBeInTheDocument();
    expect(back()).toHaveTextContent("Radiohead");
    const sideA = within(back()).getByRole("region", { name: "Side A" });
    const sideB = within(back()).getByRole("region", { name: "Side B" });
    expect(within(sideA).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Play 15 Step",
      "Play Bodysnatchers",
      "Play Nude",
      "Play Weird Fishes/Arpeggi",
      "Play All I Need",
    ]);
    expect(within(sideB).getAllByRole("button")).toHaveLength(5);
    expect(within(sideB).getByRole("button", { name: "Play Faust Arp" })).toHaveTextContent(
      "B1Faust Arp2:10",
    );
    expect(back()).toHaveTextContent("2007 · XL Recordings");

    // Turning it over again shows the front; Enter turns it too.
    fireEvent.click(within(back()).getByRole("heading", { name: "In Rainbows" }));
    expect(screen.getByRole("button", { name: "Turn In Rainbows over" })).not.toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(
      frontSide(),
    ).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("plays the album from the track you pick, by the track's real Spotify ID", async () => {
    const calls = sleeveBackEnd();
    await pullOutInRainbows();
    await turnOver();

    fireEvent.click(screen.getByRole("button", { name: "Play Reckoner" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "play_album",
        args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "track-7" },
      }),
    );
  });

  it("prints its back in the album's own colours, through AlbumColours", async () => {
    sleeveBackEnd();
    await pullOutInRainbows();
    await turnOver();

    const paper = back().closest(".sleeve-face") as HTMLElement;
    expect(paper.style.getPropertyValue("--album-ground")).toBe(PALETTE.ground);
    expect(paper.style.getPropertyValue("--album-ink")).toBe(PALETTE.ink);
    expect(paper.style.getPropertyValue("--album-accent")).toBe(PALETTE.accent);
  });

  it("has Open in Spotify, which opens the album by its Spotify ID", async () => {
    const calls = sleeveBackEnd();
    await pullOutInRainbows();
    await turnOver();

    const link = within(back()).getByRole("link", { name: "Open in Spotify" });
    expect(link).toHaveAttribute(
      "href",
      `https://open.spotify.com/album/${IN_RAINBOWS_DETAILS.spotifyId}`,
    );
    fireEvent.click(link);

    expect(calls).toContainEqual({
      cmd: "open_album_in_spotify",
      args: { spotifyId: IN_RAINBOWS_DETAILS.spotifyId },
    });
  });

  it("shows wear on its front and back only for artwork from other sources", async () => {
    sleeveBackEnd();
    await pullOutInRainbows();
    await turnOver();
    expect(
      frontSide().querySelector(".wear"),
    ).not.toBeNull();
    expect(back().closest(".sleeve-face")?.querySelector(".wear")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Turn In Rainbows over" })).toBeNull(),
    );
    fireEvent.keyDown(window, { key: "]" });
    fireEvent.keyDown(window, { key: "]" });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Turn Pink Moon over" }));

    const pinkMoon = await screen.findByRole("group", { name: "The back of Pink Moon" });
    expect(
      frontSide().querySelector(".wear"),
    ).toBeNull();
    expect(pinkMoon.closest(".sleeve-face")?.querySelector(".wear")).toBeNull();
    // Open in Spotify is on every sleeve.
    expect(within(pinkMoon).getByRole("link", { name: "Open in Spotify" })).toBeInTheDocument();
  });

  it("takes the album out of the crate after asking, at the foot of its back, under Open in Spotify", async () => {
    let collection = COLLECTION;
    const calls = sleeveBackEnd({
      get_collection: () => collection,
      remove_album: (args) => {
        collection = collection.filter((a) => a.id !== (args as { id: string }).id);
        return null;
      },
    });
    await pullOutInRainbows();
    await turnOver();

    const foot = within(back()).getByRole("link", { name: "Open in Spotify" }).parentElement as HTMLElement;
    const takeOut = within(foot).getByRole("button", { name: "Take it out of the crate" });
    expect(foot.lastElementChild).toBe(takeOut);
    fireEvent.click(takeOut);

    // It asks first, and keeping it changes nothing.
    const ask = within(back()).getByRole("group", { name: "Take it out of the crate?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(calls.map((c) => c.cmd)).not.toContain("remove_album");

    fireEvent.click(within(back()).getByRole("button", { name: "Take it out of the crate" }));
    fireEvent.click(within(back()).getByRole("button", { name: "Take it out" }));

    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: "remove_album", args: { id: IN_RAINBOWS.id } }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Turn In Rainbows over" })).toBeNull(),
    );
    expect(
      within(crate()).queryByRole("button", { name: /In Rainbows by Radiohead/ }),
    ).not.toBeInTheDocument();
  });

  it("lets the crate flip again when the record that was out has left it", async () => {
    let collection = COLLECTION;
    sleeveBackEnd({ get_collection: () => collection });
    await pullOutInRainbows();

    collection = COLLECTION.filter((a) => a.id !== IN_RAINBOWS.id);
    await emit(ALBUM_UPDATED, IN_RAINBOWS.id);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Turn In Rainbows over" })).toBeNull(),
    );
    const before = front();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(front()).not.toBe(before);
  });

  it("stays out, saying why, when taking it out fails", async () => {
    sleeveBackEnd({
      remove_album: () => {
        throw "Couldn't update your collection: disk full";
      },
    });
    await pullOutInRainbows();
    await turnOver();

    fireEvent.click(within(back()).getByRole("button", { name: "Take it out of the crate" }));
    fireEvent.click(within(back()).getByRole("button", { name: "Take it out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(back()).toBeInTheDocument();
    expect(within(back()).getByRole("button", { name: "Take it out" })).toBeEnabled();
  });

  it("shows a tracklist fetched again when its cache is stale", async () => {
    const fresh: AlbumDetails = {
      ...IN_RAINBOWS_DETAILS,
      tracks: [{ ...IN_RAINBOWS_DETAILS.tracks[0], title: "15 Step (Remastered)" }],
    };
    const calls = sleeveBackEnd({ refresh_album: () => fresh });
    await pullOutInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));

    expect(
      await screen.findByRole("button", { name: "Play 15 Step (Remastered)" }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({ cmd: "refresh_album", args: { id: IN_RAINBOWS.id } });
  });

  it("says so when the tracklist can't be loaded, and still opens in Spotify", async () => {
    sleeveBackEnd({
      get_album: () => {
        throw "That album isn't in your collection.";
      },
    });
    await pullOutInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));

    expect(await within(back()).findByRole("alert")).toHaveTextContent(
      "That album isn't in your collection.",
    );
    // Open in Spotify is there all the same.
    expect(within(back()).getByRole("link", { name: "Open in Spotify" })).toHaveAttribute(
      "href",
      `https://open.spotify.com/album/${IN_RAINBOWS.spotifyId}`,
    );
  });
});
