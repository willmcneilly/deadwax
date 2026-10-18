import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../ArtworkReport";
import { backEnd } from "../mockBackEnd";
import CrateSpike from "./CrateSpike";

// jsdom has no canvas to draw the textures on.
vi.mock("./textures", async (original) => ({
  ...(await original<typeof import("./textures")>()),
  installTextures: async () => {},
  removeTextures: () => {},
}));

const row = (id: string, title: string): Report["albums"][number] => ({
  id,
  title,
  artist: "Radiohead",
  source: "iTunes",
  url: null,
  width: 1600,
  height: 1600,
  palette: null,
  genre: "Alternative",
  label: null,
  steps: [],
});

const REPORT: Report = {
  albums: [row("a", "Kid A"), row("b", "In Rainbows")],
  totals: [],
};

/** The cover drawn by the record in front of the crate. */
const front = (container: HTMLElement) =>
  container.querySelector("[data-front] img")?.getAttribute("src");

/**
 * Waits for the crate to be drawn, then for React's effects, so the scroll
 * wheel's listener knows how many records there are. On a busy machine (CI)
 * the first wheel could otherwise arrive before it did, and be ignored.
 */
async function opened(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector("[data-front]")).not.toBeNull());
  await act(async () => {});
}

beforeEach(() => {
  backEnd({
    artwork_report: () => REPORT,
    get_album: () => ({ tracks: [] }),
    crate_spike_keep_in_front: () => null,
  });
  // jsdom has no Web Animations or frames.
  Element.prototype.animate = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => setTimeout(() => f(0), 0));
});

describe("CrateSpike", () => {
  it("flips one record for each notch of a mouse's scroll wheel", async () => {
    const { container } = render(<CrateSpike run={null} onClose={() => {}} />);
    // The crate opens on the Alternative divider, which has no cover.
    await opened(container);
    expect(front(container)).toBeUndefined();

    fireEvent.wheel(window, { deltaY: 100, deltaMode: 0 });
    expect(front(container)).toContain("cover://localhost/a/640");

    fireEvent.wheel(window, { deltaY: 100, deltaMode: 0 });
    expect(front(container)).toContain("cover://localhost/b/640");

    fireEvent.wheel(window, { deltaY: -100, deltaMode: 0 });
    expect(front(container)).toContain("cover://localhost/a/640");
  });

  it("adds up a trackpad's small scrolls to one record", async () => {
    const { container } = render(<CrateSpike run={null} onClose={() => {}} />);
    await opened(container);

    fireEvent.wheel(window, { deltaY: 20, deltaMode: 0 });
    expect(front(container)).toBeUndefined();
    fireEvent.wheel(window, { deltaY: 20, deltaMode: 0 });
    expect(front(container)).toContain("cover://localhost/a/640");
  });

  it("flips with the arrow keys", async () => {
    const { container } = render(<CrateSpike run={null} onClose={() => {}} />);
    await opened(container);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(front(container)).toContain("cover://localhost/a/640");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(front(container)).toBeUndefined();
  });

  it("pulls the record in front out when it's clicked, and brings another to the front", async () => {
    const { container } = render(<CrateSpike run={null} onClose={() => {}} />);
    await opened(container);

    const slots = container.querySelectorAll(".spike-slot");
    fireEvent.click(slots[1]);
    expect(front(container)).toContain("cover://localhost/a/640");
    expect(container.querySelector(".spike-hero")).toBeNull();

    fireEvent.click(container.querySelector("[data-front]") as HTMLElement);
    const large = container.querySelector(".spike-hero img.large");
    expect(large?.getAttribute("src")).toBe("cover://localhost/a/1600");
  });
});
