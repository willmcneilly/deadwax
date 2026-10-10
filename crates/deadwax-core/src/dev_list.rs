//! The dev list: a development-only file outside the repository that mirrors
//! the collection, so it survives database resets and is shared by every
//! checkout and worktree. See RFC-001, "A dev list that survives resets".
//!
//! It holds each album's Spotify ID and when it was added, nothing else. It
//! lives in Deadwax's folder in `~/Library/Application Support`. Several
//! development builds can run at once, so every change takes a lock on the
//! file, reads it, and writes it back whole.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::collection::{millis, time};

/// The dev list's file name, in the app-data folder.
pub const DEV_LIST_FILE: &str = "dev-list.json";

/// Where the dev list lives.
pub fn path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DEV_LIST_FILE)
}

/// An album in the dev list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub spotify_id: String,
    pub added_at: SystemTime,
}

#[derive(Debug, thiserror::Error)]
pub enum DevListError {
    #[error("couldn't use the dev list at {path}: {error}")]
    Io { path: PathBuf, error: io::Error },
    #[error("the dev list at {path} is unreadable: {error}")]
    Corrupt {
        path: PathBuf,
        error: serde_json::Error,
    },
}

/// The file's contents.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contents {
    albums: Vec<Stored>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    spotify_id: String,
    /// Unix milliseconds, as in the database.
    added_at: i64,
}

pub struct DevList {
    path: PathBuf,
}

impl DevList {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Every album in the dev list, in the order they were first added. A
    /// missing file is an empty list.
    pub fn albums(&self) -> Result<Vec<Entry>, DevListError> {
        let _lock = self.lock()?;
        Ok(self
            .read()?
            .albums
            .into_iter()
            .map(|stored| Entry {
                spotify_id: stored.spotify_id,
                added_at: time(stored.added_at),
            })
            .collect())
    }

    /// Records that the album was added at `added_at`. An album already in
    /// the list keeps the date it has: that's when it was first added.
    pub fn added(&self, spotify_id: &str, added_at: SystemTime) -> Result<(), DevListError> {
        self.change(|file| {
            if file.albums.iter().any(|a| a.spotify_id == spotify_id) {
                return false;
            }
            file.albums.push(Stored {
                spotify_id: spotify_id.into(),
                added_at: millis(added_at),
            });
            true
        })
    }

    /// Records that the album was removed.
    pub fn removed(&self, spotify_id: &str) -> Result<(), DevListError> {
        self.change(|file| {
            let before = file.albums.len();
            file.albums.retain(|a| a.spotify_id != spotify_id);
            file.albums.len() != before
        })
    }

    /// Applies `edit` under the lock, and writes the file if it says it
    /// changed something.
    fn change(&self, edit: impl FnOnce(&mut Contents) -> bool) -> Result<(), DevListError> {
        let _lock = self.lock()?;
        let mut file = self.read()?;
        if edit(&mut file) {
            self.write(&file)?;
        }
        Ok(())
    }

