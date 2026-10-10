//! The collection: the albums you've added, in SQLite. See RFC-001, "The
//! collection".
//!
//! Two tables. `collection` is what you own: each album's Spotify ID and when
//! you added it. `album_cache` is a refreshable copy of what we show about
//! each album (title, artist, year, tracklist, Spotify's cover URLs, UPC) and
//! when it was fetched. Spotify's terms allow caching metadata only for a
//! while, so the cache can always be thrown away and fetched again. The
//! collection can't.
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
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

#[cfg(debug_assertions)]
use crate::dev_list::{DevList, DevListError};

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

/// What adding an album did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Added {
    New,
    /// It was already in the collection. It keeps its date added, and the
    /// cache is updated with what was just fetched.
    AlreadyThere,
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
const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &str = "
    CREATE TABLE collection (
        spotify_id TEXT PRIMARY KEY NOT NULL,
        added_at   INTEGER NOT NULL  -- Unix milliseconds
    ) STRICT;

    CREATE TABLE album_cache (
        spotify_id TEXT PRIMARY KEY NOT NULL,
        title      TEXT NOT NULL,
        artist     TEXT NOT NULL,
        year       INTEGER,
        tracks     TEXT NOT NULL,    -- JSON: [Track]
        covers     TEXT NOT NULL,    -- JSON: [Cover]
        upc        TEXT,
        fetched_at INTEGER NOT NULL  -- Unix milliseconds
    ) STRICT;
";

/// Schema 2 (DWX-7): the artwork found for each album.
const ARTWORK: &str = "
    CREATE TABLE artwork (
        spotify_id TEXT PRIMARY KEY NOT NULL,
        source     TEXT NOT NULL,    -- ArtworkSource::as_str
        url        TEXT,             -- NULL when nothing had a cover
        width      INTEGER,
        height     INTEGER,
        found_at   INTEGER NOT NULL  -- Unix milliseconds
    ) STRICT;
