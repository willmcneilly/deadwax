import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AlbumCard, SearchResults } from "./api";
import Library from "./Library";
import { backEnd } from "./mockBackEnd";

const album = (n: number, extra: Partial<AlbumCard> = {}): AlbumCard => ({
  id: `album${n}`,
  title: `Album ${n}`,
  artist: `Artist ${n}`,
  year: 2000 + n,
  coverUrl: `https://i.scdn.co/image/cover${n}`,
  ...extra,
});

const IN_RAINBOWS: AlbumCard = {
  id: "5vkqYmiPBYLaalcmjujWxK",
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
  coverUrl: "https://i.scdn.co/image/in-rainbows-640",
};

/** Ten results from `offset`, the first marked as in the collection. */
function page(offset: number, last = false): SearchResults {
  return {
    results: Array.from({ length: last ? 3 : 10 }, (_, i) => ({
      album: album(offset + i),
      inCollection: offset + i === 0,
    })),
    nextOffset: last ? null : offset + 10,
  };
}

function searchFor(text: string) {
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

const results = () =>
  within(screen.getByRole("list", { name: "Search results" })).getAllByRole(
    "listitem",
  );

const grid = () => screen.getByRole("list", { name: "Your collection" });

describe("Library", () => {
  it("shows the collection as a grid of Spotify's covers", async () => {
    backEnd({
      get_collection: () => [IN_RAINBOWS, album(2, { coverUrl: null })],
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    expect(await screen.findByText("Signed in as Will")).toBeInTheDocument();
    const items = within(
      await screen.findByRole("list", {
        name: "Your collection",
      }),
    ).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("In Rainbows");
    expect(items[0]).toHaveTextContent("Radiohead");

    // The cover is Spotify's, as it is: nothing styled over or around it.
    const cover = within(items[0]).getByRole("img", {
      name: "Cover of In Rainbows",
    });
    expect(cover).toHaveAttribute("src", IN_RAINBOWS.coverUrl);
    expect(cover).not.toHaveAttribute("style");
    expect(cover.children).toHaveLength(0);
    expect(cover.parentElement).toBe(items[0]);

    expect(
      within(items[1]).getByRole("img", { name: "No cover" }),
    ).toBeInTheDocument();
  });

  it("says so when the collection is empty", async () => {
    backEnd({ get_collection: () => [] });
    render(<Library name="Will" onSignedOut={() => {}} />);

    expect(
      await screen.findByText(
        "Your collection is empty. Search for an album to add it.",
      ),
    ).toBeInTheDocument();
  });

  it("searches ten at a time, with cover, title, artist and year", async () => {
    const calls = backEnd({
      get_collection: () => [],
      search_albums: (args) => {
        const { offset } = args as { offset: number };
        return page(offset, offset === 10);
      },
    });
    render(<Library name="Will" onSignedOut={() => {}} />);
    await screen.findByText(/collection is empty/);

    searchFor("  album  ");

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
      get_collection: () => [],
      search_albums: (args) => {
        const { offset } = args as { offset: number };
        if (offset === 0) return page(0);
        // Spotify's ranking shifted: album 9 comes back on the next page.
        const next = page(10, true);
        next.results[0] = { album: album(9), inCollection: false };
        return next;
      },
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    searchFor("album");
    await waitFor(() => expect(results()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "More" }));

    await waitFor(() => expect(results()).toHaveLength(12));
    expect(
      results().filter((r) => r.textContent?.includes("Album 9")),
    ).toHaveLength(1);
  });

  it("marks the albums already in your collection", async () => {
    backEnd({
      get_collection: () => [],
      search_albums: () => page(0),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    searchFor("album");

    await waitFor(() => expect(results()).toHaveLength(10));
    const [owned, other] = results();
    expect(owned).toHaveTextContent("In your collection");
    expect(within(owned).queryByRole("button")).not.toBeInTheDocument();
    expect(
      within(other).getByRole("button", { name: "Add Album 1 by Artist 1" }),
    ).toBeInTheDocument();
  });

  it("adds an album to the grid", async () => {
    let finish: (album: AlbumCard) => void = () => {};
    const calls = backEnd({
      get_collection: () => [album(50)],
      search_albums: () => ({
        results: [{ album: IN_RAINBOWS, inCollection: false }],
        nextOffset: null,
      }),
      add_album: () => new Promise<AlbumCard>((resolve) => (finish = resolve)),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);
    await screen.findByRole("list", { name: "Your collection" });

    searchFor("in rainbows");
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
      args: { id: IN_RAINBOWS.id },
    });

    finish(IN_RAINBOWS);

    await waitFor(() =>
      expect(within(grid()).getAllByRole("listitem")).toHaveLength(2),
    );
    // The newest is first.
    expect(within(grid()).getAllByRole("listitem")[0]).toHaveTextContent(
      "In Rainbows",
    );
    expect(results()[0]).toHaveTextContent("In your collection");
  });

  it("shows a failed search", async () => {
    backEnd({
      get_collection: () => [],
      get_session: () => ({ state: "signedIn", name: "Will" }),
      search_albums: () => {
        throw "couldn't reach Spotify";
      },
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    searchFor("album");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't reach Spotify",
    );
  });

  it("goes back to sign-in when the sign-in has expired", async () => {
    const message =
      "Your Spotify sign-in has expired. Sign in again to carry on.";
    const onSignedOut = vi.fn();
    backEnd({
      get_collection: () => [],
      get_session: () => ({ state: "signedOut", message: null }),
      search_albums: () => {
        throw message;
      },
    });
    render(<Library name="Will" onSignedOut={onSignedOut} />);

    searchFor("album");

    await waitFor(() =>
      expect(onSignedOut).toHaveBeenCalledWith({ state: "signedOut", message }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
