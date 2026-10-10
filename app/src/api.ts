// The Tauri commands the UI calls (app/src-tauri/src/commands.rs). The UI
// never talks to Spotify itself: it asks Rust and draws what comes back.

import { invoke } from "@tauri-apps/api/core";

export type Session =
  | { state: "needsClientId" }
  | { state: "signedOut"; message: string | null }
  | { state: "signedIn"; name: string };

/** The event the Spotify › Change Client ID… menu item sends. */
export const CHANGE_CLIENT_ID = "change-client-id";

export const getSession = () => invoke<Session>("get_session");
export const getClientId = () => invoke<string | null>("get_client_id");
export const setClientId = (clientId: string) =>
  invoke<Session>("set_client_id", { clientId });
export const signIn = () => invoke<Session>("sign_in");
export const cancelSignIn = () => invoke<void>("cancel_sign_in");
export const openSpotifyDashboard = () =>
  invoke<void>("open_spotify_dashboard");

/** Command errors arrive as plain sentences, but anything can be thrown. */
export function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : String(error);
}