";

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

    fn set_up(db: Connection) -> Result<Self, CollectionError> {
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        match version {
            0 => {
                db.execute_batch(SCHEMA)?;
                db.execute_batch(ARTWORK)?;
                db.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
            1 => {
                db.execute_batch(ARTWORK)?;
                db.pragma_update(None, "user_version", SCHEMA_VERSION)?;
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
    /// about it.
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
        let inserted = tx.execute(
            "INSERT INTO collection (spotify_id, added_at) VALUES (?1, ?2)
             ON CONFLICT (spotify_id) DO NOTHING",
            params![album.spotify_id, millis(added_at)],
        )?;
        cache(&tx, album, fetched_at)?;
        tx.commit()?;
        #[cfg(debug_assertions)]
        if let Some(dev_list) = &self.dev_list {
            // The date in the collection, which an album already there keeps.
            let added_at: i64 = self.db.query_row(
                "SELECT added_at FROM collection WHERE spotify_id = ?1",
                [&album.spotify_id],
                |row| row.get(0),
            )?;
            dev_list.added(&album.spotify_id, time(added_at))?;
        }
        Ok(if inserted == 1 {
            Added::New
        } else {
            Added::AlreadyThere
        })
    }

    /// Replaces the cached metadata with `album`, fetched at `now`, if the
    /// album is still in the collection. Returns whether it was: one removed
    /// while it was being fetched stays removed.
    pub fn refresh(&mut self, album: &Album, now: SystemTime) -> Result<bool, CollectionError> {
        let tx = self.db.transaction()?;
        let collected = tx
            .query_row(
                "SELECT 1 FROM collection WHERE spotify_id = ?1",
                [&album.spotify_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if collected {
            cache(&tx, album, now)?;
        }
        tx.commit()?;
        Ok(collected)
    }

    /// Records the artwork found for the album at `now`, if the album is
    /// still in the collection. Returns whether it was.
    pub fn set_artwork(
        &mut self,
        spotify_id: &str,
        artwork: &Artwork,
        now: SystemTime,
    ) -> Result<bool, CollectionError> {
        let cover = artwork.cover.as_ref();
        let stored = self.db.execute(
            "INSERT OR REPLACE INTO artwork
                 (spotify_id, source, url, width, height, found_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
             WHERE EXISTS (SELECT 1 FROM collection WHERE spotify_id = ?1)",
            params![
                spotify_id,
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
    pub fn remove(&mut self, spotify_id: &str) -> Result<bool, CollectionError> {
        let tx = self.db.transaction()?;
        let removed = tx.execute("DELETE FROM collection WHERE spotify_id = ?1", [spotify_id])?;
        tx.execute(
            "DELETE FROM album_cache WHERE spotify_id = ?1",
            [spotify_id],
        )?;
        tx.execute("DELETE FROM artwork WHERE spotify_id = ?1", [spotify_id])?;
        tx.commit()?;
        #[cfg(debug_assertions)]
        if let Some(dev_list) = &self.dev_list {
            dev_list.removed(spotify_id)?;
        }
        Ok(removed == 1)
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
            "SELECT c.spotify_id, c.added_at, a.title, a.artist, a.year, a.tracks,
                    a.covers, a.upc, a.fetched_at,
                    w.source, w.url, w.width, w.height
             FROM collection c JOIN album_cache a USING (spotify_id)
             LEFT JOIN artwork w USING (spotify_id)
             ORDER BY c.added_at DESC, c.rowid DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let url: Option<String> = row.get(10)?;
            let cover = match url {
                Some(url) => Some(Cover {
                    url,
                    width: row.get(11)?,
                    height: row.get(12)?,
                }),
                None => None,
            };
            Ok((
                Album {
                    spotify_id: row.get(0)?,
                    title: row.get(2)?,
                    artist: row.get(3)?,
                    year: row.get(4)?,
                    tracks: Vec::new(),
                    covers: Vec::new(),
                    upc: row.get(7)?,
                },
                row.get::<_, i64>(1)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(8)?,
                row.get::<_, Option<String>>(9)?,
                cover,
            ))
        })?;
        rows.map(|row| {
            let (mut album, added_at, tracks, covers, fetched_at, source, cover) = row?;
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
                album,
                added_at: time(added_at),
                fetched_at: time(fetched_at),
                artwork,
            })
        })
        .collect()
    }

    /// One album, if it's in the collection.
    pub fn get(&self, spotify_id: &str) -> Result<Option<Collected>, CollectionError> {
        // A few hundred albums: reading them all is simpler than a second
        // query, and fast enough.
        Ok(self
            .albums()?
            .into_iter()
            .find(|c| c.album.spotify_id == spotify_id))
    }

    /// The Spotify IDs of every album in the collection.
    pub fn ids(&self) -> Result<HashSet<String>, CollectionError> {
        let mut statement = self.db.prepare("SELECT spotify_id FROM collection")?;
        let ids = statement.query_map([], |row| row.get(0))?;
        Ok(ids.collect::<Result<_, _>>()?)
    }

    /// Whether the album is in the collection.
    pub fn contains(&self, spotify_id: &str) -> Result<bool, CollectionError> {
        Ok(self
            .db
            .query_row(
                "SELECT 1 FROM collection WHERE spotify_id = ?1",
                [spotify_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
}

fn cache(tx: &Transaction, album: &Album, now: SystemTime) -> Result<(), CollectionError> {
    tx.execute(
        "INSERT OR REPLACE INTO album_cache
             (spotify_id, title, artist, year, tracks, covers, upc, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            album.spotify_id,
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

    fn ids(collection: &Collection) -> Vec<String> {
        collection
            .albums()
            .unwrap()
            .into_iter()
            .map(|c| c.album.spotify_id)
            .collect()
    }

    #[test]
    fn a_new_collection_is_empty() {
        let collection = Collection::open_in_memory().unwrap();
        assert!(collection.albums().unwrap().is_empty());
        assert!(collection.ids().unwrap().is_empty());
    }

    #[test]
    fn adds_an_album_with_its_metadata() {
        let mut collection = Collection::open_in_memory().unwrap();
        let in_rainbows = album("in-rainbows", "In Rainbows");

        assert_eq!(collection.add(&in_rainbows, day(1)).unwrap(), Added::New);

        assert_eq!(
            collection.albums().unwrap(),
            [Collected {
                album: in_rainbows,
                added_at: day(1),
                fetched_at: day(1),
                artwork: None,
            }]
        );
        assert!(collection.contains("in-rainbows").unwrap());
        assert!(!collection.contains("ok-computer").unwrap());
    }

    #[test]
    fn lists_the_most_recently_added_first() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.add(&album("c", "C"), day(3)).unwrap();
        collection.add(&album("b", "B"), day(2)).unwrap();
        // Two in the same millisecond: the later add comes first.
        collection.add(&album("d", "D"), day(3)).unwrap();

        assert_eq!(ids(&collection), ["d", "c", "b", "a"]);
    }

    #[test]
    fn adding_an_album_twice_keeps_one_with_its_first_date_and_fresh_metadata() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection
            .add(&album("in-rainbows", "In Rainbows"), day(1))
            .unwrap();
        let mut renamed = album("in-rainbows", "In Rainbows (Remastered)");
        renamed.upc = None;

        assert_eq!(
            collection.add(&renamed, day(5)).unwrap(),
            Added::AlreadyThere
        );

        assert_eq!(
            collection.albums().unwrap(),
            [Collected {
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
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.add(&album("b", "B"), day(2)).unwrap();

        assert!(collection.remove("a").unwrap());
        assert!(!collection.remove("a").unwrap());
        assert!(!collection.remove("never-added").unwrap());

        assert_eq!(ids(&collection), ["b"]);
        let cached: i64 = collection
            .db
            .query_row("SELECT count(*) FROM album_cache", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cached, 1);
    }

    #[test]
    fn removed_albums_can_be_added_again_as_new() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.remove("a").unwrap();

        assert_eq!(
            collection.add(&album("a", "A"), day(4)).unwrap(),
            Added::New
        );
        assert_eq!(collection.get("a").unwrap().unwrap().added_at, day(4));
    }

    #[test]
    fn everything_survives_reopening_the_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        {
            let mut collection = Collection::open(&path).unwrap();
            collection.add(&album("a", "A"), day(1)).unwrap();
            collection.add(&album("b", "B"), day(2)).unwrap();
            collection.add(&album("c", "C"), day(3)).unwrap();
            collection.add(&album("a", "A again"), day(4)).unwrap();
            collection.remove("b").unwrap();
        }

        let collection = Collection::open(&path).unwrap();

        assert_eq!(ids(&collection), ["c", "a"]);
        let a = collection.get("a").unwrap().unwrap();
        assert_eq!(a.album, album("a", "A again"));
        assert_eq!((a.added_at, a.fetched_at), (day(1), day(4)));
        assert_eq!(
            collection.ids().unwrap(),
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
            Err(CollectionError::TooNew(3))
        ));
    }

    #[test]
    fn adding_at_a_date_keeps_that_date() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("b", "B"), day(5)).unwrap();

        collection.add_at(&album("a", "A"), day(1), day(9)).unwrap();

        let a = collection.get("a").unwrap().unwrap();
        assert_eq!((a.added_at, a.fetched_at), (day(1), day(9)));
        assert_eq!(ids(&collection), ["b", "a"]);
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
        fn every_add_and_remove_updates_the_dev_list() {
            let (_root, mut collection) = collection();

            collection.add(&album("a", "A"), day(1)).unwrap();
            collection.add(&album("b", "B"), day(2)).unwrap();
            assert_eq!(
                listed(&collection),
                [("a".into(), day(1)), ("b".into(), day(2))]
            );

            collection.remove("a").unwrap();
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

            collection.add(&album("a", "A"), day(1)).unwrap();
            collection.remove("a").unwrap();

            let files: Vec<_> = std::fs::read_dir(root.path())
                .unwrap()
                .map(|f| f.unwrap().file_name())
                .collect();
            assert_eq!(files, ["deadwax.sqlite3"]);
        }
    }

    #[test]
    fn refreshing_replaces_the_cache_and_keeps_the_date_added() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();
        let renamed = album("a", "A (Remastered)");

        assert!(collection.refresh(&renamed, day(9)).unwrap());

        assert_eq!(
            collection.get("a").unwrap().unwrap(),
            Collected {
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
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.remove("a").unwrap();

        assert!(!collection.refresh(&album("a", "A"), day(2)).unwrap());

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
        collection.add(&album("a", "A"), day(1)).unwrap();
        assert_eq!(collection.get("a").unwrap().unwrap().artwork, None);

        assert!(collection.set_artwork("a", &itunes(), day(2)).unwrap());

        assert_eq!(
            collection.get("a").unwrap().unwrap().artwork,
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
            ["spotify_id", "source", "url", "width", "height", "found_at"]
        );
    }

    #[test]
    fn stores_spotifys_cover_and_no_cover_at_all() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.add(&album("b", "B"), day(1)).unwrap();
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

        collection.set_artwork("a", &spotify, day(2)).unwrap();
        collection.set_artwork("b", &nothing, day(2)).unwrap();

        assert_eq!(collection.get("a").unwrap().unwrap().artwork, Some(spotify));
        assert_eq!(collection.get("b").unwrap().unwrap().artwork, Some(nothing));
    }

    #[test]
    fn artwork_for_an_album_not_in_the_collection_isnt_stored() {
        let mut collection = Collection::open_in_memory().unwrap();

        assert!(!collection.set_artwork("a", &itunes(), day(2)).unwrap());

        collection.add(&album("a", "A"), day(3)).unwrap();
        assert_eq!(collection.get("a").unwrap().unwrap().artwork, None);
    }

    #[test]
    fn removing_or_clearing_forgets_the_artwork() {
        let mut collection = Collection::open_in_memory().unwrap();
        for id in ["a", "b"] {
            collection.add(&album(id, id), day(1)).unwrap();
            collection.set_artwork(id, &itunes(), day(1)).unwrap();
        }
        let artwork = |c: &Collection| -> i64 {
            c.db.query_row("SELECT count(*) FROM artwork", [], |row| row.get(0))
                .unwrap()
        };

        collection.remove("a").unwrap();
        assert_eq!(artwork(&collection), 1);
        collection.clear().unwrap();
        assert_eq!(artwork(&collection), 0);
    }

    #[test]
    fn refreshing_the_cache_keeps_the_artwork() {
        let mut collection = Collection::open_in_memory().unwrap();
        collection.add(&album("a", "A"), day(1)).unwrap();
        collection.set_artwork("a", &itunes(), day(1)).unwrap();

        collection.refresh(&album("a", "A"), day(9)).unwrap();

        assert_eq!(
            collection.get("a").unwrap().unwrap().artwork,
            Some(itunes())
        );
    }

    #[test]
    fn a_schema_1_database_gains_the_artwork_table_and_keeps_its_albums() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deadwax.sqlite3");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(SCHEMA).unwrap();
            db.pragma_update(None, "user_version", 1).unwrap();
            let tx = db.unchecked_transaction().unwrap();
            tx.execute(
                "INSERT INTO collection (spotify_id, added_at) VALUES ('a', ?1)",
                [millis(day(1))],
            )
            .unwrap();
            cache(&tx, &album("a", "A"), day(1)).unwrap();
            tx.commit().unwrap();
        }

        let mut collection = Collection::open(&path).unwrap();

        assert_eq!(ids(&collection), ["a"]);
        assert!(collection.set_artwork("a", &itunes(), day(2)).unwrap());
        let version: i64 = collection
            .db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }
}
