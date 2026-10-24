import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notes, NowPlaying } from "./api";
import { COLLECTION, IN_RAINBOWS, IN_RAINBOWS_DETAILS, PINK_MOON } from "./crateFixtures";
import Library from "./Library";
import { backEnd } from "./mockBackEnd";
import { plainTitle } from "./notes";

/** In Rainbows' liner notes, as Rust sends them: two sections, mentioning two tracks. */
const NOTES: Notes = {
  albumTitle: "In Rainbows",
  artist: "Radiohead",
  headline: "Pay What You *Want*",
  standfirst: "In October 2007 Radiohead let anyone name their price.",
  sections: [
    {
      heading: "The release",
      paragraphs: [
        "The record opens with [[15 Step]], a skittering beat in 5/4.",
        "*In Rainbows* came out on 10 October.",
      ],
      pullQuote: { text: "Anyone could name their price.", attribution: null },
    },
    {
      heading: "The songs",
      paragraphs: ["Later comes [[Reckoner]], and the record ends with [[Videotape]]."],
    },
  ],
  quotes: [{ text: "It was a gamble.", who: "Thom Yorke", sourceIndex: 0 }],
  facts: [
    { figure: "10", label: "tracks" },
    { figure: "2007", label: "released *online*" },
  ],
  credits: [{ role: "Producer", names: ["Nigel Godrich"] }],
  sources: [{ title: "The interview", publisher: "Wired", url: "https://example.com", year: 2007 }],
};

