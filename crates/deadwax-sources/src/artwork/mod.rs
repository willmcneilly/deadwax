//! Finding each album's sharpest cover. See RFC-001, "High-res artwork, as
//! an experiment".
//!
//! Spotify's covers stop at about 640 pixels. We look for a bigger one by the
//! album's barcode (UPC), trying iTunes, then Deezer, then MusicBrainz with
//! the Cover Art Archive. If the barcode finds nothing anywhere, we try the
//! same sources by artist and title, with edition words like "Deluxe
//! Edition" and "Remastered" taken out. A result only counts if its artist
//! is the album's. If nothing matches, the cover is Spotify's own.
//!
//! The barcode goes first everywhere because it names the exact release.
//! Artist and title can find a different edition with a different cover.
//!
//! The lookup keeps the winning image's URL, its source and its pixel size,
//! read from the start of the image. Then the album job queue downloads the
//! winner once (`Finder::download`) and keeps it in sizes on disk, for
//! Deadwax's own use (RFC-002, "2. Local artwork, in sizes").
//!
//! The same sources give each album its genre and label
//! (`Finder::genre_and_label`, RFC-002, "3. Genre and label"). They share
//! the lookup's rate limits, and its iTunes and MusicBrainz replies
//! (`replies`), so asking for both rarely costs a second request.

mod deezer;
mod genre_label;
mod itunes;
mod musicbrainz;
mod names;
mod replies;

use std::time::Duration;

use deadwax_core::collection::{Album, Artwork, ArtworkSource, Cover};
use reqwest::header::RANGE;
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;

use crate::clock::Clock;
use crate::limiter::Limiter;
pub use genre_label::strip_copyright;
pub use names::{same_artist, same_title, strip_edition};
use replies::Replies;

/// How Deadwax introduces itself. MusicBrainz asks every app to say who it
/// is and how to reach whoever runs it: that's the project's GitHub page,
/// never an email address.
pub const USER_AGENT: &str = concat!(
    "Deadwax/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/willmcneilly/deadwax )"
);

/// Apple asks for about 20 calls a minute at most.
pub const ITUNES_INTERVAL: Duration = Duration::from_secs(3);
/// Deezer allows 50 requests every 5 seconds.
pub const DEEZER_INTERVAL: Duration = Duration::from_millis(100);
/// MusicBrainz allows one request a second.
pub const MUSICBRAINZ_INTERVAL: Duration = Duration::from_secs(1);

/// How much of an image we read to find its size. A JPEG's size comes after
/// its metadata, which is usually a few kilobytes.
const SIZE_PROBE: usize = 512 * 1024;

/// The most we download for one cover. The biggest real covers are a few
/// megabytes, so anything past this isn't a cover.
pub const MAX_DOWNLOAD: usize = 40 * 1024 * 1024;

/// How many matching MusicBrainz releases we ask the Cover Art Archive
/// about, when the first ones have no front cover.
const MAX_RELEASES: usize = 3;

