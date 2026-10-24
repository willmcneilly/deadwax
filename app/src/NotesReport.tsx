// The Develop menu's liner notes items (RFC-002, "5. Liner notes in the
// app"): Import prototype notes, which copies PR #9's five essays into the
// notes folder for the albums in the collection they're about, and the Liner
// notes report, which lists every notes file and says what's wrong with any
// the gatefold won't show. A file that isn't valid notes is reported here,
// and the sleeve simply has no Liner notes.
//
// Development builds only. Library renders this behind import.meta.env.DEV,
// so Vite leaves it out of a release build, as Rust leaves out its commands.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent, useState } from "react";
import type { AlbumId } from "./api";

/** The events the Develop menu's items send (app/src-tauri/src/commands/dev.rs). */
export const IMPORT_PROTOTYPE_NOTES = "import-prototype-notes";
export const NOTES_REPORT = "notes-report";

/** `NotesImport` in app/src-tauri/src/commands/dev.rs. */
export type NotesImport = {
  /** The essays now in the notes folder, each with the album it's for. */
  imported: { id: AlbumId; title: string; artist: string }[];
  /** Essays about albums that aren't in the collection. */
  unmatched: { file: string; albumTitle: string; artist: string }[];
  /** Files in the prototype's folder that aren't valid notes. */
  invalid: { file: string; message: string }[];
};

/** `NotesReport` in app/src-tauri/src/commands/dev.rs. */
export type Report = {
  /** Where the notes folder is. */
  folder: string;
  files: {
    file: string;
    /** The album it's for, when one in the collection has its ID. */
    id: AlbumId | null;
    title: string | null;
    artist: string | null;
    /** Why the gatefold won't show it. Null when it will. */
    problem: string | null;
  }[];
};

const importPrototypeNotes = () => invoke<NotesImport>("import_prototype_notes");
const notesReport = () => invoke<Report>("notes_report");

type Props = {
  onFailed: (error: unknown) => void;
};

type Shown =
  | { kind: "none" }
  | { kind: "importing" }
  | { kind: "imported"; result: NotesImport }
  | { kind: "report"; report: Report };

const essays = (n: number) => (n === 1 ? "1 essay" : `${n} essays`);

function NotesReport({ onFailed }: Props) {
  const [shown, setShown] = useState<Shown>({ kind: "none" });

  async function load() {
    try {
      setShown({ kind: "report", report: await notesReport() });
    } catch (e) {
      onFailed(e);
    }
  }

  async function importNotes() {
    setShown({ kind: "importing" });
    try {
      setShown({ kind: "imported", result: await importPrototypeNotes() });
    } catch (e) {
      setShown({ kind: "none" });
      onFailed(e);
    }
  }

  const loadEvent = useEffectEvent(() => void load());
  const importEvent = useEffectEvent(() => void importNotes());

  useEffect(() => {
    const unlistenReport = listen(NOTES_REPORT, () => loadEvent());
    const unlistenImport = listen(IMPORT_PROTOTYPE_NOTES, () => importEvent());
    return () => {
      void unlistenReport.then((stop) => stop());
      void unlistenImport.then((stop) => stop());
    };
  }, []);

  const close = (
    <button type="button" className="secondary" onClick={() => setShown({ kind: "none" })}>
      Close
    </button>
  );

  switch (shown.kind) {
    case "none":
      return null;
    case "importing":
      return (
        <section className="notice" aria-label="Import prototype notes" aria-busy="true">
          <p>Importing the prototype's notes…</p>
        </section>
      );
    case "imported": {
      const { imported, unmatched, invalid } = shown.result;
      return (
        <section className="notice notes-report" aria-label="Import prototype notes">
          <h2>Import prototype notes</h2>
          <p>
            Imported {essays(imported.length)}
            {imported.length > 0 &&
              `: ${imported.map((i) => `${i.title} by ${i.artist}`).join(", ")}`}
            .
          </p>
          {unmatched.length > 0 && (
            <>
              <p>No album in the crate for {essays(unmatched.length)}:</p>
              <ul aria-label="Not matched">
                {unmatched.map((u) => (
                  <li key={u.file}>
                    {u.albumTitle} by {u.artist} ({u.file})
                  </li>
                ))}
              </ul>
            </>
          )}
          {invalid.length > 0 && (
            <>
              <p>Not valid liner notes:</p>
              <ul aria-label="Not valid">
                {invalid.map((i) => (
                  <li key={i.file}>
                    {i.file}: {i.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {close}
        </section>
      );
    }
    case "report": {
      const { folder, files } = shown.report;
      return (
        <section className="notice notes-report" aria-label="Liner notes report">
          <h2>Liner notes report</h2>
          <p>{folder}</p>
          {files.length === 0 ? (
            <p>No albums have liner notes yet. Develop › Import prototype notes adds some.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Album</th>
                  <th scope="col">Artist</th>
                  <th scope="col">Problem</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.file}>
                    <td>{f.file}</td>
                    <td>{f.title ?? "–"}</td>
                    <td>{f.artist ?? "–"}</td>
                    <td>{f.problem ?? "None: the gatefold shows it"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
          {close}
        </section>
      );
    }
  }
}

export default NotesReport;
