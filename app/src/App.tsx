import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  CHANGE_CLIENT_ID,
  errorMessage,
  getClientId,
  getSession,
  SIGNED_OUT,
  type Session,
} from "./api";
import { AccountRoom, Setup, SignIn, Trouble } from "./Account";
import Library from "./Library";

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "session"; session: Session }
  /** Changing the client ID from the menu, with the session to go back to. */
  | { kind: "changeClientId"; current: string | null; previous: View };

function App() {
  const [view, setView] = useState<View>({ kind: "loading" });

  const load = useCallback(() => {
    getSession().then(
      (session) => setView({ kind: "session", session }),
      (e: unknown) => setView({ kind: "error", message: errorMessage(e) }),
    );
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    const unlisten = listen(CHANGE_CLIENT_ID, async () => {
      try {
        const current = await getClientId();
        setView((previous) =>
          previous.kind === "changeClientId"
            ? previous
            : { kind: "changeClientId", current, previous },
        );
      } catch (e) {
        setView({ kind: "error", message: errorMessage(e) });
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // Any command that finds you signed out, from anywhere, brings up the
  // sign-in card. Calls that were already on their way find no tokens and
  // say so without a message: the card keeps saying the sign-in expired.
  useEffect(() => {
    const unlisten = listen<string | null>(SIGNED_OUT, ({ payload }) => {
      setView((previous) => {
        const shown =
          previous.kind === "session" &&
          previous.session.state === "signedOut";
        if (shown && !payload) return previous;
        return {
          kind: "session",
          session: { state: "signedOut", message: payload },
        };
      });
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const show = (session: Session) => setView({ kind: "session", session });

  const retry = () => {
    setView({ kind: "loading" });
    load();
  };

  return <main className="app">{render(view, show, setView, retry)}</main>;
}

function render(
  view: View,
  show: (session: Session) => void,
  setView: (view: View) => void,
  retry: () => void,
) {
  switch (view.kind) {
    case "loading":
      return <AccountRoom />;
    case "error":
      return (
        <AccountRoom>
          <Trouble message={view.message} onRetry={retry} />
        </AccountRoom>
      );
    case "changeClientId":
      return (
        <AccountRoom>
          <Setup
            current={view.current}
            onSaved={show}
            onCancel={() => setView(view.previous)}
          />
        </AccountRoom>
      );
    case "session":
      switch (view.session.state) {
        case "needsClientId":
          return (
            <AccountRoom>
              <Setup current={null} onSaved={show} />
            </AccountRoom>
          );
        case "signedOut":
          return (
            <AccountRoom>
              {/* Keyed by what it says, so a new expiry starts it afresh. */}
              <SignIn
                key={view.session.message ?? ""}
                message={view.session.message}
                onSignedIn={show}
              />
            </AccountRoom>
          );
        case "signedIn":
          return <Library name={view.session.name} />;
      }
  }
}

export default App;
