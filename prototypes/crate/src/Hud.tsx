import { useEffect, useRef, useState } from "react";

const EFFECTS = [
  { id: "no-grain", label: "Screen grain" },
  { id: "no-wear", label: "Sleeve wear" },
  { id: "no-shade", label: "Depth shading" },
] as const;

// Press H for a frame-rate readout, with switches to turn the analog effects
// off one at a time and feel what each costs.
export function Hud() {
  const [open, setOpen] = useState(new URLSearchParams(location.search).has("hud"));
  const [off, setOff] = useState<string[]>([]);
  const fps = useRef<HTMLSpanElement>(null);
  const worst = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "h" && setOpen((o) => !o);
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    for (const e of EFFECTS) document.body.classList.toggle(e.id, off.includes(e.id));
  }, [off]);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let longest = 0;
    let since = last;
    const loop = (t: number) => {
      const dt = t - last;
      last = t;
      frames++;
      longest = Math.max(longest, dt);
      if (t - since >= 1000) {
        if (fps.current) fps.current.textContent = String(Math.round((frames * 1000) / (t - since)));
        if (worst.current) worst.current.textContent = `${Math.round(longest)}ms`;
        frames = 0;
        longest = 0;
        since = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;
  return (
    <div className="hud">
      <p>
        <span ref={fps}>–</span> fps · worst frame <span ref={worst}>–</span>
      </p>
      {EFFECTS.map((e) => (
        <label key={e.id}>
          <input
            type="checkbox"
            checked={!off.includes(e.id)}
            onChange={() =>
              setOff((o) => (o.includes(e.id) ? o.filter((x) => x !== e.id) : [...o, e.id]))
            }
          />
          {e.label}
        </label>
      ))}
    </div>
  );
}
