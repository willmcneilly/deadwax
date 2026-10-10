//! Finding albums and fetching them. See RFC-001, "Finding albums" and
//! "Spotify's 2026 limits".
//!
//! Since February 2026, search returns at most 10 results a request, so we
//! page with an offset. Albums are fetched one at a time: the "get several
//! albums" call is gone.

use deadwax_core::collection::{Album, Cover, Track};
use serde::Deserialize;

use super::{Spotify, SpotifyError};
use crate::clock::Clock;
use crate::spotify::tokens::TokenStore;

/// Results per search request: Spotify's limit for development-mode apps.
pub const SEARCH_PAGE: u32 = 10;

/// Tracks per request when an album's tracklist runs past its first page.
const TRACKS_PAGE: u32 = 50;

/// One search result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AlbumSummary {
    pub spotify_id: String,
    pub title: String,
    /// The album's artists, joined with ", ".
    pub artist: String,
    pub year: Option<u16>,
    pub covers: Vec<Cover>,
}

/// A page of search results.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchPage {
    pub albums: Vec<AlbumSummary>,
    /// The offset that asks for the next page, if there is one.
    pub next_offset: Option<u32>,
}

impl<C: Clock, S: TokenStore> Spotify<C, S> {
    /// Searches Spotify's albums, `SEARCH_PAGE` at a time from `offset`.
    pub async fn search_albums(
        &self,
        query: &str,
        offset: u32,
    ) -> Result<SearchPage, SpotifyError> {
        let reply: SearchReply = self
            .get(
                "/v1/search",
                &[
                    ("q", query.to_owned()),
                    ("type", "album".into()),
                    ("limit", SEARCH_PAGE.to_string()),
                    ("offset", offset.to_string()),
                ],
                "the search",
            )
            .await?;
        let page = reply.albums;
        // Spotify counts the gaps it leaves in `items` (below) towards the
        // offset, so the next page starts after all of them.
        let next_offset = page
            .next
            .map(|_| offset + u32::try_from(page.items.len()).unwrap_or(SEARCH_PAGE));
        Ok(SearchPage {
            // Spotify's search sometimes has `null` where a result should be.
            albums: page.items.into_iter().flatten().map(summary).collect(),
            next_offset,
        })
    }

    /// Fetches one album with its whole tracklist.
    pub async fn album(&self, spotify_id: &str) -> Result<Album, SpotifyError> {
        if !is_spotify_id(spotify_id) {
            return Err(SpotifyError::NotAnId(spotify_id.to_owned()));
        }
        let reply: AlbumReply = self
            .get(&format!("/v1/albums/{spotify_id}"), &[], "the album")
            .await?;
        let mut tracks = reply.tracks.items;
        let mut more = reply.tracks.next.is_some();
        while more {
            let page: Page<TrackReply> = self
                .get(
                    &format!("/v1/albums/{spotify_id}/tracks"),
                    &[
                        ("offset", tracks.len().to_string()),
                        ("limit", TRACKS_PAGE.to_string()),
                    ],
                    "the album's tracks",
                )
                .await?;
            // An empty page would loop for ever.
            more = page.next.is_some() && !page.items.is_empty();
            tracks.extend(page.items);
        }
        Ok(Album {
            spotify_id: reply.id,
            title: reply.name,
            artist: artists(&reply.artists),
            year: year(&reply.release_date),
            tracks: tracks.into_iter().map(track).collect(),
            covers: reply.images.into_iter().map(cover).collect(),
            upc: reply.external_ids.and_then(|ids| ids.upc),
        })
    }
}

