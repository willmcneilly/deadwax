import { useSyncExternalStore } from "react";

// One type system for the whole record (sleeve back, gatefold, captions, now
// playing), switchable while we decide: Fraunces with JetBrains Mono, or IBM
// Plex Sans with Plex Mono. The stylesheets read it from --type-body and
// --type-label, which a class on <html> swaps.

export type Typeface = "serif" | "grotesk";

const listeners = new Set<() => void>();

function read(): Typeface {
  return document.documentElement.classList.contains("type-grotesk") ? "grotesk" : "serif";
}

export function setTypeface(t: Typeface) {
  document.documentElement.classList.toggle("type-grotesk", t === "grotesk");
  try {
    localStorage.setItem("typeface", t);
  } catch {
    // fine without it
  }
  listeners.forEach((l) => l());
}

export function restoreTypeface() {
  try {
    if (localStorage.getItem("typeface") === "grotesk") setTypeface("grotesk");
  } catch {
    // fine without it
  }
}

export function useTypeface() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );
}
