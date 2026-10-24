import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  AlbumDetails,
  DeviceChoice,
  Devices,
  NowPlaying,
  PlayOutcome,
  TransferOutcome,
} from "./api";
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

/** Nude, from In Rainbows, on `on`: 61 seconds in, playing or paused. */
const nude = (on: string, isPlaying = true): NowPlaying => ({
  isPlaying,
  device: on,
  progressMs: 61_000,
  track: {
    spotifyId: "t3",
    disc: 1,
    number: 3,
    title: "Nude",
    artist: "Radiohead",
    album: "In Rainbows",
    albumId: IN_RAINBOWS.id,
    spotifyAlbumId: IN_RAINBOWS.spotifyId,
    durationMs: 255_386,
    coverUrl: null,
  },
});

/**
 * The back end for In Rainbows, with `devices` listed and `remembered` the
 * device Play goes to.
 */
function crate(
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
    get_remembered_device: () => devices.remembered,
    get_devices: () => devices,
    choose_device: () => null,
    play_album: (): PlayOutcome => ({
      state: "playing",
      devices: devices.devices,
    }),
    transfer_playback: (): TransferOutcome => ({
      state: "moved",
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

const list = () => screen.findByRole("dialog", { name: "Devices" });
const noList = () => expect(screen.queryByRole("dialog", { name: "Devices" })).toBeNull();
/** Each device in the list, and what it says beside it. */
const listed = async () =>
  within(await list())
    .getAllByRole("listitem")
    .map((item) => {
      const button = within(item).getByRole("button");
      return {
        text: button.textContent,
        disabled: (button as HTMLButtonElement).disabled,
      };
    });
const plays = (calls: { cmd: string }[]) => calls.filter((c) => c.cmd === "play_album");
const MISSING =
  "Living Room isn't showing up. Open Spotify on it, or play something there, then try again";

describe("Playing on the remembered device", () => {
  it("goes straight to the remembered device, without asking", async () => {
    const calls = crate({
      devices: [MACBOOK, LIVING_ROOM],
      remembered: "Living Room",
    });
    await openInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "play_album",
        args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "t3" },
      }),
    );
    noList();
    // It never asked Spotify for its devices: play_album does that.
    expect(calls.map((c) => c.cmd)).not.toContain("get_devices");
    // A track without an ID isn't a button.
    expect(screen.queryByRole("button", { name: "Play Demo" })).not.toBeInTheDocument();
  });

  it("asks once where it should play, the first time", async () => {
    const calls = crate({
      devices: [MACBOOK, LIVING_ROOM, KITCHEN],
      remembered: null,
    });
    await openInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));

    const sheet = await list();
    expect(within(sheet).getByText("Where should it play?")).toBeInTheDocument();
    expect(within(sheet).getByRole("status")).toHaveTextContent(
      "Deadwax remembers it for next time.",
    );
    await waitFor(async () =>
      expect(await listed()).toEqual([
        { text: "Will's MacBook Proplaying", disabled: false },
        { text: "Living RoomSpeaker", disabled: false },
        // Listed, but Spotify won't take commands for it.
        { text: "Kitchencan't be controlled", disabled: true },
      ]),
    );
    expect(plays(calls)).toHaveLength(0);

    fireEvent.click(within(sheet).getByRole("button", { name: /Living Room/ }));

    noList();
    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "play_album",
        args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "t3" },
      }),
    );
  });

  it("doesn't ask again once a device is chosen", async () => {
    let now: NowPlaying | null = null;
    const calls = crate(
      { devices: [LIVING_ROOM], remembered: null },
      {
        get_playback: () => now,
        play_album: (args): PlayOutcome => {
          now = nude((args as { device: string }).device);
          return { state: "playing", devices: [LIVING_ROOM] };
        },
      },
    );
    await openInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));
    fireEvent.click(within(await list()).getByRole("button", { name: /Living Room/ }));
    // Spotify confirms it, and the record floats front up.
    await screen.findByRole("region", { name: "Now playing" });
    await waitFor(() =>
      expect(document.querySelector(".sleeve-out")).not.toHaveClass("starting"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Turn In Rainbows over" }));
    fireEvent.click(await screen.findByRole("button", { name: "Play 15 Step" }));

    await waitFor(() => expect(plays(calls)).toHaveLength(2));
    expect(plays(calls)[1]).toEqual({
      cmd: "play_album",
      args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "t1" },
    });
    noList();
  });

  it("says so when Spotify isn't showing any devices", async () => {
    crate({ devices: [], remembered: null });
    await openInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "Play 15 Step" }));

    expect(await within(await list()).findByRole("status")).toHaveTextContent(
      "Spotify isn't showing any devices. Open Spotify on a speaker, your TV or this Mac, then try again.",
    );
  });

  it("shows a failure from Spotify", async () => {
    crate(
      { devices: [LIVING_ROOM], remembered: "Living Room" },
      {
        play_album: () => {
          throw "Spotify replied 403 Forbidden to playing the album: Player command failed: Premium required";
        },
      },
    );
    await openInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "Play 15 Step" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Premium required");
    expect(screen.getByRole("button", { name: "Play 15 Step" })).toBeEnabled();
    noList();
  });
});

