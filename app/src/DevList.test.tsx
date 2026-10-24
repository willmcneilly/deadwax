import { emit } from "@tauri-apps/api/event";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AlbumCard } from "./api";
import {
  RESET_COLLECTION,
  RESTORE_FROM_DEV_LIST,
  type RestoreReport,
} from "./DevList";
import Library from "./Library";
import { backEnd, card, NOTHING_PLAYING } from "./mockBackEnd";

const album = (n: number): AlbumCard => card(n, { id: `album${n}` });

/** A back end whose collection is `albums`, until a restore or reset changes it. */
function devBackEnd(
  start: AlbumCard[],
  {
    missing = 0,
    report = { restored: 0, failed: [] } as RestoreReport,
    restored = [] as AlbumCard[],
  } = {},
) {
  let albums = start;
  return backEnd({
    get_collection: () => albums,
    dev_list_missing: () => (albums.length === 0 ? missing : 0),
    restore_from_dev_list: () => {
      albums = [...albums, ...restored];
      return report;
    },
    reset_collection: () => {
      albums = [];
      return null;
    },
    ...NOTHING_PLAYING,
  });
}

// The first render of the crate can take more than findBy's second while
// scripts/check runs everything else alongside.
const offer = () =>
  screen.findByRole("region", { name: "Dev list" }, { timeout: 5000 });
const commands = (calls: { cmd: string }[]) => calls.map((c) => c.cmd);
const crate = () => screen.findByRole("region", { name: "Your crate" });
/** The records drawn in the crate, by their buttons: dividers aside. */
const records = async () =>
  within(await crate()).queryAllByRole("button", {
    name: /^(Pull out|Flip to) Album /,
  });

describe("The dev list", () => {
  it("offers to restore an empty collection, and restores it", async () => {
    const calls = devBackEnd([], {
      missing: 2,
      report: { restored: 2, failed: [] },
      restored: [album(1), album(2)],
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    expect(await offer()).toHaveTextContent(
      "Your dev list has 2 albums that aren't in this collection. Restore them?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    expect(
      await screen.findByText("Restored 2 albums from the dev list."),
    ).toBeInTheDocument();
    expect(await records()).toHaveLength(2);
    expect(commands(calls)).toContain("restore_from_dev_list");
  });

  it("says it's restoring while it waits", async () => {
    backEnd({
      get_collection: () => [],
      dev_list_missing: () => 1,
      restore_from_dev_list: () => new Promise(() => {}),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await offer()).toHaveTextContent("Restoring from the dev list…");
  });

  it("restores once, however often it's asked while restoring", async () => {
    const calls = backEnd({
      get_collection: () => [],
      dev_list_missing: () => 1,
      restore_from_dev_list: () => new Promise(() => {}),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await offer()).toHaveTextContent("Restoring from the dev list…");
    await emit(RESTORE_FROM_DEV_LIST);
    await emit(RESTORE_FROM_DEV_LIST);

    expect(
      commands(calls).filter((c) => c === "restore_from_dev_list"),
    ).toHaveLength(1);
  });

  it("doesn't offer when the dev list has nothing to restore", async () => {
    const calls = devBackEnd([], { missing: 0 });
    render(<Library name="Will" onSignedOut={() => {}} />);

    expect(
      await screen.findByText("Your crate is empty. Find the first record for it."),
    ).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(commands(calls)).toContain("dev_list_missing"),
    );
    expect(
      screen.queryByRole("region", { name: "Dev list" }),
    ).not.toBeInTheDocument();
  });

  it("doesn't ask about the dev list when the collection has albums", async () => {
    const calls = devBackEnd([album(1)], { missing: 3 });
    render(<Library name="Will" onSignedOut={() => {}} />);

    await vi.waitFor(async () => expect(await records()).not.toHaveLength(0));
    expect(commands(calls)).not.toContain("dev_list_missing");
    expect(
      screen.queryByRole("region", { name: "Dev list" }),
    ).not.toBeInTheDocument();
  });

  it("can be put off", async () => {
    devBackEnd([], { missing: 1 });
    render(<Library name="Will" onSignedOut={() => {}} />);

    expect(await offer()).toHaveTextContent(
      "Your dev list has 1 album that isn't in this collection. Restore it?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(
      screen.queryByRole("region", { name: "Dev list" }),
    ).not.toBeInTheDocument();
  });

  it("lists the albums Spotify couldn't give back", async () => {
    devBackEnd([], {
      missing: 2,
      report: {
        restored: 1,
        failed: [{ spotifyId: "gone", message: "Spotify said 404" }],
      },
      restored: [album(1)],
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't restore 1 album:",
    );
    expect(screen.getByText("gone: Spotify said 404")).toBeInTheDocument();
    expect(
      screen.getByText("Restored 1 album from the dev list."),
    ).toBeInTheDocument();
  });

  it("goes back to sign-in if the sign-in expired while restoring", async () => {
    const message =
      "Your Spotify sign-in has expired. Sign in again to carry on.";
    backEnd({
      get_collection: () => [],
      dev_list_missing: () => 1,
      restore_from_dev_list: () => {
        throw message;
      },
      get_session: () => ({ state: "signedOut", message: null }),
    });
    const onSignedOut = vi.fn();
    render(<Library name="Will" onSignedOut={onSignedOut} />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await vi.waitFor(() =>
      expect(onSignedOut).toHaveBeenCalledWith({ state: "signedOut", message }),
    );
  });

  it("shows a dev list it can't read", async () => {
    backEnd({
      get_collection: () => [],
      dev_list_missing: () => {
        throw "Couldn't read the dev list: unreadable";
      },
      get_session: () => ({ state: "signedIn", name: "Will" }),
    });
    render(<Library name="Will" onSignedOut={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't read the dev list: unreadable",
    );
  });

  describe("the Develop menu", () => {
    it("resets the collection, then offers to restore it", async () => {
      const calls = devBackEnd([album(1), album(2)], { missing: 2 });
      render(<Library name="Will" onSignedOut={() => {}} />);
      await vi.waitFor(async () => expect(await records()).not.toHaveLength(0));

      await emit(RESET_COLLECTION);

      expect(await offer()).toHaveTextContent("Your dev list has 2 albums");
      expect(screen.getByText("Your crate is empty. Find the first record for it.")).toBeInTheDocument();
      // Only a collection that's empty when it first loads opens on search.
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
      expect(commands(calls)).toContain("reset_collection");
    });

    it("restores from the dev list, even into a collection with albums", async () => {
      const calls = devBackEnd([album(1)], {
        report: { restored: 1, failed: [] },
        restored: [album(2)],
      });
      render(<Library name="Will" onSignedOut={() => {}} />);
      await vi.waitFor(async () => expect(await records()).not.toHaveLength(0));

      await emit(RESTORE_FROM_DEV_LIST);

      expect(
        await screen.findByText("Restored 1 album from the dev list."),
      ).toBeInTheDocument();
      await vi.waitFor(async () =>
        expect(await records()).toHaveLength(2),
      );
      expect(commands(calls)).toContain("restore_from_dev_list");
    });
  });
});