    /// Holds an exclusive lock on a file beside the list until it's dropped,
    /// so two development builds can't lose each other's changes. The lock
    /// is on its own file because writing replaces the list's.
    fn lock(&self) -> Result<File, DevListError> {
        let lock_path = self.path.with_extension("lock");
        let lock = (|| {
            if let Some(dir) = lock_path.parent() {
                fs::create_dir_all(dir)?;
            }
            let file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&lock_path)?;
            file.lock()?;
            Ok(file)
        })();
        lock.map_err(|error| self.io(error))
    }

    fn read(&self) -> Result<Contents, DevListError> {
        match fs::read_to_string(&self.path) {
            Ok(json) => serde_json::from_str(&json).map_err(|error| DevListError::Corrupt {
                path: self.path.clone(),
                error,
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Contents::default()),
            Err(error) => Err(self.io(error)),
        }
    }

    /// Writes a temporary file and renames it, so a crash can't leave half a
    /// list.
    fn write(&self, file: &Contents) -> Result<(), DevListError> {
        let temporary = self.path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(file).expect("the dev list serialises") + "\n";
        fs::write(&temporary, json)
            .and_then(|()| fs::rename(&temporary, &self.path))
            .map_err(|error| self.io(error))
    }

    fn io(&self, error: io::Error) -> DevListError {
        DevListError::Io {
            path: self.path.clone(),
            error,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;

    fn day(n: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000 + n * 24 * 60 * 60)
    }

    fn entry(id: &str, added_at: SystemTime) -> Entry {
        Entry {
            spotify_id: id.into(),
            added_at,
        }
    }

    /// A dev list in a temporary `Application Support` folder.
    fn dev_list() -> (tempfile::TempDir, DevList) {
        let root = tempfile::tempdir().unwrap();
        let app_data = root
            .path()
            .join("Application Support/com.willmcneilly.deadwax");
        (root, DevList::new(path(&app_data)))
    }

    #[test]
    fn lives_in_the_app_data_folder() {
        let app_data = Path::new("/Users/w/Library/Application Support/com.willmcneilly.deadwax");
        assert_eq!(path(app_data), app_data.join("dev-list.json"));
    }

    #[test]
    fn a_missing_file_is_an_empty_list() {
        let (_root, list) = dev_list();
        assert_eq!(list.albums().unwrap(), []);
    }

    #[test]
    fn records_adds_in_order_creating_the_folder() {
        let (_root, list) = dev_list();

        list.added("b", day(2)).unwrap();
        list.added("a", day(1)).unwrap();

        assert_eq!(
            list.albums().unwrap(),
            [entry("b", day(2)), entry("a", day(1))]
        );
        assert!(list.path.is_file());
    }

    #[test]
    fn adding_again_keeps_the_first_date() {
        let (_root, list) = dev_list();
        list.added("a", day(1)).unwrap();

        list.added("a", day(5)).unwrap();

        assert_eq!(list.albums().unwrap(), [entry("a", day(1))]);
    }

    #[test]
    fn records_removes() {
        let (_root, list) = dev_list();
        list.added("a", day(1)).unwrap();
        list.added("b", day(2)).unwrap();

        list.removed("a").unwrap();
        list.removed("never-added").unwrap();

        assert_eq!(list.albums().unwrap(), [entry("b", day(2))]);
    }

    #[test]
    fn every_checkout_shares_one_file() {
        let (_root, first) = dev_list();
        let second = DevList::new(first.path.clone());

        first.added("a", day(1)).unwrap();
        second.added("b", day(2)).unwrap();
        first.removed("b").unwrap();

        assert_eq!(second.albums().unwrap(), [entry("a", day(1))]);
    }

    #[test]
    fn concurrent_changes_are_not_lost() {
        let (_root, list) = dev_list();
        let path = list.path.clone();

        let writers: Vec<_> = (0..8)
            .map(|n| {
                let list = DevList::new(path.clone());
                std::thread::spawn(move || list.added(&format!("album-{n}"), day(n)).unwrap())
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }

        assert_eq!(list.albums().unwrap().len(), 8);
    }

    #[test]
    fn the_file_holds_ids_and_dates_only() {
        let (_root, list) = dev_list();
        list.added("a", UNIX_EPOCH + Duration::from_millis(1_790_000_000_123))
            .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&list.path).unwrap()).unwrap();

        assert_eq!(
            json,
            serde_json::json!({"albums": [{"spotifyId": "a", "addedAt": 1_790_000_000_123_i64}]})
        );
    }

    #[test]
    fn an_unreadable_file_is_an_error_not_an_empty_list() {
        let (_root, list) = dev_list();
        list.added("a", day(1)).unwrap();
        fs::write(&list.path, "not json").unwrap();

        assert!(matches!(list.albums(), Err(DevListError::Corrupt { .. })));
        // And it isn't overwritten, losing what was there.
        assert!(list.added("b", day(2)).is_err());
        assert_eq!(fs::read_to_string(&list.path).unwrap(), "not json");
    }
}
