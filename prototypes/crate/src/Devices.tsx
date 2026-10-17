import { useEffect, useState } from "react";
import { chooseDevice, errorMessage, getDevices, type Devices } from "./connect/api";

/**
 * Why the device list is showing. It stays out of sight while the remembered
 * device works, and only comes up to choose the first one, to change on
 * purpose (the "on Kitchen" at the end of the now-playing line, or D), or
 * when the one you chose isn't showing up.
 */
export type SheetReason =
  | { kind: "first" }
  | { kind: "none" }
  | { kind: "choose" }
  | { kind: "missing"; device: string };

export function DeviceSheet({
  reason,
  onChosen,
  onClose,
  onFailed,
}: {
  reason: SheetReason;
  onChosen: (device: string) => void;
  onClose: () => void;
  onFailed: (message: string) => void;
}) {
  const [devices, setDevices] = useState<Devices | null>(null);
  const [looking, setLooking] = useState(true);

  const look = async () => {
    setLooking(true);
    try {
      setDevices(await getDevices());
    } catch (e) {
      onFailed(errorMessage(e));
    } finally {
      setLooking(false);
    }
  };

  useEffect(() => {
    void look();
  }, []);

  const choose = async (name: string) => {
    try {
      await chooseDevice(name);
      onChosen(name);
    } catch (e) {
      onFailed(errorMessage(e));
    }
  };

  const list = devices?.devices ?? [];
  const missing = reason.kind === "missing" && !list.some((d) => d.name === reason.device) ? reason.device : null;
  const none = devices && list.length === 0;

  const heading =
    reason.kind === "first"
      ? "Where should it play?"
      : reason.kind === "missing"
        ? "Play somewhere else?"
        : "Play on";
  const note = none
    ? "Spotify isn't showing any devices. Open Spotify on a speaker, your TV or this Mac, then try again."
    : missing
      ? `${missing} isn't showing up. Open Spotify on it, or play something there, then try again`
      : reason.kind === "first"
        ? "Deadwax remembers it for next time."
        : null;

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Devices" onClick={(e) => e.stopPropagation()}>
        <p className="sheet-heading">{heading}</p>
        {note && <p className="sheet-note">{note}</p>}
        <ul className={looking ? "looking" : undefined}>
          {list.map((d) => (
            <li key={d.name}>
              <button disabled={!d.canPlay} onClick={() => choose(d.name)}>
                <span className="sheet-name">{d.name}</span>
                <span className="sheet-kind">
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
          {!devices && looking && <li className="sheet-looking">Looking for devices…</li>}
        </ul>
        <div className="sheet-actions">
          <button onClick={look} disabled={looking}>
            {looking ? "Looking…" : "Look again"}
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
