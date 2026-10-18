// Where the record in front sits on screen, in 3D, so the pulled-out sleeve
// can fly from exactly there and back (Sleeve.tsx).
//
// The crate is drawn in perspective, seen from above: the front sleeve leans
// back a little, so on screen it's a taller trapezoid, not a square. A
// sleeve flying to its bounding box as a flat square changed shape as it
// landed. This is the slot's whole transform instead: the crate's
// perspective, the stack's position and the slot's own lean.

/** The front slot's transform from its own box to the room, and its size. */
export type Place = { matrix: DOMMatrix; size: number };

const numbers = (value: string) => value.split(" ").map(parseFloat);

/**
 * The record in front's place in the room, as the crate draws it at rest.
 * Null where the browser can't say (as in tests, with no layout or
 * DOMMatrix): the sleeve then simply appears.
 */
export function frontPlace(room: HTMLElement | null): Place | null {
  if (typeof DOMMatrix === "undefined" || !room) return null;
  const crate = room.querySelector<HTMLElement>(".crate");
  const stack = crate?.querySelector<HTMLElement>(".crate-stack");
  const slot = stack?.querySelector<HTMLElement>(".crate-slot[data-front]");
  if (!crate || !stack || !slot || !slot.offsetWidth) return null;

  const scene = getComputedStyle(crate);
  const depth = parseFloat(scene.perspective);
  const [px, py] = numbers(scene.perspectiveOrigin);
  const own = getComputedStyle(slot);
  const [ox, oy] = numbers(own.transformOrigin);
  const lean = own.transform === "none" ? new DOMMatrix() : new DOMMatrix(own.transform);
  const room0 = room.getBoundingClientRect();

  let m = new DOMMatrix().translate(room0.left + crate.offsetLeft, room0.top + crate.offsetTop);
  if (depth > 0) {
    // CSS perspective around the crate's perspective origin. DOMMatrix takes
    // 16 values column by column; -1/d is m34.
    const perspective = new DOMMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / depth, 0, 0, 0, 1]);
    m = m.translate(px, py).multiply(perspective).translate(-px, -py);
  }
  m = m
    .translate(stack.offsetLeft + slot.offsetLeft, stack.offsetTop + slot.offsetTop)
    .translate(ox, oy)
    .multiply(lean)
    .translate(-ox, -oy);
  return { matrix: m, size: slot.offsetWidth };
}
