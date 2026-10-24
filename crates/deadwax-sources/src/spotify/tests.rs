//! The Spotify client against a fake Spotify: token exchange, refresh, the
//! profile, and being signed out.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::clock::fake::FakeClock;
use crate::spotify::tokens::MemoryStore;

const HOUR: Duration = Duration::from_secs(3600);

fn spotify(server: &MockServer) -> (Spotify<FakeClock, MemoryStore>, FakeClock) {
    let clock = FakeClock::new(Arc::new(Mutex::new(Vec::new())));
    let endpoints = Endpoints {
        accounts: server.uri(),
        api: server.uri(),
        redirect_port: 0,
    };
    let spotify = Spotify::new(
        "client-id".into(),
        clock.clone(),
        MemoryStore::default(),
        endpoints,
    );
    (spotify, clock)
}

/// Saves tokens as if you'd signed in an hour ago, at `now`.
fn signed_in(spotify: &Spotify<FakeClock, MemoryStore>, clock: &FakeClock) {
    let tokens = Tokens::new(
        "old-access".into(),
        "old-refresh".into(),
        clock.now() + HOUR,
    );
    spotify.store.save(&tokens).unwrap();
}

async fn me_replies(server: &MockServer, token: &str, body: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path("/v1/me"))
        .and(header("authorization", format!("Bearer {token}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

#[test]
fn authorize_url_asks_for_a_pkce_code() {
    let spotify = Spotify::new(
        "client-id".into(),
        crate::clock::SystemClock,
        MemoryStore::default(),
        Endpoints::default(),
    );
    let url = Url::parse(&spotify.authorize_url(
        "http://127.0.0.1:5000/callback",
        "the-challenge",
        "the-state",
    ))
    .unwrap();
    let params: Vec<(String, String)> = url.query_pairs().into_owned().collect();

    assert_eq!(
        url.origin().ascii_serialization(),
        "https://accounts.spotify.com"
    );
    assert_eq!(url.path(), "/authorize");
    for (key, value) in [
        ("client_id", "client-id"),
        ("response_type", "code"),
        ("redirect_uri", "http://127.0.0.1:5000/callback"),
        ("code_challenge_method", "S256"),
        ("code_challenge", "the-challenge"),
        ("state", "the-state"),
        ("scope", SCOPES),
    ] {
        assert!(
            params.contains(&(key.into(), value.into())),
            "missing {key}={value}"
        );
    }
}

#[tokio::test]
async fn exchanging_the_code_saves_the_tokens() {
    let server = MockServer::start().await;
    let verifier = Verifier::generate();
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .and(body_string_contains("grant_type=authorization_code"))
        .and(body_string_contains("code=the-code"))
        .and(body_string_contains("client_id=client-id"))
        .and(body_string_contains(format!(
            "code_verifier={}",
            verifier.as_str()
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "new-access", "token_type": "Bearer", "expires_in": 3600,
            "refresh_token": "new-refresh", "scope": SCOPES,
        })))
        .expect(1)
        .mount(&server)
        .await;
    let (spotify, clock) = spotify(&server);

    spotify
        .exchange_code("the-code", "http://127.0.0.1:5000/callback", &verifier)
        .await
        .unwrap();

    let saved = spotify.store.load().unwrap().unwrap();
    assert_eq!(saved.access(), "new-access");
    assert_eq!(saved.refresh(), "new-refresh");
    assert_eq!(saved.expires_at(), clock.now() + HOUR);
}

#[tokio::test]
async fn profile_uses_the_saved_token_and_shows_the_display_name() {
    let server = MockServer::start().await;
    me_replies(
        &server,
        "old-access",
        json!({"id": "will123", "display_name": "Will"}),
    )
    .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);

    assert_eq!(spotify.profile().await.unwrap().name, "Will");
}

#[tokio::test]
async fn profile_falls_back_to_the_user_id_without_a_display_name() {
    let server = MockServer::start().await;
    me_replies(
        &server,
        "old-access",
        json!({"id": "will123", "display_name": null}),
    )
    .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);

    assert_eq!(spotify.profile().await.unwrap().name, "will123");
}

