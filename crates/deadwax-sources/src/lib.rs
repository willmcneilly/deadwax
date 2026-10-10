//! Deadwax's web clients: Spotify, with sign-in and rate-limit handling, and
//! the artwork sources (iTunes, Deezer and MusicBrainz) to come. See RFC-001,
//! "Repository and checks".
//!
//! Tests never call a real web API: each client runs against a local fake
//! server (`wiremock`) replaying hand-written responses.

pub mod clock;
pub mod spotify;
