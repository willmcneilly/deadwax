// Where the sound plays (RFC-002, "4. The UI"). The device stays out of
// sight while the remembered one works: Play goes straight there. This
// small list comes up only to choose the first one, to change it on purpose
// (the "on Kitchen" under the floating record, the device on the playing
// chip, or D), or when the device you pressed Play for isn't showing up.
// It's the prototype's device sheet (prototypes/crate/src/Devices.tsx).

import { useCallback, useEffect, useRef, useState } from "react";
import { getDevices, type Devices } from "./api";
import "./DeviceList.css";

/** Why the device list is up. */
export type DeviceAsk =
  /** The first play, with no device remembered. */
  | { kind: "first" }
  /** You asked to change device. */
  | { kind: "choose" }
  /** You pressed Play, and Spotify isn't listing this device. */
  | { kind: "missing"; device: string };

type Props = {
  ask: DeviceAsk;
  onChosen: (name: string) => void;
  onClose: () => void;
  onFailed: (error: unknown) => void;
};

/**
 * The devices Spotify lists now, to pick one. Spotify doesn't list devices
 * that are asleep, so a missing one gets a sentence saying what to do,
 * rather than an error (RFC-001, "Playing music").
 */
export default function DeviceList({ ask, onChosen, onClose, onFailed }: Props) {
  const [devices, setDevices] = useState<Devices | null>(null);
  const [looking, setLooking] = useState(true);
  const sheet = useRef<HTMLDivElement>(null);
  const failed = useRef(onFailed);
  const close = useRef(onClose);
  useEffect(() => {
    failed.current = onFailed;
    close.current = onClose;
  });

  const load = useCallback(() => {
    getDevices()
      .then(setDevices, (e: unknown) => failed.current(e))
      .finally(() => setLooking(false));
  }, []);

  useEffect(load, [load]);

  function look() {
    setLooking(true);
    load();
  }
  useEffect(() => sheet.current?.focus(), []);

  // Escape puts it away, and so does D, which brought it up. It's modal, so
  // the crate's own keys wait until it has gone.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" || e.key === "d" || e.key === "D") {
        e.preventDefault();
        close.current();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  const list = devices?.devices ?? [];
  const missing =
    ask.kind === "missing" && !list.some((d) => d.name === ask.device)
      ? ask.device
      : null;
  const heading =
    ask.kind === "first"
      ? "Where should it play?"
      : ask.kind === "missing"
        ? "Play somewhere else?"
        : "Play on";
  const note =
    devices && list.length === 0
      ? "Spotify isn't showing any devices. Open Spotify on a speaker, your TV or this Mac, then try again."
      : missing
        ? `${missing} isn't showing up. Open Spotify on it, or play something there, then try again`
        : ask.kind === "first"
          ? "Deadwax remembers it for next time."
          : null;

  return (
    <div className="device-scrim" onClick={onClose}>
      <div
        ref={sheet}
        className="device-list"
        role="dialog"
        aria-modal="true"
        aria-label="Devices"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="device-heading">{heading}</p>
        {note && (
          <p className="device-note" role="status">
            {note}
          </p>
        )}
        <ul className={looking ? "looking" : undefined}>
          {list.map((d, index) => (
            <li key={index}>
              <button
                type="button"
                disabled={!d.canPlay}
                onClick={() => onChosen(d.name)}
              >
                <span className="device-name">{d.name}</span>
                <span className="device-kind">
                  {!d.canPlay
                    ? "can't be controlled"
                    : d.isActive
                      ? "playing"
                      : d.name === devices?.remembered
                        ? "last used"
                        : d.kind}
                </span>
              </button>
            </li>
          ))}
          {!devices && looking && (
            <li className="device-looking">Looking for devices…</li>
          )}
        </ul>
        <div className="device-actions">
          <button type="button" onClick={look} disabled={looking}>
            {looking ? "Looking…" : "Look again"}
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
