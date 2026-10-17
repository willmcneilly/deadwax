import { createRoot } from "react-dom/client";
import { Account } from "./Account";
import { Colours } from "./Colours";
import { loadFixture } from "./connect/fake";
import { Dev } from "./Dev";
import { restoreDividers } from "./dividers";
import { installTextures } from "./grain";
import { restoreTypeface } from "./typeface";
import type { Album } from "./types";
import "./styles.css";
import "./gatefold.css";
import "./connect.css";

installTextures();
restoreTypeface();
restoreDividers();

const root = createRoot(document.getElementById("root")!);

loadFixture()
  .then(async () => {
    if (new URLSearchParams(location.search).has("colours")) {
      const albums: Album[] = await fetch("/data/albums.json").then((r) => r.json());
      root.render(<Colours albums={albums} />);
      return;
    }
    root.render(
      <>
        <Account />
        <Dev />
      </>,
    );
  })
  .catch(() =>
    root.render(<p className="missing">No fixture yet. Run <code>npm run fixture</code>.</p>),
  );
