import { describe, expect, it } from "vitest";
import glowCss from "./Glow.css?raw";

/** The declarations of the rule with exactly this selector. */
function rule(selector: string): string {
  const at = glowCss.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return glowCss.slice(at, glowCss.indexOf("}", at));
}

const opacity = (selector: string) =>
  Number(/opacity:\s*([\d.]+)/.exec(rule(selector))?.[1]);

describe("The glow's levels", () => {
  it("has a record out faint, below the needle dropping", () => {
    expect(opacity(".glow.out")).toBeGreaterThan(0);
    expect(opacity(".glow.out")).toBeLessThan(opacity(".glow.warming"));
  });

  it("holds the pools still for a record out, as when paused", () => {
    const still = /\n((?:\.glow\.\w+ \.glow-pool,?\s*)+)\{\s*animation-play-state: paused;/.exec(
      glowCss,
    )?.[1];
    expect(still).toContain(".glow.out .glow-pool");
    expect(still).toContain(".glow.paused .glow-pool");
  });
});
