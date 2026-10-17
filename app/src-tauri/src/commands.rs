//! The Tauri commands: everything the UI can ask Rust for.
//!
//! Every type a command returns is defined here, from plain values, so the
//! test in `command_types.rs` can check that none of them can carry a token.
//! Errors are plain sentences for the UI to show.
//!
//! Albums are named by their Deadwax ID (`AlbumId`, RFC-002). A Spotify ID
//! appears only where it says it's Spotify's (`spotify_id`): a search result
//! not yet collected, the album to add, and where Open in Spotify goes.
//!
//! The Develop menu's commands are in `dev`, in development builds only.

#[cfg(debug_assertions)]
pub mod dev;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use deadwax_core::collection::{self, AlbumId, Collected, Collection};
use deadwax_core::covers::{Size, Store};
use deadwax_sources::clock::{Clock, SystemClock};
use deadwax_sources::spotify::albums::{AlbumSummary, is_spotify_id};
use deadwax_sources::spotify::playback::{Device, Playback, StartAt};
use deadwax_sources::spotify::tokens::{KeychainStore, TokenStore};
use deadwax_sources::spotify::{Endpoints, Spotify, SpotifyError};
use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{Mutex, RwLock, oneshot};

use crate::config;
use crate::cover;
use crate::jobs::AlbumJobs;

type Client = Spotify<SystemClock, KeychainStore>;

/// Where you register your Spotify app.
const DASHBOARD_URL: &str = "https://developer.spotify.com/dashboard";

/// What the UI shows: the setup screen, the sign-in screen, or you.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Session {
    /// No client ID yet: show the setup screen.
    NeedsClientId,
    /// Show the sign-in screen, with `message` if there's something to say,
    /// such as the sign-in having expired.
    SignedOut {
        message: Option<String>,
    },
    SignedIn {
        name: String,
    },
}

/// Shown when Spotify has rejected the refresh token, after six months or
/// because access was revoked.
pub const EXPIRED_MESSAGE: &str = "Your Spotify sign-in has expired. Sign in again to carry on.";

pub struct AppState {
    config_path: PathBuf,
    /// A plain mutex: it's never held across an `await`. Shared with the
    /// album job queue's worker.
    collection: Arc<std::sync::Mutex<Collection>>,
    /// Each album's cover on disk, in sizes, which `cover://` serves.
    covers: Store,
    /// Looks up and downloads covers in the background (RFC-002).
    jobs: AlbumJobs,
    spotify: RwLock<Option<Arc<Client>>>,
    /// Dropping this cancels the sign-in that's waiting for the browser, and
    /// closes its listener.
    waiting_sign_in: Mutex<Option<oneshot::Sender<()>>>,
}

impl AppState {
    pub fn new(
        config_path: PathBuf,
        collection: Arc<std::sync::Mutex<Collection>>,
        covers: Store,
        jobs: AlbumJobs,
    ) -> Result<Self, String> {
        let config = config::load(&config_path)
            .map_err(|e| format!("Couldn't read Deadwax's config: {e}"))?;
        let spotify = config.spotify_client_id.map(client).transpose()?;
        Ok(Self {
            config_path,
            collection,
            covers,
            jobs,
            spotify: RwLock::new(spotify),
            waiting_sign_in: Mutex::new(None),
        })
    }

    pub fn covers(&self) -> &Store {
        &self.covers
    }

    async fn spotify(&self) -> Option<Arc<Client>> {
        self.spotify.read().await.clone()
    }

    async fn signed_in(&self) -> Result<Arc<Client>, String> {
        self.spotify()
            .await
            .ok_or_else(|| "Add your Spotify client ID first.".into())
    }
}

fn client(client_id: String) -> Result<Arc<Client>, String> {
    let store = KeychainStore::new().map_err(|e| e.to_string())?;
    Ok(Arc::new(Spotify::new(
        client_id,
        SystemClock,
        store,
        Endpoints::default(),
    )))
}

/// Where things stand: no client ID, signed out, or signed in as you (which
/// fetches your profile, refreshing the token if needed).
#[tauri::command]
pub async fn get_session(state: State<'_, AppState>) -> Result<Session, String> {
    let Some(spotify) = state.spotify().await else {
        return Ok(Session::NeedsClientId);
    };
    session(&spotify).await
}

async fn session<C: Clock, S: TokenStore>(spotify: &Spotify<C, S>) -> Result<Session, String> {
    if !spotify.has_tokens().map_err(|e| e.to_string())? {
        return Ok(Session::SignedOut { message: None });
    }
    match spotify.profile().await {
        Ok(profile) => Ok(Session::SignedIn { name: profile.name }),
        Err(SpotifyError::SignedOut) => Ok(Session::SignedOut {
            message: Some(EXPIRED_MESSAGE.into()),
        }),
        Err(SpotifyError::NotSignedIn) => Ok(Session::SignedOut { message: None }),
        Err(error) => Err(error.to_string()),
    }
}

/// The saved client ID, to fill in the setup screen when you change it.
#[tauri::command]
pub async fn get_client_id(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let config = config::load(&state.config_path).map_err(|e| e.to_string())?;
    Ok(config.spotify_client_id)
}

/// Saves a new client ID. A different one signs you out, because the old
/// tokens belong to the old Spotify app.
#[tauri::command]
pub async fn set_client_id(
    state: State<'_, AppState>,
    client_id: String,
) -> Result<Session, String> {
    let client_id = config::parse_client_id(&client_id)?;
    let mut spotify = state.spotify.write().await;
    let mut config = config::load(&state.config_path).map_err(|e| e.to_string())?;
    if config.spotify_client_id.as_deref() != Some(client_id.as_str()) {
        // A sign-in still waiting belongs to the old Spotify app.
        state.waiting_sign_in.lock().await.take();
        if let Some(old) = spotify.as_ref() {
            old.sign_out().map_err(|e| e.to_string())?;
        }
        config.spotify_client_id = Some(client_id.clone());
        config::save(&state.config_path, &config)
            .map_err(|e| format!("Couldn't save the client ID: {e}"))?;
        *spotify = Some(client(client_id)?);
    }
    let current = spotify.clone().expect("a client ID was just set");
    drop(spotify);
    session(&current).await
}

/// Signs in through the browser and returns the new session. Waits until you
/// approve in the browser, five minutes pass, or the sign-in is cancelled.
/// Starting a sign-in cancels one that's still waiting.
#[tauri::command]
pub async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<Session, String> {
    let spotify = state
        .spotify()
        .await
        .ok_or("Add your Spotify client ID first.")?;
    let (cancel, cancelled) = oneshot::channel();
    *state.waiting_sign_in.lock().await = Some(cancel);

    let signing_in = spotify.sign_in(|url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string())
    });
    tokio::select! {
        result = signing_in => result.map_err(|error| match error {
            SpotifyError::TimedOut => "Sign-in timed out. Try again when you're ready.".to_string(),
            error => format!("Couldn't sign in: {error}"),
        })?,
        _ = cancelled => return Err("Sign-in was cancelled.".into()),
    }
    session(&spotify).await
}

/// Stops waiting for the browser. Doing nothing is fine.
#[tauri::command]
pub async fn cancel_sign_in(state: State<'_, AppState>) -> Result<(), String> {
    state.waiting_sign_in.lock().await.take();
    Ok(())
}

/// Opens Spotify's developer dashboard in your browser.
#[tauri::command]
pub fn open_spotify_dashboard(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(DASHBOARD_URL, None::<&str>)
        .map_err(|e| e.to_string())
}

/// An album in your collection, as the grid shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCard {
    pub id: AlbumId,
    pub title: String,
    pub artist: String,
    pub year: Option<u16>,
    /// The 320 from disk (`cover://`) once the album's cover is there,
    /// otherwise Spotify's largest, about 640 pixels.
    pub cover_url: Option<String>,
}

/// The album's cover at `size` from disk once it's there, otherwise
/// Spotify's largest, about 640 pixels.
fn cover_url(collected: &Collected, size: Size) -> Option<String> {
    if collected.has_local_cover() {
        return Some(cover::url(&collected.id, size));
    }
    collected
        .album
        .largest_cover()
        .map(|cover| cover.url.clone())
}

