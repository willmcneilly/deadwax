//! The one HTTP client every Spotify call goes through, so rate limits are
//! handled in one place.
//!
//! Spotify counts requests over a rolling 30 seconds and doesn't publish the
//! limit. When it's hit, the reply is a `429` with `Retry-After` in seconds.
//! We wait exactly that long and try again, a few times at most, and never in
//! a tight loop.

use std::time::Duration;

use reqwest::header::RETRY_AFTER;
use reqwest::{Request, RequestBuilder, Response, StatusCode};

use crate::clock::Clock;

/// How many times a request is retried after a `429` before giving up.
const MAX_RETRIES: u32 = 3;

/// The longest `Retry-After` we'll sit through. Spotify sometimes asks for
/// hours. Better to say so than to leave a button spinning.
const MAX_WAIT: Duration = Duration::from_secs(30);

/// The wait when a `429` has no usable `Retry-After`.
const DEFAULT_WAIT: Duration = Duration::from_secs(5);

/// Each is a plain sentence for the UI (RFC-002, "What the back end gains").
/// The HTTP library's own text stays in the `source`, out of sight.
#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    /// No connection, a timeout, or a reply that broke off.
    #[error("Couldn't reach Spotify. Check the connection, then try again.")]
    Network(#[source] reqwest::Error),
    /// A reply that isn't the JSON Spotify documents.
    #[error("Spotify sent a reply Deadwax couldn't read.")]
    Unreadable(#[source] reqwest::Error),
    #[error("Spotify is rate limiting Deadwax. Try again in {} seconds.", .0.as_secs())]
    RateLimited(Duration),
}

impl From<reqwest::Error> for HttpError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_decode() {
            Self::Unreadable(error)
        } else {
            Self::Network(error)
        }
    }
}

pub struct SpotifyHttp<C> {
    client: reqwest::Client,
    clock: C,
}

impl<C: Clock> SpotifyHttp<C> {
    pub fn new(clock: C) -> Self {
        Self {
            client: reqwest::Client::new(),
            clock,
        }
    }

    pub fn clock(&self) -> &C {
        &self.clock
    }

    pub fn get(&self, url: &str) -> RequestBuilder {
        self.client.get(url)
    }

    pub fn post(&self, url: &str) -> RequestBuilder {
        self.client.post(url)
    }

    pub fn put(&self, url: &str) -> RequestBuilder {
        self.client.put(url)
    }

    /// Sends the request, waiting out any `429`s. Any other status is the
    /// caller's to handle.
    pub async fn send(&self, request: RequestBuilder) -> Result<Response, HttpError> {
        let request = request.build()?;
        let mut retries = 0;
        loop {
            let response = self.client.execute(clone(&request)).await?;
            if response.status() != StatusCode::TOO_MANY_REQUESTS {
                return Ok(response);
            }
            let wait = retry_after(&response);
            if retries == MAX_RETRIES || wait > MAX_WAIT {
                return Err(HttpError::RateLimited(wait));
            }
            retries += 1;
            self.clock.sleep(wait).await;
        }
    }
}

fn clone(request: &Request) -> Request {
    // Our requests have no streaming bodies, so they always clone.
    request
        .try_clone()
        .expect("Spotify requests have cloneable bodies")
}

fn retry_after(response: &Response) -> Duration {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_WAIT)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, Request as MockRequest, Respond, ResponseTemplate};

    use super::*;
    use crate::clock::SystemClock;
    use crate::clock::fake::FakeClock;

    /// Writes "request" to the shared log, then replies with `response`.
    struct Logged {
        log: Arc<Mutex<Vec<String>>>,
        response: ResponseTemplate,
    }

    impl Respond for Logged {
        fn respond(&self, _: &MockRequest) -> ResponseTemplate {
            self.log.lock().unwrap().push("request".into());
            self.response.clone()
        }
    }

    /// A server whose first `limited` replies are `429`s with `retry_after`,
    /// and every reply after that a `200`.
    async fn server(log: &Arc<Mutex<Vec<String>>>, limited: u64, retry_after: &str) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(Logged {
                log: log.clone(),
                response: ResponseTemplate::new(429).insert_header("Retry-After", retry_after),
            })
            .up_to_n_times(limited)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(Logged {
                log: log.clone(),
                response: ResponseTemplate::new(200),
            })
            .with_priority(2)
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn retries_a_429_after_its_retry_after_and_only_then() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let server = server(&log, 1, "2").await;
        let http = SpotifyHttp::new(FakeClock::new(log.clone()));

        let response = http
            .send(http.get(&format!("{}/v1/me", server.uri())))
            .await
            .unwrap();

        assert_eq!(response.status(), 200);
        assert_eq!(*log.lock().unwrap(), ["request", "sleep 2s", "request"]);
    }

    #[tokio::test]
    async fn gives_up_after_three_retries() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let server = server(&log, 10, "1").await;
        let http = SpotifyHttp::new(FakeClock::new(log.clone()));

        let result = http
            .send(http.get(&format!("{}/v1/me", server.uri())))
            .await;

        assert!(
            matches!(result, Err(HttpError::RateLimited(wait)) if wait == Duration::from_secs(1))
        );
        assert_eq!(
            *log.lock().unwrap(),
            [
                "request", "sleep 1s", "request", "sleep 1s", "request", "sleep 1s", "request"
            ]
        );
    }

    #[tokio::test]
    async fn does_not_sit_through_a_long_retry_after() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let server = server(&log, 1, "3600").await;
        let http = SpotifyHttp::new(FakeClock::new(log.clone()));

        let result = http
            .send(http.get(&format!("{}/v1/me", server.uri())))
            .await;

        assert!(
            matches!(result, Err(HttpError::RateLimited(wait)) if wait == Duration::from_secs(3600))
        );
        assert_eq!(*log.lock().unwrap(), ["request"]);
    }

    #[tokio::test]
    async fn waits_a_default_time_when_retry_after_is_missing_or_unreadable() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let server = server(&log, 1, "soon").await;
        let http = SpotifyHttp::new(FakeClock::new(log.clone()));

        http.send(http.get(&format!("{}/v1/me", server.uri())))
            .await
            .unwrap();

        assert_eq!(*log.lock().unwrap(), ["request", "sleep 5s", "request"]);
    }

    /// A port nothing is listening on: one that was free a moment ago.
    fn closed_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[tokio::test]
    async fn no_connection_is_a_plain_sentence_not_the_http_librarys() {
        let http = SpotifyHttp::new(SystemClock);

        let error = http
            .send(http.get(&format!("http://127.0.0.1:{}/v1/me", closed_port())))
            .await
            .unwrap_err();

        assert!(matches!(error, HttpError::Network(_)), "{error:?}");
        assert_eq!(
            error.to_string(),
            "Couldn't reach Spotify. Check the connection, then try again."
        );
    }

    #[tokio::test]
    async fn a_reply_that_isnt_json_says_so_rather_than_blaming_the_connection() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>"))
            .mount(&server)
            .await;
        let http = SpotifyHttp::new(SystemClock);

        let response = http
            .send(http.get(&format!("{}/v1/me", server.uri())))
            .await
            .unwrap();
        let error = HttpError::from(response.json::<serde_json::Value>().await.unwrap_err());

        assert_eq!(
            error.to_string(),
            "Spotify sent a reply Deadwax couldn't read."
        );
    }
}
