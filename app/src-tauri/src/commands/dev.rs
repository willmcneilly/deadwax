//! The Develop menu's commands: resetting the collection and restoring it
//! from the dev list. See RFC-001, "A dev list that survives resets".
//!
//! Development builds only: `commands.rs` compiles this module under
//! `debug_assertions`, so release builds don't contain it.

use std::time::SystemTime;

use deadwax_core::collection::Collection;
use deadwax_core::dev_list::Entry;
use deadwax_sources::clock::Clock;
use deadwax_sources::spotify::tokens::TokenStore;
use deadwax_sources::spotify::{Spotify, SpotifyError};
use serde::Serialize;
use tauri::State;

use super::{AppState, EXPIRED_MESSAGE, collection_error, spotify_error};

/// The events the Develop menu's items send the UI.
pub const RESET_COLLECTION: &str = "reset-collection";
pub const RESTORE_FROM_DEV_LIST: &str = "restore-from-dev-list";

/// What restoring did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: u32,
    /// Albums Spotify couldn't give us. They stay in the dev list.
    pub failed: Vec<RestoreFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    pub id: String,
    pub message: String,
}

fn dev_list_error(error: impl std::fmt::Display) -> String {
    format!("Couldn't read the dev list: {error}")
}

/// The albums in the dev list that aren't in the collection.
fn missing(collection: &std::sync::Mutex<Collection>) -> Result<Vec<Entry>, String> {
    let collection = collection.lock().expect("collection lock");
    let dev_list = collection.dev_list().ok_or("This build has no dev list.")?;
    let owned = collection.ids().map_err(collection_error)?;
    Ok(dev_list
        .albums()
        .map_err(dev_list_error)?
        .into_iter()
        .filter(|entry| !owned.contains(&entry.spotify_id))
        .collect())
}

/// How many albums restoring would bring back. The UI offers to restore
/// when the collection is empty and this isn't zero.
#[tauri::command]
pub fn dev_list_missing(state: State<'_, AppState>) -> Result<u32, String> {
    Ok(u32::try_from(missing(&state.collection)?.len()).unwrap_or(u32::MAX))
}

/// Empties this checkout's collection. The dev list keeps everything.
#[tauri::command]
pub fn reset_collection(state: State<'_, AppState>) -> Result<(), String> {
    state
        .collection
        .lock()
        .expect("collection lock")
        .clear()
        .map_err(collection_error)
}

/// Adds back every album in the dev list that isn't in the collection,
/// fetching each from Spotify one at a time, with its original date added.
#[tauri::command]
pub async fn restore_from_dev_list(state: State<'_, AppState>) -> Result<RestoreReport, String> {
    let spotify = state.signed_in().await?;
    restore(&spotify, &state.collection, SystemTime::now()).await
}

