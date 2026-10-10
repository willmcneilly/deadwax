//! The Tauri commands: everything the UI can ask Rust for.
//!
//! Every type a command returns is defined here, from plain values, so the
//! test in `command_types.rs` can check that none of them can carry a token.
//! Errors are plain sentences for the UI to show.
//!
//! The Develop menu's commands are in `dev`, in development builds only.

#[cfg(debug_assertions)]
pub mod dev;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use deadwax_core::collection::{self, Album, Collection};
use deadwax_sources::clock::{Clock, SystemClock};
use deadwax_sources::spotify::albums::{AlbumSummary, is_spotify_id};
use deadwax_sources::spotify::playback::{Device, Playback, StartAt};
use deadwax_sources::spotify::tokens::{KeychainStore, TokenStore};
use deadwax_sources::spotify::{Endpoints, Spotify, SpotifyError};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{Mutex, RwLock, oneshot};

use crate::config;

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
    /// A plain mutex: it's never held across an `await`.
    collection: std::sync::Mutex<Collection>,
    spotify: RwLock<Option<Arc<Client>>>,
    /// Dropping this cancels the sign-in that's waiting for the browser, and
    /// closes its listener.
    waiting_sign_in: Mutex<Option<oneshot::Sender<()>>>,
}

impl AppState {
    pub fn new(config_path: PathBuf, collection: Collection) -> Result<Self, String> {
        let config = config::load(&config_path)
            .map_err(|e| format!("Couldn't read Deadwax's config: {e}"))?;
        let spotify = config.spotify_client_id.map(client).transpose()?;
        Ok(Self {
            config_path,
            collection: std::sync::Mutex::new(collection),
            spotify: RwLock::new(spotify),
            waiting_sign_in: Mutex::new(None),
        })
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

/// An album as the grid and the search results show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumCard {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub year: Option<u16>,
    /// Spotify's largest cover, about 640 pixels.
    pub cover_url: Option<String>,
}

impl From<Album> for AlbumCard {
    fn from(album: Album) -> Self {
        Self {
            cover_url: album.largest_cover().map(|cover| cover.url.clone()),
            id: album.spotify_id,
            title: album.title,
            artist: album.artist,
            year: album.year,
        }
    }
}

impl From<AlbumSummary> for AlbumCard {
    fn from(album: AlbumSummary) -> Self {
        Self {
            cover_url: collection::largest(&album.covers).map(|cover| cover.url.clone()),
            id: album.spotify_id,
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
    pub album: AlbumCard,
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
        .map(|collected| collected.album.into())
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
        .ids()
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

/// Fetches the album from Spotify, adds it to your collection, and returns
/// it for the grid. Adding one that's already there refreshes its cache.
#[tauri::command]
pub async fn add_album(state: State<'_, AppState>, id: String) -> Result<AlbumCard, String> {
    let spotify = state.signed_in().await?;
    add(&spotify, &state.collection, &id, SystemTime::now()).await
}

async fn add<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    id: &str,
    now: SystemTime,
) -> Result<AlbumCard, String> {
    let album = spotify.album(id).await.map_err(spotify_error)?;
    collection
        .lock()
        .expect("collection lock")
        .add(&album, now)
        .map_err(collection_error)?;
    Ok(album.into())
}

/// An album as the album page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPage {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub year: Option<u16>,
    /// Spotify's largest cover, about 640 pixels.
    pub cover_url: Option<String>,
    pub tracks: Vec<AlbumTrack>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumTrack {
    pub id: String,
    pub disc: u32,
    pub number: u32,
    pub title: String,
    pub duration_ms: u64,
}

impl From<Album> for AlbumPage {
    fn from(album: Album) -> Self {
        Self {
            cover_url: album.largest_cover().map(|cover| cover.url.clone()),
            id: album.spotify_id,
            title: album.title,
            artist: album.artist,
            year: album.year,
            tracks: album
                .tracks
                .into_iter()
                .map(|track| AlbumTrack {
                    id: track.spotify_id,
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
/// does that when the cache is old.
#[tauri::command]
pub fn get_album(state: State<'_, AppState>, id: String) -> Result<AlbumPage, String> {
    album_page(&state.collection, &id)
}

fn album_page(collection: &std::sync::Mutex<Collection>, id: &str) -> Result<AlbumPage, String> {
    collection
        .lock()
        .expect("collection lock")
        .get(id)
        .map_err(collection_error)?
        .map(|collected| collected.album.into())
        .ok_or_else(|| NOT_IN_COLLECTION.into())
}

/// Fetches the album from Spotify again if its cache is over a week old,
/// and returns the updated page. `None` if the cache was fresh enough, so
/// nothing was fetched.
#[tauri::command]
pub async fn refresh_album(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<AlbumPage>, String> {
    let spotify = state.signed_in().await?;
    refresh(&spotify, &state.collection, &id, SystemTime::now()).await
}

async fn refresh<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    id: &str,
    now: SystemTime,
) -> Result<Option<AlbumPage>, String> {
    let cached = collection
        .lock()
        .expect("collection lock")
        .get(id)
        .map_err(collection_error)?
        .ok_or(NOT_IN_COLLECTION)?;
    if !cached.is_stale(now) {
        return Ok(None);
    }
    let album = spotify.album(id).await.map_err(spotify_error)?;
    let collected = collection
        .lock()
        .expect("collection lock")
        .refresh(&album, now)
        .map_err(collection_error)?;
    if !collected {
        // Removed while it was being fetched.
        return Err(NOT_IN_COLLECTION.into());
    }
    Ok(Some(album.into()))
}

/// Takes the album out of your collection. Removing one that isn't there is
/// fine.
#[tauri::command]
pub fn remove_album(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .collection
        .lock()
        .expect("collection lock")
        .remove(&id)
        .map_err(collection_error)?;
    Ok(())
}

/// The album's page on Spotify. Spotify's developer policy wants every album
/// page to link back to it (RFC-001, "Spotify's attribution rules").
fn spotify_album_url(id: &str) -> Result<String, String> {
    // Spotify IDs are base 62, so nothing in one can change the URL.
    if !is_spotify_id(id) {
        return Err(format!("\"{id}\" isn't a Spotify album ID."));
    }
    Ok(format!("https://open.spotify.com/album/{id}"))
}

/// Opens the album on Spotify, in your browser or the Spotify app.
#[tauri::command]
pub fn open_album_in_spotify(app: AppHandle, id: String) -> Result<(), String> {
    app.opener()
        .open_url(spotify_album_url(&id)?, None::<&str>)
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

/// What Spotify is playing, for the playback bar.
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
    pub album_id: Option<String>,
    pub duration_ms: u64,
}

impl From<Playback> for NowPlaying {
    fn from(playback: Playback) -> Self {
        Self {
            is_playing: playback.is_playing,
            device: playback.device,
            progress_ms: playback.progress_ms,
            track: playback.track.map(|track| {
                let (album, album_id) = match track.album {
                    Some(album) => (Some(album.title), Some(album.spotify_id)),
                    None => (None, None),
                };
                NowPlayingTrack {
                    title: track.title,
                    artist: track.artist,
                    album,
                    album_id,
                    duration_ms: track.duration_ms,
                }
            }),
        }
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

/// Plays the album on the device with this name, from the first track or
/// the track with `track_id`. Asks Spotify for its devices first, because
/// the picker's list may be old and device IDs don't last.
#[tauri::command]
pub async fn play_album(
    state: State<'_, AppState>,
    id: String,
    device: String,
    track_id: Option<String>,
) -> Result<PlayOutcome, String> {
    let spotify = state.signed_in().await?;
    play(&spotify, &state.config_path, &id, &device, track_id).await
}

async fn play<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    config_path: &std::path::Path,
    album_id: &str,
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
        .play_album(device_id, album_id, &start)
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
        .map(NowPlaying::from))
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

    fn in_rainbows_card() -> AlbumCard {
        AlbumCard {
            id: IN_RAINBOWS.into(),
            title: "In Rainbows".into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            cover_url: Some(
                "https://i.scdn.co/image/ab67616d0000b273de3c04b5fc750b68899b20a9".into(),
            ),
        }
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
        assert_eq!(first.results[0].album, in_rainbows_card());
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
            .map(|r| r.album.id.as_str())
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
    async fn adding_fetches_the_album_and_puts_it_in_the_grid() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = empty_collection();

        let added = add(&spotify, &collection, IN_RAINBOWS, SystemTime::now())
            .await
            .unwrap();

        assert_eq!(added, in_rainbows_card());
        let albums_fetched = server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|r| r.url.path().starts_with("/v1/albums"))
            .count();
        let collection = collection.lock().unwrap();
        assert_eq!(cards(&collection).unwrap(), [in_rainbows_card()]);
        // The whole album is cached, for the album page (DWX-4).
        let cached = collection.get(IN_RAINBOWS).unwrap().unwrap().album;
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

        let page = album_page(&collection, IN_RAINBOWS).unwrap();

        assert_eq!(page.title, "In Rainbows (old title)");
        assert_eq!(page.artist, "Radiohead");
        assert_eq!(page.year, Some(2007));
        assert_eq!(page.cover_url, in_rainbows_card().cover_url);
        assert_eq!(page.tracks.len(), 10);
        assert_eq!(
            page.tracks[0],
            AlbumTrack {
                id: page.tracks[0].id.clone(),
                disc: 1,
                number: 1,
                title: "15 Step".into(),
                duration_ms: 237_293,
            }
        );
        assert_eq!(albums_fetched(&server).await, before);
    }

    #[test]
    fn an_album_not_in_the_collection_has_no_page() {
        assert_eq!(
            album_page(&empty_collection(), IN_RAINBOWS),
            Err(NOT_IN_COLLECTION.into())
        );
    }

    #[tokio::test]
    async fn a_cache_up_to_a_week_old_isnt_fetched_again() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let before = albums_fetched(&server).await;

        assert_eq!(
            refresh(&spotify, &collection, IN_RAINBOWS, day(8)).await,
            Ok(None)
        );

        assert_eq!(albums_fetched(&server).await, before);
        let cached = collection
            .lock()
            .unwrap()
            .get(IN_RAINBOWS)
            .unwrap()
            .unwrap();
        assert_eq!(cached.fetched_at, day(1));
    }

    #[tokio::test]
    async fn a_cache_over_a_week_old_is_fetched_again_and_updates_the_page() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let collection = collection_with_in_rainbows(&spotify, day(1)).await;
        let before = albums_fetched(&server).await;
        let now = day(8) + std::time::Duration::from_secs(1);

        let page = refresh(&spotify, &collection, IN_RAINBOWS, now)
            .await
            .unwrap()
            .expect("a stale cache is fetched again");

        assert_eq!(page.title, "In Rainbows");
        assert_eq!(page.tracks.len(), 10);
        assert_eq!(albums_fetched(&server).await, before + 1);
        let cached = collection
            .lock()
            .unwrap()
            .get(IN_RAINBOWS)
            .unwrap()
            .unwrap();
        assert_eq!(cached.album.title, "In Rainbows");
        assert_eq!((cached.added_at, cached.fetched_at), (day(1), now));
        // Fresh again: opening it straight after asks Spotify nothing.
        assert_eq!(
            refresh(&spotify, &collection, IN_RAINBOWS, now).await,
            Ok(None)
        );
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

        let error = refresh(&spotify, &collection, IN_RAINBOWS, day(30))
            .await
            .unwrap_err();

        assert!(error.contains("503"), "{error}");
        let cached = collection
            .lock()
            .unwrap()
            .get(IN_RAINBOWS)
            .unwrap()
            .unwrap();
        assert_eq!(cached.album.title, "In Rainbows (old title)");
        assert_eq!(cached.fetched_at, day(1));
    }

    #[tokio::test]
    async fn refreshing_an_album_not_in_the_collection_asks_spotify_nothing() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let before = albums_fetched(&server).await;

        assert_eq!(
            refresh(&spotify, &empty_collection(), IN_RAINBOWS, day(30)).await,
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
            id: IN_RAINBOWS.into(),
            title: "In Rainbows".into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            cover_url: None,
            tracks: vec![AlbumTrack {
                id: "t".into(),
                disc: 1,
                number: 1,
                title: "15 Step".into(),
                duration_ms: 237_293,
            }],
        };
        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            json!({
                "id": IN_RAINBOWS,
                "title": "In Rainbows",
                "artist": "Radiohead",
                "year": 2007,
                "coverUrl": null,
                "tracks": [{
                    "id": "t", "disc": 1, "number": 1, "title": "15 Step",
                    "durationMs": 237_293,
                }],
            })
        );
    }

    #[test]
    fn search_results_serialise_as_the_ui_expects() {
        let results = SearchResults {
            results: vec![SearchResult {
                album: in_rainbows_card(),
                in_collection: true,
            }],
            next_offset: Some(10),
        };
        assert_eq!(
            serde_json::to_value(&results).unwrap(),
            json!({
                "results": [{
                    "album": {
                        "id": IN_RAINBOWS,
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
                    album_id: Some(IN_RAINBOWS.into()),
                    duration_ms: 255_386,
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
                    "albumId": IN_RAINBOWS,
                    "durationMs": 255_386,
                },
            })
        );
    }
}
