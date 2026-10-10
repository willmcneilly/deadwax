import { useRef, useState } from "react";
import { cancelSignIn, errorMessage, signIn, type Session } from "./api";

type Props = {
  /** Something to say first, such as the sign-in having expired. */
  message: string | null;
  onSignedIn: (session: Session) => void;
};

function SignIn({ message, onSignedIn }: Props) {
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

  return (
    <section className="panel" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">Sign in to Spotify</h1>
      {message && <p>{message}</p>}
      {waiting ? (
        <>
          <p>Waiting for you to agree in your browser…</p>
          <p>
            If Spotify shows an error instead, check the redirect URI in your
            Spotify app, then cancel and try again.
          </p>
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" onClick={start}>
          Sign in with Spotify
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export default SignIn;
