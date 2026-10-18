import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AlbumDetails, DeviceChoice, Devices, PlayOutcome } from "./api";
import Library from "./Library";
import { backEnd, card } from "./mockBackEnd";

// Played by its Deadwax ID, from a track's Spotify ID.
const IN_RAINBOWS: AlbumDetails = {
  id: "0b1c7e1e-6a0e-4c43-9f1e-2b8f6f1d9a01",
  spotifyId: "5vkqYmiPBYLaalcmjujWxK",
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
  coverUrl: null,
  tracks: [
    {
      spotifyId: "t1",
      disc: 1,
      number: 1,
      title: "15 Step",
      durationMs: 237_293,
    },
    {
      spotifyId: "t3",
      disc: 1,
      number: 3,
      title: "Nude",
      durationMs: 255_386,
    },
    // A local file: Spotify gives it no ID, so it can't be played.
    { spotifyId: "", disc: 1, number: 4, title: "Demo", durationMs: 60_000 },
  ],
};

/** In Rainbows in the crate. */
const IN_RAINBOWS_CARD = card(0, {
  id: IN_RAINBOWS.id,
  title: "In Rainbows",
  artist: "Radiohead",
  year: 2007,
});

const device = (name: string, more: Partial<DeviceChoice> = {}) => ({
  name,
  kind: "Speaker",
  isActive: false,
  canPlay: true,
  ...more,
});

const LIVING_ROOM = device("Living Room");
const MACBOOK = device("Will's MacBook Pro", {
  kind: "Computer",
  isActive: true,
});
const KITCHEN = device("Kitchen", { canPlay: false });

/** The back end for In Rainbows' sleeve, with `devices` listed. */
function albumPage(
  devices: Devices,
  replies: Record<string, (args?: unknown) => unknown> = {},
) {
  return backEnd({
    get_collection: () => [IN_RAINBOWS_CARD],
    dev_list_missing: () => 0,
    get_album: () => IN_RAINBOWS,
    refresh_album: () => null,
    get_playback: () => null,
    get_session: () => ({ state: "signedIn", name: "Will" }),
    get_devices: () => devices,
    choose_device: () => null,
    play_album: (): PlayOutcome => ({
      state: "playing",
      devices: devices.devices,
    }),
    ...replies,
  });
}

