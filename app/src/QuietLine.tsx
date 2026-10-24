import { useEffect, useState } from "react";
import { UNANSWERED, type Notice } from "./notice";
import "./QuietLine.css";

/** How long the line takes to fade (QuietLine.css). */
const FADE_MS = 500;

type Props = {
  notice: Notice | null;
  /** Spotify hasn't answered the last two polls: said until it does. */
  unanswered: boolean;
};

/**
 * Spotify's errors, as one quiet line at the top of the room (RFC-002, "4.
 * The UI"). An error fades after 8 seconds. While Spotify isn't answering
 * it says so, under any error, until it answers again. The crate keeps
 * working underneath: the collection is on disk.
 */
export default function QuietLine({ notice, unanswered }: Props) {
  const line = notice?.message ?? (unanswered ? UNANSWERED : null);
  // What it said last, kept on the page while it fades.
  const [previous, setPrevious] = useState(line);
  const [fading, setFading] = useState<string | null>(null);
  if (line !== previous) {
    setPrevious(line);
    setFading(line ? null : previous);
  }
  useEffect(() => {
    if (!fading) return;
    const timer = setTimeout(() => setFading(null), FADE_MS);
    return () => clearTimeout(timer);
  }, [fading]);

  const text = line ?? fading;
  if (!text) return null;
  return (
    <p className={`quiet-line ${line ? "on" : ""}`} role="alert">
      {text}
    </p>
  );
}
