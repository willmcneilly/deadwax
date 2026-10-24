import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it, vi } from "vitest";
import { ALBUM_UPDATED, type AlbumCard } from "./api";
import {
  A_LOVE_SUPREME,
  COLLECTION,
  IN_RAINBOWS,
  KIND_OF_BLUE,
  PINK_MOON,
} from "./crateFixtures";
import Library from "./Library";
import { backEnd, card, fromDisk, NOTHING_PLAYING } from "./mockBackEnd";

function crateOf(albums: () => AlbumCard[]) {
  return backEnd({
    get_collection: albums,
    dev_list_missing: () => 0,
    ...NOTHING_PLAYING,
  });
}

const crate = () => screen.getByRole("region", { name: "Your crate" });
/** What's in front: a record to pull out, or a divider and its count. */
const front = () =>
  crate().querySelector("[data-front]")?.getAttribute("aria-label");
/** Every record and divider drawn, front to back, past ones first. */
const drawn = () =>
  [...crate().querySelectorAll(".crate-slot")].map((slot) =>
    slot.getAttribute("aria-label"),
  );
const slot = (name: string) =>
  within(crate()).getByRole("button", { name: new RegExp(`${name} by`) });

async function openCrate(albums: AlbumCard[] = COLLECTION) {
  crateOf(() => albums);
  render(<Library name="Will" />);
  await waitFor(() => expect(front()).toBeDefined());
}

