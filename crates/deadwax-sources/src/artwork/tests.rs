//! The lookup against a fake server standing in for all four services, with
//! hand-written replies shaped like the real ones (checked live on
//! 2026-10-10). Each service gets its own path prefix.

use std::sync::{Arc, Mutex};

use deadwax_core::collection::{Album, ArtworkSource, Cover};
use serde_json::{Value, json};
use wiremock::matchers::{method, path, path_regex, query_param, query_param_contains};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::clock::fake::FakeClock;

const UPC: &str = "634904032463";
const RELEASE: &str = "1a33443c-3fff-450f-8298-efbc65659d32";
const OTHER_RELEASE: &str = "0b4b2f2c-1d1e-4f6a-9a51-2e0c6f1b7c10";

fn endpoints(server: &MockServer) -> Endpoints {
    Endpoints {
        itunes: format!("{}/itunes", server.uri()),
        deezer: format!("{}/deezer", server.uri()),
        musicbrainz: format!("{}/mb", server.uri()),
        cover_art_archive: format!("{}/caa", server.uri()),
    }
}

fn finder(server: &MockServer) -> (Finder<FakeClock>, Arc<Mutex<Vec<String>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    (
        Finder::new(FakeClock::new(log.clone()), endpoints(server)),
        log,
    )
}

fn in_rainbows() -> Album {
    Album {
        spotify_id: "5vkqYmiPBYLaalcmjujWxK".into(),
        title: "In Rainbows".into(),
        artist: "Radiohead".into(),
        year: Some(2007),
        tracks: Vec::new(),
        covers: vec![
            Cover {
                url: "https://i.scdn.co/image/in-rainbows-300".into(),
                width: Some(300),
                height: Some(300),
            },
            Cover {
                url: "https://i.scdn.co/image/in-rainbows-640".into(),
                width: Some(640),
                height: Some(640),
            },
        ],
        upc: Some(UPC.into()),
    }
}

/// The start of a PNG: enough for its size to be read.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

fn ok(body: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(body)
}

/// Every service finds nothing, unless a test mounts something else first.
async fn nothing_anywhere(server: &MockServer) {
    let empty_itunes = ok(json!({"resultCount": 0, "results": []}));
    let no_data =
        ok(json!({"error": {"type": "DataException", "message": "no data", "code": 800}}));
    for (route, reply) in [
        ("/itunes/lookup", empty_itunes.clone()),
        ("/itunes/search", empty_itunes),
        ("/deezer/search/album", ok(json!({"data": [], "total": 0}))),
        ("/mb/ws/2/release/", ok(json!({"count": 0, "releases": []}))),
    ] {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(reply)
            .with_priority(10)
            .mount(server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path_regex("^/deezer/album/upc:"))
        .respond_with(no_data)
        .with_priority(10)
        .mount(server)
        .await;
}

/// An image of this size at `route`.
async fn image(server: &MockServer, route: &str, width: u32, height: u32) {
    Mock::given(method("GET"))
        .and(path(route))
        .respond_with(ResponseTemplate::new(206).set_body_bytes(png(width, height)))
        .mount(server)
        .await;
}

fn itunes_album(server: &MockServer, artist: &str, title: &str) -> Value {
    json!({
        "wrapperType": "collection",
        "collectionType": "Album",
        "artistName": artist,
        "collectionName": title,
        "artworkUrl100": format!("{}/mzstatic/thumb/{UPC}.png/100x100bb.jpg", server.uri()),
    })
}

fn deezer_album(server: &MockServer, artist: &str, title: &str) -> Value {
    json!({
        "title": title,
        "upc": UPC,
        "md5_image": "a175af9b7d329bc678cb4d26fc13d6de",
        "cover_xl": format!("{}/dzcdn/cover/a175af/1000x1000-000000-80-0-0.jpg", server.uri()),
        "artist": {"name": artist},
    })
}

fn musicbrainz_release(id: &str, artist: &str, title: &str) -> Value {
    json!({
        "id": id,
        "score": 100,
        "title": title,
        "barcode": UPC,
        "artist-credit": [{"name": artist, "artist": {"name": artist}}],
    })
}

/// What was asked of whom, in order.
async fn asked(server: &MockServer) -> Vec<String> {
    server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|request| {
            let path = request.url.path();
            let query = |name: &str| {
                request
                    .url
                    .query_pairs()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default()
            };
            if path == "/itunes/lookup" {
                format!("iTunes upc {}", query("upc"))
            } else if path == "/itunes/search" {
                format!("iTunes term {}", query("term"))
            } else if let Some(upc) = path.strip_prefix("/deezer/album/upc:") {
                format!("Deezer upc {upc}")
            } else if path == "/deezer/search/album" {
                format!("Deezer q {}", query("q"))
            } else if path == "/mb/ws/2/release/" {
                format!("MusicBrainz query {}", query("query"))
            } else if let Some(release) = path.strip_prefix("/caa/release/") {
                format!("Cover Art Archive {release}")
            } else {
                format!("image {path}")
            }
        })
        .collect()
}

