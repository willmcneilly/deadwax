import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no Web Animations, decoding or canvas. An animation finishes
// straight away, an image decodes at once, and there's no canvas to draw the
// crate's textures on, so its sleeves show no wear and its room no grain.
Element.prototype.animate = function () {
  const animation = { onfinish: null as (() => void) | null, cancel() {} };
  setTimeout(() => animation.onfinish?.(), 0);
  return animation as unknown as Animation;
};
HTMLImageElement.prototype.decode = () => Promise.resolve();
HTMLCanvasElement.prototype.getContext = () => null;

// Vitest's globals are off, so Testing Library can't register this itself.
// clearMocks removes the mocked Tauri back end a test set up with mockIPC, so
// the next test starts without one. Unmounting stops event listeners a
// microtask later, so the mocks stay until those have run.
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});
