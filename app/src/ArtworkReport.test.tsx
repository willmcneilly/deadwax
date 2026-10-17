import { emit } from "@tauri-apps/api/event";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ARTWORK_REPORT, type Report } from "./ArtworkReport";
import Library from "./Library";
import { backEnd, EMPTY_COLLECTION } from "./mockBackEnd";

const REPORT: Report = {
  albums: [
    {
      id: "a",
      title: "In Rainbows",
      artist: "Radiohead",
      source: "iTunes",
      url: "https://is1-ssl.mzstatic.com/a/10000x10000bb.jpg",
      width: 4000,
      height: 4000,
      steps: [
        { step: "Lookup", status: "Done", error: null },
        { step: "Sizes", status: "Done", error: null },
      ],
    },
    {
      id: "b",
      title: "Kid A",
      artist: "Radiohead",
      source: "Deezer",
      url: "https://cdn-images.dzcdn.net/b/1000x1000.jpg",
      width: null,
      height: null,
      steps: [
        { step: "Lookup", status: "Done", error: null },
        {
          step: "Sizes",
          status: "Failed",
          error: "Deezer replied 404 Not Found",
        },
      ],
    },
    {
      id: "c",
      title: "Amnesiac",
      artist: "Radiohead",
      source: "Spotify",
      url: null,
      width: null,
      height: null,
      steps: [
        { step: "Lookup", status: "Done", error: null },
        { step: "Sizes", status: "Done", error: null },
      ],
    },
    {
      id: "d",
      title: "OK Computer",
      artist: "Radiohead",
      source: "Not looked up yet",
      url: null,
      width: null,
      height: null,
      steps: [
        { step: "Lookup", status: "Queued", error: null },
        { step: "Sizes", status: "Queued", error: null },
      ],
    },
  ],
  totals: [
    { source: "iTunes", albums: 1 },
    { source: "Deezer", albums: 1 },
    { source: "MusicBrainz", albums: 0 },
    { source: "Spotify", albums: 1 },
    { source: "Not looked up yet", albums: 1 },
  ],
};

function open() {
  let report = REPORT;
  const calls = backEnd({
    ...EMPTY_COLLECTION,
    artwork_report: () => report,
  });
  render(<Library name="Will" onSignedOut={() => {}} />);
  return {
    calls,
    change: (next: Report) => (report = next),
  };
}

const report = () => screen.findByRole("region", { name: "Artwork report" });

describe("The Artwork report", () => {
  it("isn't shown until the Develop menu asks for it", async () => {
    const { calls } = open();
    await screen.findByText(/Your collection is empty/);

    expect(
      screen.queryByRole("region", { name: "Artwork report" }),
    ).not.toBeInTheDocument();
    expect(calls.map((c) => c.cmd)).not.toContain("artwork_report");
  });

  it("lists every album with its cover source, size and steps, and totals by source", async () => {
    open();
    await screen.findByText(/Your collection is empty/);

    await emit(ARTWORK_REPORT);

    const shown = await report();
    const rows = within(shown)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      [
        "In Rainbows",
        "Radiohead",
        "iTunes",
        "4000 × 4000",
        "Lookup: Done · Sizes: Done",
      ],
      [
        "Kid A",
        "Radiohead",
        "Deezer",
        "Unknown size",
        "Lookup: Done · Sizes: Failed (Deezer replied 404 Not Found)",
      ],
      [
        "Amnesiac",
        "Radiohead",
        "Spotify",
        "No cover",
        "Lookup: Done · Sizes: Done",
      ],
      [
        "OK Computer",
        "Radiohead",
        "Not looked up yet",
        "No cover",
        "Lookup: Queued · Sizes: Queued",
      ],
    ]);
    const totals = within(
      within(shown).getByRole("list", { name: "Totals by source" }),
    )
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(totals).toEqual([
      "iTunes: 1",
      "Deezer: 1",
      "MusicBrainz: 0",
      "Spotify: 1",
      "Not looked up yet: 1",
    ]);
  });

  it("refreshes, and closes", async () => {
    const { change } = open();
    await screen.findByText(/Your collection is empty/);
    await emit(ARTWORK_REPORT);
    await report();

    change({ albums: [], totals: [{ source: "iTunes", albums: 7 }] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("iTunes: 7")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("region", { name: "Artwork report" }),
    ).not.toBeInTheDocument();
  });
});