#[tokio::test]
async fn tries_itunes_then_deezer_then_musicbrainz_by_barcode_then_by_name() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, _) = finder(&server);

    finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(
        asked(&server).await,
        [
            format!("iTunes upc {UPC}"),
            format!("Deezer upc {UPC}"),
            format!("MusicBrainz query barcode:{UPC}"),
            "iTunes term Radiohead In Rainbows".into(),
            r#"Deezer q artist:"Radiohead" album:"In Rainbows""#.into(),
            r#"MusicBrainz query release:"In Rainbows" AND artist:"Radiohead""#.into(),
        ]
    );
}

#[tokio::test]
async fn with_no_match_anywhere_the_cover_is_spotifys() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(
        artwork,
        Artwork {
            source: ArtworkSource::Spotify,
            cover: Some(Cover {
                url: "https://i.scdn.co/image/in-rainbows-640".into(),
                width: Some(640),
                height: Some(640),
            }),
        }
    );
}

#[tokio::test]
async fn with_no_match_and_no_spotify_cover_there_is_no_cover() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, _) = finder(&server);
    let mut album = in_rainbows();
    album.covers.clear();

    let artwork = finder.find(&album).await.unwrap();

    assert_eq!(
        artwork,
        Artwork {
            source: ArtworkSource::Spotify,
            cover: None,
        }
    );
}

#[tokio::test]
async fn an_itunes_barcode_match_wins_at_the_original_size() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path("/itunes/lookup"))
        .and(query_param("upc", UPC))
        .and(query_param("entity", "album"))
        .respond_with(ok(json!({
            "resultCount": 1,
            "results": [itunes_album(&server, "Radiohead", "In Rainbows")],
        })))
        .mount(&server)
        .await;
    let original = format!("/mzstatic/thumb/{UPC}.png/10000x10000bb.jpg");
    image(&server, &original, 4000, 4000).await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(
        artwork,
        Artwork {
            source: ArtworkSource::Itunes,
            cover: Some(Cover {
                url: format!("{}{original}", server.uri()),
                width: Some(4000),
                height: Some(4000),
            }),
        }
    );
    // Nothing else was asked once iTunes had it.
    assert_eq!(
        asked(&server).await,
        [format!("iTunes upc {UPC}"), format!("image {original}")]
    );
}

#[tokio::test]
async fn only_the_start_of_the_image_is_asked_for() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path("/itunes/lookup"))
        .respond_with(ok(json!({
            "results": [itunes_album(&server, "Radiohead", "In Rainbows")],
        })))
        .mount(&server)
        .await;
    image(
        &server,
        &format!("/mzstatic/thumb/{UPC}.png/10000x10000bb.jpg"),
        4000,
        4000,
    )
    .await;
    let (finder, _) = finder(&server);

    finder.find(&in_rainbows()).await.unwrap();

    let requests = server.received_requests().await.unwrap();
    let image = requests.last().unwrap();
    assert_eq!(image.headers.get("range").unwrap(), "bytes=0-524287");
}

#[tokio::test]
async fn a_deezer_barcode_match_wins_when_itunes_has_none() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path(format!("/deezer/album/upc:{UPC}")))
        .respond_with(ok(deezer_album(&server, "Radiohead", "In Rainbows")))
        .mount(&server)
        .await;
    image(
        &server,
        "/dzcdn/cover/a175af/1000x1000-000000-80-0-0.jpg",
        1000,
        1000,
    )
    .await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(artwork.source, ArtworkSource::Deezer);
    assert_eq!(
        artwork.cover.map(|c| (c.width, c.height)),
        Some((Some(1000), Some(1000)))
    );
    // MusicBrainz is never asked.
    assert_eq!(
        asked(&server).await,
        [
            format!("iTunes upc {UPC}"),
            format!("Deezer upc {UPC}"),
            "image /dzcdn/cover/a175af/1000x1000-000000-80-0-0.jpg".into(),
        ]
    );
}

