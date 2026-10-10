import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest's globals are off, so Testing Library can't register this itself.
// clearMocks removes the mocked Tauri back end a test set up with mockIPC, so
// the next test starts without one.
afterEach(() => {
  cleanup();
  clearMocks();
});
