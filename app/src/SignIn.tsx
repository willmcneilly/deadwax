import { useState } from "react";
import { errorMessage, signIn, type Session } from "./api";

type Props = {
  /** Something to say first, such as the sign-in having expired. */
  message: string | null;
  onSignedIn: (session: Session) => void;
};

function SignIn({ message, onSignedIn }: Props) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setWaiting(true);
    setError(null);
    try {
      onSignedIn(await signIn());
    } catch (e) {
      setError(errorMessage(e));
      setWaiting(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title">Sign in to Spotify</h1>
      {message && <p>{message}</p>}
      {waiting ? (
        <p>Waiting for you to agree in your browser…</p>
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
