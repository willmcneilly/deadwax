// The glow behind a playing record (RFC-002, "4. The UI"): a few soft pools
// of the album's key colours drifting over the room behind the glow. It
// warms to a third while the needle drops, comes up fully once Spotify says
// it's playing, and settles lower, still, while paused. A stranger's record,
// or one whose palette isn't worked out yet, has theme.css's plain one.
//
// DWX-20 measured the five drifting gradients at 60 fps with no frames
// dropped, and pre-drawn images no cheaper (DESIGN.md, "Verdicts"). The
// drift and the fades are transforms and opacity only (rule 7).

import AlbumColours from "./AlbumColours";
import type { Palette } from "./api";
import "./Glow.css";

export type GlowLevel = "off" | "warming" | "on" | "paused";

const POOLS = [0, 1, 2, 3, 4];

function Glow({ palette, level }: { palette: Palette | null; level: GlowLevel }) {
  return (
    <AlbumColours palette={palette} className={`glow ${level}`}>
      {POOLS.map((i) => (
        <div key={i} className={`glow-pool p${i}`} />
      ))}
      <div className="glow-vignette" />
    </AlbumColours>
  );
}

export default Glow;
