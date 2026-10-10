//! The Tauri commands: everything the UI can ask Rust for.
//!
//! Every type a command returns is defined here, from plain values, so the
//! test in `command_types.rs` can check that none of them can carry a token.
//! Errors are plain sentences for the UI to show.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use deadwax_core::collection::{self, Album, Collection};
use deadwax_sources::clock::{Clock, SystemClock};
use deadwax_sources::spotify::albums::AlbumSummary;
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
    pub fn new(config_path: PathBuf, database_path: &Path) -> Result<Self, String> {
        let config = config::load(&config_path)
            .map_err(|e| format!("Couldn't read Deadwax's config: {e}"))?;
        let spotify = config.spotify_client_id.map(client).transpose()?;
        let collection = Collection::open(database_path).map_err(|e| {
            format!(
                "Couldn't open the collection at {}: {e}",
                database_path.display()
            )
        })?;
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
    const IN_RAINBOWS: &str = "5vkqYmiPBYLaalcmjujWxK";

    fn fixture(name: &str) -> serde_json::Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(FIXTURES)
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Signed in to a fake Spotify that answers search and the album with the
    /// hand-written fixtures in `deadwax-sources`.
    async fn fake_spotify(server: &MockServer) -> Spotify<SystemClock, MemoryStore> {
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
}