/** Spotify playing 15 Step from In Rainbows, the first track. */
const PLAYING_15_STEP: NowPlaying = {
  isPlaying: true,
  device: "Living Room",
  progressMs: 1_000,
  track: {
    spotifyId: "track-1",
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
};

function gatefoldBackEnd({
  notesFor = IN_RAINBOWS.id,
  playing = null,
}: { notesFor?: string | null; playing?: NowPlaying | null } = {}) {
  return backEnd({
    get_collection: () => COLLECTION,
    dev_list_missing: () => 0,
    get_album: () => IN_RAINBOWS_DETAILS,
    refresh_album: () => null,
    get_notes: (args) => ((args as { id: string }).id === notesFor ? NOTES : null),
    get_playback: () => playing,
    get_remembered_device: () => "Living Room",
    get_devices: () => ({ devices: [], remembered: "Living Room" }),
  });
}

/** Opens the crate and pulls out In Rainbows, the record in front. */
async function pullOutInRainbows() {
  render(<Library name="Will" onSignedOut={() => {}} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" }),
  );
}

const linerNotes = () => screen.findByRole("button", { name: "Liner notes" });
const gatefold = () => screen.getByRole("dialog", { name: "Liner notes for In Rainbows" });
const print = () => gatefold().querySelector(".gf-print") as HTMLElement;
const styles = () => within(gatefold()).getByRole("navigation", { name: "Type style" });

async function openNotes() {
  fireEvent.click(await linerNotes());
  return screen.findByRole("dialog", { name: "Liner notes for In Rainbows" });
}

describe("The gatefold", () => {
  afterEach(() => localStorage.clear());

  it("shows Liner notes on the sleeve of an album with notes, and opens them", async () => {
    const calls = gatefoldBackEnd();
    await pullOutInRainbows();

    await openNotes();

    expect(calls).toContainEqual({ cmd: "get_notes", args: { id: IN_RAINBOWS.id } });
    // The title page, then the essay, its credits and its sources.
    expect(within(gatefold()).getAllByRole("heading", { level: 1 })[0]).toHaveTextContent(
      "Pay What You Want",
    );
    expect(
      within(gatefold()).getByText("In October 2007 Radiohead let anyone name their price."),
    ).toBeInTheDocument();
    expect(within(gatefold()).getAllByText("The release").length).toBeGreaterThan(0);
    expect(within(gatefold()).getAllByText("Nigel Godrich").length).toBeGreaterThan(0);
    expect(
      within(gatefold()).getAllByText("Wired, “The interview” (2007)").length,
    ).toBeGreaterThan(0);
    // The sleeve it came out of is out of sight while it's open, and the
    // button fades rather than going.
    expect(document.querySelector(".sleeve-out")).toHaveClass("away");
    expect(document.querySelector(".notes-open")).toHaveClass("away");
    expect(document.querySelector(".notes-open")).toHaveAttribute("aria-hidden", "true");
  });

  it("has no Liner notes on the sleeve of an album without notes", async () => {
    // Pink Moon has notes; In Rainbows, the record pulled out, has none.
    const calls = gatefoldBackEnd({ notesFor: PINK_MOON.id });
    await pullOutInRainbows();

    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: "get_notes", args: { id: IN_RAINBOWS.id } }),
    );
    await screen.findByRole("button", { name: "Turn In Rainbows over" });
    expect(screen.queryByRole("button", { name: "Liner notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no Liner notes on the next record out when only the last one had notes", async () => {
    const calls = gatefoldBackEnd();
    await pullOutInRainbows();
    expect(await linerNotes()).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Flip to Kind of Blue by Miles Davis" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Pull out Kind of Blue by Miles Davis" }),
    );

    await screen.findByRole("button", { name: "Turn Kind of Blue over" });
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: "get_notes", args: { id: "deadwax-2" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".notes-open")).toBeNull();
  });

  it("has no Liner notes when Rust can't give the album's notes", async () => {
    backEnd({
      get_collection: () => COLLECTION,
      dev_list_missing: () => 0,
      get_album: () => IN_RAINBOWS_DETAILS,
      refresh_album: () => null,
      get_notes: () => {
        throw new Error("The notes folder can't be read.");
      },
      get_playback: () => null,
      get_remembered_device: () => "Living Room",
    });
    await pullOutInRainbows();

    await screen.findByRole("button", { name: "Turn In Rainbows over" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Liner notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("folds back up with Escape, and the sleeve shows again", async () => {
    gatefoldBackEnd();
    await pullOutInRainbows();
    await openNotes();

    fireEvent.keyDown(window, { key: "Escape" });

    // It folds up first: the sleeve stays out, and doesn't go back into the crate.
    expect(gatefold()).toHaveClass("closing");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(document.querySelector(".sleeve-out")).not.toHaveClass("away");
    expect(screen.getByRole("button", { name: "Turn In Rainbows over" })).toBeInTheDocument();
    expect(await linerNotes()).toBeInTheDocument();
  });

  it("comes out of the sleeve's front, and goes back into it", async () => {
    // Where things are: jsdom lays nothing out. The sleeve's front is up and
    // to the left of the closed gatefold, and smaller.
    const at = (left: number, top: number, size: number) =>
      ({ left, top, width: size, height: size, right: left + size, bottom: top + size }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".sleeve-side.front")) return at(100, 50, 400);
      if (this.matches(".gf-strip")) return at(300, 200, 500);
      return at(0, 0, 0);
    });
    const animate = vi.spyOn(Element.prototype, "animate");
    const flights = () =>
      animate.mock.contexts.flatMap((el, i) =>
        (el as Element).classList.contains("gf-stage") ? [animate.mock.calls[i][0]] : [],
      );
    gatefoldBackEnd();
    await pullOutInRainbows();
    await openNotes();

    // The centres are 250px and 200px apart, and the sleeve is 0.8 of its size.
    const over = "translate(-250px, -200px) scale(0.8)";
    expect(flights()).toEqual([[{ transform: over }, { transform: "none" }]]);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(flights()[1]).toEqual([{ transform: "none" }, { transform: over }]);
    vi.restoreAllMocks();
  });

  it("closes with Close", async () => {
    gatefoldBackEnd();
    await pullOutInRainbows();
    await openNotes();

    fireEvent.click(within(gatefold()).getByRole("button", { name: "Close" }));

    expect(gatefold()).toHaveClass("closing");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it("turns a sleeve showing its back to its front before it opens", async () => {
    gatefoldBackEnd();
    await pullOutInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));
    await screen.findByRole("button", { name: "Play 15 Step" });
    const flipper = () => document.querySelector(".sleeve-flipper") as HTMLElement;
    expect(flipper()).toHaveStyle({ transform: "rotateY(180deg)" });

    fireEvent.click(await linerNotes());

    expect(flipper()).toHaveStyle({ transform: "rotateY(360deg)" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("has the five type styles, opens on Album × Archive, and remembers the one you pick", async () => {
    gatefoldBackEnd();
    await pullOutInRainbows();
    await openNotes();

    const buttons = within(styles()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Liner notes",
      "Magazine",
      "Archive",
      "Album colours",
      "Album × Archive",
    ]);
    expect(within(styles()).getByRole("button", { name: "Album × Archive" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Archive's layout, printed in the album's colours (from AlbumColours).
    expect(print()).toHaveClass("style-archive", "in-album-colours");
    expect(print().style.getPropertyValue("--album-ground")).toBe("#f4ecdc");

    for (const [label, classes] of [
      ["Liner notes", ["style-liner"]],
      ["Magazine", ["style-magazine"]],
      ["Archive", ["style-archive"]],
      ["Album colours", ["style-album"]],
    ] as const) {
      fireEvent.click(within(styles()).getByRole("button", { name: label }));
      expect(print()).toHaveClass(...classes);
      expect(print()).not.toHaveClass("in-album-colours");
      expect(within(styles()).getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }

    fireEvent.click(within(styles()).getByRole("button", { name: "Magazine" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    await openNotes();

    expect(print()).toHaveClass("style-magazine");
  });

  it("sets the record in Serif or Grotesk, and remembers which", async () => {
    gatefoldBackEnd();
    await pullOutInRainbows();
    await openNotes();
    const type = () => within(gatefold()).getByRole("navigation", { name: "Type" });

    expect(within(type()).getByRole("button", { name: "Serif" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(gatefold()).not.toHaveClass("type-grotesk");

    fireEvent.click(within(type()).getByRole("button", { name: "Grotesk" }));

    expect(gatefold()).toHaveClass("type-grotesk");
    expect(localStorage.getItem("gatefold-type")).toBe("grotesk");
  });

  it("marks where the essay mentions the playing track, and says what's playing", async () => {
    gatefoldBackEnd({ playing: PLAYING_15_STEP });
    await pullOutInRainbows();
    await openNotes();

    await waitFor(() =>
      expect(gatefold().querySelectorAll(".gf-stage .gf-track-playing").length).toBeGreaterThan(0),
    );
    const marked = [...gatefold().querySelectorAll(".gf-stage .gf-track-playing")];
    expect(new Set(marked.map((m) => m.textContent))).toEqual(new Set(["15 Step"]));
    // The other tracks it mentions are found, but not marked.
    const mentioned = [...gatefold().querySelectorAll(".gf-stage .gf-track")].map(
      (m) => (m as HTMLElement).dataset.track,
    );
    expect(new Set(mentioned)).toEqual(new Set(["track-1", "track-7", "track-10"]));
    expect(within(gatefold()).getByRole("button", { name: /Now playing 15 Step/ })).toBeInTheDocument();
  });

  it("marks nothing when the record out isn't what's playing", async () => {
    gatefoldBackEnd({
      playing: { ...PLAYING_15_STEP, track: { ...PLAYING_15_STEP.track!, albumId: PINK_MOON.id } },
    });
    await pullOutInRainbows();
    await openNotes();

    expect(gatefold().querySelector(".gf-track-playing")).toBeNull();
    expect(within(gatefold()).queryByRole("button", { name: /Now playing/ })).not.toBeInTheDocument();
  });
});

describe("Finding the tracks the notes mention", () => {
  it("leaves out a store's additions to the title, and ignores case", () => {
    expect(plainTitle("Reckoner")).toBe("reckoner");
    expect(plainTitle("Pink Moon - 2009 Remaster")).toBe("pink moon");
    expect(plainTitle("Northern Sky (Remastered)")).toBe("northern sky");
    expect(plainTitle("River [Mono Version]")).toBe("river");
    expect(plainTitle("Weird Fishes/Arpeggi")).toBe("weird fishes/arpeggi");
    expect(plainTitle("Roygbiv (Live)")).toBe("roygbiv (live)");
  });
});
