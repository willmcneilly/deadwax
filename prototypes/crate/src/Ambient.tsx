import type { CSSProperties } from "react";
import { css, type Palette } from "./palette";

// The slowly evolving field behind a playing record: a few soft pools of the
// album's key colours drifting over a dark ground. The colours are registered
// CSS properties, so changing album crossfades rather than snaps.
export function Ambient({ palette, on }: { palette: Palette; on: boolean }) {
  const k = palette.key;
  const style = {
    "--deep": css(palette.deep),
    "--c0": css(k[0]),
    "--c1": css(k[1 % k.length]),
    "--c2": css(k[2 % k.length]),
    "--c3": css(k[3 % k.length]),
    "--c4": css(k[4 % k.length]),
  } as CSSProperties;
  return (
    <div className={`ambient ${on ? "on" : ""}`} style={style}>
      <div className="pool p0" />
      <div className="pool p1" />
      <div className="pool p2" />
      <div className="pool p3" />
      <div className="pool p4" />
      <div className="vignette" />
    </div>
  );
}
