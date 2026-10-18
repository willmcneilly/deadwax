import { describe, expect, it } from "vitest";
import { FINAL, PLANS, row, seconds, type Plan } from "./crateSpike.ts";

describe("seconds", () => {
  it("reads ps's CPU time with and without hours and days", () => {
    expect(seconds("0:01.50")).toBe(1.5);
    expect(seconds("2:03.25")).toBe(123.25);
    expect(seconds("1:02:03")).toBe(3723);
    expect(seconds("1-00:00:01")).toBe(86401);
  });
});

describe("the runs", () => {
  it("has a label for each run that no other run has", () => {
    const labels = PLANS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("measures every scenario as the prototype had it and with the final cuts", () => {
    for (const scenario of ["flip", "pull", "glow", "search"] as const) {
      const runs = PLANS.filter((p) => p.scenario === scenario);
      expect(runs.some((p) => Object.keys(p.effects).length === 0 && !p.cold)).toBe(true);
      expect(runs.some((p) => p.effects === FINAL)).toBe(true);
    }
  });

  it("flips the real collection and the 400-record crate", () => {
    const flips = PLANS.filter((p) => p.scenario === "flip");
    expect(flips.some((p) => p.many)).toBe(true);
    expect(flips.some((p) => !p.many)).toBe(true);
  });
});

describe("row", () => {
  const glow: Plan = { label: "glow: x", scenario: "glow", many: false, effects: {} };
  const frames = { fps: 60, dropped: 0, late: 1, longestMs: 20, p95Ms: 17, p99Ms: 19 };
  const cpu = { gpu: 5, web: 12, windowServer: 40 };

  it("prints each repeat's numbers side by side", () => {
    const line = row(glow, [
      { frames, cpu, longestCommitMs: 1 },
      { frames: { ...frames, dropped: 2 }, cpu, longestCommitMs: 1 },
    ]);
    expect(line).toContain("| glow: x | dropped 0 · 2 |");
    expect(line).toContain("GPU 5 · 5%");
  });

  it("says so when a run failed", () => {
    expect(row(glow, [{ error: "The app didn't answer." }])).toBe(
      "| glow: x | error: The app didn't answer. |",
    );
  });
});
