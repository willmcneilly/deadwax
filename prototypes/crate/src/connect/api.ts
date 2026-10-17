// The app's back end, as the prototype sees it. The types are copied from
// app/src/api.ts, unchanged. The functions have the same names and arguments
// as the app's Tauri commands, but answer from the fake in fake.ts.
//
// RFC-002 swaps this file for app/src/api.ts. The app's file imports Tauri,
// so it can't be imported here; keep these types in step with it by hand.
// Errors are thrown as plain sentences, like the app's commands.

export {
  addAlbum,
  cancelSignIn,
  chooseDevice,
  getAlbum,
  getClientId,
  getCollection,
  getDevices,
  getPlayback,
  getSession,
  nextTrack,
  openSpotifyDashboard,
  pausePlayback,
  playAlbum,
  previousTrack,
  resumePlayback,
  searchAlbums,
  setClientId,
  signIn,
} from "./fake";

/** Command errors arrive as plain sentences, but anything can be thrown. */
export function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : String(error);
}

export type Session =
  | { state: "needsClientId" }
  | { state: "signedOut"; message: string | null }
  | { state: "signedIn"; name: string };

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
    /**
     * The album's high-res cover if it's in the collection and one has been
     * found, otherwise Spotify's largest, about 640 pixels.
     */
    coverUrl: string | null;
  } | null;
};
