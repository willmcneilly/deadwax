//! The Tauri commands: everything the UI can ask Rust for.
//!
//! Every type a command returns is defined here, from plain values, so the
//! test in `command_types.rs` can check that none of them can carry a token.
//! Errors are plain sentences for the UI to show.

use std::path::PathBuf;
use std::sync::Arc;

use deadwax_sources::clock::{Clock, SystemClock};
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
    spotify: RwLock<Option<Arc<Client>>>,
    /// Dropping this cancels the sign-in that's waiting for the browser, and
    /// closes its listener.
    waiting_sign_in: Mutex<Option<oneshot::Sender<()>>>,
}

impl AppState {
    pub fn new(config_path: PathBuf) -> Result<Self, String> {
        let config = config::load(&config_path)
            .map_err(|e| format!("Couldn't read Deadwax's config: {e}"))?;
        let spotify = config.spotify_client_id.map(client).transpose()?;
        Ok(Self {
            config_path,
            spotify: RwLock::new(spotify),
            waiting_sign_in: Mutex::new(None),
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

#[cfg(test)]
mod tests {
    use deadwax_sources::spotify::pkce::Verifier;
    use deadwax_sources::spotify::tokens::MemoryStore;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    /// A client against a fake Spotify whose sign-in gives a token that has
    /// already expired, and whose token refresh replies `refresh`.
    async fn signed_in_with_expired_token(
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
}
