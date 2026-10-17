// The Develop menu's Artwork report: where every album's cover came from and
// how big it is, with totals by source. It's how the artwork experiment is
// measured (RFC-001, "High-res artwork, as an experiment").
//
// Development builds only. Library renders this behind import.meta.env.DEV,
// so Vite leaves it out of a release build, as Rust leaves out its command.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent, useState } from "react";
import type { AlbumId } from "./api";

/** The event the Develop menu's item sends (app/src-tauri/src/commands/dev.rs). */
export const ARTWORK_REPORT = "artwork-report";

/** `ArtworkReport` in app/src-tauri/src/commands/dev.rs. */
export type Report = {
  /** The collection, the most recently added first. */
  albums: {
    /** The album's Deadwax ID. */
    id: AlbumId;
    title: string;
    artist: string;
    /** "iTunes", "Deezer", "MusicBrainz", "Spotify" or "Not looked up yet". */
    source: string;
    url: string | null;
    /** In pixels. Null when it couldn't be read, or there's no cover. */
    width: number | null;
    height: number | null;
  }[];
  /** Albums per source, in the order they're tried. */
  totals: { source: string; albums: number }[];
};

const artworkReport = () => invoke<Report>("artwork_report");

type Props = {
  onFailed: (error: unknown) => void;
};

function size({ url, width, height }: Report["albums"][number]): string {
  if (url === null) return "No cover";
  if (width === null || height === null) return "Unknown size";
  return `${width} × ${height}`;
}

function ArtworkReport({ onFailed }: Props) {
  const [report, setReport] = useState<Report | null>(null);

  async function load() {
    try {
      setReport(await artworkReport());
    } catch (e) {
      onFailed(e);
    }
  }
  const loadEvent = useEffectEvent(() => void load());

  useEffect(() => {
    const unlisten = listen(ARTWORK_REPORT, () => loadEvent());
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  if (report === null) return null;
  return (
    <section className="notice artwork-report" aria-label="Artwork report">
      <h2>Artwork report</h2>
      <ul aria-label="Totals by source">
        {report.totals.map((total) => (
          <li key={total.source}>
            {total.source}: {total.albums}
          </li>
        ))}
      </ul>
      <table>
        <thead>
          <tr>
            <th scope="col">Album</th>
            <th scope="col">Artist</th>
            <th scope="col">Source</th>
            <th scope="col">Size</th>
          </tr>
        </thead>
        <tbody>
          {report.albums.map((album) => (
            <tr key={album.id}>
              <td>{album.title}</td>
              <td>{album.artist}</td>
              <td>{album.source}</td>
              <td>{size(album)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => void load()}>
        Refresh
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => setReport(null)}
      >
        Close
      </button>
    </section>
  );
}

export default ArtworkReport;
