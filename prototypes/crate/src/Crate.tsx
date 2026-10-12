import { memo, type CSSProperties } from "react";
import { SleeveFront } from "./Sleeve";
import { hash, type CrateItem } from "./types";

const BEHIND = 11; // how many records to draw behind the one in front
const AHEAD = 3; // and how many already flipped past

// Where a record sits relative to the one you're looking at (d = 0).
// rotateX: positive leans the top away from you, negative tips it toward you.
function place(d: number, jitter: number): CSSProperties {
  if (d < 0) {
    // Flipped past: tips toward you and drops out of sight.
    return {
      transform: `translate3d(${jitter * 6}px, 4%, 60px) rotateX(-72deg) rotateZ(${jitter * 1.2}deg)`,
      opacity: 0,
    };
  }
  if (d === 0) return { transform: "translate3d(0, 0, 0) rotateX(5deg)" };
  return {
    transform: `translate3d(${jitter * 5}px, 0, ${-14 - d * 20}px) rotateX(${13 + Math.min(d, 8) * 0.6}deg) rotateZ(${jitter * 0.9}deg)`,
    opacity: d > BEHIND - 1 ? 0 : 1,
  };
}

export const Crate = memo(function Crate({
  items,
  focus,
  hiddenId,
  state,
  onFocus,
  onSelect,
}: {
  items: CrateItem[];
  focus: number;
  hiddenId: string | null;
  state: "rest" | "dim" | "gone";
  onFocus: (index: number) => void;
  onSelect: () => void;
}) {
  const visible = [];
  for (let i = Math.max(0, focus - AHEAD); i <= Math.min(items.length - 1, focus + BEHIND); i++) {
    visible.push(i);
  }

  return (
    <div className={`crate-scene ${state}`}>
      <div className="stack">
        {visible.map((i) => {
          const item = items[i];
          const d = i - focus;
          const jitter = (hash(item.id) - 0.5) * 2;
          return (
            <div
              key={item.id}
              className={`slot ${item.kind} ${d < 0 ? "past" : ""}`}
              data-focused={d === 0 || undefined}
              style={{
                ...place(d, jitter),
                zIndex: 100 - d,
                visibility: item.id === hiddenId ? "hidden" : undefined,
                ["--shade" as string]: d > 0 ? Math.min(0.08 + d * 0.055, 0.75) : d < 0 ? 0.55 : 0,
              }}
              onClick={() => (d === 0 ? onSelect() : onFocus(i))}
            >
              {item.kind === "album" ? (
                <>
                  <SleeveFront album={item.album} size="sm" />
                  <div className="sleeve-rear" />
                </>
              ) : (
                <Divider label={item.label} count={item.count} tab={item.tab} />
              )}
              <div className="shade" />
            </div>
          );
        })}
      </div>
    </div>
  );
});

function Divider({ label, count, tab }: { label: string; count: number; tab: number }) {
  return (
    <div className="divider-card" style={{ ["--tab" as string]: `${8 + tab * 30}%` }}>
      <div className="divider-tab">
        <span>{label}</span>
      </div>
      <div className="divider-body">
        <span className="divider-big">{label}</span>
        <span className="divider-count">
          {count} {count === 1 ? "record" : "records"}
        </span>
      </div>
    </div>
  );
}
