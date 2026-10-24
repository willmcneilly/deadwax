import { useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  cancelSignIn,
  errorMessage,
  openSpotifyDashboard,
  setClientId,
  signIn,
  type Session,
} from "./api";
import "./Account.css";

// The account cards: setting up the client ID, signing in, waiting for the
// browser, signed out and expired. Each is a plain card in the middle of the
// dark room (RFC-002, "4. The UI"). They're deliberate, but not part of the
// crate's world: you only see them once, or when something has gone wrong.
//
// Spotify being out of reach isn't one of these. The collection is on disk,
// so the crate still works, and the quiet line says Spotify isn't answering.

/** The dark room the cards sit in, with nothing else in it. */
export function AccountRoom({ children }: { children?: ReactNode }) {
  return <div className="account">{children}</div>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="account-card" aria-label={title}>
      <p className="account-mark">Deadwax</p>
      <h1>{title}</h1>
      {children}
    </section>
  );
}

/** What went wrong on a card, under it. */
function CardError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="account-error" role="alert">
      {error}
    </p>
  );
}

type SetupProps = {
  /** The saved client ID, when you're changing it. */
  current: string | null;
  onSaved: (session: Session) => void;
  /** Leaves without changing anything. Missing on first run. */
  onCancel?: () => void;
};

/** Asks for the client ID of your own Spotify app (RFC-001, open question 3). */
export function Setup({ current, onSaved, onCancel }: SetupProps) {
  const [clientId, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await setClientId(clientId));
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  async function openDashboard() {
    try {
      await openSpotifyDashboard();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Card title="Connect Deadwax to Spotify">
      <p>
        Deadwax plays through your own Spotify developer app. It's free, takes a
        couple of minutes, and your account needs Premium.
      </p>
      <ol className="account-steps">
        <li>
          Open the{" "}
          <button type="button" className="account-link" onClick={openDashboard}>
            Spotify developer dashboard
          </button>{" "}
          and sign in.
        </li>
        <li>Create an app. Any name and description will do.</li>
        <li>
          Add this redirect URI, exactly, and click Add:{" "}
          <code>http://127.0.0.1:43117/callback</code>
        </li>
        <li>Tick Web API, agree to the terms and save.</li>
        <li>Copy the app's Client ID and paste it below.</li>
      </ol>
      <form onSubmit={save}>
        <input
          aria-label="Client ID"
          placeholder="Client ID"
          value={clientId}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <button
          type="submit"
          className="primary"
          disabled={saving || clientId.trim() === ""}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
      {onCancel && (
        <div className="account-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      <CardError error={error} />
    </Card>
  );
}

type SignInProps = {
  /** Something to say first, such as the sign-in having expired. */
  message: string | null;
  onSignedIn: (session: Session) => void;
};

/**
 * Signing in, then waiting for the browser. Signed out says what Deadwax is
 * for; expired says the sign-in has expired (Rust's `message`).
 */
export function SignIn({ message, onSignedIn }: SignInProps) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counts sign-ins, so a cancelled one that finishes late is ignored.
  const attempt = useRef(0);

  async function start() {
    const current = ++attempt.current;
    setWaiting(true);
    setError(null);
    try {
      const session = await signIn();
      if (current === attempt.current) onSignedIn(session);
    } catch (e) {
      if (current !== attempt.current) return;
      setError(errorMessage(e));
      setWaiting(false);
    }
  }

  async function cancel() {
    attempt.current++;
    setWaiting(false);
    try {
      await cancelSignIn();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  if (waiting) {
    return (
      <Card title="Waiting for Spotify">
        <p>Agree in your browser, then come back here.</p>
        <p className="account-small">
          If Spotify shows an error instead, check the redirect URI in your
          Spotify app, then cancel and try again.
        </p>
        <div className="account-actions">
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
        <CardError error={error} />
      </Card>
    );
  }
  return (
    <Card title={message ? "Sign in again" : "Sign in to Spotify"}>
      <p>
        {message ??
          "Deadwax plays your records through Spotify. Sign in to start."}
      </p>
      <div className="account-actions">
        <button type="button" className="primary" onClick={start}>
          Sign in with Spotify
        </button>
      </div>
      <CardError error={error} />
    </Card>
  );
}

/**
 * Deadwax couldn't find out whether you're signed in: the Keychain or its
 * config failed. Spotify being out of reach never gets here.
 */
export function Trouble({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card title="Deadwax couldn't start">
      <p role="alert">{message}</p>
      <div className="account-actions">
        <button type="button" className="primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </Card>
  );
}
