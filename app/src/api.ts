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
  /**
   * The high-res cover once one has been found, otherwise Spotify's largest,
   * about 640 pixels.
   */
  coverUrl: string | null;
  tracks: AlbumTrack[];
};

/**
 * The event Rust sends, with the album's ID, when it has stored the album's
 * high-res cover (app/src-tauri/src/artwork.rs).
 */
export const ARTWORK_FOUND = "artwork-found";

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

/** A Spotify Connect device, as the device picker shows it. */
export type DeviceChoice = {
  name: string;
  /** "Speaker", "TV", "Computer" and so on. */
  kind: string;
  /** The device playing, or last to play. */
  isActive: boolean;
  /** Spotify will take commands for it. */
  canPlay: boolean;
};

/** What Spotify lists now, and the device you chose last. */
export type Devices = { devices: DeviceChoice[]; remembered: string | null };

/**
 * What happened when you pressed Play, with the device list as Spotify gave
 * it just before.
 */
export type PlayOutcome =
  | { state: "playing"; devices: DeviceChoice[] }
  /** Spotify isn't listing the device: it's asleep or offline. */
  | { state: "deviceMissing"; devices: DeviceChoice[] };

/** What Spotify is playing, anywhere. */
export type NowPlaying = {
  isPlaying: boolean;
  device: string | null;
  progressMs: number | null;
  /** Null for an advert or anything else Spotify won't describe. */
  track: {
    title: string;
    artist: string;
    album: string | null;
    albumId: string | null;
    durationMs: number;
  } | null;
};

export const getDevices = () => invoke<Devices>("get_devices");
/** Remembers the device you chose, by name. */
export const chooseDevice = (name: string) =>
  invoke<void>("choose_device", { name });
/** Plays the album on the named device, from the first track or `trackId`. */
export const playAlbum = (id: string, device: string, trackId: string | null) =>
  invoke<PlayOutcome>("play_album", { id, device, trackId });
/** Null when Spotify isn't playing anything. */
export const getPlayback = () => invoke<NowPlaying | null>("get_playback");
export const pausePlayback = () => invoke<void>("pause_playback");
export const resumePlayback = () => invoke<void>("resume_playback");
export const nextTrack = () => invoke<void>("next_track");
export const previousTrack = () => invoke<void>("previous_track");