impl From<Collected> for AlbumCard {
    fn from(collected: Collected) -> Self {
        let cover_url = cover_url(&collected, Size::Small);
        let Collected { id, album, .. } = collected;
        Self {
            cover_url,
            id,
            title: album.title,
            artist: album.artist,
            year: album.year,
        }
    }
}

/// An album as Spotify's search finds it. It has no Deadwax ID until it's
/// added, so it's named by its Spotify ID, which `add_album` takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchAlbum {
    pub spotify_id: String,
    pub title: String,
    pub artist: String,
    pub year: Option<u16>,
    /// Spotify's largest cover, about 640 pixels.
    pub cover_url: Option<String>,
}

impl From<AlbumSummary> for SearchAlbum {
    fn from(album: AlbumSummary) -> Self {
        Self {
            cover_url: collection::largest(&album.covers).map(|cover| cover.url.clone()),
            spotify_id: album.spotify_id,
            title: album.title,
            artist: album.artist,
            year: album.year,
        }
    }
}

/// One search result, and whether it's already in your collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub album: SearchAlbum,
    pub in_collection: bool,
}

/// A page of search results.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub results: Vec<SearchResult>,
    /// Pass this back as `offset` for the next page ("More"). `null` on the
    /// last page.
    pub next_offset: Option<u32>,
}

/// What the UI shows when a Spotify call fails.
fn spotify_error(error: SpotifyError) -> String {
    match error {
        SpotifyError::SignedOut => EXPIRED_MESSAGE.into(),
        SpotifyError::NotSignedIn => "Sign in to Spotify first.".into(),
        error => error.to_string(),
    }
}

fn collection_error(error: collection::CollectionError) -> String {
    format!("Couldn't update your collection: {error}")
}

/// Your collection, the most recently added first.
#[tauri::command]
pub fn get_collection(state: State<'_, AppState>) -> Result<Vec<AlbumCard>, String> {
    cards(&state.collection.lock().expect("collection lock"))
}

fn cards(collection: &Collection) -> Result<Vec<AlbumCard>, String> {
    Ok(collection
        .albums()
        .map_err(collection_error)?
        .into_iter()
        .map(AlbumCard::from)
        .collect())
}

/// Searches Spotify's albums, ten at a time from `offset`, marking the ones
/// already in your collection.
#[tauri::command]
pub async fn search_albums(
    state: State<'_, AppState>,
    query: String,
    offset: u32,
) -> Result<SearchResults, String> {
    let spotify = state.signed_in().await?;
    search(&spotify, &state.collection, &query, offset).await
}

async fn search<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    query: &str,
    offset: u32,
) -> Result<SearchResults, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResults {
            results: Vec::new(),
            next_offset: None,
        });
    }
    let page = spotify
        .search_albums(query, offset)
        .await
        .map_err(spotify_error)?;
    let owned = collection
        .lock()
        .expect("collection lock")
        .spotify_ids()
        .map_err(collection_error)?;
    let results = page
        .albums
        .into_iter()
        .map(|album| SearchResult {
            in_collection: owned.contains(&album.spotify_id),
            album: album.into(),
        })
        .collect();
    Ok(SearchResults {
        results,
        next_offset: page.next_offset,
    })
}

/// Fetches the album with this Spotify ID, adds it to your collection with
/// a new Deadwax ID, and returns it for the grid. Adding one that's already
/// there refreshes its cache and keeps its Deadwax ID. It's queued for the
/// album job queue, which looks up and downloads its cover.
#[tauri::command]
pub async fn add_album(
    state: State<'_, AppState>,
    spotify_id: String,
) -> Result<AlbumCard, String> {
    let spotify = state.signed_in().await?;
    add_and_queue(
        &spotify,
        &state.collection,
        &state.jobs,
        &spotify_id,
        SystemTime::now(),
    )
    .await
}

/// Adds the album, then queues its jobs.
async fn add_and_queue<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    jobs: &AlbumJobs,
    spotify_id: &str,
    now: SystemTime,
) -> Result<AlbumCard, String> {
    let card = add(spotify, collection, spotify_id, now).await?;
    jobs.queue(&card.id);
    Ok(card)
}

async fn add<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    spotify_id: &str,
    now: SystemTime,
) -> Result<AlbumCard, String> {
    let album = spotify.album(spotify_id).await.map_err(spotify_error)?;
    let mut collection = collection.lock().expect("collection lock");
    let added = collection.add(&album, now).map_err(collection_error)?;
    collected(&collection, added.id()).map(AlbumCard::from)
}

/// An album as the album page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPage {
    pub id: AlbumId,
    /// Where Open in Spotify goes.
    pub spotify_id: String,
    pub title: String,
    pub artist: String,
    pub year: Option<u16>,
    /// The 1600 from disk (`cover://`) once the album's cover is there,
    /// otherwise Spotify's largest, about 640 pixels.
    pub cover_url: Option<String>,
    pub tracks: Vec<AlbumTrack>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumTrack {
    /// Tracks have no Deadwax IDs: this is what `play_album` starts from.
    pub spotify_id: String,
    pub disc: u32,
    pub number: u32,
    pub title: String,
    pub duration_ms: u64,
}

impl From<Collected> for AlbumPage {
    fn from(collected: Collected) -> Self {
        let cover_url = cover_url(&collected, Size::Large);
        let Collected { id, album, .. } = collected;
        Self {
            cover_url,
            id,
            spotify_id: album.spotify_id,
            title: album.title,
            artist: album.artist,
            year: album.year,
            tracks: album
                .tracks
                .into_iter()
                .map(|track| AlbumTrack {
                    spotify_id: track.spotify_id,
                    disc: track.disc,
                    number: track.number,
                    title: track.title,
                    duration_ms: track.duration_ms,
                })
                .collect(),
        }
    }
}

const NOT_IN_COLLECTION: &str = "That album isn't in your collection.";

/// The album page, from the cache. It never asks Spotify: `refresh_album`
/// does that when the cache is old. An album with steps left is queued, in
/// case one failed, and `ALBUM_UPDATED` says when its cover is on disk or
/// its palette, genre and label are stored.
#[tauri::command]
pub fn get_album(state: State<'_, AppState>, id: AlbumId) -> Result<AlbumPage, String> {
    open_album(&state.collection, &state.jobs, &id)
}

fn open_album(
    collection: &std::sync::Mutex<Collection>,
    jobs: &AlbumJobs,
    id: &AlbumId,
) -> Result<AlbumPage, String> {
    let collected = collected(&collection.lock().expect("collection lock"), id)?;
    if !collected.unfinished().is_empty() {
        jobs.queue(id);
    }
    Ok(collected.into())
}

fn collected(collection: &Collection, id: &AlbumId) -> Result<Collected, String> {
    collection
        .get(id)
        .map_err(collection_error)?
        .ok_or_else(|| NOT_IN_COLLECTION.into())
}

fn album_page(
    collection: &std::sync::Mutex<Collection>,
    id: &AlbumId,
) -> Result<AlbumPage, String> {
    collected(&collection.lock().expect("collection lock"), id).map(AlbumPage::from)
}

/// Fetches the album from Spotify again if its cache is over a week old,
/// and returns the updated page. `None` if the cache was fresh enough, so
/// nothing was fetched.
#[tauri::command]
pub async fn refresh_album(
    state: State<'_, AppState>,
    id: AlbumId,
) -> Result<Option<AlbumPage>, String> {
    let spotify = state.signed_in().await?;
    refresh(&spotify, &state.collection, &id, SystemTime::now()).await
}

