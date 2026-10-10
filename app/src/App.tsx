import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  CHANGE_CLIENT_ID,
  errorMessage,
  getClientId,
  getSession,
  type Session,
} from "./api";
import Setup from "./Setup";
import SignIn from "./SignIn";
import "./App.css";

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
      return null;
    case "error":
      return (
        <section className="panel">
          <p className="error" role="alert">
            {view.message}
          </p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </section>
      );
    case "changeClientId":
      return (
        <Setup
          current={view.current}
          onSaved={show}
          onCancel={() => setView(view.previous)}
        />
      );
    case "session":
      switch (view.session.state) {
        case "needsClientId":
          return <Setup current={null} onSaved={show} />;
        case "signedOut":
          return <SignIn message={view.session.message} onSignedIn={show} />;
        case "signedIn":
          return (
            <section className="panel">
              <p>Signed in as {view.session.name}</p>
            </section>
          );
      }
  }
}

export default App;
