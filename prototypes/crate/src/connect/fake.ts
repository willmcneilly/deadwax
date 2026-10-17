// A pretend Spotify and collection behind the app's commands (see api.ts). It
// answers in the app's own shapes and behaves like the real thing: play takes
// a moment to start, speakers fall asleep and drop off the list, someone skips
// a track from their phone, and Spotify has bad days. The dev panel (Dev.tsx)
// changes all of that while you watch.
//
// What persists between reloads (the collection, the remembered device, the
// client ID and being signed in) is kept in localStorage, like the app's
// database and Keychain would keep it.

import type {
  AlbumCard,
  AlbumDetails,
  DeviceChoice,
  Devices,
  NowPlaying,
  PlayOutcome,
  SearchResults,
  Session,
} from "./api";
import type { Album } from "../types";

// ---------- the fixture ----------

const albums = new Map<string, Album>();
/** The albums the fixture put in the collection, in the order they came. */
let starter: string[] = [];

/** Prototype only: loads the fixture the fake answers from. */
export async function loadFixture() {
  const get = (path: string) =>
    fetch(path).then((r) => (r.ok ? (r.json() as Promise<Album[]>) : Promise.reject(new Error(path))));
  const [collection, catalogue] = await Promise.all([
    get("/data/albums.json"),
    get("/data/catalogue.json").catch(() => [] as Album[]),
  ]);
  for (const a of [...collection, ...catalogue]) albums.set(a.id, a);
  starter = collection.map((a) => a.id);
  if (!stored.collection) store("collection", starter);
}

/**
 * Prototype only: the album with what the crate needs beyond the app's types
 * (a genre for the dividers, the label for the sleeve's back). The real back
 * end has no genres yet: RFC-002 has to find them.
 */
export const fixtureAlbum = (id: string) => albums.get(id) ?? null;

// ---------- what persists ----------

type Stored = {
  collection: string[] | null;
  remembered: string | null;
  clientId: string | null;
  signedIn: boolean;
  signedOutMessage: string | null;
};

function load(): Stored {
  try {
    const raw = localStorage.getItem("deadwax-fake");
    if (raw) return { ...defaults(), ...(JSON.parse(raw) as Partial<Stored>) };
  } catch {
    // A private window or cleared storage: start again.
  }
  return defaults();
}
function defaults(): Stored {
  return {
    collection: null,
    remembered: "Kitchen",
    clientId: "3f9c1e0b7a2d4c58b6e1f0a9d8c7b6a5",
    signedIn: true,
    signedOutMessage: null,
  };
}
const stored = load();
function store<K extends keyof Stored>(key: K, value: Stored[K]) {
  stored[key] = value;
  try {
    localStorage.setItem("deadwax-fake", JSON.stringify(stored));
  } catch {
    // Not kept, but this session carries on.
  }
}

// ---------- the scenario the dev panel changes ----------

export type Failure = "rateLimited" | "serverError" | "network" | "slow";

export type FakeDevice = { name: string; kind: string; awake: boolean; canPlay: boolean };

export type Scenario = {
  /** Every Spotify call fails, polling too. The collection still loads. */
  spotifyDown: boolean;
  /** How the next action (play, search, add, a control) goes wrong. */
  failNext: Failure | null;
  /** Play takes 1–3 seconds to start, or a slow 5–7. */
  slowStart: boolean;
  /** Sign-in in the browser goes wrong. */
  signInFails: boolean;
  devices: FakeDevice[];
};

export const scenario: Scenario = {
  spotifyDown: false,
  failNext: null,
  slowStart: false,
  signInFails: false,
  devices: [
    { name: "Kitchen", kind: "Speaker", awake: true, canPlay: true },
    { name: "Living Room", kind: "TV", awake: true, canPlay: false },
    { name: "Bedroom", kind: "Speaker", awake: false, canPlay: true },
    { name: "Will's MacBook Pro", kind: "Computer", awake: true, canPlay: true },
    { name: "Will's iPhone", kind: "Smartphone", awake: true, canPlay: true },
  ],
};

const listeners = new Set<() => void>();
/** Prototype only: hears every change, for the dev panel and the app. */
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const changed = () => listeners.forEach((fn) => fn());

