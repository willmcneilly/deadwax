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

/** An album as the grid and the search results show it. */
export type AlbumCard = {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  /** Spotify's largest cover, about 640 pixels. */
  coverUrl: string | null;
};

export type SearchResult = { album: AlbumCard; inCollection: boolean };

export type SearchResults = {
  results: SearchResult[];
  /** The offset for "More", or null on the last page. */
  nextOffset: number | null;
};

export const getCollection = () => invoke<AlbumCard[]>("get_collection");
export const searchAlbums = (query: string, offset: number) =>
  invoke<SearchResults>("search_albums", { query, offset });
export const addAlbum = (id: string) => invoke<AlbumCard>("add_album", { id });

export type AlbumTrack = {
  id: string;
  disc: number;
  number: number;
  title: string;
  durationMs: number;
};

/** An album as the album page shows it (`AlbumPage` in commands.rs). */
export type AlbumDetails = {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  /** Spotify's largest cover, about 640 pixels. */
  coverUrl: string | null;
  tracks: AlbumTrack[];
};

/** The album page, from the cache. */
export const getAlbum = (id: string) =>
  invoke<AlbumDetails>("get_album", { id });
/**
 * Fetches the album again if its cache is over a week old. Null if it was
 * fresh enough, so nothing changed.
 */
export const refreshAlbum = (id: string) =>
  invoke<AlbumDetails | null>("refresh_album", { id });
export const removeAlbum = (id: string) => invoke<void>("remove_album", { id });
export const openAlbumInSpotify = (id: string) =>
  invoke<void>("open_album_in_spotify", { id });
