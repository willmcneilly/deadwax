import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  const { title, artist, year } = album(n);
  return {
    spotifyId: `spotify${n}`,
    title,
    artist,
    year,
    coverUrl: `https://i.scdn.co/image/cover${n}`,
  };
};

const IN_RAINBOWS: AlbumCard = card(0, {
  id: "0b1c7e1e-6a0e-4c43-9f1e-2b8f6f1d9a01",
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

/** Ten results from `offset`, the first marked as in the collection. */
function page(offset: number, last = false): SearchResults {
  return {
    results: Array.from({ length: last ? 3 : 10 }, (_, i) => ({
      album: found(offset + i),
      inCollection: offset + i === 0,
    })),
    nextOffset: last ? null : offset + 10,
  };
}

/** Opens search from the crate, if it isn't open, and searches. */
async function searchFor(text: string) {
  if (!screen.queryByRole("searchbox")) {
    fireEvent.click(await screen.findByRole("button", { name: "Find a record" }));
  }
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

const results = () =>
  within(screen.getByRole("list", { name: "Search results" })).getAllByRole(
    "listitem",
  );

const crate = () => screen.getByRole("region", { name: "Your crate" });

// Search is the old search box until DWX-24 replaces it, opened from the
// crate's Find a record.
describe("Search", () => {
  it("opens from the crate, and closes back to it", async () => {
    backEnd({ get_collection: () => [IN_RAINBOWS], ...NOTHING_PLAYING });
    render(<Library name="Will" onSignedOut={() => {}} />);
    expect(await screen.findByText("Signed in as Will")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Find a record" }));
    expect(screen.getByRole("searchbox")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to the crate" }));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find a record" })).toBeInTheDocument();
  });

  it("searches ten at a time, with cover, title, artist and year", async () => {
    const calls = backEnd({
      ...EMPTY_COLLECTION,
      search_albums: (args) => {
        const { offset } = args as { offset: number };
        return page(offset, offset === 10);
      },
    });
    render(<Library name="Will" onSignedOut={() => {}} />);
    await screen.findByText("Your crate is empty.");

    await searchFor("  album  ");

    await waitFor(() => expect(results()).toHaveLength(10));
    expect(calls).toContainEqual({
      cmd: "search_albums",
      args: { query: "album", offset: 0 },
    });
    const second = results()[1];
    expect(second).toHaveTextContent("Album 1");
    expect(second).toHaveTextContent("Artist 1 · 2001");
    expect(within(second).getByRole("img")).toHaveAttribute(
      "src",
      "https://i.scdn.co/image/cover1",
    );

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    await waitFor(() => expect(results()).toHaveLength(13));
    expect(calls).toContainEqual({
      cmd: "search_albums",
      args: { query: "album", offset: 10 },
    });
    // The last page has no "More".
    expect(
      screen.queryByRole("button", { name: "More" }),
    ).not.toBeInTheDocument();
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
    render(<Library name="Will" onSignedOut={() => {}} />);

    await searchFor("album");
    await waitFor(() => expect(results()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    await waitFor(() => expect(results()).toHaveLength(12));
    expect(
      results().filter((r) => r.textContent?.includes("Album 9")),
    ).toHaveLength(1);
  });

  it("keeps an album's mark when More finishes after its Add", async () => {
    let finishMore: (results: SearchResults) => void = () => {};
    backEnd({
      ...EMPTY_COLLECTION,
      search_albums: (args) => {
        const { offset } = args as { offset: number };
        if (offset === 0) return page(0);
        return new Promise<SearchResults>((resolve) => (finishMore = resolve));
      },
      add_album: () => album(1),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    await searchFor("album");
    await waitFor(() => expect(results()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add Album 1 by Artist 1" }),
    );
    await waitFor(() =>
      expect(results()[1]).toHaveTextContent("In your collection"),
    );

    finishMore(page(10, true));

    await waitFor(() => expect(results()).toHaveLength(13));
    expect(results()[1]).toHaveTextContent("In your collection");
  });

  it("marks the albums already in your collection", async () => {
    backEnd({
      ...EMPTY_COLLECTION,
      search_albums: () => page(0),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    await searchFor("album");

    await waitFor(() => expect(results()).toHaveLength(10));
    const [owned, other] = results();
    expect(owned).toHaveTextContent("In your collection");
    expect(within(owned).queryByRole("button")).not.toBeInTheDocument();
    expect(
      within(other).getByRole("button", { name: "Add Album 1 by Artist 1" }),
    ).toBeInTheDocument();
  });

  it("adds an album by its Spotify ID, and the crate has it by its Deadwax ID", async () => {
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
    render(<Library name="Will" onSignedOut={() => {}} />);
    await screen.findByRole("button", { name: "Pull out Album 50 by Artist 50" });

    await searchFor("in rainbows");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add In Rainbows by Radiohead",
      }),
    );

    expect(
      await screen.findByRole("button", {
        name: "Add In Rainbows by Radiohead",
      }),
    ).toHaveTextContent("Adding…");
    expect(calls).toContainEqual({
      cmd: "add_album",
      args: { spotifyId: IN_RAINBOWS_FOUND.spotifyId },
    });

    finish(IN_RAINBOWS);

    await waitFor(() =>
      expect(
        within(crate()).getByRole("button", {
          name: /In Rainbows by Radiohead$/,
        }),
      ).toBeInTheDocument(),
    );
    expect(results()[0]).toHaveTextContent("In your collection");
  });

  it("shows a failed search", async () => {
    backEnd({
      ...EMPTY_COLLECTION,
      get_session: () => ({ state: "signedIn", name: "Will" }),
      search_albums: () => {
        throw "couldn't reach Spotify";
      },
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    await searchFor("album");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't reach Spotify",
    );
  });

  it("goes back to sign-in when the sign-in has expired", async () => {
    const message =
      "Your Spotify sign-in has expired. Sign in again to carry on.";
    const onSignedOut = vi.fn();
    backEnd({
      ...EMPTY_COLLECTION,
      get_session: () => ({ state: "signedOut", message: null }),
      search_albums: () => {
        throw message;
      },
    });
    render(<Library name="Will" onSignedOut={onSignedOut} />);

    await searchFor("album");

    await waitFor(() =>
      expect(onSignedOut).toHaveBeenCalledWith({ state: "signedOut", message }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
