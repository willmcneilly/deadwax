// A stranger's record (RFC-002, "4. The UI"): Spotify is playing an album
// that isn't in the collection, so it has no place in the crate to come out
// of. It rises from below in a plain paper sleeve, with Spotify's cover as it
// is and a plain glow, and has no tracklist to turn over to. Now playing's
// line under it offers Add to the crate.

import { useEffect, useLayoutEffect, useRef } from "react";
import { NowLine } from "./NowLine";
import type { Live } from "./playing";
import "./Sleeve.css";

/** Up from below the window, and back down. */
const RISE = { duration: 900, easing: "cubic-bezier(.2,.75,.15,1)" };
const SINK = { duration: 620, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" as const };
const BELOW = "translateY(75vh) scale(0.6)";

/** What a stranger's sleeve shows: the record as Spotify described it. */
export type StrangerRecord = {
  spotifyAlbumId: string | null;
  album: string | null;
  artist: string;
  title: string;
  coverUrl: string | null;
};

type Props = {
  record: StrangerRecord;
  /** What's playing, while it's this record. */
  live: Live | null;
  /** Going back down. */
  returning: boolean;
  /** It's gone. */
  onReturned: () => void;
  /** Adds it to the crate. Null when it can't be added (no album). */
  onAdd: (() => void) | null;
  adding: boolean;
  onFailed: (error: unknown) => void;
};

function Stranger({ record, live, returning, onReturned, onAdd, adding, onFailed }: Props) {
  const lift = useRef<HTMLDivElement>(null);
  const returned = useRef(onReturned);
  useEffect(() => {
    returned.current = onReturned;
  });

  useLayoutEffect(() => {
    lift.current?.animate([{ transform: BELOW, opacity: 0 }, { transform: "none", opacity: 1 }], RISE);
  }, []);

  useEffect(() => {
    if (!returning) return;
    const sink = lift.current?.animate(
      [{ transform: "none", opacity: 1 }, { transform: BELOW, opacity: 0 }],
      SINK,
    );
    if (!sink) {
      returned.current();
      return;
    }
    sink.onfinish = () => returned.current();
    return () => sink.cancel();
  }, [returning]);

  const name = record.album ?? record.title;

  return (
    <div className={`sleeve-out floating ${live?.starting ? "starting" : ""}`}>
      <div className="sleeve-lift" ref={lift}>
        <div className="sleeve-offset">
          <div className="sleeve-float">
            <div
              className="sleeve-face stranger"
              role="img"
              aria-label={`${name} by ${record.artist}, not in your crate`}
            >
              {record.coverUrl ? (
                <img src={record.coverUrl} alt="" draggable={false} decoding="async" />
              ) : (
                <span className="sleeve-blank">{name}</span>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="sleeve-desk">
        {live && (
          <NowLine
            live={live}
            tracks={null}
            onAdd={onAdd ?? undefined}
            adding={adding}
            onFailed={onFailed}
          />
        )}
      </div>
    </div>
  );
}

export default Stranger;
