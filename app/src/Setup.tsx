import { useState, type FormEvent } from "react";
import {
  errorMessage,
  openSpotifyDashboard,
  setClientId,
  type Session,
} from "./api";

type Props = {
  /** The saved client ID, when you're changing it. */
  current: string | null;
  onSaved: (session: Session) => void;
  /** Leaves without changing anything. Missing on first run. */
  onCancel?: () => void;
};

/** Asks for the client ID of your own Spotify app (RFC-001, open question 3). */
function Setup({ current, onSaved, onCancel }: Props) {
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
    <section className="panel" aria-labelledby="setup-title">
      <h1 id="setup-title">Connect Deadwax to Spotify</h1>
      <p>
        Deadwax plays through your own Spotify developer app. It's free, takes a
        couple of minutes, and your account needs Premium.
      </p>
      <ol className="steps">
        <li>
          Open the{" "}
          <button type="button" className="link" onClick={openDashboard}>
            Spotify developer dashboard
          </button>{" "}
          and sign in.
        </li>
        <li>Create an app. Any name and description will do.</li>
        <li>
          Add this redirect URI, exactly, with no port:{" "}
          <code>http://127.0.0.1/callback</code>
        </li>
        <li>Tick Web API, agree to the terms and save.</li>
        <li>Copy the app's Client ID and paste it below.</li>
      </ol>
      <form onSubmit={save}>
        <label htmlFor="client-id">Client ID</label>
        <input
          id="client-id"
          value={clientId}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={saving || clientId.trim() === ""}>
            Save
          </button>
          {onCancel && (
            <button type="button" className="secondary" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

export default Setup;
