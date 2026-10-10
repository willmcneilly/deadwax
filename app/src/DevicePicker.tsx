import type { DeviceChoice } from "./api";

type Props = {
  devices: DeviceChoice[] | null;
  selected: string | null;
  refreshing: boolean;
  onChoose: (name: string) => void;
  onRefresh: () => void;
};

/**
 * Picks the Spotify Connect device to play on. When the chosen device isn't
 * listed, it says so and what to do, rather than showing an error: Spotify
 * doesn't list devices that are asleep (RFC-001, "Playing music").
 */
function DevicePicker({
  devices,
  selected,
  refreshing,
  onChoose,
  onRefresh,
}: Props) {
  if (devices === null) {
    return <p className="device-note">Looking for devices…</p>;
  }
  const listed =
    selected !== null && devices.some((device) => device.name === selected);
  const note =
    selected === null
      ? "Spotify isn't showing any devices. Open Spotify on a speaker, your TV or this Mac, then try again."
      : listed
        ? null
        : `${selected} isn't showing up. Open Spotify on it, or play something there, then try again`;

  return (
    <div className="device-picker">
      <label className="device-label">
        Device
        <select
          value={selected ?? ""}
          onChange={(event) => onChoose(event.target.value)}
        >
          {selected === null && (
            <option value="" disabled>
              No devices
            </option>
          )}
          {selected !== null && !listed && (
            <option value={selected}>{selected} (not showing up)</option>
          )}
          {devices.map((device, index) => (
            <option key={index} value={device.name} disabled={!device.canPlay}>
              {device.name}
              {!device.canPlay && " (can't be controlled)"}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="secondary"
        onClick={onRefresh}
        disabled={refreshing}
      >
        {refreshing ? "Looking…" : "Refresh devices"}
      </button>
      {note && (
        <p className="device-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

export default DevicePicker;