#[tokio::test]
async fn deezers_placeholder_for_an_album_without_a_cover_isnt_a_match() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let mut placeholder = deezer_album(&server, "Radiohead", "In Rainbows");
    placeholder["md5_image"] = json!("");
    Mock::given(method("GET"))
        .and(path(format!("/deezer/album/upc:{UPC}")))
        .respond_with(ok(placeholder))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(artwork.source, ArtworkSource::Spotify);
}

#[tokio::test]
async fn a_musicbrainz_match_uses_the_cover_art_archives_1200_pixel_front_cover() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path("/mb/ws/2/release/"))
        .and(query_param("query", format!("barcode:{UPC}")))
        .and(query_param("fmt", "json"))
        .respond_with(ok(json!({
            "count": 2,
            "releases": [
                musicbrainz_release(OTHER_RELEASE, "Radiohead", "In Rainbows"),
                musicbrainz_release(RELEASE, "Radiohead", "In Rainbows"),
            ],
        })))
        .mount(&server)
        .await;
    // The first release has no cover art.
    Mock::given(method("GET"))
        .and(path(format!("/caa/release/{OTHER_RELEASE}")))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let caa = format!("{}/caa-images/release/{RELEASE}", server.uri());
    Mock::given(method("GET"))
        .and(path(format!("/caa/release/{RELEASE}")))
        .respond_with(ok(json!({
            "images": [
                {"front": false, "types": ["Back"], "image": format!("{caa}/back.jpg"), "thumbnails": {}},
                {
                    "front": true,
                    "types": ["Front"],
                    "image": format!("{caa}/front.jpg"),
                    "thumbnails": {
                        "250": format!("{caa}/front-250.jpg"),
                        "500": format!("{caa}/front-500.jpg"),
                        "1200": format!("{caa}/front-1200.jpg"),
                    },
                },
            ],
        })))
        .mount(&server)
        .await;
    image(
        &server,
        &format!("/caa-images/release/{RELEASE}/front-1200.jpg"),
        1200,
        1200,
    )
    .await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(
        artwork,
        Artwork {
            source: ArtworkSource::MusicBrainz,
            cover: Some(Cover {
                url: format!("{caa}/front-1200.jpg"),
                width: Some(1200),
                height: Some(1200),
            }),
        }
    );
    assert_eq!(
        asked(&server).await[2..],
        [
            format!("MusicBrainz query barcode:{UPC}"),
            format!("Cover Art Archive {OTHER_RELEASE}"),
            format!("Cover Art Archive {RELEASE}"),
            format!("image /caa-images/release/{RELEASE}/front-1200.jpg"),
        ]
    );
}

#[tokio::test]
async fn an_older_cover_art_archive_upload_without_a_1200_uses_the_original() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path("/mb/ws/2/release/"))
        .respond_with(ok(json!({
            "releases": [musicbrainz_release(RELEASE, "Radiohead", "In Rainbows")],
        })))
        .mount(&server)
        .await;
    let caa = format!("{}/caa-images/release/{RELEASE}", server.uri());
    Mock::given(method("GET"))
        .and(path(format!("/caa/release/{RELEASE}")))
        .respond_with(ok(json!({
            "images": [{
                "front": true,
                "image": format!("{caa}/14926982777.jpg"),
                "thumbnails": {"small": format!("{caa}/14926982777-250.jpg"), "large": format!("{caa}/14926982777-500.jpg")},
            }],
        })))
        .mount(&server)
        .await;
    image(
        &server,
        &format!("/caa-images/release/{RELEASE}/14926982777.jpg"),
        1425,
        1425,
    )
    .await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(artwork.cover.unwrap().url, format!("{caa}/14926982777.jpg"));
}