/// Where the sources live. Tests point them all at a local fake server.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub itunes: String,
    pub deezer: String,
    pub musicbrainz: String,
    pub cover_art_archive: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            itunes: "https://itunes.apple.com".into(),
            deezer: "https://api.deezer.com".into(),
            musicbrainz: "https://musicbrainz.org".into(),
            cover_art_archive: "https://coverartarchive.org".into(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ArtworkError {
    #[error("couldn't reach {service}: {error}")]
    Network {
        service: &'static str,
        error: reqwest::Error,
    },
    #[error("{service} replied {status}")]
    Unexpected {
        service: &'static str,
        status: StatusCode,
    },
    #[error("{service} replied: {message}")]
    Refused {
        service: &'static str,
        message: String,
    },
    #[error("{service}'s cover is over {} MB", MAX_DOWNLOAD / 1024 / 1024)]
    TooBig { service: &'static str },
    #[error("couldn't read {service}'s reply: {error}")]
    Unreadable {
        service: &'static str,
        error: serde_json::Error,
    },
}

/// What we're looking for: by barcode, or by artist and title.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By<'a> {
    Upc(&'a str),
    Name { artist: &'a str, title: &'a str },
}

/// One album a source found, before we check it's the right one.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Hit {
    artist: String,
    title: String,
    /// The cover's URL, or for MusicBrainz the release's ID, whose cover is
    /// in the Cover Art Archive.
    cover: String,
}

pub struct Finder<C> {
    client: reqwest::Client,
    endpoints: Endpoints,
    clock: C,
    itunes: Limiter<C>,
    deezer: Limiter<C>,
    musicbrainz: Limiter<C>,
    /// Recent iTunes and MusicBrainz replies, for the next step to reuse.
    replies: Replies,
}

impl<C: Clock + Clone> Finder<C> {
    pub fn new(clock: C, endpoints: Endpoints) -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent(USER_AGENT)
                // One stalled request mustn't hold up the queue behind it.
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("a plain HTTP client builds"),
            endpoints,
            itunes: Limiter::new(clock.clone(), ITUNES_INTERVAL),
            deezer: Limiter::new(clock.clone(), DEEZER_INTERVAL),
            musicbrainz: Limiter::new(clock.clone(), MUSICBRAINZ_INTERVAL),
            clock,
            replies: Replies::default(),
        }
    }

    /// The sharpest cover we can find for `album`, or Spotify's own.
    pub async fn find(&self, album: &Album) -> Result<Artwork, ArtworkError> {
        let title = strip_edition(&album.title);
        let mut searches = Vec::new();
        if let Some(upc) = album.upc.as_deref().filter(|upc| is_barcode(upc)) {
            searches.push(By::Upc(upc));
        }
        searches.push(By::Name {
            artist: &album.artist,
            title: &title,
        });
        for by in searches {
            for source in [
                ArtworkSource::Itunes,
                ArtworkSource::Deezer,
                ArtworkSource::MusicBrainz,
            ] {
                if let Some(url) = self.search(source, by, album).await? {
                    let cover = self.measure(source, url).await?;
                    return Ok(Artwork {
                        source,
                        cover: Some(cover),
                    });
                }
            }
        }
        Ok(Artwork {
            source: ArtworkSource::Spotify,
            cover: album.largest_cover().cloned(),
        })
    }

    /// Downloads the whole image the lookup found, from `source`.
    pub async fn download(
        &self,
        source: ArtworkSource,
        cover: &Cover,
    ) -> Result<Vec<u8>, ArtworkError> {
        let service = source_name(source);
        let mut response = self.send(service, self.client.get(&cover.url)).await?;
        let mut image = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| ArtworkError::Network { service, error })?
        {
            if image.len() + chunk.len() > MAX_DOWNLOAD {
                return Err(ArtworkError::TooBig { service });
            }
            image.extend_from_slice(&chunk);
        }
        Ok(image)
    }

    /// The cover URL of the first of `source`'s results that is `album`.
    async fn search(
        &self,
        source: ArtworkSource,
        by: By<'_>,
        album: &Album,
    ) -> Result<Option<String>, ArtworkError> {
        let is_album = |hit: &Hit| {
            same_artist(&album.artist, &hit.artist)
                && (matches!(by, By::Upc(_)) || same_title(&album.title, &hit.title))
        };
        match source {
            ArtworkSource::Itunes => {
                let hits = self.itunes(by).await?;
                Ok(hits.into_iter().find(is_album).map(|hit| hit.cover))
            }
            ArtworkSource::Deezer => {
                let hits = self.deezer(by).await?;
                Ok(hits.into_iter().find(is_album).map(|hit| hit.cover))
            }
            ArtworkSource::MusicBrainz => {
                let releases = self.musicbrainz(by).await?;
                for release in releases.into_iter().filter(is_album).take(MAX_RELEASES) {
                    if let Some(url) = self.front_cover(&release.cover).await? {
                        return Ok(Some(url));
                    }
                }
                Ok(None)
            }
            ArtworkSource::Spotify => Ok(None),
        }
    }

    /// Sends a request to `service`, and returns the reply if it succeeded.
    async fn send(
        &self,
        service: &'static str,
        request: RequestBuilder,
    ) -> Result<Response, ArtworkError> {
        let response = request
            .send()
            .await
            .map_err(|error| ArtworkError::Network { service, error })?;
        if !response.status().is_success() {
            return Err(ArtworkError::Unexpected {
                service,
                status: response.status(),
            });
        }
        Ok(response)
    }

    /// `request`'s reply from `service`, read as JSON. A reply to the same
    /// URL from the last few minutes is reused; otherwise the request waits
    /// its turn on `limiter`.
    async fn search_json<T: DeserializeOwned>(
        &self,
        service: &'static str,
        limiter: &Limiter<C>,
        request: RequestBuilder,
    ) -> Result<T, ArtworkError> {
        let request = request
            .build()
            .map_err(|error| ArtworkError::Network { service, error })?;
        let url = request.url().to_string();
        let read = |body: &[u8]| {
            serde_json::from_slice(body)
                .map_err(|error| ArtworkError::Unreadable { service, error })
        };
        if let Some(body) = self.replies.get(&url, self.clock.now()) {
            return read(&body);
        }
        limiter.wait().await;
        let request = RequestBuilder::from_parts(Client::clone(&self.client), request);
        let body = self
            .send(service, request)
            .await?
            .bytes()
            .await
            .map_err(|error| ArtworkError::Network { service, error })?
            .to_vec();
        let reply = read(&body)?;
        self.replies.put(url, self.clock.now(), body);
        Ok(reply)
    }

    /// The cover at `url` with its pixel size, read from the start of the
    /// image. An image whose size can't be read is still used, without one.
    async fn measure(&self, source: ArtworkSource, url: String) -> Result<Cover, ArtworkError> {
        let service = source_name(source);
        let request = self
            .client
            .get(&url)
            .header(RANGE, format!("bytes=0-{}", SIZE_PROBE - 1));
        let mut response = self.send(service, request).await?;
        let mut start = Vec::new();
        let size = loop {
            if let Ok(size) = imagesize::blob_size(&start) {
                break Some(size);
            }
            if start.len() >= SIZE_PROBE {
                break None;
            }
            match response
                .chunk()
                .await
                .map_err(|error| ArtworkError::Network { service, error })?
            {
                Some(chunk) => start.extend_from_slice(&chunk),
                None => break None,
            }
        };
        let dimension = |n: usize| u32::try_from(n).ok();
        Ok(Cover {
            url,
            width: size.and_then(|s| dimension(s.width)),
            height: size.and_then(|s| dimension(s.height)),
        })
    }
}

fn source_name(source: ArtworkSource) -> &'static str {
    match source {
        ArtworkSource::Itunes => itunes::SERVICE,
        ArtworkSource::Deezer => deezer::SERVICE,
        ArtworkSource::MusicBrainz => musicbrainz::COVER_ART_ARCHIVE,
        ArtworkSource::Spotify => "Spotify",
    }
}

/// UPCs and EANs are 12 or 13 digits, sometimes 14. Checking keeps anything
/// else out of the queries.
fn is_barcode(upc: &str) -> bool {
    (8..=14).contains(&upc.len()) && upc.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests;
