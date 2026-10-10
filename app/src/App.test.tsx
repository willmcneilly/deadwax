import { mockIPC } from "@tauri-apps/api/mocks";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders an empty window without calling the back end", () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
      calls.push(cmd);
    });

    const { container } = render(<App />);

    expect(container.querySelector("main.app")).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });
});
