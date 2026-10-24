import { emit } from "@tauri-apps/api/event";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Library from "./Library";
import { backEnd, EMPTY_COLLECTION } from "./mockBackEnd";
import {
  IMPORT_PROTOTYPE_NOTES,
  NOTES_REPORT,
  type NotesImport,
  type Report,
} from "./NotesReport";

const IMPORTED: NotesImport = {
  imported: [
    { id: "a", title: "Pink Moon", artist: "Nick Drake" },
    { id: "b", title: "In Rainbows", artist: "Radiohead" },
  ],
  unmatched: [{ file: "blue.json", albumTitle: "Blue", artist: "Joni Mitchell" }],
  invalid: [{ file: "broken.json", message: "It isn't valid liner notes: missing field `headline`" }],
};

const REPORT: Report = {
  folder: "/checkout/.dev-data/notes",
  files: [
    { file: "a.json", id: "a", title: "Pink Moon", artist: "Nick Drake", problem: null },
    {
      file: "b.json",
      id: "b",
      title: "In Rainbows",
      artist: "Radiohead",
      problem: "It isn't valid liner notes: expected value at line 1 column 1",
    },
    {
      file: "gone.json",
      id: null,
      title: null,
      artist: null,
      problem: "No album in the collection has this ID.",
    },
  ],
};

function open(replies: Record<string, () => unknown> = {}) {
  const calls = backEnd({
    ...EMPTY_COLLECTION,
    import_prototype_notes: () => IMPORTED,
    notes_report: () => REPORT,
    ...replies,
  });
  render(<Library name="Will" onSignedOut={() => {}} />);
  return calls;
}

describe("The Develop menu's liner notes", () => {
  it("does nothing until the Develop menu asks", async () => {
    const calls = open();
    await screen.findByText("Your crate is empty.");

    expect(calls.map((c) => c.cmd)).not.toContain("import_prototype_notes");
    expect(calls.map((c) => c.cmd)).not.toContain("notes_report");
    expect(screen.queryByRole("region", { name: "Liner notes report" })).not.toBeInTheDocument();
  });

  it("imports the prototype's notes, and says which matched an album and which didn't", async () => {
    const calls = open();
    await screen.findByText("Your crate is empty.");

    await emit(IMPORT_PROTOTYPE_NOTES);

    const result = await screen.findByRole("region", { name: "Import prototype notes" });
    expect(calls.map((c) => c.cmd)).toContain("import_prototype_notes");
    expect(result).toHaveTextContent(
      "Imported 2 essays: Pink Moon by Nick Drake, In Rainbows by Radiohead.",
    );
    expect(within(result).getByRole("list", { name: "Not matched" })).toHaveTextContent(
      "Blue by Joni Mitchell (blue.json)",
    );
    expect(within(result).getByRole("list", { name: "Not valid" })).toHaveTextContent(
      "broken.json: It isn't valid liner notes: missing field `headline`",
    );

    fireEvent.click(within(result).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Import prototype notes" })).not.toBeInTheDocument();
  });

  it("shows what went wrong when importing fails", async () => {
    open({
      import_prototype_notes: () => {
        throw "There are no notes to import in /checkout/prototypes/crate/public/notes.";
      },
      get_session: () => ({ state: "signedIn", name: "Will" }),
    });
    await screen.findByText("Your crate is empty.");

    await emit(IMPORT_PROTOTYPE_NOTES);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There are no notes to import in /checkout/prototypes/crate/public/notes.",
    );
    expect(screen.queryByRole("region", { name: "Import prototype notes" })).not.toBeInTheDocument();
  });

  it("reports every notes file, with what's wrong with an invalid one", async () => {
    open();
    await screen.findByText("Your crate is empty.");

    await emit(NOTES_REPORT);

    const report = await screen.findByRole("region", { name: "Liner notes report" });
    expect(report).toHaveTextContent("/checkout/.dev-data/notes");
    const rows = within(report).getAllByRole("row").slice(1);
    expect(rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["a.json", "Pink Moon", "Nick Drake", "None: the gatefold shows it"],
      [
        "b.json",
        "In Rainbows",
        "Radiohead",
        "It isn't valid liner notes: expected value at line 1 column 1",
      ],
      ["gone.json", "–", "–", "No album in the collection has this ID."],
    ]);
  });

  it("says when no album has notes yet", async () => {
    open({ notes_report: () => ({ folder: "/notes", files: [] }) });
    await screen.findByText("Your crate is empty.");

    await emit(NOTES_REPORT);

    expect(await screen.findByRole("region", { name: "Liner notes report" })).toHaveTextContent(
      "No albums have liner notes yet. Develop › Import prototype notes adds some.",
    );
  });
});