async fn refresh<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    id: &AlbumId,
    now: SystemTime,
) -> Result<Option<AlbumPage>, String> {
    let cached = collected(&collection.lock().expect("collection lock"), id)?;
    if !cached.is_stale(now) {
        return Ok(None);
    }
    let album = spotify
        .album(&cached.album.spotify_id)
        .await
        .map_err(spotify_error)?;
    let collected = collection
        .lock()
        .expect("collection lock")
        .refresh(id, &album, now)
        .map_err(collection_error)?;
    if !collected {
        // Removed while it was being fetched.
        return Err(NOT_IN_COLLECTION.into());
    }
    // From the collection, which has the artwork too.
    album_page(collection, id).map(Some)
}

/// Takes the album out of your collection. Removing one that isn't there is
/// fine.
#[tauri::command]
pub fn remove_album(state: State<'_, AppState>, id: AlbumId) -> Result<(), String> {
    remove(&state.collection, &state.covers, &id)
}

/// Takes the album out of the collection, then deletes its covers.
fn remove(
    collection: &std::sync::Mutex<Collection>,
    covers: &Store,
    id: &AlbumId,
) -> Result<(), String> {
    collection
        .lock()
        .expect("collection lock")
        .remove(id)
        .map_err(collection_error)?;
    covers
        .remove(id)
        .map_err(|e| format!("Couldn't delete the album's covers: {e}"))
}

/// The album's page on Spotify. Spotify's developer policy wants every album
/// page to link back to it (RFC-001, "Spotify's attribution rules").
fn spotify_album_url(spotify_id: &str) -> Result<String, String> {
    // Spotify IDs are base 62, so nothing in one can change the URL.
    if !is_spotify_id(spotify_id) {
        return Err(format!("\"{spotify_id}\" isn't a Spotify album ID."));
    }
    Ok(format!("https://open.spotify.com/album/{spotify_id}"))
}

/// Opens the album with this Spotify ID on Spotify, in your browser or the
/// Spotify app. Now playing uses it for albums outside the collection too.
#[tauri::command]
pub fn open_album_in_spotify(app: AppHandle, spotify_id: String) -> Result<(), String> {
    app.opener()
        .open_url(spotify_album_url(&spotify_id)?, None::<&str>)
        .map_err(|e| e.to_string())
}

/// A Spotify Connect device, as the device picker shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChoice {
    pub name: String,
    /// "Speaker", "TV", "Computer" and so on.
    pub kind: String,
    /// The device playing, or last to play.
    pub is_active: bool,
    /// Spotify will take commands for it. Some devices are listed but
    /// can't be controlled.
    pub can_play: bool,
}

impl From<Device> for DeviceChoice {
    fn from(device: Device) -> Self {
        Self {
            can_play: device.id.is_some() && !device.is_restricted,
            name: device.name,
            kind: device.kind,
            is_active: device.is_active,
        }
    }
}

/// The device picker: what Spotify lists now, and the device you chose
/// last, which may not be among them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub devices: Vec<DeviceChoice>,
    pub remembered: Option<String>,
}

/// What happened when you pressed Play. Either way, `devices` is the list
/// as Spotify gave it just before playing, for the picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PlayOutcome {
    Playing {
        devices: Vec<DeviceChoice>,
    },
    /// Spotify isn't listing the device. Not a failure: it's asleep or
    /// offline, and waking it is up to you.
    DeviceMissing {
        devices: Vec<DeviceChoice>,
    },
}

/// What Spotify is playing, for the playback bar and now playing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub is_playing: bool,
    pub device: Option<String>,
    pub progress_ms: Option<u64>,
    /// `None` for an advert or anything else Spotify won't describe.
    pub track: Option<NowPlayingTrack>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingTrack {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    /// The album's Deadwax ID, if it's in the collection.
    pub album_id: Option<AlbumId>,
    /// Where Open in Spotify goes, whether or not it's in the collection.
    pub spotify_album_id: Option<String>,
    pub duration_ms: u64,
    /// The album's 1600 from disk (`cover://`) if it's in the collection and
    /// its cover is there, otherwise Spotify's largest, about 640 pixels.
    pub cover_url: Option<String>,
}

/// What's playing, with the cover from disk when the album is in the
/// collection and its cover is there. An album played from elsewhere may
/// not be in the collection, so Spotify's cover is the fallback.
fn now_playing(playback: Playback, collection: &std::sync::Mutex<Collection>) -> NowPlaying {
    NowPlaying {
        is_playing: playback.is_playing,
        device: playback.device,
        progress_ms: playback.progress_ms,
        track: playback.track.map(|track| {
            let Some(album) = track.album else {
                return NowPlayingTrack {
                    title: track.title,
                    artist: track.artist,
                    album: None,
                    album_id: None,
                    spotify_album_id: None,
                    duration_ms: track.duration_ms,
                    cover_url: None,
                };
            };
            let collected = collection
                .lock()
                .expect("collection lock")
                .get_by_spotify_id(&album.spotify_id)
                // Only the ID and cover depend on this: it's played as an
                // album outside the collection.
                .ok()
                .flatten();
            let album_id = collected.as_ref().map(|c| c.id.clone());
            let local = collected
                .filter(Collected::has_local_cover)
                .map(|collected| cover::url(&collected.id, Size::Large));
            NowPlayingTrack {
                title: track.title,
                artist: track.artist,
                cover_url: local
                    .or_else(|| collection::largest(&album.covers).map(|cover| cover.url.clone())),
                album: Some(album.title),
                album_id,
                spotify_album_id: Some(album.spotify_id),
                duration_ms: track.duration_ms,
            }
        }),
    }
}

fn remembered_device(config_path: &std::path::Path) -> Result<Option<String>, String> {
    Ok(config::load(config_path)
        .map_err(|e| format!("Couldn't read Deadwax's config: {e}"))?
        .last_device)
}

fn remember_device(config_path: &std::path::Path, name: &str) -> Result<(), String> {
    let mut config =
        config::load(config_path).map_err(|e| format!("Couldn't read Deadwax's config: {e}"))?;
    if config.last_device.as_deref() == Some(name) {
        return Ok(());
    }
    config.last_device = Some(name.to_owned());
    config::save(config_path, &config).map_err(|e| format!("Couldn't remember the device: {e}"))
}

/// The devices Spotify lists now, and the one you chose last.
#[tauri::command]
pub async fn get_devices(state: State<'_, AppState>) -> Result<Devices, String> {
    let spotify = state.signed_in().await?;
    devices(&spotify, &state.config_path).await
}

async fn devices<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    config_path: &std::path::Path,
) -> Result<Devices, String> {
    let devices = spotify.devices().await.map_err(spotify_error)?;
    Ok(Devices {
        devices: devices.into_iter().map(DeviceChoice::from).collect(),
        remembered: remembered_device(config_path)?,
    })
}

/// Remembers the device you chose in the picker, by name.
#[tauri::command]
pub fn choose_device(state: State<'_, AppState>, name: String) -> Result<(), String> {
    remember_device(&state.config_path, &name)
}

/// Plays the album in your collection on the device with this name, from
/// the first track or the track with this Spotify ID. Asks Spotify for its
/// devices first, because the picker's list may be old and device IDs don't
/// last.
#[tauri::command]
pub async fn play_album(
    state: State<'_, AppState>,
    id: AlbumId,
    device: String,
    track_id: Option<String>,
) -> Result<PlayOutcome, String> {
    let spotify = state.signed_in().await?;
    play_collected(
        &spotify,
        &state.collection,
        &state.config_path,
        &id,
        &device,
        track_id,
    )
    .await
}

/// Plays the collected album from its Spotify ID.
async fn play_collected<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    config_path: &std::path::Path,
    id: &AlbumId,
    device_name: &str,
    track_id: Option<String>,
) -> Result<PlayOutcome, String> {
    let spotify_id = collected(&collection.lock().expect("collection lock"), id)?
        .album
        .spotify_id;
    play(spotify, config_path, &spotify_id, device_name, track_id).await
}

