//! The iTunes Search API: albums by barcode (`/lookup?upc=`) or by artist
//! and title (`/search`). Apple asks for about 20 calls a minute.
//!
//! Its replies also carry each album's genre and copyright line, which
//! `genre_label` reads.
//!
//! Its artwork URLs end in the size they ask for, such as `100x100bb.jpg`.
//! Asking for something huge returns the original upload, which was 3,000 to
//! 4,000 pixels in testing (RFC-001 research).

use serde::Deserialize;

use super::{ArtworkError, By, Finder, Hit};
use crate::clock::Clock;

pub const SERVICE: &str = "iTunes";

/// The size we ask Apple for: bigger than any original, so we get the
/// original. `100000x100000` is refused.
const HUGE: &str = "10000x10000bb";

impl<C: Clock + Clone> Finder<C> {
    pub(super) async fn itunes(&self, by: By<'_>) -> Result<Vec<Hit>, ArtworkError> {
        Ok(self
            .itunes_albums(by)
            .await?
            .into_iter()
            .filter_map(|album| {
                Some(Hit {
                    artist: album.artist_name?,
                    title: album.collection_name?,
                    cover: original(&album.artwork_url100?),
                })
            })
            .collect())
    }

    /// The albums iTunes finds, as it describes them.
    pub(super) async fn itunes_albums(&self, by: By<'_>) -> Result<Vec<Item>, ArtworkError> {
        let request = match by {
            By::Upc(upc) => self
                .client
                .get(format!("{}/lookup", self.endpoints.itunes))
                .query(&[("upc", upc), ("entity", "album")]),
            By::Name { artist, title } => self
                .client
                .get(format!("{}/search", self.endpoints.itunes))
                .query(&[
                    ("term", format!("{artist} {title}").as_str()),
                    ("media", "music"),
                    ("entity", "album"),
                    ("limit", "10"),
                ]),
        };
        let reply: Reply = self.search_json(SERVICE, &self.itunes, request).await?;
        Ok(reply
            .results
            .into_iter()
            .filter(|result| result.wrapper_type.as_deref() == Some("collection"))
            .collect())
    }
}

/// The URL of the original upload, from one that asks for a size.
/// `…/634904032463.png/100x100bb.jpg` → `…/634904032463.png/10000x10000bb.jpg`.
/// A URL that doesn't end in a size is left as it is.
fn original(url: &str) -> String {
    let Some((path, file)) = url.rsplit_once('/') else {
        return url.to_owned();
    };
    let Some((size, extension)) = file.split_once('.') else {
        return url.to_owned();
    };
    let is_size = size.strip_suffix("bb").is_some_and(|dimensions| {
        dimensions
            .split_once('x')
            .is_some_and(|(w, h)| is_number(w) && is_number(h))
    });
    if is_size {
        format!("{path}/{HUGE}.{extension}")
    } else {
        url.to_owned()
    }
}

fn is_number(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Deserialize)]
struct Reply {
    #[serde(default)]
    results: Vec<Item>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Item {
    wrapper_type: Option<String>,
    pub artist_name: Option<String>,
    collection_name: Option<String>,
    artwork_url100: Option<String>,
    /// One coarse genre, such as "Alternative".
    pub primary_genre_name: Option<String>,
    /// Such as "℗ 2007 XL Recordings Ltd".
    pub copyright: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_the_original_upload() {
        assert_eq!(
            original(
                "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dd/50/c7/x/634904032463.png/100x100bb.jpg"
            ),
            "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dd/50/c7/x/634904032463.png/10000x10000bb.jpg"
        );
        for unchanged in [
            "https://example.com/cover.jpg",
            "https://example.com/600x600.jpg",
            "https://example.com/axbbb.jpg",
            "no slashes",
        ] {
            assert_eq!(original(unchanged), unchanged);
        }
    }
}
