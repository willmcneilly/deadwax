//! The collection: the albums you've added, in SQLite. See RFC-001, "The
//! collection", and RFC-002, "1. Deadwax's own album IDs".
//!
//! Every album has a Deadwax ID (`AlbumId`), made when it's added, which
//! never changes. Its Spotify ID says where it plays, not what it is.
//!
//! Two tables. `collection` is what you own: each album's Deadwax ID, its
//! Spotify ID and when you added it. `album_cache` is a refreshable copy of
//! what we show about each album (title, artist, year, tracklist, Spotify's
//! cover URLs, UPC) and when it was fetched. Spotify's terms allow caching
//! metadata only for a while, so the cache can always be thrown away and
//! fetched again. The collection can't.
//!
//! A third table, `artwork`, holds the high-res cover found for each album
//! (DWX-7): only its URL, where it came from and its size, never the image.
//! It's found in the background, so an album can be in the collection
//! without one for a while.
//!
//! In development builds the collection also mirrors every add and remove to
//! the dev list (`crate::dev_list`), which survives resets. All of that is
//! compiled under `debug_assertions`, so release builds don't contain it.

use std::collections::HashSet;
use std::fmt;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

#[cfg(debug_assertions)]
use crate::dev_list::{DevList, DevListError};

/// An album's Deadwax ID: random, made when the album is added, and never
/// changed. Commands take and return it; only the Spotify client sees
/// Spotify IDs.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AlbumId(String);

impl AlbumId {
    /// A new, random ID.
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for AlbumId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for AlbumId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// An ID as stored or as the UI sent it. Nothing checks its shape: an ID
/// that isn't in the collection just finds nothing.
impl From<String> for AlbumId {
    fn from(id: String) -> Self {
        Self(id)
    }
}

impl From<&str> for AlbumId {
    fn from(id: &str) -> Self {
        Self(id.to_owned())
    }
}

/// An album as Spotify describes it, which is what the cache holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Album {
    pub spotify_id: String,
    pub title: String,
    /// The album's artists, joined with ", ".
    pub artist: String,
    pub year: Option<u16>,
    pub tracks: Vec<Track>,
    /// Spotify's covers, largest first, as Spotify lists them.
    pub covers: Vec<Cover>,
    /// The barcode, for finding high-res artwork (DWX-7).
    pub upc: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Track {
    pub spotify_id: String,
    pub disc: u32,
    pub number: u32,
    pub title: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cover {
    pub url: String,
    /// Spotify sometimes leaves the size out.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl Album {
    /// The largest of Spotify's covers, about 640 pixels wide.
    pub fn largest_cover(&self) -> Option<&Cover> {
        largest(&self.covers)
    }
}

/// The largest cover in `covers`. One without a size counts as the smallest.
pub fn largest(covers: &[Cover]) -> Option<&Cover> {
    covers.iter().max_by_key(|cover| cover.width.unwrap_or(0))
}

/// Where an album's cover came from (RFC-001, "High-res artwork, as an
/// experiment"), in the order they're tried.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ArtworkSource {
    Itunes,
    Deezer,
    MusicBrainz,
    /// No other source had it, so it's Spotify's own cover.
    Spotify,
}

impl ArtworkSource {
    pub const ALL: [ArtworkSource; 4] =
        [Self::Itunes, Self::Deezer, Self::MusicBrainz, Self::Spotify];

    /// The name stored in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Itunes => "itunes",
            Self::Deezer => "deezer",
            Self::MusicBrainz => "musicbrainz",
            Self::Spotify => "spotify",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|source| source.as_str() == name)
    }
}

/// The result of looking for an album's high-res cover: the winning image's
/// URL and pixel size, and where it came from. Never the image itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artwork {
    pub source: ArtworkSource,
    /// `None` only when nothing had a cover, not even Spotify.
    pub cover: Option<Cover>,
}

/// How long the cache is good for. Spotify's terms say to keep cached
/// metadata reasonably up to date, so opening an album whose cache is older
/// fetches it again (RFC-001, "The collection").
pub const CACHE_LIFETIME: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// An album in the collection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Collected {
    pub id: AlbumId,
    pub album: Album,
    pub added_at: SystemTime,
    /// When the cached metadata was fetched from Spotify.
    pub fetched_at: SystemTime,
    /// The high-res cover, once it's been looked for.
    pub artwork: Option<Artwork>,
}

impl Collected {
    /// Whether the cache is over `CACHE_LIFETIME` old at `now`. A fetch
    /// that seems to be in the future (the clock went back) isn't.
    pub fn is_stale(&self, now: SystemTime) -> bool {
        now.duration_since(self.fetched_at)
            .is_ok_and(|age| age > CACHE_LIFETIME)
    }
}

/// What adding an album did, and the album's Deadwax ID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Added {
    New(AlbumId),
    /// It was already in the collection. It keeps its Deadwax ID and date
    /// added, and the cache is updated with what was just fetched.
    AlreadyThere(AlbumId),
}