/** Prototype only: changes the scenario. */
export function setScenario(patch: Partial<Scenario>) {
  Object.assign(scenario, patch);
  changed();
}

export function setAwake(name: string, awake: boolean) {
  scenario.devices = scenario.devices.map((d) => (d.name === name ? { ...d, awake } : d));
  // A speaker that falls asleep stops playing.
  if (!awake && play?.device === name) play = null;
  changed();
}

/** Prototype only: puts the account into a state, as the dev panel asks. */
export function setAccount(state: "needsClientId" | "signedOut" | "expired" | "signedIn") {
  if (state === "needsClientId") {
    store("clientId", null);
    store("signedIn", false);
    store("signedOutMessage", null);
  } else {
    if (!stored.clientId) store("clientId", defaults().clientId);
    store("signedIn", state === "signedIn");
    store(
      "signedOutMessage",
      state === "expired" ? "Your Spotify sign-in has expired. Sign in again to carry on." : null,
    );
  }
  if (state !== "signedIn") play = null;
  changed();
}

/** Prototype only: an empty collection (first run) or the fixture's. */
export function setCollection(which: "empty" | "full") {
  store("collection", which === "empty" ? [] : starter);
  changed();
}

export function forgetDevice() {
  store("remembered", null);
  changed();
}

export const remembered = () => stored.remembered;
export const accountState = () =>
  !stored.clientId ? "needsClientId" : stored.signedIn ? "signedIn" : "signedOut";

// ---------- how Spotify answers ----------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

const NETWORK = "Couldn't reach Spotify. Check the connection, then try again.";

/** Every Spotify call goes through here first. */
async function spotify(action: boolean, ms: [number, number] = [150, 450]) {
  await wait(between(...ms));
  if (stored.clientId === null || !stored.signedIn) throw "Sign in to Spotify first.";
  if (scenario.spotifyDown) throw NETWORK;
  if (!action || !scenario.failNext) return;
  const failure = scenario.failNext;
  scenario.failNext = null;
  changed();
  if (failure === "slow") {
    // A 429 with a short Retry-After: Rust waits it out, so it's only slow.
    await wait(5000);
    return;
  }
  throw failure === "rateLimited"
    ? "Spotify is rate limiting Deadwax. Try again in 40 seconds."
    : failure === "serverError"
      ? "Spotify had a problem (502). Try again in a moment."
      : NETWORK;
}

// ---------- the session ----------

export async function getSession(): Promise<Session> {
  await wait(120);
  if (!stored.clientId) return { state: "needsClientId" };
  if (!stored.signedIn) return { state: "signedOut", message: stored.signedOutMessage };
  return { state: "signedIn", name: "Will" };
}

export async function getClientId() {
  return stored.clientId;
}

export async function setClientId(clientId: string): Promise<Session> {
  await wait(200);
  const id = clientId.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    throw "That isn't a Spotify client ID. It's 32 letters and numbers, on your app's page.";
  }
  store("clientId", id);
  store("signedIn", false);
  store("signedOutMessage", null);
  changed();
  return { state: "signedOut", message: null };
}

let cancel: ((reason: string) => void) | null = null;

export function signIn(): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    cancel = reject;
    // The time it takes to agree in the browser.
    setTimeout(() => {
      if (cancel !== reject) return;
      cancel = null;
      if (scenario.spotifyDown) return reject(NETWORK);
      if (scenario.signInFails) return reject("Deadwax couldn't finish signing in. Try again.");
      store("signedIn", true);
      store("signedOutMessage", null);
      changed();
      resolve({ state: "signedIn", name: "Will" });
    }, 3200);
  });
}

export async function cancelSignIn() {
  cancel?.("Sign-in was cancelled.");
  cancel = null;
}

export async function openSpotifyDashboard() {
  window.open("https://developer.spotify.com/dashboard", "_blank", "noopener");
}

// ---------- the collection and search ----------

const card = (a: Album, size: "sm" | "lg" = "sm"): AlbumCard => ({
  id: a.id,
  title: a.title,
  artist: a.artist,
  year: a.year,
  coverUrl: `/covers/${a.id}-${size}.jpg`,
});
const inCollection = (id: string) => (stored.collection ?? []).includes(id);