describe("The crate", () => {
  it("sorts by genre, with a divider in front of each that counts its records, and Unsorted at the back", async () => {
    await openCrate();

    expect(front()).toBe("Pull out In Rainbows by Radiohead");
    expect(drawn()).toEqual([
      "Flip to Alternative",
      "Pull out In Rainbows by Radiohead",
      "Flip to Jazz",
      "Flip to A Love Supreme by John Coltrane",
      "Flip to Kind of Blue by Miles Davis",
      "Flip to Unsorted",
      "Flip to Pink Moon by Nick Drake",
    ]);
    const jazz = within(crate()).getByRole("button", { name: "Flip to Jazz" });
    expect(jazz).toHaveTextContent("Jazz");
    expect(jazz).toHaveTextContent("2 records");
    expect(
      within(crate()).getByRole("button", { name: "Flip to Unsorted" }),
    ).toHaveTextContent("1 record");
  });

  it("sorts by artist or by decade, keeping the record in front", async () => {
    await openCrate();
    const sort = screen.getByRole("navigation", { name: "Sort the crate" });

    fireEvent.click(within(sort).getByRole("button", { name: "Decade" }));
    expect(within(sort).getByRole("button", { name: "Decade" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(front()).toBe("Pull out In Rainbows by Radiohead");
    // The newest is at the back, with the three before it drawn.
    expect(drawn()).toEqual([
      "Flip to 1970s",
      "Flip to Pink Moon by Nick Drake",
      "Flip to 2000s",
      "Pull out In Rainbows by Radiohead",
    ]);
    for (let i = 0; i < 4; i++) fireEvent.keyDown(window, { key: "[" });
    expect(front()).toBe("1950s, 1 record");

    fireEvent.click(within(sort).getByRole("button", { name: "Artist A–Z" }));
    // A divider in front gives way to the first record.
    expect(front()).toBe("Pull out A Love Supreme by John Coltrane");
    expect(drawn()).toEqual([
      "Flip to J",
      "Pull out A Love Supreme by John Coltrane",
      "Flip to M",
      "Flip to Kind of Blue by Miles Davis",
      "Flip to N",
      "Flip to Pink Moon by Nick Drake",
      "Flip to R",
      "Flip to In Rainbows by Radiohead",
    ]);
  });

  it("flips one record for each notch of the scroll wheel, and with the arrow keys", async () => {
    await openCrate();

    fireEvent.wheel(crate(), { deltaY: 100, deltaMode: 0 });
    expect(front()).toBe("Jazz, 2 records");
    fireEvent.wheel(crate(), { deltaY: 100, deltaMode: 0 });
    expect(front()).toBe("Pull out A Love Supreme by John Coltrane");
    // A trackpad's small deltas add up to one record.
    fireEvent.wheel(crate(), { deltaY: 20, deltaMode: 0 });
    expect(front()).toBe("Pull out A Love Supreme by John Coltrane");
    fireEvent.wheel(crate(), { deltaY: 20, deltaMode: 0 });
    expect(front()).toBe("Pull out Kind of Blue by Miles Davis");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(front()).toBe("Pull out A Love Supreme by John Coltrane");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(front()).toBe("Unsorted, 1 record");
  });

  it("jumps between dividers with ] and [, and Shift on the scroll wheel", async () => {
    await openCrate();

    fireEvent.keyDown(window, { key: "]" });
    expect(front()).toBe("Jazz, 2 records");
    fireEvent.keyDown(window, { key: "]" });
    expect(front()).toBe("Unsorted, 1 record");
    fireEvent.keyDown(window, { key: "[" });
    expect(front()).toBe("Jazz, 2 records");

    fireEvent.wheel(crate(), { deltaY: 100, shiftKey: true });
    expect(front()).toBe("Unsorted, 1 record");
  });

  it("brings a record to the front when you click it, and steps past a divider in front", async () => {
    await openCrate();

    fireEvent.click(slot("Kind of Blue"));
    expect(front()).toBe("Pull out Kind of Blue by Miles Davis");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(front()).toBe("Jazz, 2 records");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(front()).toBe("Pull out A Love Supreme by John Coltrane");
  });

  it("draws only the records near the front: 3 flipped past and 6 behind", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      card(i + 10, { genre: "Jazz", artist: `Artist ${i + 10}` }),
    );
    await openCrate(many);
    // The Jazz divider and the 6 behind the first record.
    expect(drawn()).toHaveLength(8);

    for (let i = 0; i < 10; i++) fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(drawn()).toHaveLength(3 + 1 + 6);
    expect(front()).toBe("Pull out Album 20 by Artist 20");
  });

  it("draws the 640 for the front two records and the 320 behind them", async () => {
    await openCrate();
    const cover = (name: string) => slot(name).querySelector("img")?.getAttribute("src");
    // In Rainbows in front, the Jazz divider next, then A Love Supreme third.
    expect(cover("In Rainbows")).toBe(fromDisk(IN_RAINBOWS.id).medium);
    expect(cover("A Love Supreme")).toBe(fromDisk(A_LOVE_SUPREME.id).small);

    fireEvent.click(slot("A Love Supreme"));

    expect(cover("A Love Supreme")).toBe(fromDisk(A_LOVE_SUPREME.id).medium);
    expect(cover("Kind of Blue")).toBe(fromDisk(KIND_OF_BLUE.id).medium);
    expect(cover("Pink Moon")).toBe(fromDisk(PINK_MOON.id).small);
  });

  it("shows wear on artwork from other sources, but never on Spotify's covers", async () => {
    await openCrate();

    const worn = (name: string) => slot(name).querySelector(".wear") !== null;
    expect(worn("In Rainbows")).toBe(true);
    expect(worn("Kind of Blue")).toBe(true);
    // Only Spotify had Pink Moon's cover: it's shown as it is.
    expect(worn("Pink Moon")).toBe(false);
    expect(slot("Pink Moon").querySelector(".sleeve-face")).not.toHaveAttribute("style");
  });

  it("changes a sleeve in place when Rust has its cover, and re-sorts it when its genre is found", async () => {
    let pinkMoon: AlbumCard = { ...PINK_MOON, covers: card(4).covers, worn: false };
    crateOf(() => [IN_RAINBOWS, KIND_OF_BLUE, pinkMoon]);
    render(<Library name="Will" />);
    await waitFor(() => expect(front()).toBeDefined());
    const img = slot("Pink Moon").querySelector("img");
    expect(img).toHaveAttribute("src", "https://i.scdn.co/image/cover4");

    pinkMoon = { ...PINK_MOON, genre: "Folk", worn: true };
    await emit(ALBUM_UPDATED, PINK_MOON.id);

    await waitFor(() =>
      expect(drawn()).toContain("Flip to Folk"),
    );
    expect(drawn()).not.toContain("Flip to Unsorted");
    expect(slot("Pink Moon").querySelector(".wear")).not.toBeNull();
    expect(front()).toBe("Pull out In Rainbows by Radiohead");
  });

  it("decodes the 1600 of the record in front ahead, so pulling it out doesn't wait for the disk", async () => {
    const decoded: string[] = [];
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(function (
      this: HTMLImageElement,
    ) {
      decoded.push(this.src);
      return Promise.resolve();
    });
    await openCrate();

    await waitFor(() => expect(decoded).toContain(fromDisk(IN_RAINBOWS.id).large));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(decoded).toContain(fromDisk(A_LOVE_SUPREME.id).large),
    );
    vi.restoreAllMocks();
  });
});