async fn play<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    config_path: &std::path::Path,
    spotify_album_id: &str,
    device_name: &str,
    track_id: Option<String>,
) -> Result<PlayOutcome, String> {
    let listed = spotify.devices().await.map_err(spotify_error)?;
    // Two devices can share a name. Prefer one that can play.
    let named = || listed.iter().filter(|d| d.name == device_name);
    let device = named()
        .find(|d| d.id.is_some() && !d.is_restricted)
        .or_else(|| named().next())
        .cloned();
    let choices = || listed.iter().cloned().map(DeviceChoice::from).collect();
    let Some(device) = device else {
        return Ok(PlayOutcome::DeviceMissing { devices: choices() });
    };
    let Some(device_id) = device.id.as_deref().filter(|_| !device.is_restricted) else {
        return Err(format!(
            "Spotify won't let Deadwax control {device_name}. Play from the Spotify app instead."
        ));
    };
    let start = match track_id {
        Some(id) => StartAt::Track(id),
        None => StartAt::FirstTrack,
    };
    spotify
        .play_album(device_id, spotify_album_id, &start)
        .await
        .map_err(spotify_error)?;
    remember_device(config_path, device_name)?;
    Ok(PlayOutcome::Playing { devices: choices() })
}

/// What Spotify is playing, anywhere, or `None` if nothing is. The playback
/// bar asks every couple of seconds while it's on screen.
#[tauri::command]
pub async fn get_playback(state: State<'_, AppState>) -> Result<Option<NowPlaying>, String> {
    let spotify = state.signed_in().await?;
    Ok(spotify
        .playback()
        .await
        .map_err(spotify_error)?
        .map(|playback| now_playing(playback, &state.collection)))
}

/// Opens or leaves now playing's fullscreen. It's macOS's "simple"
/// fullscreen, which fills the screen without the animation into a new
/// Space (RFC-001, "Now playing").
#[tauri::command]
pub fn set_now_playing_fullscreen(window: WebviewWindow, fullscreen: bool) -> Result<(), String> {
    window
        .set_simple_fullscreen(fullscreen)
        .map_err(|e| format!("Couldn't change fullscreen: {e}"))
}

#[tauri::command]
pub async fn pause_playback(state: State<'_, AppState>) -> Result<(), String> {
    let spotify = state.signed_in().await?;
    spotify.pause().await.map_err(spotify_error)
}

#[tauri::command]
pub async fn resume_playback(state: State<'_, AppState>) -> Result<(), String> {
    let spotify = state.signed_in().await?;
    spotify.resume().await.map_err(spotify_error)
}

#[tauri::command]
pub async fn next_track(state: State<'_, AppState>) -> Result<(), String> {
    let spotify = state.signed_in().await?;
    spotify.next().await.map_err(spotify_error)
}

#[tauri::command]
pub async fn previous_track(state: State<'_, AppState>) -> Result<(), String> {
    let spotify = state.signed_in().await?;
    spotify.previous().await.map_err(spotify_error)
}

