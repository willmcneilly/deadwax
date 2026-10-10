//! The iTunes Search API: albums by barcode (`/lookup?upc=`) or by artist
//! and title (`/search`). Apple asks for about 20 calls a minute.
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
        self.itunes.wait().await;
        let reply: Reply = self
            .send(SERVICE, request)
            .await?
            .json()
            .await
            .map_err(|error| ArtworkError::Network {
                service: SERVICE,
                error,
            })?;
        Ok(reply
            .results
            .into_iter()
            .filter(|result| result.wrapper_type.as_deref() == Some("collection"))
            .filter_map(|result| {
                Some(Hit {
                    artist: result.artist_name?,
                    title: result.collection_name?,
                    cover: original(&result.artwork_url100?),
                })
            })
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
struct Item {
    wrapper_type: Option<String>,
    artist_name: Option<String>,
    collection_name: Option<String>,
    artwork_url100: Option<String>,
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