/** Pulls In Rainbows out of the crate, and turns it over to its tracklist. */
async function openInRainbows() {
  render(<Library name="Will" onSignedOut={() => {}} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Pull out In Rainbows by Radiohead",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));
  await screen.findByRole("button", { name: "Play 15 Step" });
}

const picker = () => screen.findByRole("combobox", { name: "Device" });
const options = (select: HTMLElement) =>
  [...(select as HTMLSelectElement).options].map((option) => ({
    label: option.textContent,
    disabled: option.disabled,
  }));
const MISSING =
  "Living Room isn't showing up. Open Spotify on it, or play something there, then try again";

describe("The device picker", () => {
  it("lists what Spotify reports and selects the remembered device", async () => {
    albumPage({
      devices: [MACBOOK, LIVING_ROOM, KITCHEN],
      remembered: "Living Room",
    });
    await openInRainbows();

    const select = await picker();
    expect(options(select)).toEqual([
      { label: "Will's MacBook Pro", disabled: false },
      { label: "Living Room", disabled: false },
      // Listed, but Spotify won't take commands for it.
      { label: "Kitchen (can't be controlled)", disabled: true },
    ]);
    expect(select).toHaveValue("Living Room");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("selects the device that's playing when none is remembered", async () => {
    albumPage({ devices: [LIVING_ROOM, MACBOOK], remembered: null });
    await openInRainbows();

    await waitFor(async () =>
      expect(await picker()).toHaveValue("Will's MacBook Pro"),
    );
  });

  it("remembers the device you choose", async () => {
    const calls = albumPage({
      devices: [MACBOOK, LIVING_ROOM],
      remembered: "Will's MacBook Pro",
    });
    await openInRainbows();

    fireEvent.change(await picker(), { target: { value: "Living Room" } });

    expect(await picker()).toHaveValue("Living Room");
    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "choose_device",
        args: { name: "Living Room" },
      }),
    );
  });

  it("says what to do when the remembered device isn't showing up", async () => {
    albumPage({ devices: [MACBOOK], remembered: "Living Room" });
    await openInRainbows();

    expect(await screen.findByRole("status")).toHaveTextContent(MISSING);
    // It stays chosen, for when it wakes up. It's a note, not an error.
    const select = await picker();
    expect(select).toHaveValue("Living Room");
    expect(options(select)[0]).toEqual({
      label: "Living Room (not showing up)",
      disabled: false,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("finds the device again when you refresh", async () => {
    let devices = [MACBOOK];
    const calls = albumPage(
      { devices: [], remembered: null },
      {
        get_devices: () => ({ devices, remembered: "Living Room" }),
      },
    );
    await openInRainbows();
    expect(await screen.findByRole("status")).toHaveTextContent(MISSING);

    devices = [MACBOOK, LIVING_ROOM];
    fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));

    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
    expect(calls.filter((c) => c.cmd === "get_devices")).toHaveLength(2);
  });

  it("says so when Spotify isn't showing any devices", async () => {
    albumPage({ devices: [], remembered: null });
    await openInRainbows();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Spotify isn't showing any devices.",
    );
    expect(screen.getByRole("button", { name: "Play 15 Step" })).toBeDisabled();
  });

  it("shows a failure to list the devices, and lets you try again", async () => {
    let fail = true;
    albumPage(
      { devices: [], remembered: null },
      {
        get_devices: () => {
          if (fail)
            throw "Spotify replied 503 Service Unavailable to the list of devices";
          return { devices: [LIVING_ROOM], remembered: "Living Room" };
        },
      },
    );
    await openInRainbows();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "503 Service Unavailable to the list of devices",
    );
    expect(screen.queryByText("Looking for devices…")).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));

    expect(await picker()).toHaveValue("Living Room");
    expect(screen.getByRole("button", { name: "Play 15 Step" })).toBeEnabled();
  });
});

describe("Playing", () => {
  it("plays the album on the chosen device from its first track", async () => {
    const calls = albumPage({
      devices: [MACBOOK, LIVING_ROOM],
      remembered: "Living Room",
    });
    await openInRainbows();
    await waitFor(async () =>
      expect(await picker()).toHaveValue("Living Room"),
    );
    const polls = () => calls.filter((c) => c.cmd === "get_playback").length;
    const before = polls();

    fireEvent.click(screen.getByRole("button", { name: "Play 15 Step" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "play_album",
        args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "t1" },
      }),
    );
    // The playback bar asks what's playing straight away.
    await waitFor(() => expect(polls()).toBeGreaterThan(before));
  });

  it("plays the album from a clicked track", async () => {
    const calls = albumPage({
      devices: [LIVING_ROOM],
      remembered: "Living Room",
    });
    await openInRainbows();
    await waitFor(async () =>
      expect(await picker()).toHaveValue("Living Room"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "play_album",
        args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "t3" },
      }),
    );
    // A track without an ID isn't a button.
    expect(
      screen.queryByRole("button", { name: "Play Demo" }),
    ).not.toBeInTheDocument();
  });

  it("says what to do when the device has gone by the time you pick a track", async () => {
    albumPage(
      { devices: [MACBOOK, LIVING_ROOM], remembered: "Living Room" },
      {
        play_album: (): PlayOutcome => ({
          state: "deviceMissing",
          devices: [MACBOOK],
        }),
      },
    );
    await openInRainbows();
    await waitFor(async () =>
      expect(await picker()).toHaveValue("Living Room"),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Play 15 Step" }));

    expect(await screen.findByRole("status")).toHaveTextContent(MISSING);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failure from Spotify", async () => {
    albumPage(
      { devices: [LIVING_ROOM], remembered: "Living Room" },
      {
        play_album: () => {
          throw "Spotify replied 403 Forbidden to playing the album: Player command failed: Premium required";
        },
      },
    );
    await openInRainbows();
    await waitFor(async () =>
      expect(await picker()).toHaveValue("Living Room"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Play 15 Step" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Premium required",
    );
    expect(screen.getByRole("button", { name: "Play 15 Step" })).toBeEnabled();
  });
});