export async function getCollection(): Promise<AlbumCard[]> {
  await wait(80);
  return (stored.collection ?? []).flatMap((id) => {
    const a = albums.get(id);
    return a ? [card(a)] : [];
  });
}

/** Spotify's page is 20. The fixture is small, so pages here are 12. */
const PAGE = 12;
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "");

export async function searchAlbums(query: string, offset: number): Promise<SearchResults> {
  await spotify(true, [350, 900]);
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], nextOffset: null };
  // Best match first: the artist's name, then the title, then anywhere.
  const scored = [...albums.values()].flatMap((a) => {
    const artist = fold(a.artist);
    const title = fold(a.title);
    const all = `${artist} ${title}`;
    if (!words.every((w) => all.includes(w))) return [];
    const q = words.join(" ");
    const score = artist === q ? 0 : artist.startsWith(q) ? 1 : title.startsWith(q) ? 2 : 3;
    return [{ a, score }];
  });
  scored.sort((x, y) => x.score - y.score || (x.a.year ?? 0) - (y.a.year ?? 0));
  const page = scored.slice(offset, offset + PAGE);
  return {
    results: page.map(({ a }) => ({ album: card(a), inCollection: inCollection(a.id) })),
    nextOffset: offset + PAGE < scored.length ? offset + PAGE : null,
  };
}

export async function addAlbum(id: string): Promise<AlbumCard> {
  await spotify(true, [400, 900]);
  const a = albums.get(id);
  if (!a) throw "Spotify doesn't have that album any more.";
  if (!inCollection(id)) store("collection", [...(stored.collection ?? []), id]);
  changed();
  return card(a);
}

const trackId = (albumId: string, disc: number, number: number) => `${albumId}:${disc}:${number}`;

export async function getAlbum(id: string): Promise<AlbumDetails> {
  await wait(60);
  const a = albums.get(id);
  if (!a || !inCollection(id)) throw "That album isn't in your collection.";
  return {
    ...card(a, "lg"),
    tracks: a.tracks.map((t) => ({ ...t, id: trackId(a.id, t.disc, t.number) })),
  };
}

// ---------- devices and playback ----------

type Play = {
  albumId: string;
  index: number;
  /** Where it was at `at`. */
  positionMs: number;
  at: number;
  playing: boolean;
  device: string;
  /** An advert is playing until then, with the album paused behind it. */
  advertUntil: number | null;
};
let play: Play | null = null;

function listed(): DeviceChoice[] {
  return scenario.devices
    .filter((d) => d.awake)
    .map((d) => ({
      name: d.name,
      kind: d.kind,
      isActive: play?.device === d.name,
      canPlay: d.canPlay,
    }));
}

/** Moves the clock on to now, through the album's tracks. */
function settle() {
  if (!play) return;
  const now = Date.now();
  if (play.advertUntil !== null) {
    if (now < play.advertUntil) return;
    play.advertUntil = null;
    play.at = now;
  }
  if (!play.playing) {
    play.at = now;
    return;
  }
  const album = albums.get(play.albumId)!;
  let pos = play.positionMs + (now - play.at);
  while (pos >= album.tracks[play.index].durationMs) {
    pos -= album.tracks[play.index].durationMs;
    if (++play.index >= album.tracks.length) {
      // The album has finished: Spotify stops on its last track.
      play.index = album.tracks.length - 1;
      pos = album.tracks[play.index].durationMs;
      play.playing = false;
      break;
    }
  }
  play.positionMs = pos;
  play.at = now;
}

export async function getDevices(): Promise<Devices> {
  await spotify(false, [300, 700]);
  return { devices: listed(), remembered: stored.remembered };
}

export async function chooseDevice(name: string) {
  await wait(50);
  store("remembered", name);
  changed();
}

