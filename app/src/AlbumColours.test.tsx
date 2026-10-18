import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AlbumColours from "./AlbumColours";
import { PALETTE } from "./crateFixtures";

const colours = (el: Element) => (el as HTMLElement).style;

describe("AlbumColours", () => {
  it("sets the album's palette as CSS custom properties, for everything inside", () => {
    const { container } = render(
      <AlbumColours palette={PALETTE} className="sleeve">
        <p>Inside</p>
      </AlbumColours>,
    );
    const style = colours(container.firstElementChild as Element);

    expect(style.getPropertyValue("--album-ground")).toBe(PALETTE.ground);
    expect(style.getPropertyValue("--album-rear")).toBe(PALETTE.rear);
    expect(style.getPropertyValue("--album-ink")).toBe(PALETTE.ink);
    expect(style.getPropertyValue("--album-muted")).toBe(PALETTE.muted);
    expect(style.getPropertyValue("--album-accent")).toBe(PALETTE.accent);
    expect(style.getPropertyValue("--album-deep")).toBe(PALETTE.deep);
    expect(container.firstElementChild).toHaveClass("sleeve");
    expect(container).toHaveTextContent("Inside");
  });

  it("gives the glow five colours, repeating the key colours when there are fewer", () => {
    const { container } = render(<AlbumColours palette={PALETTE} />);
    const style = colours(container.firstElementChild as Element);

    expect(
      [1, 2, 3, 4, 5].map((n) => style.getPropertyValue(`--album-glow-${n}`)),
    ).toEqual([...PALETTE.key, PALETTE.key[0], PALETTE.key[1]]);
  });

  it("sets nothing for an album whose palette isn't worked out yet, so theme.css's sleeve colours show", () => {
    const { container } = render(<AlbumColours palette={null} />);

    expect(container.firstElementChild).not.toHaveAttribute("style");
  });

  it("keeps any other style it's given", () => {
    const { container } = render(
      <AlbumColours palette={PALETTE} style={{ ["--wear" as string]: "var(--wear-2)" }} />,
    );
    const style = colours(container.firstElementChild as Element);

    expect(style.getPropertyValue("--wear")).toBe("var(--wear-2)");
    expect(style.getPropertyValue("--album-ink")).toBe(PALETTE.ink);
  });
});
