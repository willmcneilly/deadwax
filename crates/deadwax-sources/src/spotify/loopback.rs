//! The one-shot listener that catches Spotify's redirect after sign-in.
//!
//! Spotify only allows `http://127.0.0.1:<port>` for a desktop app's redirect.
//! Its docs say the port can be left out when registering and picked at
//! runtime, but its dashboard refuses an address without a port. So Deadwax
//! listens on one fixed port, `REDIRECT_PORT`, that you register, and waits
//! for the browser to arrive with the authorisation code.

use std::io;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use url::Url;

/// The path in the redirect URI. Spotify matches it exactly, so it's also
/// what the setup screen tells you to register.
pub const CALLBACK_PATH: &str = "/callback";

/// The port in the redirect URI you register with Spotify:
/// `http://127.0.0.1:43117/callback`. An obscure one, so it's unlikely to be
/// in use.
pub const REDIRECT_PORT: u16 = 43117;

/// How long to keep trying a port that's in use. A sign-in that was just
/// cancelled may take a moment to let go of it.
const PORT_WAIT: Duration = Duration::from_secs(2);

/// What the redirect ended in, apart from success.
#[derive(Debug, thiserror::Error)]
pub enum CallbackError {
    #[error("the redirect's state doesn't match this sign-in")]
    StateMismatch,
    #[error("Spotify didn't approve the sign-in ({0})")]
    Denied(String),
    #[error("the redirect had no authorisation code")]
    MissingCode,
    #[error(
        "another app is using port {0}, which Deadwax needs to finish signing in. \
         Quit it and try again"
    )]
    PortInUse(u16),
    #[error("the sign-in listener failed: {0}")]
    Io(#[from] io::Error),
}

/// A listener on `127.0.0.1`.
pub struct Listener {
    listener: TcpListener,
    port: u16,
}

impl Listener {
    /// Listens on `port` (`REDIRECT_PORT`, or 0 for any free port in
    /// tests). If the port is in use, keeps trying for a moment first.
    pub async fn bind(port: u16) -> Result<Self, CallbackError> {
        let deadline = tokio::time::Instant::now() + PORT_WAIT;
        let listener = loop {
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => break listener,
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(CallbackError::PortInUse(port));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) => return Err(error.into()),
            }
        };
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK_PATH}", self.port)
    }

    /// Waits for the redirect and returns the authorisation code, if its
    /// `state` is `expected_state`. Other requests (a browser asking for
    /// `/favicon.ico`) get a 404 and the wait goes on. The browser is shown a
    /// page saying whether it worked, either way.
    ///
    /// Connections are read side by side, because browsers open spare
    /// connections ahead of time that may never send anything. Waiting on
    /// one of those would miss the redirect.
    pub async fn wait_for_code(self, expected_state: &str) -> Result<String, CallbackError> {
        let (requests, mut arrived) = mpsc::channel(8);
        loop {
            tokio::select! {
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted?;
                    let requests = requests.clone();
                    tokio::spawn(async move {
                        if let Some(request) = read_request(stream).await {
                            let _ = requests.send(request).await;
                        }
                    });
                }
                Some((stream, target)) = arrived.recv() => {
                    if let Some(result) = answer(stream, target, expected_state).await {
                        return result;
                    }
                }
            }
        }
    }
}

/// Answers one request. Returns the sign-in's result if it was the
/// redirect, or `None` if the wait should go on.
async fn answer(
    mut stream: TcpStream,
    target: Option<String>,
    expected_state: &str,
) -> Option<Result<String, CallbackError>> {
    let url = target.and_then(|target| Url::parse(&format!("http://127.0.0.1{target}")).ok());
    let Some(url) = url else {
        respond(
            &mut stream,
            "400 Bad Request",
            "That wasn't a request Deadwax understands.",
        )
        .await;
        return None;
    };
    if url.path() != CALLBACK_PATH {
        respond(&mut stream, "404 Not Found", "Nothing here.").await;
        return None;
    }
    let result = parse_callback(&url, expected_state);
    let (status, message) = match result {
        Ok(_) => (
            "200 OK",
            "You're signed in to Spotify. You can close this tab and go back to Deadwax.",
        ),
        Err(_) => (
            "400 Bad Request",
            "Deadwax couldn't finish signing in. Close this tab and try again from Deadwax.",
        ),
    };
    respond(&mut stream, status, message).await;
    Some(result)
}

fn parse_callback(url: &Url, expected_state: &str) -> Result<String, CallbackError> {
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    // Check the state before anything else: a reply that isn't ours tells us
    // nothing, not even an error.
    if param("state").as_deref() != Some(expected_state) {
        return Err(CallbackError::StateMismatch);
    }
    if let Some(error) = param("error") {
        return Err(CallbackError::Denied(error));
    }
    param("code")
        .filter(|code| !code.is_empty())
        .ok_or(CallbackError::MissingCode)
}