async fn restore<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    now: SystemTime,
) -> Result<RestoreReport, String> {
    let mut report = RestoreReport {
        restored: 0,
        failed: Vec::new(),
    };
    for entry in missing(collection)? {
        // One album at a time: Spotify no longer fetches several at once,
        // and the client waits out any 429.
        match spotify.album(&entry.spotify_id).await {
            Ok(album) => {
                collection
                    .lock()
                    .expect("collection lock")
                    .add_at(&album, entry.added_at, now)
                    .map_err(collection_error)?;
                report.restored += 1;
            }
            // No point asking for the rest.
            Err(SpotifyError::SignedOut) => return Err(EXPIRED_MESSAGE.into()),
            Err(error) => report.failed.push(RestoreFailure {
                id: entry.spotify_id,
                message: spotify_error(error),
            }),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use deadwax_core::dev_list::{self, DevList};
    use deadwax_sources::clock::SystemClock;
    use deadwax_sources::spotify::tokens::MemoryStore;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::super::tests::{IN_RAINBOWS, fake_spotify, fixture, signed_in_with_expired_token};
    use super::*;

    const OK_COMPUTER: &str = "6dVIqQ8qmQ5GBnJ9shOYGE";
    const GONE: &str = "0000000000000000000000";

    fn day(n: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000 + n * 24 * 60 * 60)
    }

    /// An empty collection in a temporary checkout, mirroring to a dev list
    /// in a temporary app-data folder that already holds `albums`.
    fn collection_with_dev_list(
        albums: &[(&str, SystemTime)],
    ) -> (tempfile::TempDir, std::sync::Mutex<Collection>) {
        let root = tempfile::tempdir().unwrap();
        let dev_list = DevList::new(dev_list::path(&root.path().join("app-data")));
        for (id, added_at) in albums {
            dev_list.added(id, *added_at).unwrap();
        }
        let collection = Collection::open(&root.path().join("checkout/.dev-data/deadwax.sqlite3"))
            .unwrap()
            .with_dev_list(dev_list);
        (root, std::sync::Mutex::new(collection))
    }

    /// Answers OK Computer with the In Rainbows fixture under its own ID.
    async fn mount_ok_computer(server: &MockServer) {
        let mut album = fixture("album-in-rainbows.json");
        album["id"] = json!(OK_COMPUTER);
        album["name"] = json!("OK Computer");
        Mock::given(method("GET"))
            .and(path(format!("/v1/albums/{OK_COMPUTER}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(album))
            .mount(server)
            .await;
    }

    fn album_requests(requests: &[wiremock::Request]) -> Vec<String> {
        requests
            .iter()
            .map(|r| r.url.path().to_owned())
            .filter(|p| p.starts_with("/v1/albums"))
            .collect()
    }

    #[tokio::test]
    async fn restores_each_album_one_at_a_time_with_its_original_date() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        mount_ok_computer(&server).await;
        let (_root, collection) =
            collection_with_dev_list(&[(IN_RAINBOWS, day(1)), (OK_COMPUTER, day(3))]);
        assert_eq!(missing(&collection).unwrap().len(), 2);

        let report = restore(&spotify, &collection, day(10)).await.unwrap();

        assert_eq!(
            report,
            RestoreReport {
                restored: 2,
                failed: Vec::new()
            }
        );
        // One request per album, in the dev list's order: no batch request.
        assert_eq!(
            album_requests(&server.received_requests().await.unwrap()),
            [
                format!("/v1/albums/{IN_RAINBOWS}"),
                format!("/v1/albums/{OK_COMPUTER}")
            ]
        );
        let collection = collection.lock().unwrap();
        let restored: Vec<_> = collection
            .albums()
            .unwrap()
            .into_iter()
            .map(|c| (c.album.title, c.added_at, c.fetched_at))
            .collect();
        assert_eq!(
            restored,
            [
                ("OK Computer".into(), day(3), day(10)),
                ("In Rainbows".into(), day(1), day(10)),
            ]
        );
        // The dev list is unchanged.
        assert_eq!(
            collection.dev_list().unwrap().albums().unwrap(),
            [
                Entry {
                    spotify_id: IN_RAINBOWS.into(),
                    added_at: day(1)
                },
                Entry {
                    spotify_id: OK_COMPUTER.into(),
                    added_at: day(3)
                },
            ]
        );
    }

    #[tokio::test]
    async fn only_fetches_the_albums_the_collection_is_missing() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        mount_ok_computer(&server).await;
        let (_root, collection) =
            collection_with_dev_list(&[(IN_RAINBOWS, day(1)), (OK_COMPUTER, day(3))]);
        super::super::add(&spotify, &collection, IN_RAINBOWS, day(1))
            .await
            .unwrap();
        let before = album_requests(&server.received_requests().await.unwrap()).len();

        let report = restore(&spotify, &collection, day(10)).await.unwrap();

        assert_eq!(report.restored, 1);
        let requests = album_requests(&server.received_requests().await.unwrap());
        assert_eq!(requests[before..], [format!("/v1/albums/{OK_COMPUTER}")]);
        assert_eq!(missing(&collection).unwrap(), []);
    }

    #[tokio::test]
    async fn an_album_spotify_cant_find_is_reported_and_the_rest_restored() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let (_root, collection) =
            collection_with_dev_list(&[(GONE, day(1)), (IN_RAINBOWS, day(2))]);

        let report = restore(&spotify, &collection, day(10)).await.unwrap();

        assert_eq!(report.restored, 1);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].id, GONE);
        assert!(report.failed[0].message.contains("404"), "{report:?}");
        // It stays in the dev list, to try again later.
        let collection = collection.lock().unwrap();
        assert_eq!(collection.dev_list().unwrap().albums().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_expired_sign_in_stops_restoring_and_says_so_plainly() {
        let server = MockServer::start().await;
        let rejected = ResponseTemplate::new(400).set_body_json(json!({"error": "invalid_grant"}));
        let spotify: Spotify<SystemClock, MemoryStore> =
            signed_in_with_expired_token(&server, rejected).await;
        let (_root, collection) =
            collection_with_dev_list(&[(IN_RAINBOWS, day(1)), (OK_COMPUTER, day(2))]);

        assert_eq!(
            restore(&spotify, &collection, day(10)).await,
            Err(EXPIRED_MESSAGE.into())
        );
        assert!(collection.lock().unwrap().albums().unwrap().is_empty());
    }

    #[test]
    fn resetting_empties_the_collection_but_not_the_dev_list() {
        let (_root, collection) = collection_with_dev_list(&[(IN_RAINBOWS, day(1))]);

        collection.lock().unwrap().clear().unwrap();

        assert_eq!(missing(&collection).unwrap().len(), 1);
    }

    #[test]
    fn a_collection_without_a_dev_list_says_so() {
        let collection = std::sync::Mutex::new(Collection::open_in_memory().unwrap());
        assert!(missing(&collection).is_err());
    }

    /// The JSON `app/src/api.ts` expects. Change both together.
    #[test]
    fn reports_serialise_as_the_ui_expects() {
        let report = RestoreReport {
            restored: 1,
            failed: vec![RestoreFailure {
                id: GONE.into(),
                message: "m".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({"restored": 1, "failed": [{"id": GONE, "message": "m"}]})
        );
    }
}
