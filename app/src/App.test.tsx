import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CHANGE_CLIENT_ID, type Session } from "./api";
import App from "./App";

const CLIENT_ID = "0123456789abcdef0123456789abcdef";

type Call = { cmd: string; args?: InvokeArgs };

/** A mocked back end: `replies` answers each command, and every call is logged. */
function backEnd(replies: Record<string, (args?: InvokeArgs) => unknown>) {
  const calls: Call[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const reply = replies[cmd];
      if (!reply) throw new Error(`unexpected command ${cmd}`);
      return reply(args);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

const session = (s: Session) => () => s;

describe("App", () => {
  it("asks for the client ID on first run, then offers sign-in", async () => {
    const calls = backEnd({
      get_session: session({ state: "needsClientId" }),
      set_client_id: session({ state: "signedOut", message: null }),
    });
    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "Connect Deadwax to Spotify",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("http://127.0.0.1:43117/callback"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: CLIENT_ID },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("button", { name: "Sign in with Spotify" }),
    ).toBeInTheDocument();
    expect(calls).toContainEqual({
      cmd: "set_client_id",
      args: { clientId: CLIENT_ID },
    });
  });

  it("shows why a client ID was refused", async () => {
    backEnd({
      get_session: session({ state: "needsClientId" }),
      set_client_id: () => {
        throw "That doesn't look like a Spotify client ID.";
      },
    });
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Client ID"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "doesn't look like a Spotify client ID",
    );
  });

  it("opens Spotify's dashboard through Rust", async () => {
    const calls = backEnd({
      get_session: session({ state: "needsClientId" }),
      open_spotify_dashboard: () => null,
    });
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Spotify developer dashboard",
      }),
    );

    expect(calls.map((c) => c.cmd)).toContain("open_spotify_dashboard");
  });

  it("signs in through the browser and shows who you are", async () => {
    let finish: (session: Session) => void = () => {};
    backEnd({
      get_session: session({ state: "signedOut", message: null }),
      sign_in: () => new Promise<Session>((resolve) => (finish = resolve)),
    });
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Spotify" }),
    );
    expect(
      await screen.findByText("Waiting for you to agree in your browser…"),
    ).toBeInTheDocument();

    finish({ state: "signedIn", name: "Will" });
    expect(await screen.findByText("Signed in as Will")).toBeInTheDocument();
  });

  it("cancels a sign-in that never comes back, and ignores it if it does", async () => {
    let fail: (reason: string) => void = () => {};
    const calls = backEnd({
      get_session: session({ state: "signedOut", message: null }),
      sign_in: () => new Promise<Session>((_, reject) => (fail = reject)),
      cancel_sign_in: () => null,
    });
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Spotify" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByRole("button", { name: "Sign in with Spotify" }),
    ).toBeInTheDocument();
    expect(calls.map((c) => c.cmd)).toContain("cancel_sign_in");

    // Rust ends the cancelled sign-in with an error, which isn't shown.
    fail("Sign-in was cancelled.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed sign-in and lets you try again", async () => {
    backEnd({
      get_session: session({ state: "signedOut", message: null }),
      sign_in: () => {
        throw "Sign-in timed out. Try again when you're ready.";
      },
    });
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in with Spotify" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in timed out",
    );
    expect(
      screen.getByRole("button", { name: "Sign in with Spotify" }),
    ).toBeInTheDocument();
  });

  it("stays signed in across restarts", async () => {
    backEnd({ get_session: session({ state: "signedIn", name: "Will" }) });
    render(<App />);

    expect(await screen.findByText("Signed in as Will")).toBeInTheDocument();
  });

  it("returns to sign-in with a plain message when the sign-in has expired", async () => {
    const message =
      "Your Spotify sign-in has expired. Sign in again to carry on.";
    backEnd({ get_session: session({ state: "signedOut", message }) });
    render(<App />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with Spotify" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("changes the client ID from the menu, or cancels back", async () => {
    const calls = backEnd({
      get_session: session({ state: "signedIn", name: "Will" }),
      get_client_id: () => CLIENT_ID,
    });
    render(<App />);
    await screen.findByText("Signed in as Will");

    await emit(CHANGE_CLIENT_ID);

    expect(await screen.findByLabelText("Client ID")).toHaveValue(CLIENT_ID);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Signed in as Will")).toBeInTheDocument();
    expect(calls.map((c) => c.cmd)).not.toContain("set_client_id");
  });

  it("shows a back-end error with a way to try again", async () => {
    let fail = true;
    backEnd({
      get_session: () => {
        if (fail) throw "couldn't reach Spotify";
        return { state: "signedIn", name: "Will" };
      },
    });
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "couldn't reach Spotify",
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Signed in as Will")).toBeInTheDocument();
  });
});
