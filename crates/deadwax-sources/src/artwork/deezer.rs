//! Deezer: albums by barcode (`/album/upc:<UPC>`) or by artist and title
//! (`/search/album`). It allows 50 requests every 5 seconds.
//!
//! `cover_xl` is Deezer's documented 1,000-pixel cover. Bigger sizes work
//! through an undocumented URL change, which we don't rely on.
//!
//! Deezer reports most failures, "not found" included, as a `200` whose body
//! is an `error`.

use serde::Deserialize;

use super::{ArtworkError, By, Finder, Hit};
use crate::clock::Clock;

pub const SERVICE: &str = "Deezer";

/// Deezer's error code for "no data": nothing found.
const NO_DATA: u32 = 800;

impl<C: Clock + Clone> Finder<C> {
    pub(super) async fn deezer(&self, by: By<'_>) -> Result<Vec<Hit>, ArtworkError> {
        let request = match by {
            By::Upc(upc) => self
                .client
                .get(format!("{}/album/upc:{upc}", self.endpoints.deezer)),
            By::Name { artist, title } => self
                .client
                .get(format!("{}/search/album", self.endpoints.deezer))
                .query(&[
                    (
                        "q",
                        format!(r#"artist:"{}" album:"{}""#, quoted(artist), quoted(title))
                            .as_str(),
                    ),
                    ("limit", "10"),
                ]),
        };
        self.deezer.wait().await;
        let reply: Reply = self
            .send(SERVICE, request)
            .await?
            .json()
            .await
            .map_err(|error| ArtworkError::Network {
                service: SERVICE,
                error,
            })?;
        let albums = match reply {
            Reply::Failed { error } if error.code == Some(NO_DATA) => Vec::new(),
            Reply::Failed { error } => {
                return Err(ArtworkError::Refused {
                    service: SERVICE,
                    message: error.message,
                });
            }
            Reply::Found { data } => data,
            Reply::Album(album) => vec![album],
        };
        Ok(albums.into_iter().filter_map(hit).collect())
    }
}

/// `text` with the double quotes taken out, so it can sit inside a quoted
/// search term.
fn quoted(text: &str) -> String {
    text.replace('"', "")
}

fn hit(album: Album) -> Option<Hit> {
    // An album without a cover still has a `cover_xl`: Deezer's placeholder,
    // with an empty `md5_image`.
    if album.md5_image.as_deref().is_none_or(str::is_empty) {
        return None;
    }
    Some(Hit {
        artist: album.artist?.name,
        title: album.title,
        cover: album.cover_xl?,
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Reply {
    Failed { error: Error },
    Found { data: Vec<Album> },
    Album(Album),
}

#[derive(Deserialize)]
struct Error {
    #[serde(default)]
    message: String,
    code: Option<u32>,
}

#[derive(Deserialize)]
struct Album {
    title: String,
    artist: Option<Artist>,
    cover_xl: Option<String>,
    md5_image: Option<String>,
}

#[derive(Deserialize)]
struct Artist {
    name: String,
}