#[tokio::test]
async fn profile_without_tokens_is_not_signed_in() {
    let server = MockServer::start().await;
    let (spotify, _) = spotify(&server);

    assert!(matches!(
        spotify.profile().await,
        Err(SpotifyError::NotSignedIn)
    ));
}

async fn refresh_replies(server: &MockServer, body: serde_json::Value) {
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .and(body_string_contains("grant_type=refresh_token"))
        .and(body_string_contains("refresh_token=old-refresh"))
        .and(body_string_contains("client_id=client-id"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .expect(1)
        .mount(server)
        .await;
}

#[tokio::test]
async fn refresh_keeps_a_working_token_with_a_new_refresh_token() {
    let server = MockServer::start().await;
    refresh_replies(
        &server,
        json!({"access_token": "new-access", "expires_in": 3600, "refresh_token": "new-refresh"}),
    )
    .await;
    me_replies(
        &server,
        "new-access",
        json!({"id": "will123", "display_name": "Will"}),
    )
    .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR);

    assert_eq!(spotify.profile().await.unwrap().name, "Will");
    let saved = spotify.store.load().unwrap().unwrap();
    assert_eq!(saved.access(), "new-access");
    assert_eq!(saved.refresh(), "new-refresh");
    assert_eq!(saved.expires_at(), clock.now() + HOUR);
}

#[tokio::test]
async fn refresh_keeps_a_working_token_without_a_new_refresh_token() {
    let server = MockServer::start().await;
    refresh_replies(
        &server,
        json!({"access_token": "new-access", "expires_in": 3600}),
    )
    .await;
    me_replies(
        &server,
        "new-access",
        json!({"id": "will123", "display_name": "Will"}),
    )
    .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR);

    assert_eq!(spotify.profile().await.unwrap().name, "Will");
    let saved = spotify.store.load().unwrap().unwrap();
    assert_eq!(saved.access(), "new-access");
    assert_eq!(saved.refresh(), "old-refresh");
}

#[tokio::test]
async fn refreshes_shortly_before_expiry_not_after() {
    let server = MockServer::start().await;
    refresh_replies(
        &server,
        json!({"access_token": "new-access", "expires_in": 3600}),
    )
    .await;
    me_replies(
        &server,
        "new-access",
        json!({"id": "will123", "display_name": "Will"}),
    )
    .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR - Duration::from_secs(30));

    spotify.profile().await.unwrap();
}

#[tokio::test]
async fn a_rejected_access_token_is_refreshed_once() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/me"))
        .and(header("authorization", "Bearer old-access"))
        .respond_with(ResponseTemplate::new(401))
        .expect(1)
        .mount(&server)
        .await;
    refresh_replies(
        &server,
        json!({"access_token": "new-access", "expires_in": 3600}),
    )
    .await;
    me_replies(
        &server,
        "new-access",
        json!({"id": "will123", "display_name": "Will"}),
    )
    .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);

    assert_eq!(spotify.profile().await.unwrap().name, "Will");
}

#[tokio::test]
async fn a_rejected_refresh_token_signs_out_and_forgets_the_tokens() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "invalid_grant", "error_description": "Refresh token revoked",
        })))
        .mount(&server)
        .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR);

    assert!(matches!(
        spotify.profile().await,
        Err(SpotifyError::SignedOut)
    ));
    assert!(!spotify.has_tokens().unwrap());
}

/// A client whose `on_signed_out` hook writes what it heard to the log.
fn listening(
    server: &MockServer,
) -> (
    Spotify<FakeClock, MemoryStore>,
    FakeClock,
    Arc<Mutex<Vec<String>>>,
) {
    let (spotify, clock) = spotify(server);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let log = heard.clone();
    let spotify = spotify.on_signed_out(move |error| log.lock().unwrap().push(error.to_string()));
    (spotify, clock, heard)
}

