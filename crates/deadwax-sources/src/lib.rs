//! Deadwax's web clients: Spotify, with sign-in and rate-limit handling, and
//! the artwork sources (iTunes, Deezer and MusicBrainz with the Cover Art
//! Archive). See RFC-001, "Repository and checks".
//!
//! Tests never call a real web API: each client runs against a local fake
//! server (`wiremock`) replaying hand-written responses.

pub mod artwork;
pub mod clock;
pub mod limiter;
pub mod spotify;
