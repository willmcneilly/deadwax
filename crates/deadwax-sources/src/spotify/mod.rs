//! Spotify: signing in with PKCE, keeping the tokens fresh, and the calls
//! Deadwax makes. See RFC-001, "Signing in to Spotify".

pub mod albums;
pub mod http;
pub mod loopback;
pub mod pkce;
pub mod playback;
pub mod tokens;

use std::time::Duration;

use reqwest::{RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;
use url::Url;

use crate::clock::Clock;
use http::{HttpError, SpotifyHttp};
use loopback::{CallbackError, Listener};
use pkce::Verifier;
use tokens::{Cached, StoreError, TokenStore, Tokens};

/// The permissions Deadwax asks for. The profile, search and albums need no
/// scope. The playback scopes are for seeing your devices and what's playing,
/// and for playing albums on them.
pub const SCOPES: &str =
    "user-read-playback-state user-modify-playback-state user-read-currently-playing";

/// How long sign-in waits for you to approve in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// An access token this close to expiring is refreshed before use.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

/// Where Spotify lives, and where it sends you back to. Tests point these at
/// a local fake server and any free port.
#[derive(Clone, Debug)]
pub struct Endpoints {
    /// Sign-in and tokens: `https://accounts.spotify.com`.
    pub accounts: String,
    /// The Web API: `https://api.spotify.com`.
    pub api: String,
    /// The port the sign-in listener uses: `loopback::REDIRECT_PORT`.
    pub redirect_port: u16,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            accounts: "https://accounts.spotify.com".into(),
            api: "https://api.spotify.com".into(),
            redirect_port: loopback::REDIRECT_PORT,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpotifyError {
    /// There are no saved tokens.
    #[error("not signed in to Spotify")]
    NotSignedIn,
    /// Spotify rejected the refresh token: it's six months old, or was
    /// revoked. The saved tokens have been forgotten. Not a failure: you sign
    /// in again.
    #[error("the Spotify sign-in has expired")]
    SignedOut,
    #[error("sign-in didn't finish in time")]
    TimedOut,
    #[error("couldn't open the browser: {0}")]
    Browser(String),
    #[error(transparent)]
    Callback(#[from] CallbackError),
    #[error(transparent)]
    Http(#[from] HttpError),
    #[error(transparent)]
    Store(#[from] StoreError),
    /// Something that should have been a Spotify ID wasn't.
    #[error("{0:?} isn't a Spotify album ID")]
    NotAnId(String),
    /// A reply we didn't expect. Never includes the request, which may hold a
    /// token.
    #[error("Spotify replied {status} to {what}")]
    Unexpected {
        what: &'static str,
        status: StatusCode,
    },
    /// A reply we didn't expect, with Spotify's explanation.
    #[error("Spotify replied {status} to {what}: {message}")]
    Refused {
        what: &'static str,
        status: StatusCode,
        message: String,
    },
}

impl SpotifyError {
    /// Spotify couldn't be reached, or couldn't answer: no connection, a rate
    /// limit, or a fault at Spotify's end. You're still signed in, and the
    /// collection still works without it.
    pub fn is_unreachable(&self) -> bool {
        match self {
            Self::Http(HttpError::Network(_) | HttpError::RateLimited(_)) => true,
            Self::Unexpected { status, .. } | Self::Refused { status, .. } => {
                status.is_server_error()
            }
            _ => false,
        }
    }
}

/// What Deadwax shows about you.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    /// Your display name, or your user ID if you haven't set one.
    pub name: String,
}

pub struct Spotify<C, S> {
    http: SpotifyHttp<C>,
    /// The store, read once per run (see `Cached`).
    store: Cached<S>,
    client_id: String,
    endpoints: Endpoints,
    /// Held while checking and refreshing the token, so two calls don't both
    /// refresh. Spotify may rotate the refresh token, and the loser would be
    /// signed out.
    refresh_lock: Mutex<()>,
    /// Told when a call finds you signed out (`on_signed_out`).
    signed_out: Option<SignedOutHook>,
}

/// Hears `SpotifyError::SignedOut` or `NotSignedIn`, from whichever call
/// found it.
type SignedOutHook = Box<dyn Fn(&SpotifyError) + Send + Sync>;

impl<C: Clock, S: TokenStore> Spotify<C, S> {
    pub fn new(client_id: String, clock: C, store: S, endpoints: Endpoints) -> Self {
        Self {
            http: SpotifyHttp::new(clock),
            store: Cached::new(store),
            client_id,
            endpoints,
            refresh_lock: Mutex::new(()),
            signed_out: None,
        }
    }

    /// Calls `hook` whenever a call finds you signed out: Spotify has just
    /// rejected the refresh token (`SignedOut`), or there are no tokens
    /// (`NotSignedIn`). Every call that needs a token passes through here, so
    /// the app hears about it however it was found (RFC-002, "What the back
    /// end gains").
    pub fn on_signed_out(mut self, hook: impl Fn(&SpotifyError) + Send + Sync + 'static) -> Self {
        self.signed_out = Some(Box::new(hook));
        self
    }

    pub fn has_tokens(&self) -> Result<bool, SpotifyError> {
        Ok(self.store.load()?.is_some())
    }

    pub fn sign_out(&self) -> Result<(), SpotifyError> {
        Ok(self.store.clear()?)
    }

    /// The whole sign-in: listens on the redirect port, opens Spotify's approval
    /// page with `open_browser`, waits for the redirect, swaps the code for
    /// tokens and saves them.
    pub async fn sign_in(
        &self,
        open_browser: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), SpotifyError> {
        let listener = Listener::bind(self.endpoints.redirect_port).await?;
        let redirect_uri = listener.redirect_uri();
        let verifier = Verifier::generate();
        let state = pkce::generate_state();

        open_browser(&self.authorize_url(&redirect_uri, &verifier.challenge(), &state))
            .map_err(SpotifyError::Browser)?;

        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, listener.wait_for_code(&state))
            .await
            .map_err(|_| SpotifyError::TimedOut)??;
        self.exchange_code(&code, &redirect_uri, &verifier).await
    }

    /// Spotify's approval page for this sign-in.
    pub fn authorize_url(&self, redirect_uri: &str, challenge: &str, state: &str) -> String {
        let mut url = Url::parse(&format!("{}/authorize", self.endpoints.accounts))
            .expect("the accounts endpoint is a valid URL");
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", challenge)
            .append_pair("state", state)
            .append_pair("scope", SCOPES);
        url.into()
    }

    /// Swaps the authorisation code for tokens, and saves them.
    pub async fn exchange_code(
        &self,
        code: &str,
        redirect_uri: &str,
        verifier: &Verifier,
    ) -> Result<(), SpotifyError> {
        let request = self.http.post(&self.token_url()).form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", &self.client_id),
            ("code_verifier", verifier.as_str()),
        ]);
        let response = self.http.send(request).await?;
        if !response.status().is_success() {
            return Err(SpotifyError::Unexpected {
                what: "the sign-in code",
                status: response.status(),
            });
        }
        let reply: TokenReply = response.json().await.map_err(HttpError::from)?;
        let refresh = reply.refresh_token.ok_or(SpotifyError::Unexpected {
            what: "the sign-in code (no refresh token)",
            status: StatusCode::OK,
        })?;
        let tokens = Tokens::new(reply.access_token, refresh, self.expiry(reply.expires_in));
        self.store.save(&tokens)?;
        Ok(())
    }

    /// Your Spotify profile, for the "Signed in as" line.
    pub async fn profile(&self) -> Result<Profile, SpotifyError> {
        let me: Me = self.get("/v1/me", &[], "your profile").await?;
        Ok(Profile {
            name: me
                .display_name
                .filter(|name| !name.is_empty())
                .unwrap_or(me.id),
        })
    }

    /// GETs `path` from the Web API with your access token, and reads the
    /// JSON reply. `what` names it in errors.
    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
        what: &'static str,
    ) -> Result<T, SpotifyError> {
        let response = self
            .send_api(|url| self.http.get(url).query(query), path, what)
            .await?;
        Ok(response.json().await.map_err(HttpError::from)?)
    }

    /// Sends a Web API request with your access token, and returns the reply
    /// if it succeeded. `build` makes the request for a URL, and may be called
    /// twice: a token can stop working before it expires, so a `401` is
    /// retried once with a refreshed one. `what` names it in errors.
    async fn send_api(
        &self,
        build: impl Fn(&str) -> RequestBuilder,
        path: &str,
        what: &'static str,
    ) -> Result<Response, SpotifyError> {
        let url = format!("{}{path}", self.endpoints.api);
        let request = |token: String| build(&url).bearer_auth(token);
        let mut response = self
            .http
            .send(request(self.access_token(false).await?))
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            response = self
                .http
                .send(request(self.access_token(true).await?))
                .await?;
        }
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        // Spotify explains most failures, such as Premium being needed to
        // play. Say what it said rather than just the status.
        let error: Option<ApiError> = response.json().await.ok();
        match error.map(|e| e.error.message).filter(|m| !m.is_empty()) {
            Some(message) => Err(SpotifyError::Refused {
                what,
                status,
                message,
            }),
            None => Err(SpotifyError::Unexpected { what, status }),
        }
    }

    /// A working access token, refreshed first if it's about to expire (or
    /// `force` is set).
    async fn access_token(&self, force: bool) -> Result<String, SpotifyError> {
        let token = self.fresh_token(force).await;
        if let Err(error @ (SpotifyError::SignedOut | SpotifyError::NotSignedIn)) = &token
            && let Some(hook) = &self.signed_out
        {
            hook(error);
        }
        token
    }

    async fn fresh_token(&self, force: bool) -> Result<String, SpotifyError> {
        let _guard = self.refresh_lock.lock().await;
        let tokens = self.store.load()?.ok_or(SpotifyError::NotSignedIn)?;
        let expiring = self.http.clock().now() + EXPIRY_MARGIN >= tokens.expires_at();
        if !force && !expiring {
            return Ok(tokens.access().to_owned());
        }
        let refreshed = self.refresh(&tokens).await?;
        self.store.save(&refreshed)?;
        Ok(refreshed.access().to_owned())
    }

    async fn refresh(&self, tokens: &Tokens) -> Result<Tokens, SpotifyError> {
        let request = self.http.post(&self.token_url()).form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", tokens.refresh()),
            ("client_id", &self.client_id),
        ]);
        let response = self.http.send(request).await?;
        let status = response.status();
        if status == StatusCode::BAD_REQUEST {
            let error: Option<OAuthError> = response.json().await.ok();
            // `invalid_grant`: the refresh token expired or was revoked.
            // `invalid_client`: the Spotify app was deleted or the client ID
            // changed. Either way the only way on is to sign in again.
            if let Some("invalid_grant" | "invalid_client") =
                error.as_ref().map(|e| e.error.as_str())
            {
                self.store.clear()?;
                return Err(SpotifyError::SignedOut);
            }
            return Err(SpotifyError::Unexpected {
                what: "the token refresh",
                status,
            });
        }
        if !status.is_success() {
            return Err(SpotifyError::Unexpected {
                what: "the token refresh",
                status,
            });
        }
        let reply: TokenReply = response.json().await.map_err(HttpError::from)?;
        // Spotify sometimes sends a new refresh token. If it doesn't, the old
        // one is still valid.
        let refresh = reply
            .refresh_token
            .unwrap_or_else(|| tokens.refresh().to_owned());
        Ok(Tokens::new(
            reply.access_token,
            refresh,
            self.expiry(reply.expires_in),
        ))
    }

    fn token_url(&self) -> String {
        format!("{}/api/token", self.endpoints.accounts)
    }

    fn expiry(&self, expires_in: u64) -> std::time::SystemTime {
        self.http.clock().now() + Duration::from_secs(expires_in)
    }
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
}

/// The body of most Web API errors.
#[derive(Deserialize)]
struct ApiError {
    error: ApiErrorDetail,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct Me {
    id: String,
    display_name: Option<String>,
}

#[cfg(test)]
mod tests;
