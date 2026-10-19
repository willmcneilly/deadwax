//! Playing albums on Spotify Connect devices, and following what's playing.
//! See RFC-001, "Playing music".
//!
//! Deadwax is a remote control: Spotify plays the music on whichever device
//! you pick, such as a Sonos room, the TV or the Spotify desktop app.
//! Spotify doesn't push changes to apps like this, so the UI asks for the
//! playback state every couple of seconds while it shows it.

use serde::Deserialize;
use serde_json::json;

use deadwax_core::collection::Cover;

use super::albums::{Image, cover, is_spotify_id};
use super::http::HttpError;
use super::{Spotify, SpotifyError};
use crate::clock::Clock;
use crate::spotify::tokens::TokenStore;

/// A Spotify Connect device, as Spotify lists it right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    /// Spotify says this can be missing, and that IDs only last "to some
    /// extent". Deadwax matches devices by name, and plays by ID.
    pub id: Option<String>,
    pub name: String,
    /// "Speaker", "TV", "Computer" and so on.
    pub kind: String,
    /// The device playing, or last to play.
    pub is_active: bool,
    /// Spotify won't take commands for this device.
    pub is_restricted: bool,
}

/// Where to start an album.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartAt {
    FirstTrack,
    /// The track with this Spotify ID.
    Track(String),
}