#[tokio::test]
async fn a_barcode_miss_falls_back_to_artist_and_title_without_the_edition() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    // Found by name, as the standard edition.
    Mock::given(method("GET"))
        .and(path("/itunes/search"))
        .and(query_param("term", "Radiohead In Rainbows"))
        .respond_with(ok(json!({
            "results": [
                itunes_album(&server, "Radiohead", "In Rainbows (Disk 2)"),
                itunes_album(&server, "Radiohead", "In Rainbows"),
            ],
        })))
        .mount(&server)
        .await;
    image(
        &server,
        &format!("/mzstatic/thumb/{UPC}.png/10000x10000bb.jpg"),
        3000,
        3000,
    )
    .await;
    let (finder, _) = finder(&server);
    let mut deluxe = in_rainbows();
    deluxe.title = "In Rainbows (Deluxe Edition)".into();
    deluxe.upc = Some("827969777220".into());

    let artwork = finder.find(&deluxe).await.unwrap();

    assert_eq!(artwork.source, ArtworkSource::Itunes);
    assert_eq!(
        asked(&server).await[..4],
        [
            "iTunes upc 827969777220".to_string(),
            "Deezer upc 827969777220".into(),
            "MusicBrainz query barcode:827969777220".into(),
            "iTunes term Radiohead In Rainbows".into(),
        ]
    );
}

#[tokio::test]
async fn remastered_is_stripped_before_searching_by_name() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path("/deezer/search/album"))
        .and(query_param_contains("q", r#"album:"OK Computer""#))
        .respond_with(ok(json!({
            "data": [deezer_album(&server, "Radiohead", "OK Computer")],
        })))
        .mount(&server)
        .await;
    image(
        &server,
        "/dzcdn/cover/a175af/1000x1000-000000-80-0-0.jpg",
        1000,
        1000,
    )
    .await;
    let (finder, _) = finder(&server);
    let mut remaster = in_rainbows();
    remaster.title = "OK Computer (Remastered)".into();
    remaster.upc = None;

    let artwork = finder.find(&remaster).await.unwrap();

    assert_eq!(artwork.source, ArtworkSource::Deezer);
    // With no barcode, the search starts with names.
    assert_eq!(
        asked(&server).await[..2],
        [
            "iTunes term Radiohead OK Computer".to_string(),
            r#"Deezer q artist:"Radiohead" album:"OK Computer""#.into(),
        ]
    );
}

#[tokio::test]
async fn a_result_whose_artist_doesnt_match_exactly_is_rejected() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    for (route, artist) in [
        ("/itunes/lookup", "Radiohead Tribute Band"),
        ("/itunes/search", "Various Artists"),
    ] {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ok(json!({
                "results": [itunes_album(&server, artist, "In Rainbows")],
            })))
            .mount(&server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path(format!("/deezer/album/upc:{UPC}")))
        .respond_with(ok(deezer_album(&server, "Thom Yorke", "In Rainbows")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/deezer/search/album"))
        .respond_with(ok(json!({
            "data": [deezer_album(&server, "Radiohead", "In Rainbows")],
        })))
        .mount(&server)
        .await;
    image(
        &server,
        "/dzcdn/cover/a175af/1000x1000-000000-80-0-0.jpg",
        1000,
        1000,
    )
    .await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    // iTunes and Deezer's barcode results, and iTunes' name result, were the
    // wrong artist. Deezer's name result was right.
    assert_eq!(artwork.source, ArtworkSource::Deezer);
    let asked = asked(&server).await;
    assert!(!asked.iter().any(|a| a.contains("mzstatic")), "{asked:?}");
}

#[tokio::test]
async fn a_name_result_with_another_title_is_rejected() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path("/itunes/search"))
        .respond_with(ok(json!({
            "results": [itunes_album(&server, "Radiohead", "In Rainbows (Disk 2)")],
        })))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(artwork.source, ArtworkSource::Spotify);
}

#[tokio::test]
async fn an_image_whose_size_cant_be_read_is_kept_without_one() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path(format!("/deezer/album/upc:{UPC}")))
        .respond_with(ok(deezer_album(&server, "Radiohead", "In Rainbows")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/dzcdn/cover/a175af/1000x1000-000000-80-0-0.jpg"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"not an image".to_vec()))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let artwork = finder.find(&in_rainbows()).await.unwrap();

    assert_eq!(artwork.source, ArtworkSource::Deezer);
    assert_eq!(
        artwork.cover.map(|c| (c.width, c.height)),
        Some((None, None))
    );
}

#[tokio::test]
async fn a_failing_service_is_an_error_not_a_miss() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path(format!("/deezer/album/upc:{UPC}")))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let error = finder.find(&in_rainbows()).await.unwrap_err();

    assert_eq!(error.to_string(), "Deezer replied 503 Service Unavailable");
}

