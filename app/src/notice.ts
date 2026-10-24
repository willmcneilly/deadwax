// What the quiet line says (QuietLine.tsx): an error that fades after 8
// seconds, or that Spotify isn't answering.

import { useCallback, useEffect, useRef, useState } from "react";

/** How long an error shows before it fades. */
export const QUIET_MS = 8000;

/** Said while Spotify's last two answers about what's playing failed. */
export const UNANSWERED = "Spotify isn't answering. Deadwax will keep trying.";

/**
 * Something that went wrong, said once. A new one, even in the same words,
 * starts the 8 seconds again.
 */
export type Notice = { message: string; n: number };

/** The error the quiet line shows, which clears itself after `QUIET_MS`. */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const said = useRef(0);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), QUIET_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  const say = useCallback(
    (message: string) => setNotice({ message, n: ++said.current }),
    [],
  );
  const hush = useCallback(() => setNotice(null), []);
  return { notice, say, hush };
}
