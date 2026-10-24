import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AlbumCard,
  type SearchAlbum,
  type SearchResults,
} from "./api";
import Library from "./Library";
import { backEnd, card, EMPTY_COLLECTION, NOTHING_PLAYING } from "./mockBackEnd";

const album = card;

/** The same album as search finds it, named by its Spotify ID. */
const found = (n: number): SearchAlbum => {
  const { title, artist, year, spotifyId } = album(n);
  return {
    spotifyId,
    title,
    artist,
    year,
    coverUrl: `https://i.scdn.co/image/cover${n}`,
  };
};

const IN_RAINBOWS: AlbumCard = card(0, {
  id: "0b1c7e1e-6a0e-4c43-9f1e-2b8f6f1d9a01",
  spotifyId: "5vkqYmiPBYLaalcmjujWxK",
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
});

const IN_RAINBOWS_FOUND: SearchAlbum = {
  spotifyId: "5vkqYmiPBYLaalcmjujWxK",
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
  coverUrl: "https://i.scdn.co/image/in-rainbows-640",
};

/** Ten results from `offset`, none in the collection. */
function page(offset: number, last = false): SearchResults {
  return {
    results: Array.from({ length: last ? 3 : 10 }, (_, i) => ({
      album: found(offset + i),
      inCollection: false,
    })),
    nextOffset: last ? null : offset + 10,
  };
}

const EMPTY_LINE = "Your crate is empty. Find the first record for it.";

const searchbox = () => screen.getByRole("searchbox", { name: "Find a record" });

/**
 * Once the crate has loaded, opens search from the faint icon (or the empty
 * crate's button) if it hasn't opened by itself, and types.
 */
async function searchFor(text: string) {
  const open = await waitFor(
    () =>
      screen.queryByRole("searchbox") ??
      screen.getByRole("button", { name: "Find a record" }),
  );
  if (open instanceof HTMLButtonElement) fireEvent.click(open);
  fireEvent.change(searchbox(), { target: { value: text } });
}

const tiles = () =>
  within(screen.getByRole("list", { name: "Search results" })).getAllByRole(
    "listitem",
  );

const crate = () => screen.getByRole("region", { name: "Your crate" });

