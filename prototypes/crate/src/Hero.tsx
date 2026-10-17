import { useEffect, useLayoutEffect, useRef } from "react";
import type { Palette } from "./palette";
import { SleeveBack, SleeveFront, StrangerFront } from "./Sleeve";
import type { Album } from "./types";

const EASE = "cubic-bezier(.2,.75,.15,1)";

// The record you've pulled out of the crate. It flies from the crate to the
// middle of the screen, turns over to show the tracklist, and turns back to
// hover while it plays.
//
// A stranger's record (playing, but not in the collection) comes up from
// below in a plain sleeve, with no tracklist to turn over to. The
// now-playing line offers to add it.
export function Hero({
  album,
  palette,
  turns,
  floating,
  current,
  fromRect,
  returning,
  onReturned,
  onPick,
  onTurn,
  stranger,
  starting,
  away = false,
}: {
  album: Album;
  palette: Palette;
  turns: number;
  floating: boolean;
  current: number | null;
  fromRect: DOMRect;
  returning: boolean;
  onReturned: () => void;
  onPick: (index: number) => void;
  onTurn: () => void;
  stranger: boolean;
  /** Play was pressed and the needle is on its way down. */
  starting: boolean;
  away?: boolean;
}) {
  const lift = useRef<HTMLDivElement>(null);
  const tilt = useRef<HTMLDivElement>(null);

  const toCrate = () => {
    const el = lift.current!;
    const r = el.getBoundingClientRect();
    const dx = fromRect.left + fromRect.width / 2 - (r.left + r.width / 2);
    const dy = fromRect.top + fromRect.height / 2 - (r.top + r.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${fromRect.width / r.width})`;
  };

  useLayoutEffect(() => {
    lift.current!.animate([{ transform: toCrate() }, { transform: "none" }], {
      duration: 760,
      easing: EASE,
    });
  }, []);

  useEffect(() => {
    if (!returning) return;
    const anim = lift.current!.animate([{ transform: "none" }, { transform: toCrate() }], {
      duration: 620,
      delay: 260,
      easing: "cubic-bezier(.5,0,.3,1)",
      fill: "forwards",
    });
    anim.onfinish = onReturned;
    return () => anim.cancel();
  }, [returning]);

  // Lean the record a few degrees toward the pointer while it floats.
  useEffect(() => {
    const el = tilt.current!;
    if (!floating) {
      el.style.transform = "";
      return;
    }
    const move = (e: PointerEvent) => {
      const x = e.clientX / innerWidth - 0.5;
      const y = e.clientY / innerHeight - 0.5;
      el.style.transform = `rotateY(${x * 9}deg) rotateX(${-y * 7}deg)`;
    };
    addEventListener("pointermove", move);
    return () => removeEventListener("pointermove", move);
  }, [floating]);

  const back = turns % 2 === 1;

  return (
    <div
      className={`hero ${floating ? "floating" : ""} ${returning ? "returning" : ""} ${away ? "away" : ""} ${starting ? "starting" : ""}`}
    >
      <div className="hero-lift" ref={lift}>
        <div className="hero-offset">
          <div className="hero-shadow" />
          <div className="hero-tilt" ref={tilt}>
            <div className="hero-float">
              <div
                className="flipper"
                style={{ transform: `rotateY(${turns * 180}deg)` }}
                onClick={() => !back && onTurn()}
              >
                <div className="face front" aria-hidden={back}>
                  {stranger ? <StrangerFront album={album} /> : <SleeveFront album={album} size="lg" />}
                </div>
                <div className="face back" aria-hidden={!back}>
                  <SleeveBack album={album} palette={palette} current={current} onPick={onPick} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
