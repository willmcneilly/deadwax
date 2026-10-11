import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Colours } from "./Colours";
import { installTextures } from "./grain";
import { restoreTypeface } from "./typeface";
import type { Album } from "./types";
import "./styles.css";
import "./gatefold.css";

installTextures();
restoreTypeface();

const root = createRoot(document.getElementById("root")!);

// `?many` repeats the collection to about 400 records, to feel how the crate
// copes with a big collection.
function stretch(albums: Album[]): Album[] {
  if (!new URLSearchParams(location.search).has("many")) return albums;
  const out: Album[] = [];
  for (let copy = 0; out.length < 400; copy++) {
    for (const a of albums) out.push({ ...a, key: `${a.id}~${copy}` });
  }
  return out;
}

fetch("/data/albums.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((albums: Album[]) =>
    root.render(
      new URLSearchParams(location.search).has("colours") ? (
        <Colours albums={albums} />
      ) : (
        <App albums={stretch(albums)} />
      ),
    ),
  )
  .catch(() =>
    root.render(<p className="missing">No fixture yet. Run <code>npm run fixture</code>.</p>),
  );