#[tokio::test]
async fn any_call_that_finds_the_sign_in_expired_says_so_to_the_hook() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error": "invalid_grant"})))
        .mount(&server)
        .await;
    let (spotify, clock, heard) = listening(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR);

    // Not the profile: asking what's playing, as the crate does every couple of seconds.
    assert!(matches!(
        spotify.playback().await,
        Err(SpotifyError::SignedOut)
    ));
    assert_eq!(*heard.lock().unwrap(), ["the Spotify sign-in has expired"]);
    // With the tokens gone, the next call is not signed in, and says so too.
    assert!(matches!(
        spotify.pause().await,
        Err(SpotifyError::NotSignedIn)
    ));
    assert_eq!(
        *heard.lock().unwrap(),
        [
            "the Spotify sign-in has expired",
            "not signed in to Spotify"
        ]
    );
}

#[tokio::test]
async fn other_failures_say_nothing_to_the_signed_out_hook() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let (spotify, clock, heard) = listening(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR);

    let error = spotify.playback().await.unwrap_err();
    assert!(error.is_unreachable(), "{error:?}");
    assert!(heard.lock().unwrap().is_empty());
}

#[test]
fn only_spotify_being_out_of_reach_counts_as_unreachable() {
    let unexpected = |status| SpotifyError::Unexpected {
        what: "your profile",
        status,
    };

    assert!(SpotifyError::Http(HttpError::RateLimited(HOUR)).is_unreachable());
    assert!(unexpected(StatusCode::BAD_GATEWAY).is_unreachable());
    assert!(!unexpected(StatusCode::FORBIDDEN).is_unreachable());
    assert!(!SpotifyError::SignedOut.is_unreachable());
    assert!(!SpotifyError::NotSignedIn.is_unreachable());
}

#[tokio::test]
async fn other_refresh_failures_keep_the_tokens() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR);

    assert!(matches!(
        spotify.profile().await,
        Err(SpotifyError::Unexpected { status, .. }) if status == StatusCode::SERVICE_UNAVAILABLE
    ));
    assert!(spotify.has_tokens().unwrap());
}

#[tokio::test]
async fn errors_never_mention_a_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let (spotify, clock) = spotify(&server);
    signed_in(&spotify, &clock);
    clock.advance(HOUR);

    let error = spotify.profile().await.unwrap_err();
    for shown in [error.to_string(), format!("{error:?}")] {
        assert!(!shown.contains("old-access"));
        assert!(!shown.contains("old-refresh"));
    }
}

#[tokio::test]
async fn sign_in_opens_the_browser_and_saves_the_tokens_from_the_redirect() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/token"))
        .and(body_string_contains("code=the-code"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "new-access", "expires_in": 3600, "refresh_token": "new-refresh",
        })))
        .expect(1)
        .mount(&server)
        .await;
    let (spotify, _) = spotify(&server);

    // Plays the browser: follows the approval URL's redirect_uri back to the
    // listener with a code and the same state, as Spotify would.
    let browser = |url: &str| {
        let url = Url::parse(url).unwrap();
        let param = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .unwrap()
                .1
                .into_owned()
        };
        let callback = format!(
            "{}?code=the-code&state={}",
            param("redirect_uri"),
            param("state")
        );
        tokio::spawn(async move {
            let callback = Url::parse(&callback).unwrap();
            let mut stream = tokio::net::TcpStream::connect((
                callback.host_str().unwrap().to_owned(),
                callback.port().unwrap(),
            ))
            .await
            .unwrap();
            let request = format!(
                "GET {}?{} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
                callback.path(),
                callback.query().unwrap()
            );
            tokio::io::AsyncWriteExt::write_all(&mut stream, request.as_bytes())
                .await
                .unwrap();
        });
        Ok(())
    };

    spotify.sign_in(browser).await.unwrap();

    assert_eq!(
        spotify.store.load().unwrap().unwrap().access(),
        "new-access"
    );
}