/// What Spotify is playing, or has paused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Playback {
    pub is_playing: bool,
    /// The device it's on.
    pub device: Option<String>,
    pub progress_ms: Option<u64>,
    /// The track, or `None` for an advert or anything else Spotify won't
    /// describe.
    pub track: Option<PlayingTrack>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayingTrack {
    pub spotify_id: Option<String>,
    pub title: String,
    /// The track's artists, joined with ", ".
    pub artist: String,
    pub album: Option<PlayingAlbum>,
    /// Which disc of the album it's on, from 1.
    pub disc: u32,
    /// Its place on that disc, from 1.
    pub number: u32,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayingAlbum {
    pub spotify_id: String,
    pub title: String,
    /// Spotify's covers, largest first, as Spotify lists them.
    pub covers: Vec<Cover>,
}

impl<C: Clock, S: TokenStore> Spotify<C, S> {
    /// The devices Spotify can see right now. Asleep or offline devices may
    /// be missing.
    pub async fn devices(&self) -> Result<Vec<Device>, SpotifyError> {
        let reply: DevicesReply = self
            .get("/v1/me/player/devices", &[], "the list of devices")
            .await?;
        Ok(reply
            .devices
            .into_iter()
            .map(|device| Device {
                id: device.id.filter(|id| !id.is_empty()),
                name: device.name,
                kind: device.kind,
                is_active: device.is_active,
                is_restricted: device.is_restricted,
            })
            .collect())
    }

    /// Plays the album on the device with this ID, from `start`.
    pub async fn play_album(
        &self,
        device_id: &str,
        album_id: &str,
        start: &StartAt,
    ) -> Result<(), SpotifyError> {
        if !is_spotify_id(album_id) {
            return Err(SpotifyError::NotAnId(album_id.to_owned()));
        }
        let offset = match start {
            StartAt::FirstTrack => json!({"position": 0}),
            StartAt::Track(id) if is_spotify_id(id) => {
                json!({"uri": format!("spotify:track:{id}")})
            }
            StartAt::Track(id) => return Err(SpotifyError::NotAnId(id.clone())),
        };
        let body = json!({
            "context_uri": format!("spotify:album:{album_id}"),
            "offset": offset,
        });
        self.send_api(
            |url| {
                self.http
                    .put(url)
                    .query(&[("device_id", device_id)])
                    .json(&body)
            },
            "/v1/me/player/play",
            "playing the album",
        )
        .await?;
        Ok(())
    }

    /// Moves whatever's playing to the device with this ID, from where it
    /// is in the track (RFC-002, "4. The UI"). `play` says whether it plays
    /// there or stays paused, so a paused record stays paused when it moves.
    pub async fn transfer(&self, device_id: &str, play: bool) -> Result<(), SpotifyError> {
        let body = json!({"device_ids": [device_id], "play": play});
        self.send_api(
            |url| self.http.put(url).json(&body),
            "/v1/me/player",
            "moving playback",
        )
        .await?;
        Ok(())
    }

    /// What's playing, or `None` if Spotify isn't playing anything anywhere.
    pub async fn playback(&self) -> Result<Option<Playback>, SpotifyError> {
        let response = self
            .send_api(
                |url| self.http.get(url),
                "/v1/me/player",
                "asking what's playing",
            )
            .await?;
        // Nothing is playing: `204 No Content`.
        let body = response.bytes().await.map_err(HttpError::from)?;
        if body.is_empty() {
            return Ok(None);
        }
        let reply: PlayerReply =
            serde_json::from_slice(&body).map_err(|_| SpotifyError::Unexpected {
                what: "asking what's playing (unreadable reply)",
                status: reqwest::StatusCode::OK,
            })?;
        Ok(Some(Playback {
            is_playing: reply.is_playing,
            device: reply.device.map(|device| device.name),
            progress_ms: reply.progress_ms,
            track: reply.item.and_then(|item| {
                // Podcast episodes have no album or artists. Deadwax only plays
                // albums, but you might have started one from your phone.
                Some(PlayingTrack {
                    spotify_id: item.id,
                    title: item.name?,
                    artist: item
                        .artists
                        .iter()
                        .map(|artist| artist.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    album: item.album.map(|album| PlayingAlbum {
                        spotify_id: album.id,
                        title: album.name,
                        covers: album.images.into_iter().map(cover).collect(),
                    }),
                    disc: item.disc_number,
                    number: item.track_number,
                    duration_ms: item.duration_ms,
                })
            }),
        }))
    }

    /// Pauses whatever's playing.
    pub async fn pause(&self) -> Result<(), SpotifyError> {
        self.command(Method::Put, "/v1/me/player/pause", "pausing")
            .await
    }

    /// Carries on playing on the device that was playing.
    pub async fn resume(&self) -> Result<(), SpotifyError> {
        self.command(Method::Put, "/v1/me/player/play", "playing")
            .await
    }

    pub async fn next(&self) -> Result<(), SpotifyError> {
        self.command(
            Method::Post,
            "/v1/me/player/next",
            "skipping to the next track",
        )
        .await
    }

    pub async fn previous(&self) -> Result<(), SpotifyError> {
        self.command(
            Method::Post,
            "/v1/me/player/previous",
            "going back to the previous track",
        )
        .await
    }

    /// A player command with no body, sent to the active device.
    async fn command(
        &self,
        method: Method,
        path: &str,
        what: &'static str,
    ) -> Result<(), SpotifyError> {
        self.send_api(
            |url| {
                let request = match method {
                    Method::Put => self.http.put(url),
                    Method::Post => self.http.post(url),
                };
                // Spotify wants a length, even of nothing (`411` otherwise).
                request.header(reqwest::header::CONTENT_LENGTH, 0)
            },
            path,
            what,
        )
        .await?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Method {
    Put,
    Post,
}

// What Spotify sends. Only the fields Deadwax uses.

#[derive(Deserialize)]
struct DevicesReply {
    devices: Vec<DeviceReply>,
}

#[derive(Deserialize)]
struct DeviceReply {
    id: Option<String>,
    name: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    is_active: bool,
    #[serde(default)]
    is_restricted: bool,
}

#[derive(Deserialize)]
struct PlayerReply {
    #[serde(default)]
    is_playing: bool,
    device: Option<PlayerDevice>,
    progress_ms: Option<u64>,
    item: Option<PlayerItem>,
}

#[derive(Deserialize)]
struct PlayerDevice {
    name: String,
}

#[derive(Deserialize)]
struct PlayerItem {
    id: Option<String>,
    name: Option<String>,
    #[serde(default)]
    artists: Vec<PlayerArtist>,
    album: Option<PlayerAlbum>,
    #[serde(default)]
    disc_number: u32,
    #[serde(default)]
    track_number: u32,
    #[serde(default)]
    duration_ms: u64,
}

#[derive(Deserialize)]
struct PlayerArtist {
    name: String,
}

#[derive(Deserialize)]
struct PlayerAlbum {
    id: String,
    name: String,
    #[serde(default)]
    images: Vec<Image>,
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::Value;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::clock::fake::FakeClock;
    use crate::spotify::Endpoints;
    use crate::spotify::tokens::{MemoryStore, Tokens};

    // Hand-written in the shape of Spotify's reference docs, trimmed to
    // typical fields. Not recorded from the real API.
    const DEVICES: &str = include_str!("fixtures/devices.json");
    const PLAYING: &str = include_str!("fixtures/player-in-rainbows.json");

    const IN_RAINBOWS: &str = "5vkqYmiPBYLaalcmjujWxK";
    const NUDE: &str = "6O4dsyobpDXX1WxHRP3bzk";
    const LIVING_ROOM: &str = "b46689a4cdd1d64b2fdf7e4f1d3e8f8bd8e3f3d1";

    async fn signed_in(server: &MockServer) -> Spotify<FakeClock, MemoryStore> {
        signed_in_with_log(server, Arc::new(Mutex::new(Vec::new()))).await
    }

    /// Signed in, with each sleep on the (fake) clock written to `log`.
    async fn signed_in_with_log(
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

    #[tokio::test]
    async fn lists_the_devices_spotify_can_see() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me/player/devices"))
            .and(header("authorization", "Bearer access"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json(DEVICES)))
            .expect(1)
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        let devices = spotify.devices().await.unwrap();

        assert_eq!(
            devices,
            [
                Device {
                    id: Some(LIVING_ROOM.into()),
                    name: "Living Room".into(),
                    kind: "Speaker".into(),
                    is_active: false,
                    is_restricted: false,
                },
                Device {
                    id: Some("5fbb3ba6aa454b5534c4ba43a8c7e8e45a63ad0e".into()),
                    name: "Will's MacBook Pro".into(),
                    kind: "Computer".into(),
                    is_active: true,
                    is_restricted: false,
                },
                // Spotify lists some devices without an ID, and some it won't
                // take commands for.
                Device {
                    id: None,
                    name: "Kitchen".into(),
                    kind: "Speaker".into(),
                    is_active: false,
                    is_restricted: true,
                },
            ]
        );
    }

    async fn play_replies(server: &MockServer, body: Value) {
        Mock::given(method("PUT"))
            .and(path("/v1/me/player/play"))
            .and(header("authorization", "Bearer access"))
            .and(query_param("device_id", LIVING_ROOM))
            .and(body_json(body))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn plays_the_album_on_the_device_from_the_first_track() {
        let server = MockServer::start().await;
        play_replies(
            &server,
            serde_json::json!({
                "context_uri": format!("spotify:album:{IN_RAINBOWS}"),
                "offset": {"position": 0},
            }),
        )
        .await;
        let spotify = signed_in(&server).await;

        spotify
            .play_album(LIVING_ROOM, IN_RAINBOWS, &StartAt::FirstTrack)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn plays_the_album_from_a_chosen_track() {
        let server = MockServer::start().await;
        play_replies(
            &server,
            serde_json::json!({
                "context_uri": format!("spotify:album:{IN_RAINBOWS}"),
                "offset": {"uri": format!("spotify:track:{NUDE}")},
            }),
        )
        .await;
        let spotify = signed_in(&server).await;

        spotify
            .play_album(LIVING_ROOM, IN_RAINBOWS, &StartAt::Track(NUDE.into()))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn transfer_moves_playback_to_one_device_with_its_play_state() {
        let server = MockServer::start().await;
        for play in [true, false] {
            Mock::given(method("PUT"))
                .and(path("/v1/me/player"))
                .and(header("authorization", "Bearer access"))
                .and(body_json(serde_json::json!({
                    "device_ids": [LIVING_ROOM],
                    "play": play,
                })))
                .respond_with(ResponseTemplate::new(204))
                .expect(1)
                .mount(&server)
                .await;
        }
        let spotify = signed_in(&server).await;

        spotify.transfer(LIVING_ROOM, true).await.unwrap();
        spotify.transfer(LIVING_ROOM, false).await.unwrap();
    }

    #[tokio::test]
    async fn transfer_waits_out_a_429() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/v1/me/player"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "1"))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/me/player"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let log = Arc::new(Mutex::new(Vec::new()));
        let spotify = signed_in_with_log(&server, log.clone()).await;

        spotify.transfer(LIVING_ROOM, true).await.unwrap();

        // It waited the second Spotify asked for, then tried again.
        assert_eq!(*log.lock().unwrap(), ["sleep 1s"]);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn refuses_ids_that_arent_spotify_ids() {
        let server = MockServer::start().await;
        let spotify = signed_in(&server).await;

        for (album, start) in [
            ("../me", StartAt::FirstTrack),
            (IN_RAINBOWS, StartAt::Track("6O4dsyobpDXX1WxHRP3bz/".into())),
        ] {
            assert!(matches!(
                spotify.play_album(LIVING_ROOM, album, &start).await,
                Err(SpotifyError::NotAnId(_))
            ));
        }
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refusal_says_what_spotify_said() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/v1/me/player/play"))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "error": {
                    "status": 403,
                    "message": "Player command failed: Premium required",
                    "reason": "PREMIUM_REQUIRED",
                },
            })))
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        let error = spotify
            .play_album(LIVING_ROOM, IN_RAINBOWS, &StartAt::FirstTrack)
            .await
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Spotify replied 403 Forbidden to playing the album: \
             Player command failed: Premium required"
        );
    }

    #[tokio::test]
    async fn a_refusal_without_an_explanation_still_says_what_failed() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/me/player/next"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        assert_eq!(
            spotify.next().await.unwrap_err().to_string(),
            "Spotify replied 502 Bad Gateway to skipping to the next track"
        );
    }

    #[tokio::test]
    async fn reads_what_is_playing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me/player"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json(PLAYING)))
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        assert_eq!(
            spotify.playback().await.unwrap(),
            Some(Playback {
                is_playing: true,
                device: Some("Living Room".into()),
                progress_ms: Some(61_480),
                track: Some(PlayingTrack {
                    spotify_id: Some(NUDE.into()),
                    title: "Nude".into(),
                    artist: "Radiohead".into(),
                    album: Some(PlayingAlbum {
                        spotify_id: IN_RAINBOWS.into(),
                        title: "In Rainbows".into(),
                        covers: vec![
                            Cover {
                                url: "https://i.scdn.co/image/ab67616d0000b273de3c04b5fc750b68899b20a9".into(),
                                width: Some(640),
                                height: Some(640),
                            },
                            Cover {
                                url: "https://i.scdn.co/image/ab67616d00001e02de3c04b5fc750b68899b20a9".into(),
                                width: Some(300),
                                height: Some(300),
                            },
                        ],
                    }),
                    disc: 1,
                    number: 3,
                    duration_ms: 255_386,
                }),
            })
        );
    }

    #[tokio::test]
    async fn nothing_playing_is_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me/player"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        assert_eq!(spotify.playback().await.unwrap(), None);
    }

    #[tokio::test]
    async fn an_advert_is_playback_without_a_track() {
        let server = MockServer::start().await;
        let mut body = json(PLAYING);
        body["item"] = Value::Null;
        body["currently_playing_type"] = "ad".into();
        Mock::given(method("GET"))
            .and(path("/v1/me/player"))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        let playback = spotify.playback().await.unwrap().unwrap();

        assert!(playback.is_playing);
        assert_eq!(playback.track, None);
    }

    #[tokio::test]
    async fn the_controls_send_their_commands_with_a_length() {
        let server = MockServer::start().await;
        for (verb, route) in [
            ("PUT", "/v1/me/player/pause"),
            ("PUT", "/v1/me/player/play"),
            ("POST", "/v1/me/player/next"),
            ("POST", "/v1/me/player/previous"),
        ] {
            Mock::given(method(verb))
                .and(path(route))
                .and(header("authorization", "Bearer access"))
                .and(header("content-length", "0"))
                .respond_with(ResponseTemplate::new(204))
                .expect(1)
                .mount(&server)
                .await;
        }
        let spotify = signed_in(&server).await;

        spotify.pause().await.unwrap();
        spotify.resume().await.unwrap();
        spotify.next().await.unwrap();
        spotify.previous().await.unwrap();
    }

    #[tokio::test]
    async fn the_controls_wait_out_a_429() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/v1/me/player/pause"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "1"))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/v1/me/player/pause"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let spotify = signed_in(&server).await;

        spotify.pause().await.unwrap();
    }
}