/// Spotify IDs are 22 base-62 characters. Checking keeps anything else out
/// of the request's path.
pub fn is_spotify_id(id: &str) -> bool {
    id.len() == 22 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn summary(album: AlbumItem) -> AlbumSummary {
    AlbumSummary {
        spotify_id: album.id,
        title: album.name,
        artist: artists(&album.artists),
        year: year(&album.release_date),
        covers: album.images.into_iter().map(cover).collect(),
    }
}

fn artists(artists: &[Artist]) -> String {
    artists
        .iter()
        .map(|artist| artist.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// The year from a release date, which Spotify gives as `2007`, `2007-12`
/// or `2007-12-28`, and sometimes as `0000` when it doesn't know.
fn year(release_date: &str) -> Option<u16> {
    release_date
        .get(..4)
        .and_then(|year| year.parse().ok())
        .filter(|&year| year > 0)
}

fn cover(image: Image) -> Cover {
    Cover {
        url: image.url,
        width: image.width,
        height: image.height,
    }
}

fn track(track: TrackReply) -> Track {
    Track {
        spotify_id: track.id.unwrap_or_default(),
        disc: track.disc_number,
        number: track.track_number,
        title: track.name,
        duration_ms: track.duration_ms,
    }
}

// What Spotify sends. Only the fields Deadwax uses.

#[derive(Deserialize)]
struct SearchReply {
    albums: Page<Option<AlbumItem>>,
}

#[derive(Deserialize)]
struct Page<T> {
    items: Vec<T>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct AlbumItem {
    id: String,
    name: String,
    #[serde(default)]
    artists: Vec<Artist>,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    images: Vec<Image>,
}

#[derive(Deserialize)]
struct AlbumReply {
    id: String,
    name: String,
    #[serde(default)]
    artists: Vec<Artist>,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    images: Vec<Image>,
    tracks: Page<TrackReply>,
    /// Removed in February 2026, then restored in March. It may go again.
    external_ids: Option<ExternalIds>,
}

#[derive(Deserialize)]
struct Artist {
    name: String,
}

#[derive(Deserialize)]
struct Image {
    url: String,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Deserialize)]
struct TrackReply {
    id: Option<String>,
    name: String,
    disc_number: u32,
    track_number: u32,
    duration_ms: u64,
}

#[derive(Deserialize)]
struct ExternalIds {
    upc: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{Value, json};
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::clock::fake::FakeClock;
    use crate::spotify::Endpoints;
    use crate::spotify::tokens::{MemoryStore, Tokens};

    // Hand-written in the shape of Spotify's reference docs, trimmed to
    // typical fields. Not recorded from the real API.
    const SEARCH_FIRST: &str = include_str!("fixtures/search-albums-in-rainbows-0.json");
    const SEARCH_LAST: &str = include_str!("fixtures/search-albums-in-rainbows-10.json");
    const ALBUM: &str = include_str!("fixtures/album-in-rainbows.json");

    const IN_RAINBOWS: &str = "5vkqYmiPBYLaalcmjujWxK";

    async fn signed_in(server: &MockServer) -> Spotify<FakeClock, MemoryStore> {
        signed_in_logging(server, Arc::new(Mutex::new(Vec::new()))).await
    }

    /// Signed in, with the fake clock writing its sleeps to `log`.
    async fn signed_in_logging(
        server: &MockServer,
        log: Arc<Mutex<Vec<String>>>,
    ) -> Spotify<FakeClock, MemoryStore> {
        let clock = FakeClock::new(log);
        let endpoints = Endpoints {
            accounts: server.uri(),
            api: server.uri(),
            redirect_port: 0,
        };
        let tokens = Tokens::new(
            "access".into(),
            "refresh".into(),
            clock.now() + Duration::from_secs(3600),
        );
        let spotify = Spotify::new("id".into(), clock, MemoryStore::default(), endpoints);
        spotify.store.save(&tokens).unwrap();
        spotify
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    async fn search_replies(server: &MockServer, offset: &str, body: &str) {
        Mock::given(method("GET"))
            .and(path("/v1/search"))
            .and(header("authorization", "Bearer access"))
            .and(query_param("q", "in rainbows"))
            .and(query_param("type", "album"))
            .and(query_param("limit", "10"))
            .and(query_param("offset", offset))
            .respond_with(ResponseTemplate::new(200).set_body_json(json(body)))
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn search_returns_ten_albums_and_the_next_offset() {
        let server = MockServer::start().await;
        search_replies(&server, "0", SEARCH_FIRST).await;
        let spotify = signed_in(&server).await;

        let page = spotify.search_albums("in rainbows", 0).await.unwrap();

        assert_eq!(page.albums.len(), 10);
        assert_eq!(page.next_offset, Some(10));
        assert_eq!(
            page.albums[0],
            AlbumSummary {
                spotify_id: IN_RAINBOWS.into(),
                title: "In Rainbows".into(),
                artist: "Radiohead".into(),
                year: Some(2007),
                covers: vec![
                    Cover {
                        url: "https://i.scdn.co/image/ab67616d0000b273de3c04b5fc750b68899b20a9"
                            .into(),
                        width: Some(640),
                        height: Some(640),
                    },
                    Cover {
                        url: "https://i.scdn.co/image/ab67616d00001e02de3c04b5fc750b68899b20a9"
                            .into(),
                        width: Some(300),
                        height: Some(300),
                    },
                    Cover {
                        url: "https://i.scdn.co/image/ab67616d00004851de3c04b5fc750b68899b20a9"
                            .into(),
                        width: Some(64),
                        height: Some(64),
                    },
                ],
            }
        );
        // Several artists are joined, and a year-only date still has a year.
        let disk = &page.albums[1];
        assert_eq!(disk.artist, "Radiohead, Nigel Godrich");
        assert_eq!(disk.year, Some(2008));
    }

    #[tokio::test]
    async fn more_asks_for_the_next_offset_and_the_last_page_has_none() {
        let server = MockServer::start().await;
        search_replies(&server, "10", SEARCH_LAST).await;
        let spotify = signed_in(&server).await;

        let page = spotify.search_albums("in rainbows", 10).await.unwrap();

        assert_eq!(page.next_offset, None);
        // The last page has a `null` where a result should be, and an album
        // with no known release date.
        assert_eq!(page.albums.len(), 2);
        assert_eq!(page.albums[1].year, None);
    }

    #[tokio::test]
    async fn search_waits_out_a_429() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/search"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "2"))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        search_replies(&server, "0", SEARCH_FIRST).await;
        let log = Arc::new(Mutex::new(Vec::new()));
        let spotify = signed_in_logging(&server, log.clone()).await;

        let page = spotify.search_albums("in rainbows", 0).await.unwrap();

        assert_eq!(page.albums.len(), 10);
        assert_eq!(*log.lock().unwrap(), ["sleep 2s"]);
    }

    #[tokio::test]
    async fn a_page_with_gaps_still_moves_on_by_a_whole_page() {
        let server = MockServer::start().await;
        let mut body = json(SEARCH_FIRST);
        body["albums"]["items"][3] = Value::Null;
        search_replies(&server, "0", &body.to_string()).await;
        let spotify = signed_in(&server).await;

        let page = spotify.search_albums("in rainbows", 0).await.unwrap();

        assert_eq!(page.albums.len(), 9);
        assert_eq!(page.next_offset, Some(10));
    }

    #[tokio::test]
    async fn fetches_an_album_with_its_tracklist_and_upc() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/v1/albums/{IN_RAINBOWS}")))
            .and(header("authorization", "Bearer access"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json(ALBUM)))
            .expect(1)
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        let album = spotify.album(IN_RAINBOWS).await.unwrap();

        assert_eq!(album.spotify_id, IN_RAINBOWS);
        assert_eq!(album.title, "In Rainbows");
        assert_eq!(album.artist, "Radiohead");
        assert_eq!(album.year, Some(2007));
        assert_eq!(album.upc.as_deref(), Some("634904032463"));
        assert_eq!(album.covers.len(), 3);
        assert_eq!(album.largest_cover().unwrap().width, Some(640));
        let titles: Vec<&str> = album.tracks.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "15 Step",
                "Bodysnatchers",
                "Nude",
                "Weird Fishes/Arpeggi",
                "All I Need",
                "Faust Arp",
                "Reckoner",
                "House Of Cards",
                "Jigsaw Falling Into Place",
                "Videotape",
            ]
        );
        assert_eq!(
            album.tracks[0],
            Track {
                spotify_id: "4GPQDyw9hC1DiZVh0ouDVL".into(),
                disc: 1,
                number: 1,
                title: "15 Step".into(),
                duration_ms: 237_293,
            }
        );
    }

    #[tokio::test]
    async fn an_album_without_external_ids_has_no_upc() {
        let server = MockServer::start().await;
        let mut body = json(ALBUM);
        body.as_object_mut().unwrap().remove("external_ids");
        Mock::given(method("GET"))
            .and(path(format!("/v1/albums/{IN_RAINBOWS}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        assert_eq!(spotify.album(IN_RAINBOWS).await.unwrap().upc, None);
    }

    #[tokio::test]
    async fn a_long_tracklist_is_fetched_page_by_page() {
        let server = MockServer::start().await;
        let track = |n: usize| {
            json!({
                "id": format!("track{n:018}"), "name": format!("Track {n}"),
                "disc_number": 1, "track_number": n, "duration_ms": 1000,
            })
        };
        let mut body = json(ALBUM);
        body["tracks"] = json!({
            "items": (1..=50).map(track).collect::<Vec<_>>(),
            "next": "https://api.spotify.com/v1/albums/x/tracks?offset=50&limit=50",
            "total": 120,
        });
        Mock::given(method("GET"))
            .and(path(format!("/v1/albums/{IN_RAINBOWS}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        for (offset, items, next) in [(50, 51..=100, true), (100, 101..=120, false)] {
            Mock::given(method("GET"))
                .and(path(format!("/v1/albums/{IN_RAINBOWS}/tracks")))
                .and(query_param("offset", offset.to_string()))
                .and(query_param("limit", "50"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "items": items.map(track).collect::<Vec<_>>(),
                    "next": next.then_some("https://api.spotify.com/v1/next"),
                    "total": 120,
                })))
                .expect(1)
                .mount(&server)
                .await;
        }
        let spotify = signed_in(&server).await;

        let album = spotify.album(IN_RAINBOWS).await.unwrap();

        assert_eq!(album.tracks.len(), 120);
        assert_eq!(album.tracks[119].title, "Track 120");
    }

    #[tokio::test]
    async fn refuses_an_album_id_that_isnt_one() {
        let server = MockServer::start().await;
        let spotify = signed_in(&server).await;

        for id in ["", "../me", "5vkqYmiPBYLaalcmjujWx/", "short"] {
            assert!(matches!(
                spotify.album(id).await,
                Err(SpotifyError::NotAnId(_))
            ));
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_missing_album_is_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "error": {"status": 404, "message": "Resource not found"},
            })))
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        let error = spotify.album(IN_RAINBOWS).await.unwrap_err();

        assert_eq!(
            error.to_string(),
            "Spotify replied 404 Not Found to the album: Resource not found"
        );
    }

    #[test]
    fn years_come_from_any_precision_of_release_date() {
        assert_eq!(year("2007-12-28"), Some(2007));
        assert_eq!(year("2007-12"), Some(2007));
        assert_eq!(year("2007"), Some(2007));
        assert_eq!(year("0000"), None);
        assert_eq!(year(""), None);
    }
}
