//! Spotify: signing in with PKCE, keeping the tokens fresh, and the calls
//! Deadwax makes. See RFC-001, "Signing in to Spotify".

pub mod http;
pub mod loopback;
pub mod pkce;
pub mod tokens;

use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;
use tokio::sync::Mutex;
use url::Url;

use crate::clock::Clock;
use http::{HttpError, SpotifyHttp};
use loopback::{CallbackError, Listener};
use pkce::Verifier;
use tokens::{Cached, StoreError, TokenStore, Tokens};

/// The permissions Deadwax asks for. Only the profile is used so far, and
/// `/v1/me` needs no scope for the display name. The playback scopes are for
/// playing albums later in project 1 (DWX-6): asking now saves you approving
/// Deadwax a second time.
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
    /// A reply we didn't expect. Never includes the request, which may hold a
    /// token.
    #[error("Spotify replied {status} to {what}")]
    Unexpected {
        what: &'static str,
        status: StatusCode,
    },
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
}

impl<C: Clock, S: TokenStore> Spotify<C, S> {
    pub fn new(client_id: String, clock: C, store: S, endpoints: Endpoints) -> Self {
        Self {
            http: SpotifyHttp::new(clock),
            store: Cached::new(store),
            client_id,
            endpoints,
            refresh_lock: Mutex::new(()),
        }
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
        let url = format!("{}/v1/me", self.endpoints.api);
        let mut response = self
            .http
            .send(
                self.http
                    .get(&url)
                    .bearer_auth(self.access_token(false).await?),
            )
            .await?;
        // A token can stop working before it expires. Refresh once and retry.
        if response.status() == StatusCode::UNAUTHORIZED {
            response = self
                .http
                .send(
                    self.http
                        .get(&url)
                        .bearer_auth(self.access_token(true).await?),
                )
                .await?;
        }
        if !response.status().is_success() {
            return Err(SpotifyError::Unexpected {
                what: "your profile",
                status: response.status(),
            });
        }
        let me: Me = response.json().await.map_err(HttpError::from)?;
        Ok(Profile {
            name: me
                .display_name
                .filter(|name| !name.is_empty())
                .unwrap_or(me.id),
        })
    }

    /// A working access token, refreshed first if it's about to expire (or
    /// `force` is set).
    async fn access_token(&self, force: bool) -> Result<String, SpotifyError> {
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

#[derive(Deserialize)]
struct Me {
    id: String,
    display_name: Option<String>,
}

#[cfg(test)]
mod tests;