describe("Search", () => {
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).animate;
  });

  it("opens from the faint search icon, and closes back to the crate", async () => {
    backEnd({ get_collection: () => [IN_RAINBOWS], ...NOTHING_PLAYING });
    render(<Library name="Will" />);
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Find a record" }));
    expect(searchbox()).toHaveFocus();
    expect(screen.queryByText(EMPTY_LINE)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to the crate" }));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Find a record" }));
    fireEvent.keyDown(searchbox(), { key: "Escape" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("hides the crate while search is open, and shows it again when it closes", async () => {
    backEnd({ get_collection: () => [IN_RAINBOWS], ...NOTHING_PLAYING });
    render(<Library name="Will" />);
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" });
    expect(crate()).not.toHaveClass("away");

    fireEvent.click(screen.getByRole("button", { name: "Find a record" }));
    expect(crate()).toHaveClass("dim", "away");

    fireEvent.click(screen.getByRole("button", { name: "Back to the crate" }));
    expect(crate()).not.toHaveClass("dim");
    expect(crate()).not.toHaveClass("away");
  });

  it("searches as you type, and shows the results as a wall of covers with More at the end", async () => {
    const calls = backEnd({
      ...EMPTY_COLLECTION,
      search_albums: (args) => {
        const { offset } = args as { offset: number };
        return page(offset, offset === 10);
      },
    });
    render(<Library name="Will" />);
    await screen.findByText(EMPTY_LINE);

    await searchFor("  album  ");

    await waitFor(() => expect(tiles()).toHaveLength(10));
    expect(calls.filter((c) => c.cmd === "search_albums")).toEqual([
      { cmd: "search_albums", args: { query: "album", offset: 0 } },
    ]);
    expect(screen.getByText("Albums on Spotify · best match first")).toBeInTheDocument();
    const second = tiles()[1];
    expect(second).toHaveTextContent("Artist 1");
    expect(second).toHaveTextContent("Album 1 · 2001");
    expect(within(second).getByRole("img")).toHaveAttribute(
      "src",
      "https://i.scdn.co/image/cover1",
    );
    // More comes after the wall.
    const more = screen.getByRole("button", { name: "More" });
    expect(
      screen
        .getByRole("list", { name: "Search results" })
        .compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(more);

    await waitFor(() => expect(tiles()).toHaveLength(13));
    expect(calls).toContainEqual({
      cmd: "search_albums",
      args: { query: "album", offset: 10 },
    });
    // The last page has no More.
    expect(
      screen.queryByRole("button", { name: "More" }),
    ).not.toBeInTheDocument();
  });

  it("searches straight away on Enter", async () => {
    const calls = backEnd({ ...EMPTY_COLLECTION, search_albums: () => page(0) });
    render(<Library name="Will" />);
    await screen.findByText(EMPTY_LINE);

    await searchFor("album");
    fireEvent.submit(searchbox());

    expect(calls).toContainEqual({
      cmd: "search_albums",
      args: { query: "album", offset: 0 },
    });
    await waitFor(() => expect(tiles()).toHaveLength(10));
    // The search as you type doesn't ask again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(calls.filter((c) => c.cmd === "search_albums")).toHaveLength(1);
  });

  it("waits until you stop typing, and searches once, for what you typed last", async () => {
    const calls = backEnd({ ...EMPTY_COLLECTION, search_albums: () => page(0) });
    render(<Library name="Will" />);
    await screen.findByText(EMPTY_LINE);

    for (const text of ["e", "en", "eno"]) {
      fireEvent.change(searchbox(), { target: { value: text } });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Still typing: nothing asked yet.
    expect(calls.filter((c) => c.cmd === "search_albums")).toHaveLength(0);

    await waitFor(() => expect(tiles()).toHaveLength(10));
    expect(calls.filter((c) => c.cmd === "search_albums")).toEqual([
      { cmd: "search_albums", args: { query: "eno", offset: 0 } },
    ]);
  });

  it("ignores a slow search that answers after a newer one", async () => {
    let finishFirst: (results: SearchResults) => void = () => {};
    backEnd({
      ...EMPTY_COLLECTION,
      search_albums: (args) => {
        const { query } = args as { query: string };
        if (query === "slow") {
          return new Promise<SearchResults>((resolve) => (finishFirst = resolve));
        }
        return page(0, true);
      },
    });
    render(<Library name="Will" />);
    await screen.findByText(EMPTY_LINE);

    await searchFor("slow");
    fireEvent.submit(searchbox());
    await searchFor("fast");
    fireEvent.submit(searchbox());
    await waitFor(() => expect(tiles()).toHaveLength(3));

    finishFirst(page(0));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tiles()).toHaveLength(3);
  });

  it("says when nothing on Spotify matches", async () => {
    backEnd({
      ...EMPTY_COLLECTION,
      search_albums: () => ({ results: [], nextOffset: null }),
    });
    render(<Library name="Will" />);

    await searchFor("zzzz");

    expect(
      await screen.findByText("Nothing on Spotify matches “zzzz”."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Search results" })).not.toBeInTheDocument();
  });

  it("shows an album once when the next page repeats it", async () => {
    backEnd({
      ...EMPTY_COLLECTION,
      search_albums: (args) => {
        const { offset } = args as { offset: number };
        if (offset === 0) return page(0);
        // Spotify's ranking shifted: album 9 comes back on the next page.
        const next = page(10, true);
        next.results[0] = { album: found(9), inCollection: false };
        return next;
      },
    });
    render(<Library name="Will" />);

    await searchFor("album");
    await waitFor(() => expect(tiles()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    await waitFor(() => expect(tiles()).toHaveLength(12));
    expect(
      tiles().filter((t) => t.textContent?.includes("Album 9")),
    ).toHaveLength(1);
  });

  it("dims the records already in the crate, with In your crate and no Add", async () => {
    backEnd({
      ...NOTHING_PLAYING,
      // Album 2 is in the crate; Rust says album 0 is too.
      get_collection: () => [album(2)],
      search_albums: () => {
        const results = page(0, true);
        results.results[0].inCollection = true;
        return results;
      },
    });
    render(<Library name="Will" />);

    await searchFor("album");

    await waitFor(() => expect(tiles()).toHaveLength(3));
    const [rusts, other, ours] = tiles();
    for (const tile of [rusts, ours]) {
      expect(tile).toHaveClass("ours");
      expect(tile).toHaveTextContent("In your crate");
      expect(within(tile).queryByRole("button")).not.toBeInTheDocument();
    }
    expect(other).not.toHaveClass("ours");
    expect(other).not.toHaveTextContent("In your crate");
    expect(
      within(other).getByRole("button", { name: "Add Album 1 by Artist 1" }),
    ).toHaveTextContent("+ Add");
  });

  it("adds an album with add_album, by its Spotify ID, and drops its cover toward the crate", async () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    Element.prototype.animate = animate as unknown as Element["animate"];
    let finish: (album: AlbumCard) => void = () => {};
    const calls = backEnd({
      ...NOTHING_PLAYING,
      get_collection: () => [album(50)],
      search_albums: () => ({
        results: [{ album: IN_RAINBOWS_FOUND, inCollection: false }],
        nextOffset: null,
      }),
      add_album: () => new Promise<AlbumCard>((resolve) => (finish = resolve)),
    });
    render(<Library name="Will" />);
    await screen.findByRole("button", { name: "Pull out Album 50 by Artist 50" });

    await searchFor("in rainbows");
    fireEvent.click(
      await screen.findByRole("button", { name: "Add In Rainbows by Radiohead" }),
    );

    expect(
      screen.getByRole("button", { name: "Add In Rainbows by Radiohead" }),
    ).toHaveTextContent("Adding…");
    expect(calls).toContainEqual({
      cmd: "add_album",
      args: { spotifyId: IN_RAINBOWS_FOUND.spotifyId },
    });
    expect(animate).not.toHaveBeenCalled();

    finish(IN_RAINBOWS);

    // The flourish: a copy of the cover drops off the bottom of the screen,
    // by transform and opacity only, and is gone once it has.
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    const ghost = animate.mock.contexts[0] as HTMLImageElement;
    expect(ghost).toHaveClass("search-ghost");
    expect(ghost).toHaveAttribute("src", IN_RAINBOWS_FOUND.coverUrl);
    const [frames] = animate.mock.calls[0] as unknown as [Keyframe[]];
    for (const frame of frames) {
      expect(Object.keys(frame).filter((k) => k !== "offset").sort()).toEqual([
        "opacity",
        "transform",
      ]);
    }
    await waitFor(() => expect(ghost).not.toBeInTheDocument());

    expect(tiles()[0]).toHaveTextContent("In your crate");
    expect(
      within(crate()).getByRole("button", { name: /In Rainbows by Radiohead$/ }),
    ).toBeInTheDocument();
  });

  it("turns the crate to the last record added when search closes", async () => {
    backEnd({
      ...NOTHING_PLAYING,
      get_collection: () => [album(50)],
      search_albums: () => ({
        results: [
          { album: found(1), inCollection: false },
          { album: IN_RAINBOWS_FOUND, inCollection: false },
        ],
        nextOffset: null,
      }),
      add_album: (args) => {
        const { spotifyId } = args as { spotifyId: string };
        return spotifyId === IN_RAINBOWS.spotifyId ? IN_RAINBOWS : album(1);
      },
    });
    render(<Library name="Will" />);
    await screen.findByRole("button", { name: "Pull out Album 50 by Artist 50" });

    await searchFor("album");
    fireEvent.click(
      await screen.findByRole("button", { name: "Add Album 1 by Artist 1" }),
    );
    await waitFor(() => expect(tiles()[0]).toHaveTextContent("In your crate"));
    fireEvent.click(screen.getByRole("button", { name: "Add In Rainbows by Radiohead" }));
    await waitFor(() => expect(tiles()[1]).toHaveTextContent("In your crate"));
    expect(
      within(crate()).queryByRole("button", { name: "Pull out In Rainbows by Radiohead" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to the crate" }));

    expect(
      within(crate()).getByRole("button", { name: "Pull out In Rainbows by Radiohead" }),
    ).toBeInTheDocument();
  });

  it("closes to the record that was in front when nothing was added", async () => {
    backEnd({
      ...NOTHING_PLAYING,
      get_collection: () => [album(1), album(50)],
      search_albums: () => page(0),
    });
    render(<Library name="Will" />);
    await screen.findByRole("button", { name: "Pull out Album 1 by Artist 1" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await screen.findByRole("button", { name: "Pull out Album 50 by Artist 50" });

    await searchFor("album");
    await waitFor(() => expect(tiles()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "Back to the crate" }));

    expect(
      within(crate()).getByRole("button", { name: "Pull out Album 50 by Artist 50" }),
    ).toBeInTheDocument();
  });

  it("opens on search with an empty collection, and closing it leaves the same line and a button", async () => {
    backEnd({ ...EMPTY_COLLECTION, search_albums: () => page(0) });
    render(<Library name="Will" />);

    // Straight onto search, with the line over it.
    expect(await screen.findByRole("searchbox", { name: "Find a record" })).toHaveFocus();
    expect(
      within(screen.getByRole("dialog", { name: "Find a record" })).getByText(EMPTY_LINE),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to the crate" }));

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByText(EMPTY_LINE)).toBeInTheDocument();
    // The search icon waits for a record; the button opens search again.
    expect(screen.getAllByRole("button", { name: "Find a record" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Find a record" }));
    expect(searchbox()).toBeInTheDocument();
  });

  it("doesn't open on search when the crate has records", async () => {
    backEnd({ get_collection: () => [IN_RAINBOWS], ...NOTHING_PLAYING });
    render(<Library name="Will" />);

    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" });

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY_LINE)).not.toBeInTheDocument();
  });

  it("drops the empty line once the first record is in", async () => {
    backEnd({
      ...EMPTY_COLLECTION,
      search_albums: () => ({
        results: [{ album: IN_RAINBOWS_FOUND, inCollection: false }],
        nextOffset: null,
      }),
      add_album: () => IN_RAINBOWS,
    });
    render(<Library name="Will" />);
    await screen.findByText(EMPTY_LINE);

    await searchFor("in rainbows");
    fireEvent.click(
      await screen.findByRole("button", { name: "Add In Rainbows by Radiohead" }),
    );
    await waitFor(() => expect(screen.queryByText(EMPTY_LINE)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Back to the crate" }));
    expect(
      within(crate()).getByRole("button", { name: "Pull out In Rainbows by Radiohead" }),
    ).toBeInTheDocument();
  });

  it("shows a failed search", async () => {
    backEnd({
      ...EMPTY_COLLECTION,
      get_session: () => ({ state: "signedIn", name: "Will" }),
      search_albums: () => {
        throw "couldn't reach Spotify";
      },
    });
    render(<Library name="Will" />);

    await searchFor("album");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't reach Spotify",
    );
  });
});