/// How long a connection gets to send its request before it's dropped.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Reads the request head. Returns the connection and the request target
/// (`/callback?code=…`), or no target if it isn't an HTTP `GET`. Returns
/// nothing at all if the connection fails or stays silent.
async fn read_request(mut stream: TcpStream) -> Option<(TcpStream, Option<String>)> {
    // The redirect is a single short GET. 8 KiB is far more than it needs.
    let mut buffer = vec![0u8; 8192];
    let mut len = 0;
    while !buffer[..len].windows(4).any(|w| w == b"\r\n\r\n") && len < buffer.len() {
        let read = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut buffer[len..]))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        len += read;
    }
    let head = String::from_utf8_lossy(&buffer[..len]);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let target = match (parts.next(), parts.next()) {
        (Some("GET"), Some(target)) if target.starts_with('/') => Some(target.to_owned()),
        _ => None,
    };
    Some((stream, target))
}

/// The browser may already have gone, so a failed write is ignored.
async fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Deadwax</title></head>\
         <body style=\"font-family: -apple-system, sans-serif; margin: 4em\"><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sends a raw GET to the listener, as a browser would, and returns the
    /// response.
    async fn get(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn redirect_uri_is_loopback_on_the_bound_port() {
        let listener = Listener::bind(0).await.unwrap();
        let uri = listener.redirect_uri();
        assert_eq!(uri, format!("http://127.0.0.1:{}/callback", listener.port));
        assert_ne!(listener.port, 0);
    }

    #[tokio::test]
    async fn a_port_in_use_is_reported_plainly() {
        let taken = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = taken.local_addr().unwrap().port();

        let error = Listener::bind(port).await.err().unwrap();

        assert!(matches!(error, CallbackError::PortInUse(p) if p == port));
        assert!(error.to_string().contains(&port.to_string()));
    }

    #[tokio::test]
    async fn waits_for_a_port_that_is_let_go_of_shortly() {
        let taken = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = taken.local_addr().unwrap().port();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(taken);
        });

        let listener = Listener::bind(port).await.unwrap();

        assert_eq!(listener.port, port);
    }

    #[tokio::test]
    async fn extracts_the_code_and_tells_the_browser_to_close_the_tab() {
        let listener = Listener::bind(0).await.unwrap();
        let port = listener.port;
        let waiting = tokio::spawn(listener.wait_for_code("expected-state"));

        let response = get(port, "/callback?code=the-code&state=expected-state").await;

        assert_eq!(waiting.await.unwrap().unwrap(), "the-code");
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("You can close this tab"));
    }

    #[tokio::test]
    async fn rejects_a_reply_whose_state_does_not_match() {
        let listener = Listener::bind(0).await.unwrap();
        let port = listener.port;
        let waiting = tokio::spawn(listener.wait_for_code("expected-state"));

        let response = get(port, "/callback?code=the-code&state=someone-elses").await;

        assert!(matches!(
            waiting.await.unwrap(),
            Err(CallbackError::StateMismatch)
        ));
        assert!(response.starts_with("HTTP/1.1 400"));
        assert!(!response.contains("You can close this tab"));
    }

    #[tokio::test]
    async fn rejects_a_reply_with_no_state() {
        let listener = Listener::bind(0).await.unwrap();
        let port = listener.port;
        let waiting = tokio::spawn(listener.wait_for_code("expected-state"));

        get(port, "/callback?code=the-code").await;

        assert!(matches!(
            waiting.await.unwrap(),
            Err(CallbackError::StateMismatch)
        ));
    }

    #[tokio::test]
    async fn reports_a_denied_sign_in() {
        let listener = Listener::bind(0).await.unwrap();
        let port = listener.port;
        let waiting = tokio::spawn(listener.wait_for_code("s"));

        get(port, "/callback?error=access_denied&state=s").await;

        assert!(matches!(
            waiting.await.unwrap(),
            Err(CallbackError::Denied(error)) if error == "access_denied"
        ));
    }

    #[tokio::test]
    async fn is_not_held_up_by_a_connection_that_sends_nothing() {
        let listener = Listener::bind(0).await.unwrap();
        let port = listener.port;
        let waiting = tokio::spawn(listener.wait_for_code("s"));

        // A browser's spare connection, opened ahead of time and left idle.
        let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        get(port, "/callback?code=c&state=s").await;

        assert_eq!(waiting.await.unwrap().unwrap(), "c");
    }

    #[tokio::test]
    async fn ignores_other_requests_until_the_redirect_arrives() {
        let listener = Listener::bind(0).await.unwrap();
        let port = listener.port;
        let waiting = tokio::spawn(listener.wait_for_code("s"));

        let favicon = get(port, "/favicon.ico").await;
        assert!(favicon.starts_with("HTTP/1.1 404"));
        assert!(!waiting.is_finished());

        get(port, "/callback?code=c&state=s").await;
        assert_eq!(waiting.await.unwrap().unwrap(), "c");
    }
}
