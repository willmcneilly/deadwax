import { useCallback, useEffect, useRef, useState } from "react";
import { chooseDevice, getDevices, type DeviceChoice } from "./api";

/**
 * The devices Spotify lists and the one chosen to play on. It starts as the
 * device you chose last, matched by name, even when Spotify isn't listing it.
 * With none remembered, it's the device playing, or the first that can play.
 */
export default function useDevices(onFailed: (error: unknown) => void) {
  const [devices, setDevices] = useState<DeviceChoice[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const failed = useRef(onFailed);
  useEffect(() => {
    failed.current = onFailed;
  });

  const load = useCallback(() => {
    getDevices()
      .then(
        (reply) => {
          setDevices(reply.devices);
          setSelected(
            (current) =>
              current ?? reply.remembered ?? firstChoice(reply.devices),
          );
        },
        (e: unknown) => failed.current(e),
      )
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(load, [load]);

  function refresh() {
    setRefreshing(true);
    load();
  }

  function choose(name: string) {
    setSelected(name);
    chooseDevice(name).catch(failed.current);
  }

  return { devices, selected, refreshing, refresh, choose, setDevices };
}

function firstChoice(devices: DeviceChoice[]): string | null {
  const playable = devices.filter((device) => device.canPlay);
  return (
    (playable.find((device) => device.isActive) ?? playable[0])?.name ?? null
  );
}
