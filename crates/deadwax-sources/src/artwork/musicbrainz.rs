//! MusicBrainz and the Cover Art Archive. MusicBrainz finds the release, by
//! barcode or by artist and title, with its labels (which `genre_label`
//! reads). The Cover Art Archive has its cover, by
//! the release's ID.
//!
//! MusicBrainz allows one request a second, and wants every app to say who
//! it is in its User-Agent (`USER_AGENT`). The Cover Art Archive has no
//! limit. It offers 250, 500 and 1,200-pixel versions and the original
//! upload. Older uploads have no 1,200, so then we take the original.

use std::collections::HashMap;

use reqwest::StatusCode;
use serde::Deserialize;

use super::{ArtworkError, By, Finder, Hit};
use crate::clock::Clock;

pub const SERVICE: &str = "MusicBrainz";
pub const COVER_ART_ARCHIVE: &str = "the Cover Art Archive";

impl<C: Clock + Clone> Finder<C> {
    /// The releases MusicBrainz finds. Each hit's `cover` is its release ID.
    pub(super) async fn musicbrainz(&self, by: By<'_>) -> Result<Vec<Hit>, ArtworkError> {
        Ok(self
            .musicbrainz_releases(by)
            .await?
            .into_iter()
            .map(|release| Hit {
                artist: release.artist(),
                title: release.title,
                cover: release.id,
            })
            .collect())
    }

    /// The releases MusicBrainz finds, as it describes them.
    pub(super) async fn musicbrainz_releases(
        &self,
        by: By<'_>,
    ) -> Result<Vec<Release>, ArtworkError> {
        let query = match by {
            By::Upc(upc) => format!("barcode:{upc}"),
            By::Name { artist, title } => {
                format!(
                    r#"release:"{}" AND artist:"{}""#,
                    escape(title),
                    escape(artist)
                )
            }
        };
        let request = self
            .client
            .get(format!("{}/ws/2/release/", self.endpoints.musicbrainz))
            .query(&[("query", query.as_str()), ("fmt", "json"), ("limit", "10")]);
        let reply: Reply = self
            .search_json(SERVICE, &self.musicbrainz, request)
            .await?;
        Ok(reply.releases)
    }

    /// The release's front cover in the Cover Art Archive, if it has one.
    pub(super) async fn front_cover(&self, release: &str) -> Result<Option<String>, ArtworkError> {
        // Release IDs are UUIDs. Checking keeps anything else out of the path.
        if !release.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Ok(None);
        }
        let response = self
            .client
            .get(format!(
                "{}/release/{release}",
                self.endpoints.cover_art_archive
            ))
            .send()
            .await
            .map_err(|error| ArtworkError::Network {
                service: COVER_ART_ARCHIVE,
                error,
            })?;
        // No cover art for this release.
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(ArtworkError::Unexpected {
                service: COVER_ART_ARCHIVE,
                status: response.status(),
            });
        }
        let art: Art = response
            .json()
            .await
            .map_err(|error| ArtworkError::Network {
                service: COVER_ART_ARCHIVE,
                error,
            })?;
        Ok(art
            .images
            .into_iter()
            .find(|image| image.front)
            .map(|image| {
                let url = image.thumbnails.get("1200").unwrap_or(&image.image);
                secure(url)
            }))
    }
}

/// `text` safe inside a quoted Lucene search term.
fn escape(text: &str) -> String {
    text.replace('\\', r"\\").replace('"', r#"\""#)
}

/// The Cover Art Archive gives its own URLs as `http`, which the app's web
/// view may refuse. It serves the same files over `https`.
fn secure(url: &str) -> String {
    match url.strip_prefix("http://coverartarchive.org/") {
        Some(path) => format!("https://coverartarchive.org/{path}"),
        None => url.to_owned(),
    }
}

#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    releases: Vec<Release>,
}

#[derive(Deserialize)]
pub(super) struct Release {
    id: String,
    title: String,
    #[serde(rename = "artist-credit", default)]
    artist_credit: Vec<Credit>,
    #[serde(rename = "label-info", default)]
    pub label_info: Vec<LabelInfo>,
}

impl Release {
    /// The whole artist credit, as one name.
    pub fn artist(&self) -> String {
        self.artist_credit
            .iter()
            .map(|credit| format!("{}{}", credit.name, credit.joinphrase))
            .collect()
    }
}

/// One of a release's labels, with its catalogue number.
#[derive(Deserialize)]
pub(super) struct LabelInfo {
    pub label: Option<Label>,
}

#[derive(Deserialize)]
pub(super) struct Label {
    pub name: String,
}

/// One artist in a release's credit. The whole credit is each name followed
/// by its join phrase: "Simon" " & " "Garfunkel" "".
#[derive(Deserialize)]
struct Credit {
    name: String,
    #[serde(default)]
    joinphrase: String,
}

#[derive(Deserialize)]
struct Art {
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Deserialize)]
struct Image {
    #[serde(default)]
    front: bool,
    image: String,
    #[serde(default)]
    thumbnails: HashMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_quotes_in_search_terms() {
        assert_eq!(escape(r#"Say "Hi" \o/"#), r#"Say \"Hi\" \\o/"#);
    }

    #[test]
    fn asks_for_cover_art_archive_images_over_https() {
        assert_eq!(
            secure("http://coverartarchive.org/release/1a33/149.jpg"),
            "https://coverartarchive.org/release/1a33/149.jpg"
        );
        assert_eq!(
            secure("http://127.0.0.1:1234/release/1a33/149.jpg"),
            "http://127.0.0.1:1234/release/1a33/149.jpg"
        );
    }
}