export async function playAlbum(id: string, device: string, trackId: string | null): Promise<PlayOutcome> {
  await spotify(true, [250, 500]);
  const devices = listed();
  const target = devices.find((d) => d.name === device);
  // Rust asks for the device list first, and stops there if it's missing.
  if (!target) return { state: "deviceMissing", devices };
  if (!target.canPlay) throw `Spotify won't let Deadwax control ${device}. Play from the Spotify app instead.`;
  const album = albums.get(id);
  if (!album || !inCollection(id)) throw "That album isn't in your collection.";
  // Waking the speaker and starting the stream.
  await wait(scenario.slowStart ? between(5000, 7000) : between(1000, 3000));
  const index = trackId ? Math.max(0, album.tracks.findIndex((t) => trackIdOf(album, t) === trackId)) : 0;
  play = { albumId: id, index, positionMs: 0, at: Date.now(), playing: true, device, advertUntil: null };
  changed();
  return { state: "playing", devices };
}

const trackIdOf = (album: Album, t: Album["tracks"][number]) => trackId(album.id, t.disc, t.number);

export async function getPlayback(): Promise<NowPlaying | null> {
  await spotify(false, [80, 260]);
  settle();
  if (!play) return null;
  const device = scenario.devices.find((d) => d.name === play!.device);
  if (!device?.awake) return null;
  if (play.advertUntil !== null) {
    return { isPlaying: true, device: play.device, progressMs: 30000 - (play.advertUntil - Date.now()), track: null };
  }
  const album = albums.get(play.albumId)!;
  const track = album.tracks[play.index];
  const ours = inCollection(album.id);
  return {
    isPlaying: play.playing,
    device: play.device,
    progressMs: Math.round(play.positionMs),
    track: {
      title: track.title,
      artist: album.artist,
      album: album.title,
      albumId: album.id,
      durationMs: track.durationMs,
      coverUrl: `/covers/${album.id}-${ours ? "lg" : "sm"}.jpg`,
    },
  };
}

async function control(change: (p: Play) => void) {
  await spotify(true);
  settle();
  if (!play) throw "Nothing is playing.";
  change(play);
  changed();
}

export const pausePlayback = () => control((p) => (p.playing = false));
export const resumePlayback = () => control((p) => (p.playing = true));
export const nextTrack = () => control(skip(1));
export const previousTrack = () => control(skip(-1));

function skip(by: 1 | -1) {
  return (p: Play) => {
    const album = albums.get(p.albumId)!;
    // Like Spotify: previous goes back to the start of the track first.
    if (by === -1 && p.positionMs > 3000) {
      p.positionMs = 0;
      return;
    }
    p.index = Math.max(0, Math.min(album.tracks.length - 1, p.index + by));
    p.positionMs = 0;
    p.playing = true;
  };
}

// ---------- someone else, on their phone ----------

const pickFrom = (ids: string[], not?: string) => {
  const choices = ids.filter((id) => id !== not && albums.has(id));
  return choices[Math.floor(Math.random() * choices.length)];
};

/** Prototype only: what happens when Spotify is changed somewhere else. */
export const elsewhere = {
  skip() {
    settle();
    if (play) skip(1)(play);
    changed();
  },
  pause() {
    settle();
    if (play) play.playing = !play.playing;
    changed();
  },
  /** Another album from the collection. */
  playAnother() {
    const id = pickFrom(stored.collection ?? [], play?.albumId);
    if (id) start(id);
  },
  /** Something from Spotify that isn't in the collection. */
  playStranger() {
    const id = pickFrom([...albums.keys()].filter((id) => !inCollection(id)), play?.albumId);
    if (id) start(id);
  },
  advert() {
    settle();
    if (!play) start(pickFrom(stored.collection ?? []));
    play!.advertUntil = Date.now() + 30000;
    changed();
  },
  stop() {
    play = null;
    changed();
  },
  /** Moves playback to another device, as the Spotify app's picker would. */
  moveTo(device: string) {
    settle();
    if (play) play.device = device;
    changed();
  },
};

function start(id: string) {
  const device = play?.device ?? stored.remembered ?? "Kitchen";
  const album = albums.get(id)!;
  play = {
    albumId: id,
    index: Math.floor(Math.random() * Math.min(4, album.tracks.length)),
    positionMs: 0,
    at: Date.now(),
    playing: true,
    device,
    advertUntil: null,
  };
  changed();
}

/** Prototype only: the fake's own view, for the dev panel. */
export function peek() {
  settle();
  return { play, stored };
}