impl Added {
    pub fn id(&self) -> &AlbumId {
        match self {
            Self::New(id) | Self::AlreadyThere(id) => id,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CollectionError {
    #[error("couldn't use the collection's database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("couldn't create the collection's folder: {0}")]
    Folder(#[from] std::io::Error),
    #[error("the collection's cache has an unreadable entry: {0}")]
    Corrupt(#[from] serde_json::Error),
    #[error("the collection was made by a newer Deadwax (schema {0})")]
    TooNew(i64),
    #[error("the collection's artwork has an unknown source {0:?}")]
    UnknownSource(String),
    #[cfg(debug_assertions)]
    #[error("the collection changed, but the dev list didn't: {0}")]
    DevList(#[from] DevListError),
}

/// The schema version this code writes, in SQLite's `user_version`.
const SCHEMA_VERSION: i64 = 3;

/// Schema 3 (DWX-17): every table is keyed by the Deadwax ID, and the
/// Spotify ID is a column of `collection`.
const SCHEMA: &str = "
    CREATE TABLE collection (
        id         TEXT PRIMARY KEY NOT NULL,  -- AlbumId
        spotify_id TEXT NOT NULL UNIQUE,
        added_at   INTEGER NOT NULL            -- Unix milliseconds
    ) STRICT;

    CREATE TABLE album_cache (
        id         TEXT PRIMARY KEY NOT NULL,
        title      TEXT NOT NULL,
        artist     TEXT NOT NULL,
        year       INTEGER,
        tracks     TEXT NOT NULL,    -- JSON: [Track]
        covers     TEXT NOT NULL,    -- JSON: [Cover]
        upc        TEXT,
        fetched_at INTEGER NOT NULL  -- Unix milliseconds
    ) STRICT;

    CREATE TABLE artwork (
        id         TEXT PRIMARY KEY NOT NULL,
        source     TEXT NOT NULL,    -- ArtworkSource::as_str
        url        TEXT,             -- NULL when nothing had a cover
        width      INTEGER,
        height     INTEGER,
        found_at   INTEGER NOT NULL  -- Unix milliseconds
    ) STRICT;
";

/// Schema 2 (DWX-7) added this to schema 1, when tables were keyed by the
/// Spotify ID.
const ARTWORK_V2: &str = "
    CREATE TABLE artwork (
        spotify_id TEXT PRIMARY KEY NOT NULL,
        source     TEXT NOT NULL,
        url        TEXT,
        width      INTEGER,
        height     INTEGER,
        found_at   INTEGER NOT NULL
    ) STRICT;
";

/// Moves a schema-2 database to schema 3 in one transaction, giving every
/// album a Deadwax ID from `new_id` and keeping its Spotify ID, date added,
/// cache and artwork. A failure part-way rolls everything back, so the
/// database stays at schema 2.
fn migrate_to_3(
    db: &mut Connection,
    mut new_id: impl FnMut() -> AlbumId,
) -> Result<(), CollectionError> {
    let tx = db.transaction()?;
    // The new tables are made beside the old ones, filled, then renamed.
    tx.execute_batch(
        &SCHEMA
            .replace("TABLE collection", "TABLE collection_3")
            .replace("TABLE album_cache", "TABLE album_cache_3")
            .replace("TABLE artwork", "TABLE artwork_3"),
    )?;
    let albums: Vec<(i64, String, i64)> = tx
        .prepare("SELECT rowid, spotify_id, added_at FROM collection ORDER BY rowid")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    for (rowid, spotify_id, added_at) in albums {
        // The same rowid keeps the order of albums added in the same
        // millisecond.
        tx.execute(
            "INSERT INTO collection_3 (rowid, id, spotify_id, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![rowid, new_id().as_str(), spotify_id, added_at],
        )?;
    }
    tx.execute_batch(
        "INSERT INTO album_cache_3
             SELECT c.id, a.title, a.artist, a.year, a.tracks, a.covers, a.upc, a.fetched_at
             FROM album_cache a JOIN collection_3 c USING (spotify_id);
         INSERT INTO artwork_3
             SELECT c.id, w.source, w.url, w.width, w.height, w.found_at
             FROM artwork w JOIN collection_3 c USING (spotify_id);
         DROP TABLE collection;
         DROP TABLE album_cache;
         DROP TABLE artwork;
         ALTER TABLE collection_3 RENAME TO collection;
         ALTER TABLE album_cache_3 RENAME TO album_cache;
         ALTER TABLE artwork_3 RENAME TO artwork;
         PRAGMA user_version = 3;",
    )?;
    tx.commit()?;
    Ok(())
}

pub struct Collection {
    db: Connection,
    /// The dev list to mirror adds and removes to, in development builds.
    #[cfg(debug_assertions)]
    dev_list: Option<DevList>,
}

impl Collection {
    /// Opens the collection at `path`, creating the folder and the database
    /// if they don't exist yet.
    pub fn open(path: &Path) -> Result<Self, CollectionError> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        Self::set_up(Connection::open(path)?)
    }

    /// A collection that lasts as long as the value, for tests.
    pub fn open_in_memory() -> Result<Self, CollectionError> {
        Self::set_up(Connection::open_in_memory()?)
    }

    fn set_up(mut db: Connection) -> Result<Self, CollectionError> {
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match version {
            0 => {
                db.execute_batch(&format!(
                    "BEGIN; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
                ))?;
            }
            1 | 2 => {
                if version == 1 {
                    // In one transaction, so a crash can't leave the table
                    // without the version that says it's there.
                    db.execute_batch(&format!(
                        "BEGIN; {ARTWORK_V2} PRAGMA user_version = 2; COMMIT;"
                    ))?;
                }
                migrate_to_3(&mut db, AlbumId::new)?;
            }
            SCHEMA_VERSION => {}
            newer => return Err(CollectionError::TooNew(newer)),
        }
        Ok(Self {
            db,
            #[cfg(debug_assertions)]
            dev_list: None,
        })
    }

    /// Mirrors every add and remove from now on to `dev_list`. Development
    /// builds only.
    #[cfg(debug_assertions)]
    pub fn with_dev_list(mut self, dev_list: DevList) -> Self {
        self.dev_list = Some(dev_list);
        self
    }

    /// The dev list this collection mirrors to, if any.
    #[cfg(debug_assertions)]
    pub fn dev_list(&self) -> Option<&DevList> {
        self.dev_list.as_ref()
    }

    /// Adds `album` to the collection at `now`, and caches what we know
    /// about it. A new album gets a new Deadwax ID.
    pub fn add(&mut self, album: &Album, now: SystemTime) -> Result<Added, CollectionError> {
        self.add_at(album, now, now)
    }

    /// Adds `album` as if it had been added at `added_at`, with metadata
    /// fetched at `fetched_at`. Restoring from the dev list uses it to keep
    /// the original dates.
    pub fn add_at(
        &mut self,
        album: &Album,
        added_at: SystemTime,
        fetched_at: SystemTime,
    ) -> Result<Added, CollectionError> {
        let tx = self.db.transaction()?;
        let new_id = AlbumId::new();
        let inserted = tx.execute(
            "INSERT INTO collection (id, spotify_id, added_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (spotify_id) DO NOTHING",
            params![new_id.as_str(), album.spotify_id, millis(added_at)],
        )?;
        // The ID and date in the collection, which an album already there
        // keeps.
        let (id, added_at): (String, i64) = tx.query_row(
            "SELECT id, added_at FROM collection WHERE spotify_id = ?1",
            [&album.spotify_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let id = AlbumId(id);
        cache(&tx, &id, album, fetched_at)?;
        tx.commit()?;
        #[cfg(debug_assertions)]
        if let Some(dev_list) = &self.dev_list {
            dev_list.added(&album.spotify_id, time(added_at))?;
        }
        #[cfg(not(debug_assertions))]
        let _ = added_at;
        Ok(if inserted == 1 {
            Added::New(id)
        } else {
            Added::AlreadyThere(id)
        })
    }

    /// Replaces the album's cached metadata with `album`, fetched at `now`,
    /// if it's still in the collection. Returns whether it was: one removed
    /// while it was being fetched stays removed.
    pub fn refresh(
        &mut self,
        id: &AlbumId,
        album: &Album,
        now: SystemTime,
    ) -> Result<bool, CollectionError> {
        let tx = self.db.transaction()?;
        let collected = contains(&tx, id)?;
        if collected {
            cache(&tx, id, album, now)?;
        }
        tx.commit()?;
        Ok(collected)
    }

    /// Records the artwork found for the album at `now`, if the album is
    /// still in the collection. Returns whether it was.
    pub fn set_artwork(
        &mut self,
        id: &AlbumId,
        artwork: &Artwork,
        now: SystemTime,
    ) -> Result<bool, CollectionError> {
        let cover = artwork.cover.as_ref();
        let stored = self.db.execute(
            "INSERT OR REPLACE INTO artwork (id, source, url, width, height, found_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
             WHERE EXISTS (SELECT 1 FROM collection WHERE id = ?1)",
            params![
                id.as_str(),
                artwork.source.as_str(),
                cover.map(|c| &c.url),
                cover.and_then(|c| c.width),
                cover.and_then(|c| c.height),
                millis(now),
            ],
        )?;
        Ok(stored == 1)
    }

    /// Takes the album out of the collection, and forgets its cache and
    /// artwork. Returns whether it was there.
    pub fn remove(&mut self, id: &AlbumId) -> Result<bool, CollectionError> {
        let tx = self.db.transaction()?;
        let spotify_id: Option<String> = tx
            .query_row(
                "DELETE FROM collection WHERE id = ?1 RETURNING spotify_id",
                [id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        tx.execute("DELETE FROM album_cache WHERE id = ?1", [id.as_str()])?;
        tx.execute("DELETE FROM artwork WHERE id = ?1", [id.as_str()])?;
        tx.commit()?;
        #[cfg(debug_assertions)]
        if let (Some(dev_list), Some(spotify_id)) = (&self.dev_list, &spotify_id) {
            dev_list.removed(spotify_id)?;
        }
        Ok(spotify_id.is_some())
    }

    /// Empties the collection, its cache and its artwork. The dev list is
    /// left alone: it's what you restore from afterwards.
    pub fn clear(&mut self) -> Result<(), CollectionError> {
        self.db.execute_batch(
            "DELETE FROM collection; DELETE FROM album_cache; DELETE FROM artwork;",
        )?;
        Ok(())
    }

    /// Every album in the collection, the most recently added first.
    pub fn albums(&self) -> Result<Vec<Collected>, CollectionError> {
        let mut statement = self.db.prepare(
            "SELECT c.id, c.spotify_id, c.added_at, a.title, a.artist, a.year, a.tracks,
                    a.covers, a.upc, a.fetched_at,
                    w.source, w.url, w.width, w.height
             FROM collection c JOIN album_cache a USING (id)
             LEFT JOIN artwork w USING (id)
             ORDER BY c.added_at DESC, c.rowid DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let url: Option<String> = row.get(11)?;
            let cover = match url {
                Some(url) => Some(Cover {
                    url,
                    width: row.get(12)?,
                    height: row.get(13)?,
                }),
                None => None,
            };
            Ok((
                AlbumId(row.get(0)?),
                Album {
                    spotify_id: row.get(1)?,
                    title: row.get(3)?,
                    artist: row.get(4)?,
                    year: row.get(5)?,
                    tracks: Vec::new(),
                    covers: Vec::new(),
                    upc: row.get(8)?,
                },
                row.get::<_, i64>(2)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(9)?,
                row.get::<_, Option<String>>(10)?,
                cover,
            ))
        })?;
        rows.map(|row| {
            let (id, mut album, added_at, tracks, covers, fetched_at, source, cover) = row?;
            album.tracks = serde_json::from_str(&tracks)?;
            album.covers = serde_json::from_str(&covers)?;
            let artwork = source
                .map(|name| {
                    ArtworkSource::parse(&name)
                        .map(|source| Artwork { source, cover })
                        .ok_or(CollectionError::UnknownSource(name))
                })
                .transpose()?;
            Ok(Collected {
                id,
                album,
                added_at: time(added_at),
                fetched_at: time(fetched_at),
                artwork,
            })
        })
        .collect()
    }

    /// One album, if it's in the collection.
    pub fn get(&self, id: &AlbumId) -> Result<Option<Collected>, CollectionError> {
        // A few hundred albums: reading them all is simpler than a second
        // query, and fast enough.
        Ok(self.albums()?.into_iter().find(|c| &c.id == id))
    }

    /// The album that plays from this Spotify ID, if it's in the
    /// collection. Now playing uses it for what Spotify is playing.
    pub fn get_by_spotify_id(
        &self,
        spotify_id: &str,
    ) -> Result<Option<Collected>, CollectionError> {
        Ok(self
            .albums()?
            .into_iter()
            .find(|c| c.album.spotify_id == spotify_id))
    }

    /// The Spotify IDs of every album in the collection, to mark search
    /// results and to compare with the dev list.
    pub fn spotify_ids(&self) -> Result<HashSet<String>, CollectionError> {
        let mut statement = self.db.prepare("SELECT spotify_id FROM collection")?;
        let ids = statement.query_map([], |row| row.get(0))?;
        Ok(ids.collect::<Result<_, _>>()?)
    }

    /// Whether the album is in the collection.
    pub fn contains(&self, id: &AlbumId) -> Result<bool, CollectionError> {
        contains(&self.db, id)
    }
}

fn contains(db: &Connection, id: &AlbumId) -> Result<bool, CollectionError> {
    Ok(db
        .query_row(
            "SELECT 1 FROM collection WHERE id = ?1",
            [id.as_str()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn cache(
    tx: &Transaction,
    id: &AlbumId,
    album: &Album,
    now: SystemTime,
) -> Result<(), CollectionError> {
    tx.execute(
        "INSERT OR REPLACE INTO album_cache
             (id, title, artist, year, tracks, covers, upc, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id.as_str(),
            album.title,
            album.artist,
            album.year,
            serde_json::to_string(&album.tracks)?,
            serde_json::to_string(&album.covers)?,
            album.upc,
            millis(now),
        ],
    )?;
    Ok(())
}

pub(crate) fn millis(time: SystemTime) -> i64 {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

pub(crate) fn time(millis: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(u64::try_from(millis).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    fn day(n: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000) + DAY * n as u32
    }

    fn album(id: &str, title: &str) -> Album {
        Album {
            spotify_id: id.into(),
            title: title.into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            tracks: vec![
                Track {
                    spotify_id: format!("{id}-1"),
                    disc: 1,
                    number: 1,
                    title: "15 Step".into(),
                    duration_ms: 237_293,
                },
                Track {
                    spotify_id: format!("{id}-2"),
                    disc: 1,
                    number: 2,
                    title: "Bodysnatchers".into(),
                    duration_ms: 242_293,
                },
            ],
            covers: vec![
                Cover {
                    url: format!("https://i.scdn.co/image/{id}-640"),
                    width: Some(640),
                    height: Some(640),
                },
                Cover {
                    url: format!("https://i.scdn.co/image/{id}-64"),
                    width: Some(64),
                    height: Some(64),
                },
            ],
            upc: Some("634904032463".into()),
        }
    }

    /// The Spotify IDs of the collection's albums, in order.
    fn spotify_ids(collection: &Collection) -> Vec<String> {
        collection
            .albums()
            .unwrap()
            .into_iter()
            .map(|c| c.album.spotify_id)
            .collect()
    }

    /// The album that plays from `spotify_id`, which must be collected.
    fn by_spotify(collection: &Collection, spotify_id: &str) -> Collected {
        collection.get_by_spotify_id(spotify_id).unwrap().unwrap()
    }

    fn id_of(collection: &Collection, spotify_id: &str) -> AlbumId {
        by_spotify(collection, spotify_id).id
    }

    #[test]
    fn a_new_collection_is_empty() {
        let collection = Collection::open_in_memory().unwrap();
        assert!(collection.albums().unwrap().is_empty());
        assert!(collection.spotify_ids().unwrap().is_empty());
    }

    #[test]
    fn adds_an_album_with_its_metadata_and_a_new_deadwax_id() {
        let mut collection = Collection::open_in_memory().unwrap();
        let in_rainbows = album("in-rainbows", "In Rainbows");

        let Added::New(id) = collection.add(&in_rainbows, day(1)).unwrap() else {
            panic!("not added as new");
        };

        assert_ne!(id.as_str(), "in-rainbows");
        assert_eq!(
            collection.albums().unwrap(),
            [Collected {
                id: id.clone(),
                album: in_rainbows,
                added_at: day(1),
                fetched_at: day(1),
                artwork: None,
            }]
        );
        assert!(collection.contains(&id).unwrap());
        assert!(!collection.contains(&"in-rainbows".into()).unwrap());
        assert_eq!(collection.get(&id).unwrap().unwrap().id, id);
    }

    #[test]
    fn every_album_gets_its_own_deadwax_id() {
        let mut collection = Collection::open_in_memory().unwrap();
        let a = collection.add(&album("a", "A"), day(1)).unwrap();
        let b = collection.add(&album("b", "B"), day(1)).unwrap();

        assert_ne!(a.id(), b.id());
    }

    #[test]
    fn lists_the_most_recently_added_first() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.add(&album("c", "C"), day(3)).unwrap();
        collection.add(&album("b", "B"), day(2)).unwrap();
        // Two in the same millisecond: the later add comes first.
        collection.add(&album("d", "D"), day(3)).unwrap();

        assert_eq!(spotify_ids(&collection), ["d", "c", "b", "a"]);
    }

    #[test]
    fn adding_an_album_twice_keeps_one_with_its_id_first_date_and_fresh_metadata() {
        let mut collection = Collection::open_in_memory().unwrap();
        let first = collection
            .add(&album("in-rainbows", "In Rainbows"), day(1))
            .unwrap();
        let mut renamed = album("in-rainbows", "In Rainbows (Remastered)");
        renamed.upc = None;

        assert_eq!(
            collection.add(&renamed, day(5)).unwrap(),
            Added::AlreadyThere(first.id().clone())
        );

        assert_eq!(
            collection.albums().unwrap(),
            [Collected {
                id: first.id().clone(),
                album: renamed,
                added_at: day(1),
                fetched_at: day(5),
                artwork: None,
            }]
        );
    }

    #[test]
    fn removes_an_album_and_its_cache() {
        let mut collection = Collection::open_in_memory().unwrap();
        let a = collection.add(&album("a", "A"), day(1)).unwrap();
        collection.add(&album("b", "B"), day(2)).unwrap();

        assert!(collection.remove(a.id()).unwrap());
        assert!(!collection.remove(a.id()).unwrap());
        assert!(!collection.remove(&"never-added".into()).unwrap());

        assert_eq!(spotify_ids(&collection), ["b"]);
        let cached: i64 = collection
            .db
            .query_row("SELECT count(*) FROM album_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cached, 1);
    }

    #[test]
    fn removed_albums_can_be_added_again_as_new_with_a_new_id() {
        let mut collection = Collection::open_in_memory().unwrap();
        let first = collection.add(&album("a", "A"), day(1)).unwrap();
        collection.remove(first.id()).unwrap();

        let again = collection.add(&album("a", "A"), day(4)).unwrap();

        assert!(matches!(again, Added::New(_)));
        assert_ne!(again.id(), first.id());
        assert_eq!(by_spotify(&collection, "a").added_at, day(4));
    }

    #[test]
    fn everything_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        let a = {
            let mut collection = Collection::open(&path).unwrap();
            let a = collection.add(&album("a", "A"), day(1)).unwrap();
            let b = collection.add(&album("b", "B"), day(2)).unwrap();
            collection.add(&album("c", "C"), day(3)).unwrap();
            collection.add(&album("a", "A again"), day(4)).unwrap();
            collection.remove(b.id()).unwrap();
            a.id().clone()
        };

        let collection = Collection::open(&path).unwrap();

        assert_eq!(spotify_ids(&collection), ["c", "a"]);
        let collected = collection.get(&a).unwrap().unwrap();
        assert_eq!(collected.album, album("a", "A again"));
        assert_eq!((collected.added_at, collected.fetched_at), (day(1), day(4)));
        assert_eq!(
            collection.spotify_ids().unwrap(),
            HashSet::from(["a".to_string(), "c".to_string()])
        );
    }

    #[test]
    fn refuses_a_database_from_a_newer_deadwax() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();

        assert!(matches!(
            Collection::open(&path),
            Err(CollectionError::TooNew(4))
        ));
    }

    #[test]
    fn adding_at_a_date_keeps_that_date() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("b", "B"), day(5)).unwrap();

        collection.add_at(&album("a", "A"), day(1), day(9)).unwrap();

        let a = by_spotify(&collection, "a");
        assert_eq!((a.added_at, a.fetched_at), (day(1), day(9)));
        assert_eq!(spotify_ids(&collection), ["b", "a"]);
    }

    #[test]
    fn clearing_empties_the_collection_and_its_cache() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.add(&album("b", "B"), day(2)).unwrap();

        collection.clear().unwrap();

        assert!(collection.albums().unwrap().is_empty());
        let cached: i64 = collection
            .db
            .query_row("SELECT count(*) FROM album_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cached, 0);
    }

    #[cfg(debug_assertions)]
    mod with_a_dev_list {
        use super::*;
        use crate::dev_list::{self, DevList, Entry};

        /// A collection in a temporary checkout, mirroring to a dev list in a
        /// temporary `Application Support`, as a development build does.
        fn collection() -> (tempfile::TempDir, Collection) {
            let root = tempfile::tempdir().unwrap();
            let database = root.path().join("deadwax/.dev-data/deadwax.sqlite3");
            let app_data = root
                .path()
                .join("Application Support/com.willmcneilly.deadwax");
            let collection = Collection::open(&database)
                .unwrap()
                .with_dev_list(DevList::new(dev_list::path(&app_data)));
            (root, collection)
        }

        fn listed(collection: &Collection) -> Vec<(String, SystemTime)> {
            collection
                .dev_list()
                .unwrap()
                .albums()
                .unwrap()
                .into_iter()
                .map(
                    |Entry {
                         spotify_id,
                         added_at,
                     }| (spotify_id, added_at),
                )
                .collect()
        }

        #[test]
        fn every_add_and_remove_updates_the_dev_list_by_spotify_id() {
            let (_root, mut collection) = collection();

            let a = collection.add(&album("a", "A"), day(1)).unwrap();
            collection.add(&album("b", "B"), day(2)).unwrap();
            assert_eq!(
                listed(&collection),
                [("a".into(), day(1)), ("b".into(), day(2))]
            );

            collection.remove(a.id()).unwrap();
            assert_eq!(listed(&collection), [("b".into(), day(2))]);
        }

        #[test]
        fn adding_again_keeps_the_date_in_the_collection() {
            let (_root, mut collection) = collection();
            collection.add(&album("a", "A"), day(1)).unwrap();

            collection.add(&album("a", "A again"), day(4)).unwrap();

            assert_eq!(listed(&collection), [("a".into(), day(1))]);
        }

        #[test]
        fn removing_an_album_not_there_leaves_the_dev_list_alone() {
            let (_root, mut collection) = collection();
            collection.add(&album("a", "A"), day(1)).unwrap();

            collection.remove(&"never-added".into()).unwrap();

            assert_eq!(listed(&collection), [("a".into(), day(1))]);
        }

        #[test]
        fn clearing_leaves_the_dev_list_alone() {
            let (_root, mut collection) = collection();
            collection.add(&album("a", "A"), day(1)).unwrap();

            collection.clear().unwrap();

            assert!(collection.albums().unwrap().is_empty());
            assert_eq!(listed(&collection), [("a".into(), day(1))]);
        }

        #[test]
        fn a_collection_without_one_writes_nothing_outside_its_database() {
            let root = tempfile::tempdir().unwrap();
            let database = root.path().join("deadwax.sqlite3");
            let mut collection = Collection::open(&database).unwrap();

            let a = collection.add(&album("a", "A"), day(1)).unwrap();
            collection.remove(a.id()).unwrap();

            let files: Vec<_> = std::fs::read_dir(root.path())
                .unwrap()
                .map(|f| f.unwrap().file_name())
                .collect();
            assert_eq!(files, ["deadwax.sqlite3"]);
        }
    }

    #[test]
    fn refreshing_replaces_the_cache_and_keeps_the_id_and_date_added() {
        let mut collection = Collection::open_in_memory().unwrap();
        let added = collection.add(&album("a", "A"), day(1)).unwrap();
        let renamed = album("a", "A (Remastered)");

        assert!(collection.refresh(added.id(), &renamed, day(9)).unwrap());

        assert_eq!(
            collection.get(added.id()).unwrap().unwrap(),
            Collected {
                id: added.id().clone(),
                album: renamed,
                added_at: day(1),
                fetched_at: day(9),
                artwork: None,
            }
        );
    }

    #[test]
    fn refreshing_an_album_not_in_the_collection_doesnt_add_it() {
        let mut collection = Collection::open_in_memory().unwrap();
        let added = collection.add(&album("a", "A"), day(1)).unwrap();
        collection.remove(added.id()).unwrap();

        assert!(
            !collection
                .refresh(added.id(), &album("a", "A"), day(2))
                .unwrap()
        );

        assert!(collection.albums().unwrap().is_empty());
        let cached: i64 = collection
            .db
            .query_row("SELECT count(*) FROM album_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cached, 0);
    }

    #[test]
    fn the_cache_goes_stale_after_a_week() {
        let collected = Collected {
            id: AlbumId::new(),
            album: album("a", "A"),
            added_at: day(1),
            fetched_at: day(1),
            artwork: None,
        };

        assert!(!collected.is_stale(day(1)));
        assert!(!collected.is_stale(day(8)));
        assert!(collected.is_stale(day(8) + Duration::from_millis(1)));
        // The clock went back: not stale.
        assert!(!collected.is_stale(day(0)));
    }

    #[test]
    fn the_largest_cover_is_spotifys_640() {
        let mut a = album("a", "A");
        assert_eq!(a.largest_cover().unwrap().width, Some(640));
        a.covers.reverse();
        assert_eq!(a.largest_cover().unwrap().width, Some(640));
        a.covers.clear();
        assert_eq!(a.largest_cover(), None);
    }

    fn itunes() -> Artwork {
        Artwork {
            source: ArtworkSource::Itunes,
            cover: Some(Cover {
                url: "https://is1-ssl.mzstatic.com/image/thumb/a/10000x10000bb.jpg".into(),
                width: Some(4000),
                height: Some(4000),
            }),
        }
    }

    #[test]
    fn stores_only_the_artworks_url_source_and_size() {
        let mut collection = Collection::open_in_memory().unwrap();
        let a = collection.add(&album("a", "A"), day(1)).unwrap();
        assert_eq!(collection.get(a.id()).unwrap().unwrap().artwork, None);

        assert!(collection.set_artwork(a.id(), &itunes(), day(2)).unwrap());

        assert_eq!(
            collection.get(a.id()).unwrap().unwrap().artwork,
            Some(itunes())
        );
        let columns: Vec<String> = collection
            .db
            .prepare("SELECT name FROM pragma_table_info('artwork')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns,
            ["id", "source", "url", "width", "height", "found_at"]
        );
    }

    #[test]
    fn stores_spotifys_cover_and_no_cover_at_all() {
        let mut collection = Collection::open_in_memory().unwrap();
        let a = collection.add(&album("a", "A"), day(1)).unwrap();
        let b = collection.add(&album("b", "B"), day(1)).unwrap();
        let spotify = Artwork {
            source: ArtworkSource::Spotify,
            cover: Some(Cover {
                url: "https://i.scdn.co/image/a-640".into(),
                width: None,
                height: None,
            }),
        };
        let nothing = Artwork {
            source: ArtworkSource::Spotify,
            cover: None,
        };

        collection.set_artwork(a.id(), &spotify, day(2)).unwrap();
        collection.set_artwork(b.id(), &nothing, day(2)).unwrap();

        assert_eq!(
            collection.get(a.id()).unwrap().unwrap().artwork,
            Some(spotify)
        );
        assert_eq!(
            collection.get(b.id()).unwrap().unwrap().artwork,
            Some(nothing)
        );
    }

    #[test]
    fn artwork_for_an_album_not_in_the_collection_isnt_stored() {
        let mut collection = Collection::open_in_memory().unwrap();
        let gone = AlbumId::new();

        assert!(!collection.set_artwork(&gone, &itunes(), day(2)).unwrap());

        collection.add(&album("a", "A"), day(3)).unwrap();
        assert_eq!(by_spotify(&collection, "a").artwork, None);
    }

    #[test]
    fn removing_or_clearing_forgets_the_artwork() {
        let mut collection = Collection::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for id in ["a", "b"] {
            let added = collection.add(&album(id, id), day(1)).unwrap();
            collection
                .set_artwork(added.id(), &itunes(), day(1))
                .unwrap();
            ids.push(added.id().clone());
        }
        let artwork = |c: &Collection| -> i64 {
            c.db.query_row("SELECT count(*) FROM artwork", [], |row| row.get(0))
                .unwrap()
        };

        collection.remove(&ids[0]).unwrap();
        assert_eq!(artwork(&collection), 1);
        collection.clear().unwrap();
        assert_eq!(artwork(&collection), 0);
    }

    #[test]
    fn refreshing_the_cache_keeps_the_artwork() {
        let mut collection = Collection::open_in_memory().unwrap();
        let a = collection.add(&album("a", "A"), day(1)).unwrap();
        collection.set_artwork(a.id(), &itunes(), day(1)).unwrap();

        collection
            .refresh(a.id(), &album("a", "A"), day(9))
            .unwrap();

        assert_eq!(
            collection.get(a.id()).unwrap().unwrap().artwork,
            Some(itunes())
        );
    }

    #[test]
    fn the_same_spotify_id_cant_be_collected_twice() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();

        let duplicate = collection.db.execute(
            "INSERT INTO collection (id, spotify_id, added_at) VALUES ('other', 'a', 0)",
            [],
        );

        assert!(duplicate.is_err());
    }

    // Migrations.

    /// The schema-1 tables, as RFC-001 made them, keyed by the Spotify ID.
    const SCHEMA_V1: &str = "
        CREATE TABLE collection (
            spotify_id TEXT PRIMARY KEY NOT NULL,
            added_at   INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE album_cache (
            spotify_id TEXT PRIMARY KEY NOT NULL,
            title      TEXT NOT NULL,
            artist     TEXT NOT NULL,
            year       INTEGER,
            tracks     TEXT NOT NULL,
            covers     TEXT NOT NULL,
            upc        TEXT,
            fetched_at INTEGER NOT NULL
        ) STRICT;
    ";

    /// Writes `albums` into a schema-1 or schema-2 database, as those
    /// versions did: (Spotify ID, added, fetched, artwork).
    fn old_database(
        path: &Path,
        version: i64,
        albums: &[(&str, SystemTime, SystemTime, Option<Artwork>)],
    ) {
        let db = Connection::open(path).unwrap();
        db.execute_batch(SCHEMA_V1).unwrap();
        if version == 2 {
            db.execute_batch(ARTWORK_V2).unwrap();
        }
        db.pragma_update(None, "user_version", version).unwrap();
        for (spotify_id, added_at, fetched_at, artwork) in albums {
            let a = album(spotify_id, &spotify_id.to_uppercase());
            db.execute(
                "INSERT INTO collection (spotify_id, added_at) VALUES (?1, ?2)",
                params![spotify_id, millis(*added_at)],
            )
            .unwrap();
            db.execute(
                "INSERT INTO album_cache
                     (spotify_id, title, artist, year, tracks, covers, upc, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    spotify_id,
                    a.title,
                    a.artist,
                    a.year,
                    serde_json::to_string(&a.tracks).unwrap(),
                    serde_json::to_string(&a.covers).unwrap(),
                    a.upc,
                    millis(*fetched_at),
                ],
            )
            .unwrap();
            if let Some(artwork) = artwork {
                let cover = artwork.cover.as_ref();
                db.execute(
                    "INSERT INTO artwork (spotify_id, source, url, width, height, found_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        spotify_id,
                        artwork.source.as_str(),
                        cover.map(|c| &c.url),
                        cover.and_then(|c| c.width),
                        cover.and_then(|c| c.height),
                        millis(day(9)),
                    ],
                )
                .unwrap();
            }
        }
    }

    fn user_version(db: &Connection) -> i64 {
        db.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    /// Everything in a table, as text, to compare before and after.
    fn dump(db: &Connection, table: &str) -> Vec<String> {
        let mut statement = db
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|i| {
                        row.get::<_, rusqlite::types::Value>(i)
                            .map(|v| format!("{v:?}"))
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map(|values| values.join(" | "))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn a_schema_2_database_migrates_with_its_albums_cache_and_artwork_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        old_database(
            &path,
            2,
            &[
                ("a", day(1), day(2), Some(itunes())),
                ("b", day(3), day(3), None),
                // Added in the same millisecond as b, after it.
                ("c", day(3), day(4), Some(itunes())),
            ],
        );

        let collection = Collection::open(&path).unwrap();

        assert_eq!(user_version(&collection.db), 3);
        let albums = collection.albums().unwrap();
        assert_eq!(spotify_ids(&collection), ["c", "b", "a"]);
        let expected = [
            ("c", day(3), day(4), Some(itunes())),
            ("b", day(3), day(3), None),
            ("a", day(1), day(2), Some(itunes())),
        ];
        for (collected, (spotify_id, added_at, fetched_at, artwork)) in albums.iter().zip(expected)
        {
            assert_eq!(
                collected.album,
                album(spotify_id, &spotify_id.to_uppercase())
            );
            assert_eq!(collected.added_at, added_at);
            assert_eq!(collected.fetched_at, fetched_at);
            assert_eq!(collected.artwork, artwork);
            assert_ne!(collected.id.as_str(), spotify_id);
        }
        let ids: HashSet<&AlbumId> = albums.iter().map(|c| &c.id).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn a_migrated_collection_works_and_keeps_its_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        old_database(&path, 2, &[("a", day(1), day(1), None)]);
        let id = id_of(&Collection::open(&path).unwrap(), "a");

        let mut collection = Collection::open(&path).unwrap();

        assert_eq!(id_of(&collection, "a"), id);
        assert_eq!(
            collection.add(&album("a", "A"), day(5)).unwrap(),
            Added::AlreadyThere(id.clone())
        );
        assert!(collection.set_artwork(&id, &itunes(), day(5)).unwrap());
        collection.add(&album("b", "B"), day(6)).unwrap();
        assert!(collection.remove(&id).unwrap());
        assert_eq!(spotify_ids(&collection), ["b"]);
    }

    #[test]
    fn a_failure_part_way_through_the_migration_leaves_schema_2_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        old_database(
            &path,
            2,
            &[
                ("a", day(1), day(1), Some(itunes())),
                ("b", day(2), day(2), None),
            ],
        );
        let mut db = Connection::open(&path).unwrap();
        let before: Vec<Vec<String>> = ["collection", "album_cache", "artwork"]
            .iter()
            .map(|table| dump(&db, table))
            .collect();

        // The second album gets the first one's ID, so the migration fails
        // after it has already moved one album.
        let same = AlbumId::new();
        let result = migrate_to_3(&mut db, || same.clone());

        assert!(matches!(result, Err(CollectionError::Sqlite(_))));
        assert_eq!(user_version(&db), 2);
        let after: Vec<Vec<String>> = ["collection", "album_cache", "artwork"]
            .iter()
            .map(|table| dump(&db, table))
            .collect();
        assert_eq!(after, before);
        let tables: Vec<String> = db
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(tables, ["album_cache", "artwork", "collection"]);
        drop(db);

        // Opening it again migrates it properly.
        let collection = Collection::open(&path).unwrap();
        assert_eq!(spotify_ids(&collection), ["b", "a"]);
    }

    #[test]
    fn a_schema_1_database_migrates_to_3_and_keeps_its_albums() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        old_database(&path, 1, &[("a", day(1), day(1), None)]);

        let mut collection = Collection::open(&path).unwrap();

        assert_eq!(user_version(&collection.db), 3);
        assert_eq!(spotify_ids(&collection), ["a"]);
        let id = id_of(&collection, "a");
        assert!(collection.set_artwork(&id, &itunes(), day(2)).unwrap());
    }

    #[test]
    fn a_new_database_is_made_at_schema_3() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");

        let collection = Collection::open(&path).unwrap();

        assert_eq!(user_version(&collection.db), 3);
        let columns: Vec<String> = collection
            .db
            .prepare("SELECT name FROM pragma_table_info('collection')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(columns, ["id", "spotify_id", "added_at"]);
    }
}