describe("A missing device", () => {
  it("shows the sentence in the device list, and picking another plays there", async () => {
    const calls = crate(
      { devices: [MACBOOK], remembered: "Living Room" },
      {
        play_album: (args): PlayOutcome =>
          (args as { device: string }).device === "Living Room"
            ? { state: "deviceMissing", devices: [MACBOOK] }
            : { state: "playing", devices: [MACBOOK] },
      },
    );
    await openInRainbows();

    fireEvent.click(screen.getByRole("button", { name: "Play Nude" }));

    const sheet = await list();
    expect(within(sheet).getByText("Play somewhere else?")).toBeInTheDocument();
    expect(await within(sheet).findByRole("status")).toHaveTextContent(MISSING);
    // It's a note, not an error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: /Will's MacBook Pro/ }));

    await waitFor(() =>
      expect(plays(calls)).toEqual([
        {
          cmd: "play_album",
          args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "t3" },
        },
        {
          cmd: "play_album",
          args: { id: IN_RAINBOWS.id, device: "Will's MacBook Pro", trackId: "t3" },
        },
      ]),
    );
    noList();
  });

  it("finds the device again when you look again", async () => {
    let devices = [MACBOOK];
    const calls = crate(
      { devices: [], remembered: "Living Room" },
      {
        get_devices: () => ({ devices, remembered: "Living Room" }),
        play_album: (): PlayOutcome => ({ state: "deviceMissing", devices }),
      },
    );
    await openInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Play 15 Step" }));
    const sheet = await list();
    expect(await within(sheet).findByRole("status")).toHaveTextContent(MISSING);

    devices = [MACBOOK, LIVING_ROOM];
    // The note can show while the first look is still going ("Looking…"), so wait for the button.
    fireEvent.click(await within(sheet).findByRole("button", { name: "Look again" }));

    await waitFor(() => expect(within(sheet).queryByRole("status")).toBeNull());
    expect(within(sheet).getByRole("button", { name: /Living Room/ })).toBeEnabled();
    expect(calls.filter((c) => c.cmd === "get_devices")).toHaveLength(2);
  });

  it("shows a failure to list the devices, and lets you look again", async () => {
    let fail = true;
    crate(
      { devices: [], remembered: null },
      {
        get_devices: () => {
          if (fail) throw "Spotify replied 503 Service Unavailable to the list of devices";
          return { devices: [LIVING_ROOM], remembered: null };
        },
      },
    );
    await openInRainbows();
    fireEvent.click(screen.getByRole("button", { name: "Play 15 Step" }));
    const sheet = await list();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "503 Service Unavailable to the list of devices",
    );
    expect(within(sheet).queryByText("Looking for devices…")).toBeNull();
    // A failed list isn't an empty one.
    expect(within(sheet).queryByText(/isn't showing any devices/)).toBeNull();

    fail = false;
    fireEvent.click(within(sheet).getByRole("button", { name: "Look again" }));

    expect(await within(sheet).findByRole("button", { name: /Living Room/ })).toBeEnabled();
  });
});

