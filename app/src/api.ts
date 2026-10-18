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

/**
 * An album's Deadwax ID (`AlbumId` in Rust): what every command names an
 * album in the collection by. It isn't the Spotify ID.
 */
export type AlbumId = string;

/**
 * An album's colours (`Palette` in crates/deadwax-core/src/palette/mod.rs),
 * each `#rrggbb`. They're data, not design tokens: only `AlbumColours` puts
 * them on the page.
 */
export type Palette = {
  /** The glow's colours, most characterful first. */
  key: string[];
  /** The paper. */
  ground: string;
  /** The paper's reverse. */
  rear: string;
  /** Body text, 7:1 on the ground. */
  ink: string;
  /** Secondary text, 4.5:1. */
  muted: string;
  /** The album's colour, 4.5:1. */
  accent: string;
  dark: boolean;
  /** The room behind the glow. */
  deep: string;
};

/**
 * One album's cover in three sizes (`CoverUrls` in commands.rs). From disk
 * (`cover://`) once it's there, otherwise all three are Spotify's largest,
 * about 640 pixels.
 */
export type CoverUrls = {
  /** The 320, for the sleeves at the back of the crate. */
  small: string;
  /** The 640, for the front two. */
  medium: string;
  /** The 1600, for the sleeve you've pulled out. */
  large: string;
};

/**
 * An album in your collection, as the crate shows it: everything its sleeve
 * needs except the tracklist, which `getAlbum` has.
 */
export type AlbumCard = {
  id: AlbumId;
  /** Where Open in Spotify goes. */
  spotifyId: string;
  title: string;
  artist: string;
  year: number | null;
  /** The crate's dividers sort by it. Null until found, or if none was. */
  genre: string | null;
  /** The record label, for the sleeve's back. */
  label: string | null;
  /** Null until the album job queue has worked it out. */
  palette: Palette | null;
  /** Null if nothing had a cover. */
  covers: CoverUrls | null;
  /**
   * Whether the sleeve shows wear: only a cover from disk that didn't come
   * from Spotify. Spotify's covers are shown as they are (RFC-002, resolved
   * open question 1).
   */
  worn: boolean;
};

/**
 * An album as Spotify's search finds it. It has no Deadwax ID until it's
 * added, so it's named by its Spotify ID.
 */
export type SearchAlbum = {
  spotifyId: string;
  title: string;
  artist: string;
  year: number | null;
  /** Spotify's largest cover, about 640 pixels. */
  coverUrl: string | null;
};

export type SearchResult = { album: SearchAlbum; inCollection: boolean };

export type SearchResults = {
  results: SearchResult[];
  /** The offset for "More", or null on the last page. */
  nextOffset: number | null;
};

export const getCollection = () => invoke<AlbumCard[]>("get_collection");
export const searchAlbums = (query: string, offset: number) =>
  invoke<SearchResults>("search_albums", { query, offset });
/** Adds the album with this Spotify ID, which gets a new Deadwax ID. */
export const addAlbum = (spotifyId: string) =>
  invoke<AlbumCard>("add_album", { spotifyId });

export type AlbumTrack = {
  /** Tracks have no Deadwax IDs: this is what `playAlbum` starts from. */
  spotifyId: string;
  disc: number;
  number: number;
  title: string;
  durationMs: number;
};

/** An album with its tracklist, for the back of its sleeve (`AlbumDetails` in commands.rs). */
export type AlbumDetails = {
  id: AlbumId;
  /** Where Open in Spotify goes. */
  spotifyId: string;
  title: string;
  artist: string;
  year: number | null;
  /**
   * The 1600 from disk (`cover://`) once the album's cover is there,
   * otherwise Spotify's largest, about 640 pixels.
   */
  coverUrl: string | null;
  tracks: AlbumTrack[];
};

/**
 * The event Rust sends, with the album's Deadwax ID, when what it shows for
 * the album has changed: its cover is on disk, or its palette, genre and label
 * are stored (app/src-tauri/src/jobs.rs).
 */
export const ALBUM_UPDATED = "album-updated";

/** The album and its tracklist, from the cache. */
export const getAlbum = (id: AlbumId) =>
  invoke<AlbumDetails>("get_album", { id });
/**
 * Fetches the album again if its cache is over a week old. Null if it was
 * fresh enough, so nothing changed.
 */
export const refreshAlbum = (id: AlbumId) =>
  invoke<AlbumDetails | null>("refresh_album", { id });
export const removeAlbum = (id: AlbumId) =>
  invoke<void>("remove_album", { id });
/** Opens the album with this Spotify ID, in or out of the collection. */
export const openAlbumInSpotify = (spotifyId: string) =>
  invoke<void>("open_album_in_spotify", { spotifyId });

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
    /**
     * The track's Spotify ID, which the sleeve highlights it by. Null for a
     * local file, which Spotify gives no ID.
     */
    spotifyId: string | null;
    /** Which disc it's on, and its place on that disc, from 1. */
    disc: number;
    number: number;
    title: string;
    artist: string;
    album: string | null;
    /** The album's Deadwax ID, if it's in the collection. */
    albumId: AlbumId | null;
    /** Where Open in Spotify goes, in the collection or not. */
    spotifyAlbumId: string | null;
    durationMs: number;
    /**
     * The album's 1600 from disk if it's in the collection and its cover is
     * there, otherwise Spotify's largest, about 640 pixels.
     */
    coverUrl: string | null;
  } | null;
};

export const getDevices = () => invoke<Devices>("get_devices");
/** Remembers the device you chose, by name. */
export const chooseDevice = (name: string) =>
  invoke<void>("choose_device", { name });
/**
 * Plays the collected album on the named device, from the first track or the
 * track with the Spotify ID `trackId`.
 */
export const playAlbum = (
  id: AlbumId,
  device: string,
  trackId: string | null,
) => invoke<PlayOutcome>("play_album", { id, device, trackId });
/** Null when Spotify isn't playing anything. */
export const getPlayback = () => invoke<NowPlaying | null>("get_playback");
export const pausePlayback = () => invoke<void>("pause_playback");
export const resumePlayback = () => invoke<void>("resume_playback");
export const nextTrack = () => invoke<void>("next_track");
export const previousTrack = () => invoke<void>("previous_track");