#[cfg(test)]
mod tests {
    use deadwax_sources::spotify::pkce::Verifier;
    use deadwax_sources::spotify::tokens::MemoryStore;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    /// A client against a fake Spotify whose sign-in gives a token that has
    /// already expired, and whose token refresh replies `refresh`.
    pub(super) async fn signed_in_with_expired_token(
        server: &MockServer,
        refresh: ResponseTemplate,
    ) -> Spotify<SystemClock, MemoryStore> {
        Mock::given(method("POST"))
            .and(path("/api/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "access", "refresh_token": "refresh", "expires_in": 0,
            })))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(refresh)
            .mount(server)
            .await;
        let endpoints = Endpoints {
            accounts: server.uri(),
            api: server.uri(),
            redirect_port: 0,
        };
        let spotify = Spotify::new("id".into(), SystemClock, MemoryStore::default(), endpoints);
        spotify
            .exchange_code("code", "http://127.0.0.1:1/callback", &Verifier::generate())
            .await
            .unwrap();
        spotify
    }

    #[tokio::test]
    async fn an_expired_sign_in_is_the_sign_in_screen_with_a_plain_message() {
        let server = MockServer::start().await;
        let rejected = ResponseTemplate::new(400).set_body_json(json!({
            "error": "invalid_grant", "error_description": "Refresh token revoked",
        }));
        let spotify = signed_in_with_expired_token(&server, rejected).await;

        assert_eq!(
            session(&spotify).await,
            Ok(Session::SignedOut {
                message: Some(EXPIRED_MESSAGE.into())
            })
        );
        // Signed out for good: the next look is the plain sign-in screen.
        assert_eq!(
            session(&spotify).await,
            Ok(Session::SignedOut { message: None })
        );
    }

    #[tokio::test]
    async fn a_working_sign_in_is_your_name() {
        let server = MockServer::start().await;
        let refreshed = ResponseTemplate::new(200)
            .set_body_json(json!({"access_token": "new", "expires_in": 3600}));
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"id": "w", "display_name": "Will"})),
            )
            .mount(&server)
            .await;
        let spotify = signed_in_with_expired_token(&server, refreshed).await;

        assert_eq!(
            session(&spotify).await,
            Ok(Session::SignedIn {
                name: "Will".into()
            })
        );
    }

    #[tokio::test]
    async fn other_failures_are_errors() {
        let server = MockServer::start().await;
        let spotify = signed_in_with_expired_token(&server, ResponseTemplate::new(503)).await;

        assert!(session(&spotify).await.is_err());
    }

    #[tokio::test]
    async fn no_tokens_is_the_sign_in_screen() {
        let spotify = Spotify::new(
            "id".into(),
            SystemClock,
            MemoryStore::default(),
            Endpoints::default(),
        );
        assert_eq!(
            session(&spotify).await,
            Ok(Session::SignedOut { message: None })
        );
    }

    /// The redirect URI you register is the one sign-in uses, and the one the
    /// setup screen tells you to register.
    #[test]
    fn sign_in_uses_the_redirect_uri_the_setup_screen_shows() {
        use deadwax_sources::spotify::loopback::REDIRECT_PORT;

        assert_eq!(REDIRECT_PORT, 43117);
        assert_eq!(Endpoints::default().redirect_port, REDIRECT_PORT);
        let setup = include_str!("../../src/Setup.tsx");
        assert!(setup.contains(&format!("http://127.0.0.1:{REDIRECT_PORT}/callback")));
    }

    const FIXTURES: &str = "../../crates/deadwax-sources/src/spotify/fixtures";
    pub(super) const IN_RAINBOWS: &str = "5vkqYmiPBYLaalcmjujWxK";

    pub(super) fn fixture(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(FIXTURES)
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Signed in to a fake Spotify that answers search and the album with the
    /// hand-written fixtures in `deadwax-sources`.
    pub(super) async fn fake_spotify(server: &MockServer) -> Spotify<SystemClock, MemoryStore> {
        let fresh = ResponseTemplate::new(200)
            .set_body_json(json!({"access_token": "fresh", "expires_in": 3600}));
        let spotify = signed_in_with_expired_token(server, fresh).await;
        for (offset, name) in [
            ("0", "search-albums-in-rainbows-0.json"),
            ("10", "search-albums-in-rainbows-10.json"),
        ] {
            Mock::given(method("GET"))
                .and(path("/v1/search"))
                .and(query_param("offset", offset))
                .respond_with(ResponseTemplate::new(200).set_body_json(fixture(name)))
                .mount(server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path(format!("/v1/albums/{IN_RAINBOWS}")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(fixture("album-in-rainbows.json")),
            )
            .mount(server)
            .await;
        spotify
    }

    fn empty_collection() -> std::sync::Mutex<Collection> {
        std::sync::Mutex::new(Collection::open_in_memory().unwrap())
    }

    const IN_RAINBOWS_COVER: &str =
        "https://i.scdn.co/image/ab67616d0000b273de3c04b5fc750b68899b20a9";

    /// In Rainbows in the grid, with the Deadwax ID it was given.
    fn in_rainbows_card(id: &AlbumId) -> AlbumCard {
        AlbumCard {
            id: id.clone(),
            title: "In Rainbows".into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            cover_url: Some(IN_RAINBOWS_COVER.into()),
        }
    }

    /// In Rainbows as search finds it, by its Spotify ID.
    fn in_rainbows_found() -> SearchAlbum {
        SearchAlbum {
            spotify_id: IN_RAINBOWS.into(),
            title: "In Rainbows".into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            cover_url: Some(IN_RAINBOWS_COVER.into()),
        }
    }

    /// In Rainbows' Deadwax ID in this collection.
    pub(super) fn in_rainbows_id(collection: &std::sync::Mutex<Collection>) -> AlbumId {
        collection
            .lock()
            .unwrap()
            .get_by_spotify_id(IN_RAINBOWS)
            .unwrap()
            .expect("In Rainbows is collected")
            .id
    }

    #[tokio::test]
    async fn search_pages_ten_at_a_time_with_640_covers() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = empty_collection();

        let first = search(&spotify, &collection, "in rainbows", 0)
            .await
            .unwrap();
        assert_eq!(first.results.len(), 10);
        assert_eq!(first.next_offset, Some(10));
        assert_eq!(first.results[0].album, in_rainbows_found());
        assert!(first.results.iter().all(|r| !r.in_collection));

        let more = search(&spotify, &collection, "in rainbows", 10)
            .await
            .unwrap();
        assert_eq!(more.results.len(), 2);
        assert_eq!(more.next_offset, None);
    }

    #[tokio::test]
    async fn search_marks_the_albums_already_in_the_collection() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = empty_collection();
        add(&spotify, &collection, IN_RAINBOWS, SystemTime::now())
            .await
            .unwrap();

        let page = search(&spotify, &collection, "in rainbows", 0)
            .await
            .unwrap();

        let marked: Vec<&str> = page
            .results
            .iter()
            .filter(|r| r.in_collection)
            .map(|r| r.album.spotify_id.as_str())
            .collect();
        assert_eq!(marked, [IN_RAINBOWS]);
    }

    #[tokio::test]
    async fn an_empty_search_asks_spotify_nothing() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let before = server.received_requests().await.unwrap().len();

        let page = search(&spotify, &empty_collection(), "   ", 0)
            .await
            .unwrap();

        assert!(page.results.is_empty());
        assert_eq!(page.next_offset, None);
        assert_eq!(server.received_requests().await.unwrap().len(), before);
    }

    #[tokio::test]
    async fn adding_fetches_the_album_and_puts_it_in_the_grid_with_a_deadwax_id() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = empty_collection();

        let added = add(&spotify, &collection, IN_RAINBOWS, SystemTime::now())
            .await
            .unwrap();

        let id = in_rainbows_id(&collection);
        assert_ne!(id.as_str(), IN_RAINBOWS);
        assert_eq!(added, in_rainbows_card(&id));
        let albums_fetched = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path().starts_with("/v1/albums"))
            .count();
        let collection = collection.lock().unwrap();
        assert_eq!(cards(&collection).unwrap(), [in_rainbows_card(&id)]);
        // The whole album is cached, for the album page (DWX-4).
        let cached = collection.get(&id).unwrap().unwrap().album;
        assert_eq!(cached.tracks.len(), 10);
        assert_eq!(cached.upc.as_deref(), Some("634904032463"));
        assert_eq!(albums_fetched, 1);
    }

    #[tokio::test]
    async fn a_failed_add_leaves_the_collection_alone() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = empty_collection();

        let missing = "0000000000000000000000";
        let error = add(&spotify, &collection, missing, SystemTime::now())
            .await
            .unwrap_err();

        assert!(error.contains("404"), "{error}");
        assert!(cards(&collection.lock().unwrap()).unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_expired_sign_in_while_searching_says_so_plainly() {
        let server = MockServer::start().await;
        let rejected = ResponseTemplate::new(400).set_body_json(json!({"error": "invalid_grant"}));
        let spotify = signed_in_with_expired_token(&server, rejected).await;

        assert_eq!(
            search(&spotify, &empty_collection(), "in rainbows", 0).await,
            Err(EXPIRED_MESSAGE.into())
        );
    }

    const DAY: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

    /// A fixed point in time: these tests' clock.
    fn day(n: u32) -> SystemTime {
        SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_790_000_000) + DAY * n
    }

    /// A collection holding In Rainbows, cached at `fetched` under an older
    /// title, so a refresh shows.
    async fn collection_with_in_rainbows(
        spotify: &Spotify<SystemClock, MemoryStore>,
        fetched: SystemTime,
    ) -> std::sync::Mutex<Collection> {
        let mut album = spotify.album(IN_RAINBOWS).await.unwrap();
        album.title = "In Rainbows (old title)".into();
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album, fetched).unwrap();
        std::sync::Mutex::new(collection)
    }

    async fn albums_fetched(server: &MockServer) -> usize {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path().starts_with("/v1/albums"))
            .count()
    }

    #[tokio::test]
    async fn the_album_page_comes_from_the_cache() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let before = albums_fetched(&server).await;

        let id = in_rainbows_id(&collection);
        let page = album_page(&collection, &id).unwrap();

        assert_eq!(page.id, id);
        assert_eq!(page.spotify_id, IN_RAINBOWS);
        assert_eq!(page.title, "In Rainbows (old title)");
        assert_eq!(page.artist, "Radiohead");
        assert_eq!(page.year, Some(2007));
        assert_eq!(page.cover_url.as_deref(), Some(IN_RAINBOWS_COVER));
        assert_eq!(page.tracks.len(), 10);
        assert_eq!(
            page.tracks[0],
            AlbumTrack {
                spotify_id: page.tracks[0].spotify_id.clone(),
                disc: 1,
                number: 1,
                title: "15 Step".into(),
                duration_ms: 237_293,
            }
        );
        assert_eq!(albums_fetched(&server).await, before);
    }

    #[tokio::test]
    async fn an_album_not_in_the_collection_has_no_page() {
        assert_eq!(
            album_page(&empty_collection(), &AlbumId::new()),
            Err(NOT_IN_COLLECTION.into())
        );
        // Not even by its Spotify ID.
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        assert_eq!(
            album_page(&collection, &IN_RAINBOWS.into()),
            Err(NOT_IN_COLLECTION.into())
        );
    }

    #[tokio::test]
    async fn adding_an_album_queues_its_jobs() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = empty_collection();
        let (jobs, mut queued) = AlbumJobs::unstarted();

        add_and_queue(&spotify, &collection, &jobs, IN_RAINBOWS, day(1))
            .await
            .unwrap();

        assert_eq!(
            AlbumJobs::queued(&mut queued),
            [in_rainbows_id(&collection)]
        );
    }

    #[tokio::test]
    async fn an_album_that_couldnt_be_added_isnt_queued() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let (jobs, mut queued) = AlbumJobs::unstarted();

        let added = add_and_queue(
            &spotify,
            &empty_collection(),
            &jobs,
            "0000000000000000000000",
            day(1),
        )
        .await;

        assert!(added.is_err());
        assert!(AlbumJobs::queued(&mut queued).is_empty());
    }

    #[tokio::test]
    async fn opening_an_album_with_steps_left_queues_it_and_a_finished_one_doesnt() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let id = in_rainbows_id(&collection);

        let (jobs, mut queued) = AlbumJobs::unstarted();
        open_album(&collection, &jobs, &id).unwrap();
        assert_eq!(AlbumJobs::queued(&mut queued), std::slice::from_ref(&id));

        // The lookup alone isn't enough: the sizes are still to make.
        found_on_itunes(&collection);
        let (jobs, mut queued) = AlbumJobs::unstarted();
        open_album(&collection, &jobs, &id).unwrap();
        assert_eq!(AlbumJobs::queued(&mut queued), std::slice::from_ref(&id));

        // Nor the sizes: the palette, genre and label are still to find.
        sizes_made(&collection);
        let (jobs, mut queued) = AlbumJobs::unstarted();
        open_album(&collection, &jobs, &id).unwrap();
        assert_eq!(AlbumJobs::queued(&mut queued), std::slice::from_ref(&id));

        palette_genre_and_label_found(&collection);
        let (jobs, mut queued) = AlbumJobs::unstarted();
        let page = open_album(&collection, &jobs, &id).unwrap();
        assert!(AlbumJobs::queued(&mut queued).is_empty());
        assert_eq!(page.cover_url, Some(format!("cover://localhost/{id}/1600")));
    }

    fn found_on_itunes(collection: &std::sync::Mutex<Collection>) {
        let artwork = collection::Artwork {
            source: collection::ArtworkSource::Itunes,
            cover: Some(collection::Cover {
                url: "https://is1-ssl.mzstatic.com/image/thumb/x/10000x10000bb.jpg".into(),
                width: Some(4000),
                height: Some(4000),
            }),
        };
        let id = in_rainbows_id(collection);
        let stored = collection
            .lock()
            .unwrap()
            .set_artwork(&id, &artwork, day(2))
            .unwrap();
        assert!(stored);
    }

    /// Records In Rainbows' palette, genre and label, as the album job queue
    /// does once it has found them.
    fn palette_genre_and_label_found(collection: &std::sync::Mutex<Collection>) {
        let id = in_rainbows_id(collection);
        let mut collection = collection.lock().unwrap();
        let palette = deadwax_core::palette::Palette::neutral();
        assert!(collection.set_palette(&id, &palette, day(2)).unwrap());
        let found = collection::GenreAndLabel::default();
        assert!(collection.set_genre_and_label(&id, &found, day(2)).unwrap());
    }

    /// Records that In Rainbows' sizes are on disk, as the album job queue
    /// does once it has saved them.
    fn sizes_made(collection: &std::sync::Mutex<Collection>) {
        let id = in_rainbows_id(collection);
        let recorded = collection
            .lock()
            .unwrap()
            .finish(&id, collection::Step::Sizes, day(2))
            .unwrap();
        assert!(recorded);
    }

    #[tokio::test]
    async fn once_its_cover_is_on_disk_the_grid_has_the_320_and_the_album_page_the_1600() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        found_on_itunes(&collection);
        sizes_made(&collection);
        let id = in_rainbows_id(&collection);

        let page = album_page(&collection, &id).unwrap();
        let grid = cards(&collection.lock().unwrap()).unwrap();

        assert_eq!(page.cover_url, Some(format!("cover://localhost/{id}/1600")));
        assert_eq!(
            grid[0].cover_url,
            Some(format!("cover://localhost/{id}/320"))
        );
    }

    #[tokio::test]
    async fn until_its_cover_is_on_disk_an_album_shows_spotifys() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let id = in_rainbows_id(&collection);
        let shown = || {
            let page = album_page(&collection, &id).unwrap();
            let grid = cards(&collection.lock().unwrap()).unwrap();
            (page.cover_url, grid[0].cover_url.clone())
        };
        let spotifys = Some(IN_RAINBOWS_COVER.to_owned());

        assert_eq!(shown(), (spotifys.clone(), spotifys.clone()));
        // Found, but not downloaded yet.
        found_on_itunes(&collection);
        assert_eq!(shown(), (spotifys.clone(), spotifys));
    }

    #[tokio::test]
    async fn spotifys_cover_is_the_fallback_on_the_album_page() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let spotifys = collection::Artwork {
            source: collection::ArtworkSource::Spotify,
            cover: None,
        };
        let id = in_rainbows_id(&collection);
        collection
            .lock()
            .unwrap()
            .set_artwork(&id, &spotifys, day(2))
            .unwrap();
        sizes_made(&collection);

        let page = album_page(&collection, &id).unwrap();

        assert_eq!(page.cover_url.as_deref(), Some(IN_RAINBOWS_COVER));
    }

    #[tokio::test]
    async fn a_refreshed_page_keeps_the_cover_from_disk() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        found_on_itunes(&collection);
        sizes_made(&collection);
        let id = in_rainbows_id(&collection);

        let page = refresh(&spotify, &collection, &id, day(30))
            .await
            .unwrap()
            .expect("a stale cache is fetched again");

        assert_eq!(page.title, "In Rainbows");
        assert_eq!(page.cover_url, Some(format!("cover://localhost/{id}/1600")));
    }

    #[tokio::test]
    async fn removing_an_album_deletes_its_covers() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let id = in_rainbows_id(&collection);
        let dir = tempfile::tempdir().unwrap();
        let covers = Store::new(dir.path().join("artwork"));
        let renditions =
            deadwax_core::covers::make(&deadwax_core::covers::testing::jpeg(400, 400)).unwrap();
        covers.save(&id, &renditions).unwrap();

        remove(&collection, &covers, &id).unwrap();

        assert!(!collection.lock().unwrap().contains(&id).unwrap());
        assert!(!dir.path().join("artwork").join(id.as_str()).exists());
        // Removing it again is fine.
        remove(&collection, &covers, &id).unwrap();
    }

    #[tokio::test]
    async fn a_cache_up_to_a_week_old_isnt_fetched_again() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let before = albums_fetched(&server).await;
        let id = in_rainbows_id(&collection);

        assert_eq!(refresh(&spotify, &collection, &id, day(8)).await, Ok(None));

        assert_eq!(albums_fetched(&server).await, before);
        let cached = collection.lock().unwrap().get(&id).unwrap().unwrap();
        assert_eq!(cached.fetched_at, day(1));
    }

    #[tokio::test]
    async fn a_cache_over_a_week_old_is_fetched_again_and_updates_the_page() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let before = albums_fetched(&server).await;
        let now = day(8) + std::time::Duration::from_secs(1);
        let id = in_rainbows_id(&collection);

        let page = refresh(&spotify, &collection, &id, now)
            .await
            .unwrap()
            .expect("a stale cache is fetched again");

        assert_eq!(page.id, id);
        assert_eq!(page.title, "In Rainbows");
        assert_eq!(page.tracks.len(), 10);
        assert_eq!(albums_fetched(&server).await, before + 1);
        let cached = collection.lock().unwrap().get(&id).unwrap().unwrap();
        assert_eq!(cached.album.title, "In Rainbows");
        assert_eq!((cached.added_at, cached.fetched_at), (day(1), now));
        // Fresh again: opening it straight after asks Spotify nothing.
        assert_eq!(refresh(&spotify, &collection, &id, now).await, Ok(None));
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_cache() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        server.reset().await;
        Mock::given(method("GET"))
            .and(path(format!("/v1/albums/{IN_RAINBOWS}")))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let id = in_rainbows_id(&collection);

        let error = refresh(&spotify, &collection, &id, day(30))
            .await
            .unwrap_err();

        assert!(error.contains("503"), "{error}");
        let cached = collection.lock().unwrap().get(&id).unwrap().unwrap();
        assert_eq!(cached.album.title, "In Rainbows (old title)");
        assert_eq!(cached.fetched_at, day(1));
    }

    #[tokio::test]
    async fn refreshing_an_album_not_in_the_collection_asks_spotify_nothing() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let before = albums_fetched(&server).await;

        assert_eq!(
            refresh(&spotify, &empty_collection(), &AlbumId::new(), day(30)).await,
            Err(NOT_IN_COLLECTION.into())
        );
        assert_eq!(albums_fetched(&server).await, before);
    }

    #[test]
    fn open_in_spotify_links_to_the_album_and_nothing_else() {
        assert_eq!(
            spotify_album_url(IN_RAINBOWS),
            Ok(format!("https://open.spotify.com/album/{IN_RAINBOWS}"))
        );
        for id in ["", "../../evil", "5vkqYmiPBYLaalcmjujWx?", "short"] {
            assert!(spotify_album_url(id).is_err(), "{id}");
        }
    }

    /// The JSON `app/src/api.ts` expects. Change both together.
    #[test]
    fn album_pages_serialise_as_the_ui_expects() {
        let page = AlbumPage {
            id: "deadwax-id".into(),
            spotify_id: IN_RAINBOWS.into(),
            title: "In Rainbows".into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            cover_url: None,
            tracks: vec![AlbumTrack {
                spotify_id: "t".into(),
                disc: 1,
                number: 1,
                title: "15 Step".into(),
                duration_ms: 237_293,
            }],
        };
        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            json!({
                "id": "deadwax-id",
                "spotifyId": IN_RAINBOWS,
                "title": "In Rainbows",
                "artist": "Radiohead",
                "year": 2007,
                "coverUrl": null,
                "tracks": [{
                    "spotifyId": "t", "disc": 1, "number": 1, "title": "15 Step",
                    "durationMs": 237_293,
                }],
            })
        );
    }

    #[test]
    fn search_results_serialise_as_the_ui_expects() {
        let results = SearchResults {
            results: vec![SearchResult {
                album: in_rainbows_found(),
                in_collection: true,
            }],
            next_offset: Some(10),
        };
        assert_eq!(
            serde_json::to_value(&results).unwrap(),
            json!({
                "results": [{
                    "album": {
                        "spotifyId": IN_RAINBOWS,
                        "title": "In Rainbows",
                        "artist": "Radiohead",
                        "year": 2007,
                        "coverUrl": "https://i.scdn.co/image/ab67616d0000b273de3c04b5fc750b68899b20a9",
                    },
                    "inCollection": true,
                }],
                "nextOffset": 10,
            })
        );
    }

    /// The JSON `app/src/api.ts` expects. Change both together.
    #[test]
    fn sessions_serialise_as_the_ui_expects() {
        let cases = [
            (Session::NeedsClientId, json!({"state": "needsClientId"})),
            (
                Session::SignedOut { message: None },
                json!({"state": "signedOut", "message": null}),
            ),
            (
                Session::SignedOut {
                    message: Some("m".into()),
                },
                json!({"state": "signedOut", "message": "m"}),
            ),
            (
                Session::SignedIn {
                    name: "Will".into(),
                },
                json!({"state": "signedIn", "name": "Will"}),
            ),
        ];
        for (session, expected) in cases {
            assert_eq!(serde_json::to_value(&session).unwrap(), expected);
        }
    }

    // Playing (DWX-6).

    const LIVING_ROOM_ID: &str = "b46689a4cdd1d64b2fdf7e4f1d3e8f8bd8e3f3d1";
    const NUDE: &str = "6O4dsyobpDXX1WxHRP3bzk";

    /// A fake Spotify listing the devices in the `devices.json` fixture,
    /// which accepts any play request.
    async fn fake_player(server: &MockServer) -> Spotify<SystemClock, MemoryStore> {
        let spotify = fake_spotify(server).await;
        Mock::given(method("GET"))
            .and(path("/v1/me/player/devices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fixture("devices.json")))
            .mount(server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/me/player/play"))
            .respond_with(ResponseTemplate::new(204))
            .mount(server)
            .await;
        spotify
    }

    /// The player requests Spotify received, in order, as "METHOD path".
    async fn player_requests(server: &MockServer) -> Vec<String> {
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path().starts_with("/v1/me/player"))
            .map(|r| format!("{} {}", r.method, r.url.path()))
            .collect()
    }

    fn config_in(dir: &tempfile::TempDir) -> PathBuf {
        config::path(dir.path())
    }

    #[tokio::test]
    async fn the_picker_lists_the_devices_and_the_one_you_chose_last() {
        let server = MockServer::start().await;
        let spotify = fake_player(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(&dir);

        let before = devices(&spotify, &config).await.unwrap();
        assert_eq!(before.remembered, None);
        assert_eq!(
            before.devices,
            [
                DeviceChoice {
                    name: "Living Room".into(),
                    kind: "Speaker".into(),
                    is_active: false,
                    can_play: true,
                },
                DeviceChoice {
                    name: "Will's MacBook Pro".into(),
                    kind: "Computer".into(),
                    is_active: true,
                    can_play: true,
                },
                // Listed without an ID, and restricted: Spotify won't take
                // commands for it.
                DeviceChoice {
                    name: "Kitchen".into(),
                    kind: "Speaker".into(),
                    is_active: false,
                    can_play: false,
                },
            ]
        );

        remember_device(&config, "Living Room").unwrap();
        let after = devices(&spotify, &config).await.unwrap();
        assert_eq!(after.remembered.as_deref(), Some("Living Room"));
    }

    #[tokio::test]
    async fn play_refreshes_the_devices_then_plays_the_album_on_the_named_one() {
        let server = MockServer::start().await;
        let spotify = fake_player(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(&dir);

        let outcome = play(&spotify, &config, IN_RAINBOWS, "Living Room", None)
            .await
            .unwrap();

        assert!(matches!(outcome, PlayOutcome::Playing { ref devices } if devices.len() == 3));
        assert_eq!(
            player_requests(&server).await,
            ["GET /v1/me/player/devices", "PUT /v1/me/player/play"]
        );
        let requests = server.received_requests().await.unwrap();
        let played = requests.last().unwrap();
        assert_eq!(
            played.url.query(),
            Some(format!("device_id={LIVING_ROOM_ID}").as_str())
        );
        assert_eq!(
            played.body_json::<serde_json::Value>().unwrap(),
            json!({
                "context_uri": format!("spotify:album:{IN_RAINBOWS}"),
                "offset": {"position": 0},
            })
        );
        // Playing remembers the device, by name.
        assert_eq!(
            remembered_device(&config).unwrap().as_deref(),
            Some("Living Room")
        );
    }

    #[tokio::test]
    async fn play_album_plays_a_collected_album_by_its_deadwax_id() {
        let server = MockServer::start().await;
        let spotify = fake_player(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let dir = tempfile::tempdir().unwrap();
        let id = in_rainbows_id(&collection);

        play_collected(
            &spotify,
            &collection,
            &config_in(&dir),
            &id,
            "Living Room",
            None,
        )
        .await
        .unwrap();

        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests
                .last()
                .unwrap()
                .body_json::<serde_json::Value>()
                .unwrap()["context_uri"],
            format!("spotify:album:{IN_RAINBOWS}")
        );
    }

    #[tokio::test]
    async fn play_album_refuses_an_album_not_in_the_collection_and_asks_spotify_nothing() {
        let server = MockServer::start().await;
        let spotify = fake_player(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let dir = tempfile::tempdir().unwrap();

        // Neither an unknown Deadwax ID nor a Spotify ID will do.
        for id in [AlbumId::new(), IN_RAINBOWS.into()] {
            let played = play_collected(
                &spotify,
                &collection,
                &config_in(&dir),
                &id,
                "Living Room",
                None,
            )
            .await;
            assert_eq!(played, Err(NOT_IN_COLLECTION.into()));
        }
        assert!(player_requests(&server).await.is_empty());
    }

    #[tokio::test]
    async fn play_can_start_from_a_clicked_track() {
        let server = MockServer::start().await;
        let spotify = fake_player(&server).await;
        let dir = tempfile::tempdir().unwrap();

        play(
            &spotify,
            &config_in(&dir),
            IN_RAINBOWS,
            "Living Room",
            Some(NUDE.into()),
        )
        .await
        .unwrap();

        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests
                .last()
                .unwrap()
                .body_json::<serde_json::Value>()
                .unwrap()["offset"],
            json!({"uri": format!("spotify:track:{NUDE}")})
        );
    }

    #[tokio::test]
    async fn a_device_spotify_isnt_listing_is_missing_not_an_error() {
        let server = MockServer::start().await;
        let spotify = fake_player(&server).await;
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(&dir);
        remember_device(&config, "TV").unwrap();

        let outcome = play(&spotify, &config, IN_RAINBOWS, "TV", None).await;

        assert!(
            matches!(outcome, Ok(PlayOutcome::DeviceMissing { ref devices }) if devices.len() == 3),
            "{outcome:?}"
        );
        // Nothing was played, and the device is still remembered for when it
        // wakes up.
        assert_eq!(
            player_requests(&server).await,
            ["GET /v1/me/player/devices"]
        );
        assert_eq!(remembered_device(&config).unwrap().as_deref(), Some("TV"));
    }

    #[tokio::test]
    async fn a_device_spotify_wont_control_says_so() {
        let server = MockServer::start().await;
        let spotify = fake_player(&server).await;
        let dir = tempfile::tempdir().unwrap();

        let error = play(&spotify, &config_in(&dir), IN_RAINBOWS, "Kitchen", None)
            .await
            .unwrap_err();

        assert_eq!(
            error,
            "Spotify won't let Deadwax control Kitchen. Play from the Spotify app instead."
        );
        assert_eq!(
            player_requests(&server).await,
            ["GET /v1/me/player/devices"]
        );
    }

    #[tokio::test]
    async fn a_restricted_device_with_an_id_is_still_refused() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let mut listed = fixture("devices.json");
        listed["devices"][0]["is_restricted"] = true.into();
        Mock::given(method("GET"))
            .and(path("/v1/me/player/devices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(listed))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();

        let error = play(&spotify, &config_in(&dir), IN_RAINBOWS, "Living Room", None)
            .await
            .unwrap_err();

        assert_eq!(
            error,
            "Spotify won't let Deadwax control Living Room. Play from the Spotify app instead."
        );
        assert_eq!(
            player_requests(&server).await,
            ["GET /v1/me/player/devices"]
        );
    }

    #[tokio::test]
    async fn a_failure_from_spotify_is_shown_and_nothing_is_remembered() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/me/player/devices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fixture("devices.json")))
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/me/player/play"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "error": {"status": 404, "message": "Device not found", "reason": "UNKNOWN"},
            })))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let config = config_in(&dir);

        let error = play(&spotify, &config, IN_RAINBOWS, "Living Room", None)
            .await
            .unwrap_err();

        assert_eq!(
            error,
            "Spotify replied 404 Not Found to playing the album: Device not found"
        );
        assert_eq!(remembered_device(&config).unwrap(), None);
    }

    #[tokio::test]
    async fn a_failure_listing_devices_is_shown() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        Mock::given(method("GET"))
            .and(path("/v1/me/player/devices"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();

        for result in [
            devices(&spotify, &config_in(&dir)).await.map(|_| ()),
            play(&spotify, &config_in(&dir), IN_RAINBOWS, "Living Room", None)
                .await
                .map(|_| ()),
        ] {
            assert_eq!(
                result,
                Err("Spotify replied 503 Service Unavailable to the list of devices".into())
            );
        }
    }

    #[test]
    fn remembering_a_device_keeps_the_client_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_in(&dir);
        let id = "0123456789abcdef0123456789abcdef";
        config::save(
            &path,
            &config::Config {
                spotify_client_id: Some(id.into()),
                last_device: None,
            },
        )
        .unwrap();

        remember_device(&path, "Living Room").unwrap();

        let saved = config::load(&path).unwrap();
        assert_eq!(saved.spotify_client_id.as_deref(), Some(id));
        assert_eq!(saved.last_device.as_deref(), Some("Living Room"));
    }

    const SPOTIFY_640: &str = "https://i.scdn.co/image/640.jpg";

    fn playing_in_rainbows() -> Playback {
        use deadwax_sources::spotify::playback::{PlayingAlbum, PlayingTrack};
        Playback {
            is_playing: true,
            device: Some("Living Room".into()),
            progress_ms: Some(61_480),
            track: Some(PlayingTrack {
                spotify_id: Some("6O4dsyobpDXX1WxHRP3bzk".into()),
                title: "Nude".into(),
                artist: "Radiohead".into(),
                album: Some(PlayingAlbum {
                    spotify_id: IN_RAINBOWS.into(),
                    title: "In Rainbows".into(),
                    covers: vec![
                        collection::Cover {
                            url: "https://i.scdn.co/image/300.jpg".into(),
                            width: Some(300),
                            height: Some(300),
                        },
                        collection::Cover {
                            url: SPOTIFY_640.into(),
                            width: Some(640),
                            height: Some(640),
                        },
                    ],
                }),
                duration_ms: 255_386,
            }),
        }
    }

    fn cover_now(playback: Playback, collection: &std::sync::Mutex<Collection>) -> Option<String> {
        now_playing(playback, collection).track?.cover_url
    }

    #[tokio::test]
    async fn now_playing_has_the_1600_from_disk_of_an_album_in_the_collection() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        found_on_itunes(&collection);
        sizes_made(&collection);
        let id = in_rainbows_id(&collection);

        assert_eq!(
            cover_now(playing_in_rainbows(), &collection),
            Some(format!("cover://localhost/{id}/1600"))
        );
    }

    #[tokio::test]
    async fn now_playing_falls_back_to_spotifys_largest_cover() {
        // In the collection, but its cover isn't on disk yet.
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        assert_eq!(
            cover_now(playing_in_rainbows(), &collection).as_deref(),
            Some(SPOTIFY_640)
        );

        // Played from elsewhere, and not in the collection at all.
        assert_eq!(
            cover_now(playing_in_rainbows(), &empty_collection()).as_deref(),
            Some(SPOTIFY_640)
        );
    }

    #[tokio::test]
    async fn now_playing_names_a_collected_album_by_its_deadwax_id() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;

        let track = now_playing(playing_in_rainbows(), &collection)
            .track
            .unwrap();

        assert_eq!(track.album_id, Some(in_rainbows_id(&collection)));
        assert_eq!(track.spotify_album_id.as_deref(), Some(IN_RAINBOWS));
    }

    #[test]
    fn now_playing_an_album_outside_the_collection_has_only_its_spotify_id() {
        let track = now_playing(playing_in_rainbows(), &empty_collection())
            .track
            .unwrap();

        assert_eq!(track.album_id, None);
        assert_eq!(track.spotify_album_id.as_deref(), Some(IN_RAINBOWS));
    }

    #[test]
    fn now_playing_without_an_album_has_no_cover() {
        let mut playback = playing_in_rainbows();
        playback.track.as_mut().unwrap().album = None;

        let now = now_playing(playback, &empty_collection());

        let track = now.track.unwrap();
        assert_eq!(track.title, "Nude");
        assert_eq!(track.album_id, None);
        assert_eq!(track.spotify_album_id, None);
        assert_eq!(track.cover_url, None);
    }

    /// The JSON `app/src/api.ts` expects. Change both together.
    #[test]
    fn playback_serialises_as_the_ui_expects() {
        let device = DeviceChoice {
            name: "Living Room".into(),
            kind: "Speaker".into(),
            is_active: true,
            can_play: true,
        };
        let device_json = json!({
            "name": "Living Room", "kind": "Speaker", "isActive": true, "canPlay": true,
        });
        assert_eq!(
            serde_json::to_value(Devices {
                devices: vec![device.clone()],
                remembered: Some("TV".into()),
            })
            .unwrap(),
            json!({"devices": [device_json.clone()], "remembered": "TV"})
        );
        assert_eq!(
            serde_json::to_value(PlayOutcome::DeviceMissing {
                devices: vec![device.clone()],
            })
            .unwrap(),
            json!({"state": "deviceMissing", "devices": [device_json.clone()]})
        );
        assert_eq!(
            serde_json::to_value(PlayOutcome::Playing {
                devices: vec![device],
            })
            .unwrap(),
            json!({"state": "playing", "devices": [device_json]})
        );
        assert_eq!(
            serde_json::to_value(NowPlaying {
                is_playing: true,
                device: Some("Living Room".into()),
                progress_ms: Some(61_480),
                track: Some(NowPlayingTrack {
                    title: "Nude".into(),
                    artist: "Radiohead".into(),
                    album: Some("In Rainbows".into()),
                    album_id: Some("deadwax-id".into()),
                    spotify_album_id: Some(IN_RAINBOWS.into()),
                    duration_ms: 255_386,
                    cover_url: Some("cover://localhost/deadwax-id/1600".into()),
                }),
            })
            .unwrap(),
            json!({
                "isPlaying": true,
                "device": "Living Room",
                "progressMs": 61_480,
                "track": {
                    "title": "Nude",
                    "artist": "Radiohead",
                    "album": "In Rainbows",
                    "albumId": "deadwax-id",
                    "spotifyAlbumId": IN_RAINBOWS,
                    "durationMs": 255_386,
                    "coverUrl": "cover://localhost/deadwax-id/1600",
                },
            })
        );
    }
}
