// The Develop menu's Artwork report: where every album's cover came from, how
// big it is, its palette, genre and label, and where its steps in the album
// job queue stand, with totals by source (RFC-001, "High-res artwork, as an
// experiment", and RFC-002, "2. Local artwork, in sizes" and "3. Genre and
// label").
//
// Development builds only. Library renders this behind import.meta.env.DEV,
// so Vite leaves it out of a release build, as Rust leaves out its command.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useEffectEvent, useState } from "react";
import type { AlbumId, Palette } from "./api";

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
    /** Null until its palette step has run. */
    palette: Palette | null;
    /** Null when no source had one, or before they've been looked for. */
    genre: string | null;
    label: string | null;
    /** The album job queue's steps, in the order they run. */
    steps: {
      /** "Lookup", "Sizes", "Palette" or "Genre and label". */
      step: string;
      /** "Done", "Queued", "Failed" or "Not started". */
      status: string;
      /** Why it failed, for "Failed". */
      error: string | null;
    }[];
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

function steps(album: Report["albums"][number]): string {
  return album.steps
    .map(({ step, status, error }) =>
      error === null ? `${step}: ${status}` : `${step}: ${status} (${error})`,
    )
    .join(" · ");
}

const SWATCH = 16;

/**
 * The palette as a row of swatches: the sleeve's colours, then the glow's.
 * Album colours are data, not design tokens (RFC-002, "6. DESIGN.md starts
 * here"), so they're SVG fills here rather than CSS. This report is for
 * development only; the app's own sleeves will take them through
 * `AlbumColours` (DWX-21).
 */
function Swatches({ palette }: { palette: Palette | null }) {
  if (palette === null) return <>Not yet</>;
  const named: [string, string][] = [
    ["ground", palette.ground],
    ["rear", palette.rear],
    ["ink", palette.ink],
    ["muted", palette.muted],
    ["accent", palette.accent],
    ...palette.key.map((colour, i): [string, string] => [`key ${i + 1}`, colour]),
    ["deep", palette.deep],
  ];
  return (
    <svg
      role="img"
      aria-label={named.map(([name, colour]) => `${name} ${colour}`).join(", ")}
      width={named.length * SWATCH}
      height={SWATCH}
      viewBox={`0 0 ${named.length * SWATCH} ${SWATCH}`}
    >
      {named.map(([name, colour], i) => (
        <rect key={name} x={i * SWATCH} width={SWATCH} height={SWATCH} fill={colour} />
      ))}
    </svg>
  );
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
            <th scope="col">Colours</th>
            <th scope="col">Genre</th>
            <th scope="col">Label</th>
            <th scope="col">Steps</th>
          </tr>
        </thead>
        <tbody>
          {report.albums.map((album) => (
            <tr key={album.id}>
              <td>{album.title}</td>
              <td>{album.artist}</td>
              <td>{album.source}</td>
              <td>{size(album)}</td>
              <td>
                <Swatches palette={album.palette} />
              </td>
              <td>{album.genre ?? "–"}</td>
              <td>{album.label ?? "–"}</td>
              <td>{steps(album)}</td>
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
