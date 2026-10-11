import { useEffect, useState, type CSSProperties } from "react";
import { css, paletteFor, ratio, type Palette } from "./palette";
import { cleanTitle, cover, type Album } from "./types";

// A contact sheet of every album's printed colours, with their contrast
// ratios, to check the derivation holds across the whole collection.
export function Colours({ albums }: { albums: Album[] }) {
  const [palettes, setPalettes] = useState<Map<string, Palette>>(new Map());

  useEffect(() => {
    let live = true;
    Promise.all(albums.map((a) => paletteFor(cover(a, "sm")).then((p) => [a.id, p] as const))).then(
      (all) => live && setPalettes(new Map(all)),
    );
    return () => {
      live = false;
    };
  }, [albums]);

  const rows = albums.filter((a) => palettes.has(a.id));
  const worst = (pick: (p: Palette) => number) => Math.min(...rows.map((a) => pick(palettes.get(a.id)!)));

  return (
    <div className="sheet">
      <header>
        <h1>Printed colours</h1>
        <p>
          Each album's paper, ink, secondary text and accent, derived from its cover. Targets: ink 7:1,
          secondary and accent 4.5:1.
          {rows.length > 0 && (
            <>
              {" "}
              Lowest across all {rows.length}: ink {worst((p) => ratio(p.ink, p.ground))}, secondary{" "}
              {worst((p) => ratio(p.muted, p.ground))}, accent {worst((p) => ratio(p.accent, p.ground))}.
            </>
          )}
        </p>
      </header>
      <div className="sheet-grid">
        {rows.map((a) => {
          const p = palettes.get(a.id)!;
          const style = {
            "--paper": css(p.ground),
            "--text": css(p.ink),
            "--muted": css(p.muted),
            "--hl": css(p.accent),
          } as CSSProperties;
          return (
            <figure key={a.id} className="sheet-card">
              <img src={cover(a, "sm")} alt="" />
              <div className="sheet-page" style={style}>
                <p className="sheet-kicker">{a.artist}</p>
                <p className="sheet-title">{cleanTitle(a.title)}</p>
                <p className="sheet-body">
                  Body text sits on the paper at reading size, with a <span>highlighted track</span> in the
                  middle of a sentence.
                </p>
                <p className="sheet-muted">Secondary · {a.year}</p>
                <p className="sheet-ratios">
                  ink {ratio(p.ink, p.ground)} · sec {ratio(p.muted, p.ground)} · accent {ratio(p.accent, p.ground)}
                </p>
              </div>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