#[tokio::test]
async fn a_deezer_error_other_than_no_data_is_an_error() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    Mock::given(method("GET"))
        .and(path(format!("/deezer/album/upc:{UPC}")))
        .respond_with(ok(json!({
            "error": {"type": "Exception", "message": "Quota limit exceeded", "code": 4},
        })))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let error = finder.find(&in_rainbows()).await.unwrap_err();

    assert_eq!(error.to_string(), "Deezer replied: Quota limit exceeded");
}

#[tokio::test]
async fn musicbrainz_is_told_who_deadwax_is_with_no_email_address() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, _) = finder(&server);

    finder.find(&in_rainbows()).await.unwrap();

    let requests = server.received_requests().await.unwrap();
    let musicbrainz: Vec<_> = requests
        .iter()
        .filter(|r| r.url.path().starts_with("/mb/"))
        .collect();
    assert_eq!(musicbrainz.len(), 2);
    for request in musicbrainz {
        let agent = request.headers.get("user-agent").unwrap().to_str().unwrap();
        assert!(agent.starts_with("Deadwax/"), "{agent}");
        assert!(
            agent.contains("https://github.com/willmcneilly/deadwax"),
            "{agent}"
        );
        assert!(!agent.contains('@'), "{agent}");
        assert!(!request.url.as_str().contains('@'));
        for (_, value) in &request.headers {
            assert!(!value.to_str().unwrap_or_default().contains('@'));
        }
    }
}

#[tokio::test]
async fn itunes_is_asked_no_more_than_20_times_a_minute() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, log) = finder(&server);

    for _ in 0..3 {
        finder.itunes(By::Upc(UPC)).await.unwrap();
    }

    assert_eq!(*log.lock().unwrap(), ["sleep 3s", "sleep 3s"]);
}

#[tokio::test]
async fn musicbrainz_is_asked_no_more_than_once_a_second() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, log) = finder(&server);

    for _ in 0..3 {
        finder.musicbrainz(By::Upc(UPC)).await.unwrap();
    }

    assert_eq!(*log.lock().unwrap(), ["sleep 1s", "sleep 1s"]);
}

#[tokio::test]
async fn deezer_is_asked_no_more_than_50_times_in_5_seconds() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, log) = finder(&server);

    for _ in 0..2 {
        finder.deezer(By::Upc(UPC)).await.unwrap();
    }

    assert_eq!(*log.lock().unwrap(), ["sleep 0.1s"]);
}

#[tokio::test]
async fn a_whole_lookup_spaces_out_its_itunes_and_musicbrainz_requests() {
    let server = MockServer::start().await;
    nothing_anywhere(&server).await;
    let (finder, log) = finder(&server);

    finder.find(&in_rainbows()).await.unwrap();

    // The clock only moves when something waits. iTunes' second request
    // waits 3 seconds, which covers Deezer's and MusicBrainz's intervals.
    assert_eq!(*log.lock().unwrap(), ["sleep 3s"]);
}

#[test]
fn only_digits_are_barcodes() {
    assert!(is_barcode(UPC));
    assert!(is_barcode("0634904032463"));
    assert!(!is_barcode("634904032463&entity=song"));
    assert!(!is_barcode(""));
}

// Downloading the winner.

fn cover_at(server: &MockServer, image: &str) -> Cover {
    Cover {
        url: format!("{}/images/{image}", server.uri()),
        width: None,
        height: None,
    }
}

#[tokio::test]
async fn downloads_the_whole_cover() {
    let server = MockServer::start().await;
    let image: Vec<u8> = (0..=255).cycle().take(3 * 1024 * 1024).collect();
    Mock::given(method("GET"))
        .and(path("/images/cover.jpg"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(image.clone()))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let downloaded = finder
        .download(ArtworkSource::Itunes, &cover_at(&server, "cover.jpg"))
        .await
        .unwrap();

    assert_eq!(downloaded, image);
}

#[tokio::test]
async fn a_failed_download_is_an_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let result = finder
        .download(ArtworkSource::Deezer, &cover_at(&server, "gone.jpg"))
        .await;

    assert!(matches!(
        result,
        Err(ArtworkError::Unexpected {
            service: "Deezer",
            ..
        })
    ));
}

#[tokio::test]
async fn a_download_too_big_to_be_a_cover_is_an_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0; MAX_DOWNLOAD + 1]))
        .mount(&server)
        .await;
    let (finder, _) = finder(&server);

    let result = finder
        .download(ArtworkSource::Spotify, &cover_at(&server, "huge.jpg"))
        .await;

    assert!(matches!(result, Err(ArtworkError::TooBig { .. })));
}
