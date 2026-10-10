import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AlbumCard, AlbumDetails } from "./api";
import Library from "./Library";
import { backEnd, NOTHING_PLAYING } from "./mockBackEnd";

const IN_RAINBOWS: AlbumDetails = {
  id: "5vkqYmiPBYLaalcmjujWxK",
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
  coverUrl: "https://i.scdn.co/image/in-rainbows-640",
  tracks: [
    { id: "t1", disc: 1, number: 1, title: "15 Step", durationMs: 237_293 },
    {
      id: "t2",
      disc: 1,
      number: 2,
      title: "Bodysnatchers",
      durationMs: 242_293,
    },
  ],
};

const card = ({
  id,
  title,
  artist,
  year,
  coverUrl,
}: AlbumDetails): AlbumCard => ({
  id,
  title,
  artist,
  year,
  coverUrl,
});

const OTHER: AlbumCard = {
  id: "6dVIqQ8qmQ5GBnJ9shOYGE",
  title: "OK Computer",
  artist: "Radiohead",
  year: 1997,
  coverUrl: null,
};

/** The back end for a collection of In Rainbows and OK Computer. */
function collection(replies: Record<string, () => unknown> = {}) {
  return backEnd({
    get_collection: () => [card(IN_RAINBOWS), OTHER],
    dev_list_missing: () => 0,
    get_album: () => IN_RAINBOWS,
    refresh_album: () => null,
    ...NOTHING_PLAYING,
    ...replies,
  });
}

async function openInRainbows() {
  render(<Library name="Will" onSignedOut={() => {}} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open In Rainbows by Radiohead",
    }),
  );
  return screen.findByRole("heading", { level: 1 });
}

const grid = () => screen.queryByRole("list", { name: "Your collection" });

describe("The album page", () => {
  it("shows the cover, title, artist, year and tracklist from the cache", async () => {
    const calls = collection();

    expect(await openInRainbows()).toHaveTextContent("In Rainbows");

    expect(screen.getByText("Radiohead · 2007")).toBeInTheDocument();
    const cover = screen.getByRole("img", { name: "Cover of In Rainbows" });
    expect(cover).toHaveAttribute("src", IN_RAINBOWS.coverUrl);
    expect(cover).not.toHaveAttribute("style");
    const tracks = within(
      screen.getByRole("list", { name: "Tracks" }),
    ).getAllByRole("listitem");
    expect(tracks.map((t) => t.textContent)).toEqual([
      "115 Step3:57",
      "2Bodysnatchers4:02",
    ]);
    expect(calls).toContainEqual({
      cmd: "get_album",
      args: { id: IN_RAINBOWS.id },
    });
    // The page asks Rust whether the cache needs fetching again.
    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "refresh_album",
        args: { id: IN_RAINBOWS.id },
      }),
    );
    // The grid and the search are gone while it's open.
    expect(grid()).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("updates when a stale cache has been fetched again", async () => {
    let finish: (album: AlbumDetails) => void = () => {};
    collection({
      refresh_album: () =>
        new Promise<AlbumDetails>((resolve) => (finish = resolve)),
    });

    expect(await openInRainbows()).toHaveTextContent("In Rainbows");

    finish({
      ...IN_RAINBOWS,
      title: "In Rainbows (Remastered)",
      tracks: [...IN_RAINBOWS.tracks.slice(0, 1)],
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "In Rainbows (Remastered)",
      ),
    );
    expect(
      within(screen.getByRole("list", { name: "Tracks" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(1);
  });

  it("keeps the cached page when fetching it again fails", async () => {
    collection({
      get_session: () => ({ state: "signedIn", name: "Will" }),
      refresh_album: () => {
        throw "couldn't reach Spotify";
      },
    });

    await openInRainbows();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't reach Spotify",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "In Rainbows",
    );
  });

  it("opens the album on Spotify through Rust", async () => {
    const calls = collection({ open_album_in_spotify: () => null });
    await openInRainbows();

    const link = screen.getByRole("link", { name: "Open in Spotify" });
    expect(link).toHaveAttribute(
      "href",
      `https://open.spotify.com/album/${IN_RAINBOWS.id}`,
    );
    fireEvent.click(link);

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "open_album_in_spotify",
        args: { id: IN_RAINBOWS.id },
      }),
    );
  });

  it("removes the album and goes back to the grid without it", async () => {
    let removed = false;
    const calls = collection({
      get_collection: () => (removed ? [OTHER] : [card(IN_RAINBOWS), OTHER]),
      remove_album: () => {
        removed = true;
        return null;
      },
    });
    await openInRainbows();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from collection" }),
    );

    await waitFor(() => expect(grid()).toBeInTheDocument());
    expect(calls).toContainEqual({
      cmd: "remove_album",
      args: { id: IN_RAINBOWS.id },
    });
    const items = within(grid()!).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("OK Computer");
  });

  it("stays on the page and says why when removing fails", async () => {
    collection({
      get_session: () => ({ state: "signedIn", name: "Will" }),
      remove_album: () => {
        throw "Couldn't update your collection: disk full";
      },
    });
    await openInRainbows();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from collection" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(
      screen.getByRole("button", { name: "Remove from collection" }),
    ).toBeEnabled();
    expect(grid()).not.toBeInTheDocument();
  });

  it("goes back to the grid, loaded again", async () => {
    const calls = collection();
    await openInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "← Your collection" }));

    await waitFor(() => expect(grid()).toBeInTheDocument());
    expect(calls.filter((c) => c.cmd === "get_collection")).toHaveLength(2);
    expect(within(grid()!).getAllByRole("listitem")).toHaveLength(2);
  });

  it("says so when the album can't be loaded", async () => {
    collection({
      get_album: () => {
        throw "That album isn't in your collection.";
      },
    });
    render(<Library name="Will" onSignedOut={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open In Rainbows by Radiohead",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That album isn't in your collection.",
    );
    expect(
      screen.getByRole("button", { name: "← Your collection" }),
    ).toBeInTheDocument();
  });

  it("splits the tracklist by disc when there's more than one", async () => {
    collection({
      get_album: () => ({
        ...IN_RAINBOWS,
        tracks: [
          ...IN_RAINBOWS.tracks,
          { id: "t3", disc: 2, number: 1, title: "MK 1", durationMs: 65_000 },
        ],
      }),
    });

    await openInRainbows();

    expect(
      screen.getByRole("heading", { level: 2, name: "Disc 2" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Disc 2" })).getByRole(
        "listitem",
      ),
    ).toHaveTextContent("1MK 11:05");
  });
});
