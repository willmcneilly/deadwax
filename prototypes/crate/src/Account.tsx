import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { App } from "./App";
import {
  cancelSignIn,
  errorMessage,
  getSession,
  openSpotifyDashboard,
  setClientId,
  signIn,
  type Session,
} from "./connect/api";
import { accountState, subscribe } from "./connect/fake";

// Before the crate: setting up the client ID, and signing in. Each is a plain
// card in the middle of the room. It's deliberate, but not part of the crate
// world: you only see these once, or when something has gone wrong.
//
// Spotify being down isn't one of these. The collection is local, so the
// crate still works, and the quiet line says Spotify isn't answering.
export function Account() {
  const [session, setSession] = useState<Session | null>(null);
  const shown = useRef<Session["state"] | null>(null);
  shown.current = session?.state ?? null;

  useEffect(() => {
    void getSession().then(setSession);
    // Prototype only: the dev panel changes the account under the app.
    return subscribe(() => {
      if (shown.current && shown.current !== accountState()) void getSession().then(setSession);
    });
  }, []);

  if (!session) return <div className="room" />;
  if (session.state === "signedIn") return <App />;
  return (
    <div className="room account">
      {session.state === "needsClientId" ? (
        <Setup onSaved={setSession} />
      ) : (
        <SignIn message={session.message} onSignedIn={setSession} />
      )}
      <div className="grain" />
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <p className="card-mark">Deadwax</p>
      <h1>{title}</h1>
      {children}
    </section>
  );
}

function Setup({ onSaved }: { onSaved: (s: Session) => void }) {
  const [clientId, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await setClientId(clientId));
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Card title="Connect Deadwax to Spotify">
      <p>
        Deadwax plays through your own Spotify developer app. It's free, takes a couple of minutes, and
        your account needs Premium.
      </p>
      <ol className="card-steps">
        <li>
          Open the{" "}
          <button type="button" className="card-link" onClick={() => void openSpotifyDashboard()}>
            Spotify developer dashboard
          </button>{" "}
          and sign in.
        </li>
        <li>Create an app. Any name and description will do.</li>
        <li>
          Add this redirect URI, exactly: <code>http://127.0.0.1:43117/callback</code>
        </li>
        <li>Tick Web API, agree to the terms and save.</li>
        <li>Copy the app's Client ID and paste it below.</li>
      </ol>
      <form onSubmit={save}>
        <input
          aria-label="Client ID"
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <button type="submit" disabled={saving || !clientId.trim()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
      {error && <p className="card-error">{error}</p>}
    </Card>
  );
}

function SignIn({ message, onSignedIn }: { message: string | null; onSignedIn: (s: Session) => void }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  async function start() {
    const n = ++attempt.current;
    setWaiting(true);
    setError(null);
    try {
      const s = await signIn();
      if (n === attempt.current) onSignedIn(s);
    } catch (e) {
      if (n !== attempt.current) return;
      setError(errorMessage(e));
      setWaiting(false);
    }
  }

  async function cancel() {
    attempt.current++;
    setWaiting(false);
    await cancelSignIn();
  }

  return (
    <Card title={waiting ? "Waiting for Spotify" : "Sign in to Spotify"}>
      {waiting ? (
        <>
          <p>Agree in your browser, then come back here.</p>
          <p className="card-small">
            If Spotify shows an error instead, check the redirect URI in your Spotify app, then cancel and try
            again.
          </p>
          <div className="card-actions">
            <button type="button" className="secondary" onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{message ?? "Deadwax plays your records through Spotify. Sign in to start."}</p>
          <div className="card-actions">
            <button type="button" onClick={start}>
              Sign in with Spotify
            </button>
          </div>
        </>
      )}
      {error && <p className="card-error">{error}</p>}
    </Card>
  );
}
