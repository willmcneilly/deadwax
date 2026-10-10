//! The Tauri commands: everything the UI can ask Rust for.
//!
//! Every type a command returns is defined here, from plain values, so the
//! test in `command_types.rs` can check that none of them can carry a token.
//! Errors are plain sentences for the UI to show.

use std::path::PathBuf;
use std::sync::Arc;

use deadwax_sources::clock::SystemClock;
use deadwax_sources::spotify::tokens::KeychainStore;
use deadwax_sources::spotify::{Endpoints, Spotify, SpotifyError};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::RwLock;

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
    spotify: RwLock<Option<Arc<Client>>>,
}

impl AppState {
    pub fn new(config_path: PathBuf) -> Result<Self, String> {
        let config = config::load(&config_path)
            .map_err(|e| format!("Couldn't read Deadwax's config: {e}"))?;
        let spotify = config.spotify_client_id.map(client).transpose()?;
        Ok(Self {
            config_path,
            spotify: RwLock::new(spotify),
        })
    }

    async fn spotify(&self) -> Option<Arc<Client>> {
        self.spotify.read().await.clone()
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

async fn session(spotify: &Client) -> Result<Session, String> {
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
/// approve in the browser (or five minutes pass).
#[tauri::command]
pub async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<Session, String> {
    let spotify = state
        .spotify()
        .await
        .ok_or("Add your Spotify client ID first.")?;
    spotify
        .sign_in(|url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|error| match error {
            SpotifyError::TimedOut => "Sign-in timed out. Try again when you're ready.".to_string(),
            error => format!("Couldn't sign in: {error}"),
        })?;
    session(&spotify).await
}

/// Opens Spotify's developer dashboard in your browser.
#[tauri::command]
pub fn open_spotify_dashboard(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(DASHBOARD_URL, None::<&str>)
        .map_err(|e| e.to_string())
}