describe("Changing device", () => {
  /**
   * Nude plays on the Living Room, or is paused there, and the crate shows
   * its chip.
   */
  function playing(
    more: Record<string, (args?: unknown) => unknown> = {},
    isPlaying = true,
  ) {
    let now: NowPlaying | null = nude("Living Room", isPlaying);
    const calls = crate(
      { devices: [MACBOOK, LIVING_ROOM, KITCHEN], remembered: "Living Room" },
      {
        get_playback: () => now,
        transfer_playback: (args): TransferOutcome => {
          now = nude((args as { device: string }).device, isPlaying);
          return { state: "moved", devices: [MACBOOK, LIVING_ROOM] };
        },
        ...more,
      },
    );
    render(<Library name="Will" onSignedOut={() => {}} />);
    return calls;
  }
  const chip = () => screen.findByRole("region", { name: "Playing" });

  it("opens the same device list from the playing chip", async () => {
    playing();

    fireEvent.click(within(await chip()).getByRole("button", { name: "Living Room" }));

    const sheet = await list();
    expect(within(sheet).getByText("Play on")).toBeInTheDocument();
    await waitFor(async () => expect(await listed()).toHaveLength(3));
  });

  it('opens it from the "on Living Room" line under the floating record', async () => {
    playing();
    fireEvent.click(
      within(await chip()).getByRole("button", { name: "Bring out In Rainbows" }),
    );
    const line = await screen.findByRole("region", { name: "Now playing" }, { timeout: 3000 });

    fireEvent.click(within(line).getByRole("button", { name: "on Living Room" }));

    expect(within(await list()).getByText("Play on")).toBeInTheDocument();
  });

  it("opens it with D, and D or Escape puts it away", async () => {
    playing();
    await chip();

    fireEvent.keyDown(window, { key: "d" });
    expect(within(await list()).getByText("Play on")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(noList);

    fireEvent.keyDown(window, { key: "d" });
    await list();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(noList);
  });

  it("moves what's playing to the device you choose, from the same place", async () => {
    const calls = playing();
    fireEvent.click(within(await chip()).getByRole("button", { name: "Living Room" }));

    fireEvent.click(
      await within(await list()).findByRole("button", { name: /Will's MacBook Pro/ }),
    );

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "transfer_playback",
        args: { device: "Will's MacBook Pro", play: true },
      }),
    );
    noList();
    // Moved, not played again from the start of the track.
    expect(plays(calls)).toHaveLength(0);
    // The chip says where it is now, once Spotify does.
    expect(
      await within(await chip()).findByRole("button", { name: "Will's MacBook Pro" }),
    ).toBeInTheDocument();
  });

  it("keeps a paused record paused when it moves", async () => {
    const calls = playing({}, false);
    fireEvent.click(within(await chip()).getByRole("button", { name: "Living Room" }));

    fireEvent.click(
      await within(await list()).findByRole("button", { name: /Will's MacBook Pro/ }),
    );

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "transfer_playback",
        args: { device: "Will's MacBook Pro", play: false },
      }),
    );
  });

  it("says so if the device has gone by the time it moves", async () => {
    let asked = 0;
    const calls = playing({
      transfer_playback: (): TransferOutcome => ({ state: "deviceMissing", devices: [LIVING_ROOM] }),
      // The MacBook goes to sleep after the first list.
      get_devices: () => ({
        devices: asked++ === 0 ? [MACBOOK, LIVING_ROOM] : [LIVING_ROOM],
        remembered: "Living Room",
      }),
    });
    await chip();
    fireEvent.keyDown(window, { key: "d" });
    fireEvent.click(
      await within(await list()).findByRole("button", { name: /Will's MacBook Pro/ }),
    );

    const sheet = await list();
    expect(await within(sheet).findByRole("status")).toHaveTextContent(
      "Will's MacBook Pro isn't showing up. Open Spotify on it, or play something there, then try again",
    );
    expect(within(sheet).getByText("Play somewhere else?")).toBeInTheDocument();
    expect(calls.filter((c) => c.cmd === "transfer_playback")).toHaveLength(1);

    // It didn't move, so Play still goes to the Living Room.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(noList);
    fireEvent.click(
      within(await chip()).getByRole("button", { name: "Bring out In Rainbows" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Turn In Rainbows over" }, { timeout: 3000 }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Play 15 Step" }));
    await waitFor(() =>
      expect(plays(calls)).toEqual([
        {
          cmd: "play_album",
          args: { id: IN_RAINBOWS.id, device: "Living Room", trackId: "t1" },
        },
      ]),
    );
  });

  it("only closes the list when you choose the device it's already on", async () => {
    const calls = playing();
    fireEvent.click(within(await chip()).getByRole("button", { name: "Living Room" }));

    fireEvent.click(await within(await list()).findByRole("button", { name: /Living Room/ }));

    await waitFor(noList);
    expect(calls.map((c) => c.cmd)).not.toContain("transfer_playback");
  });

  it("only remembers the device when nothing is playing", async () => {
    const calls = crate({ devices: [MACBOOK, LIVING_ROOM], remembered: "Living Room" });
    render(<Library name="Will" onSignedOut={() => {}} />);
    await screen.findByRole("button", { name: "Pull out In Rainbows by Radiohead" });

    fireEvent.keyDown(window, { key: "d" });
    fireEvent.click(
      await within(await list()).findByRole("button", { name: /Will's MacBook Pro/ }),
    );

    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: "choose_device",
        args: { name: "Will's MacBook Pro" },
      }),
    );
    expect(calls.map((c) => c.cmd)).not.toContain("transfer_playback");
  });
});
