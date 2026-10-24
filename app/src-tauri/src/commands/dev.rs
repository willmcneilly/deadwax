//! The Develop menu's commands: resetting the collection, restoring it from
//! the dev list, the Artwork report, importing the prototype's liner notes
//! and the Liner notes report, and keeping the window in front for the crate
//! spike (DWX-20). See RFC-001, "A dev list that survives resets" and
//! "High-res artwork, as an experiment", and RFC-002, "2. Local artwork, in
//! sizes", "3. Genre and label" and "5. Liner notes in the app".
//!
//! Development builds only: `commands.rs` compiles this module under
//! `debug_assertions`, so release builds don't contain it.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use deadwax_core::collection::{AlbumId, ArtworkSource, Collection, Step};
use deadwax_core::covers::Store;
use deadwax_core::dev_list::Entry;
use deadwax_core::notes::{self, NotesDir, NotesError};
use deadwax_core::palette::Palette;
use deadwax_sources::clock::Clock;
use deadwax_sources::spotify::tokens::TokenStore;
use deadwax_sources::spotify::{Spotify, SpotifyError};
use serde::Serialize;
use tauri::State;

use super::{AppState, EXPIRED_MESSAGE, collection_error, spotify_error};
use crate::jobs::{AlbumJobs, StepStatus};

/// The events the Develop menu's items send the UI.
pub const RESET_COLLECTION: &str = "reset-collection";
pub const RESTORE_FROM_DEV_LIST: &str = "restore-from-dev-list";
pub const ARTWORK_REPORT: &str = "artwork-report";
/// The crate spike: DWX-20's measuring of the crate against the frame budget.
pub const CRATE_SPIKE: &str = "crate-spike";
pub const IMPORT_PROTOTYPE_NOTES: &str = "import-prototype-notes";
pub const NOTES_REPORT: &str = "notes-report";

/// What restoring did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: u32,
    /// Albums Spotify couldn't give us. They stay in the dev list.
    pub failed: Vec<RestoreFailure>,
}

/// An album the dev list has that couldn't be restored. It has no Deadwax
/// ID, since it never made it into the collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFailure {
    pub spotify_id: String,
    pub message: String,
}

fn dev_list_error(error: impl std::fmt::Display) -> String {
    format!("Couldn't read the dev list: {error}")
}

/// The albums in the dev list that aren't in the collection.
fn missing(collection: &std::sync::Mutex<Collection>) -> Result<Vec<Entry>, String> {
    let collection = collection.lock().expect("collection lock");
    let dev_list = collection.dev_list().ok_or("This build has no dev list.")?;
    let owned = collection.spotify_ids().map_err(collection_error)?;
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

/// Empties this checkout's collection and deletes its covers. The dev list
/// keeps everything.
#[tauri::command]
pub fn reset_collection(state: State<'_, AppState>) -> Result<(), String> {
    reset(&state.collection, &state.covers)
}

fn reset(collection: &std::sync::Mutex<Collection>, covers: &Store) -> Result<(), String> {
    collection
        .lock()
        .expect("collection lock")
        .clear()
        .map_err(collection_error)?;
    covers
        .clear()
        .map_err(|e| format!("Couldn't delete the covers: {e}"))
}

/// Adds back every album in the dev list that isn't in the collection,
/// fetching each from Spotify one at a time, with its original date added
/// and a new Deadwax ID (the dev list keeps only Spotify IDs).
/// Their covers are looked up and downloaded in the background.
#[tauri::command]
pub async fn restore_from_dev_list(state: State<'_, AppState>) -> Result<RestoreReport, String> {
    let spotify = state.signed_in().await?;
    restore_and_queue(&spotify, &state.collection, &state.jobs, SystemTime::now()).await
}

/// Restores, then queues every album with steps left.
async fn restore_and_queue<C: Clock, S: TokenStore>(
    spotify: &Spotify<C, S>,
    collection: &std::sync::Mutex<Collection>,
    jobs: &AlbumJobs,
    now: SystemTime,
) -> Result<RestoreReport, String> {
    let report = restore(spotify, collection, now).await?;
    jobs.queue_unfinished(collection)?;
    Ok(report)
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
                spotify_id: entry.spotify_id,
                message: spotify_error(error),
            }),
        }
    }
    Ok(report)
}

/// Where every album's cover came from, how big it is, its palette, genre
/// and label, and where each of its steps in the album job queue stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkReport {
    /// The collection's albums, the most recently added first.
    pub albums: Vec<ArtworkRow>,
    /// Albums per source, in the order they're tried, then the albums not
    /// looked up yet.
    pub totals: Vec<ArtworkTotal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkRow {
    pub id: AlbumId,
    pub title: String,
    pub artist: String,
    /// "iTunes", "Deezer", "MusicBrainz", "Spotify", or `NOT_LOOKED_UP`.
    pub source: String,
    pub url: Option<String>,
    /// In pixels. `None` when it couldn't be read, or there's no cover.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Its colours as `#rrggbb`, once they've been worked out.
    pub palette: Option<Palette>,
    /// `None` when no source had one, or they haven't been looked for yet
    /// (the steps say which).
    pub genre: Option<String>,
    pub label: Option<String>,
    /// The album job queue's steps, in the order they run.
    pub steps: Vec<StepRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRow {
    /// "Lookup", "Sizes", "Palette" or "Genre and label".
    pub step: String,
    /// "Done", "Queued", "Failed" or "Not started".
    pub status: String,
    /// Why it failed, for "Failed".
    pub error: Option<String>,
}

fn step_row(step: Step, status: StepStatus) -> StepRow {
    let (status, error) = match status {
        StepStatus::Done => ("Done", None),
        StepStatus::Queued => ("Queued", None),
        StepStatus::Failed(error) => ("Failed", Some(error)),
        StepStatus::NotStarted => ("Not started", None),
    };
    StepRow {
        step: match step {
            Step::Lookup => "Lookup",
            Step::Sizes => "Sizes",
            Step::Palette => "Palette",
            Step::GenreAndLabel => "Genre and label",
        }
        .into(),
        status: status.into(),
        error,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkTotal {
    pub source: String,
    pub albums: u32,
}

/// An album whose lookup hasn't finished, or failed and will run again when
/// its page opens.
pub const NOT_LOOKED_UP: &str = "Not looked up yet";

fn source_name(source: ArtworkSource) -> &'static str {
    match source {
        ArtworkSource::Itunes => "iTunes",
        ArtworkSource::Deezer => "Deezer",
        ArtworkSource::MusicBrainz => "MusicBrainz",
        ArtworkSource::Spotify => "Spotify",
    }
}

/// Keeps the window in front, filling the screen, while the crate spike
/// measures (DWX-20), or lets it go. WebKit stops drawing a window that's
/// covered, which would spoil the frame counts, and a full screen is the most
/// there is to draw.
#[tauri::command]
pub fn crate_spike_keep_in_front(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())?;
    if on {
        window.maximize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The Artwork report, for the Develop menu.
#[tauri::command]
pub fn artwork_report(state: State<'_, AppState>) -> Result<ArtworkReport, String> {
    report(
        &state.collection.lock().expect("collection lock"),
        &state.jobs,
    )
}

fn report(collection: &Collection, jobs: &AlbumJobs) -> Result<ArtworkReport, String> {
    let albums: Vec<ArtworkRow> = collection
        .albums()
        .map_err(collection_error)?
        .into_iter()
        .map(|collected| {
            let steps = jobs
                .statuses(&collected)
                .into_iter()
                .map(|(step, status)| step_row(step, status))
                .collect();
            let source = collected
                .artwork
                .as_ref()
                .map_or(NOT_LOOKED_UP, |artwork| source_name(artwork.source));
            let cover = collected.artwork.and_then(|artwork| artwork.cover);
            let found = collected.genre_and_label.unwrap_or_default();
            ArtworkRow {
                id: collected.id,
                title: collected.album.title,
                artist: collected.album.artist,
                source: source.into(),
                width: cover.as_ref().and_then(|c| c.width),
                height: cover.as_ref().and_then(|c| c.height),
                url: cover.map(|c| c.url),
                palette: collected.palette,
                genre: found.genre,
                label: found.label,
                steps,
            }
        })
        .collect();
    let count = |name: &str| {
        let n = albums.iter().filter(|row| row.source == name).count();
        u32::try_from(n).unwrap_or(u32::MAX)
    };
    let mut totals: Vec<ArtworkTotal> = ArtworkSource::ALL
        .into_iter()
        .map(|source| ArtworkTotal {
            source: source_name(source).into(),
            albums: count(source_name(source)),
        })
        .collect();
    let not_looked_up = count(NOT_LOOKED_UP);
    if not_looked_up > 0 {
        totals.push(ArtworkTotal {
            source: NOT_LOOKED_UP.into(),
            albums: not_looked_up,
        });
    }
    Ok(ArtworkReport { albums, totals })
}

/// What importing the prototype's liner notes did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesImport {
    /// The essays now in the notes folder, each with the album it's for.
    pub imported: Vec<ImportedNotes>,
    /// Essays about albums that aren't in the collection.
    pub unmatched: Vec<UnmatchedNotes>,
    /// Files in the prototype's folder that aren't valid notes.
    pub invalid: Vec<NotesProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedNotes {
    pub id: AlbumId,
    pub title: String,
    pub artist: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedNotes {
    /// The file's name in the prototype's folder.
    pub file: String,
    /// The album and artist the essay names.
    pub album_title: String,
    pub artist: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesProblem {
    pub file: String,
    pub message: String,
}

/// The prototype's five essays (PR #9), in this checkout.
fn prototype_notes() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../prototypes/crate/public/notes")
}

/// Copies the prototype's essays into the notes folder, each named by the
/// Deadwax ID of the album in the collection with the same title and artist.
/// An album's notes are replaced if it had some.
#[tauri::command]
pub fn import_prototype_notes(state: State<'_, AppState>) -> Result<NotesImport, String> {
    import_notes(&prototype_notes(), &state.collection, &state.notes)
}

fn notes_error(error: NotesError) -> String {
    match error {
        NotesError::Invalid(reason) => format!("It isn't valid liner notes: {reason}"),
        NotesError::Io(error) => error.to_string(),
    }
}

fn import_notes(
    from: &Path,
    collection: &std::sync::Mutex<Collection>,
    to: &NotesDir,
) -> Result<NotesImport, String> {
    let files = NotesDir::new(from)
        .files()
        .map_err(|e| format!("Couldn't read the prototype's notes: {}", notes_error(e)))?;
    if files.is_empty() {
        return Err(format!(
            "There are no notes to import in {}.",
            from.display()
        ));
    }
    let albums = collection
        .lock()
        .expect("collection lock")
        .albums()
        .map_err(collection_error)?;
    let mut import = NotesImport {
        imported: Vec::new(),
        unmatched: Vec::new(),
        invalid: Vec::new(),
    };
    for file in files {
        let found = match file.notes {
            Ok(found) => found,
            Err(error) => {
                import.invalid.push(NotesProblem {
                    file: file.name,
                    message: notes_error(error),
                });
                continue;
            }
        };
        let album = albums
            .iter()
            .find(|a| notes::is_about(&found, &a.album.title, &a.album.artist));
        let Some(album) = album else {
            import.unmatched.push(UnmatchedNotes {
                file: file.name,
                album_title: found.album_title,
                artist: found.artist,
            });
            continue;
        };
        to.write(&album.id, &found).map_err(|e| {
            format!(
                "Couldn't write the notes for {}: {}",
                album.album.title,
                notes_error(e)
            )
        })?;
        import.imported.push(ImportedNotes {
            id: album.id.clone(),
            title: album.album.title.clone(),
            artist: album.album.artist.clone(),
        });
    }
    Ok(import)
}

/// Every file in the notes folder, the album it's for, and what's wrong with
/// it, if anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesReport {
    /// Where the notes folder is.
    pub folder: String,
    pub files: Vec<NotesRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesRow {
    pub file: String,
    /// The album it's for, when its name is the Deadwax ID of one in the
    /// collection.
    pub id: Option<AlbumId>,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Why the gatefold won't show it. `None` when it will.
    pub problem: Option<String>,
}

/// No album in the collection has the ID a notes file is named by.
pub const NO_SUCH_ALBUM: &str = "No album in the collection has this ID.";

/// The Liner notes report, for the Develop menu: where an invalid notes
/// file is reported, since the gatefold treats it as no notes.
#[tauri::command]
pub fn notes_report(state: State<'_, AppState>) -> Result<NotesReport, String> {
    report_notes(
        &state.notes,
        &state.collection.lock().expect("collection lock"),
    )
}

fn report_notes(dir: &NotesDir, collection: &Collection) -> Result<NotesReport, String> {
    let files = dir
        .files()
        .map_err(|e| format!("Couldn't read the notes folder: {}", notes_error(e)))?;
    let mut rows = Vec::new();
    for file in files {
        let album = match &file.id {
            Some(id) => collection.get(id).map_err(collection_error)?,
            None => None,
        };
        let problem = match (file.notes, &album) {
            (Err(error), _) => Some(notes_error(error)),
            (Ok(_), None) => Some(NO_SUCH_ALBUM.into()),
            (Ok(_), Some(_)) => None,
        };
        rows.push(NotesRow {
            file: file.name,
            id: album.as_ref().map(|a| a.id.clone()),
            title: album.as_ref().map(|a| a.album.title.clone()),
            artist: album.as_ref().map(|a| a.album.artist.clone()),
            problem,
        });
    }
    Ok(NotesReport {
        folder: dir.path().display().to_string(),
        files: rows,
    })
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use deadwax_core::collection::{Artwork, Cover, GenreAndLabel};
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
    async fn restoring_makes_new_deadwax_ids_and_keeps_the_dates_added() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        let (_root, collection) = collection_with_dev_list(&[(IN_RAINBOWS, day(1))]);
        restore(&spotify, &collection, day(10)).await.unwrap();
        let first = collection.lock().unwrap().albums().unwrap()[0].clone();

        // Reset and restore again: the same album comes back with a new
        // Deadwax ID and its original date.
        collection.lock().unwrap().clear().unwrap();
        restore(&spotify, &collection, day(20)).await.unwrap();
        let again = collection.lock().unwrap().albums().unwrap()[0].clone();

        assert_ne!(first.id.as_str(), IN_RAINBOWS);
        assert_ne!(again.id, first.id);
        assert_eq!(again.album.spotify_id, IN_RAINBOWS);
        assert_eq!((first.added_at, again.added_at), (day(1), day(1)));
        assert_eq!(again.fetched_at, day(20));
        // The dev list still names it by its Spotify ID only.
        assert_eq!(
            collection
                .lock()
                .unwrap()
                .dev_list()
                .unwrap()
                .albums()
                .unwrap(),
            [Entry {
                spotify_id: IN_RAINBOWS.into(),
                added_at: day(1)
            }]
        );
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
    async fn restoring_queues_every_restored_album_for_its_jobs() {
        let server = MockServer::start().await;
        let spotify = fake_spotify(&server).await;
        mount_ok_computer(&server).await;
        let (_root, collection) =
            collection_with_dev_list(&[(IN_RAINBOWS, day(1)), (OK_COMPUTER, day(3))]);
        let (jobs, mut queued) = AlbumJobs::unstarted();

        restore_and_queue(&spotify, &collection, &jobs, day(10))
            .await
            .unwrap();

        let mut queued = AlbumJobs::queued(&mut queued);
        queued.sort();
        let mut restored: Vec<AlbumId> = collection
            .lock()
            .unwrap()
            .albums()
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        restored.sort();
        assert_eq!(restored.len(), 2);
        assert_eq!(queued, restored);
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
        assert_eq!(report.failed[0].spotify_id, GONE);
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
    fn resetting_empties_the_collection_and_deletes_the_covers_but_not_the_dev_list() {
        let (root, collection) = collection_with_dev_list(&[(IN_RAINBOWS, day(1))]);
        let covers = Store::new(root.path().join("artwork"));
        let renditions =
            deadwax_core::covers::make(&deadwax_core::covers::testing::jpeg(400, 400)).unwrap();
        covers.save(&AlbumId::new(), &renditions).unwrap();

        reset(&collection, &covers).unwrap();

        assert!(collection.lock().unwrap().albums().unwrap().is_empty());
        assert!(!root.path().join("artwork").exists());
        assert_eq!(missing(&collection).unwrap().len(), 1);
    }

    fn album(id: &str, title: &str) -> deadwax_core::collection::Album {
        deadwax_core::collection::Album {
            spotify_id: id.into(),
            title: title.into(),
            artist: "Radiohead".into(),
            year: None,
            tracks: Vec::new(),
            covers: Vec::new(),
            upc: None,
        }
    }

    fn cover(url: &str, size: Option<u32>) -> Option<Cover> {
        Some(Cover {
            url: url.into(),
            width: size,
            height: size,
        })
    }

    #[test]
    fn the_artwork_report_lists_every_album_with_its_source_and_size_and_totals_by_source() {
        let mut collection = Collection::open_in_memory().unwrap();
        let mut ids = std::collections::HashMap::new();
        for (n, id) in ["a", "b", "c", "d", "e"].into_iter().enumerate() {
            let added = collection
                .add(&album(id, &id.to_uppercase()), day(n as u64))
                .unwrap();
            ids.insert(id, added.id().clone());
        }
        for (id, source, cover) in [
            (
                "a",
                ArtworkSource::Itunes,
                cover("https://itunes/a", Some(4000)),
            ),
            ("b", ArtworkSource::Itunes, cover("https://itunes/b", None)),
            (
                "c",
                ArtworkSource::Spotify,
                cover("https://spotify/c", Some(640)),
            ),
            ("d", ArtworkSource::Spotify, None),
        ] {
            collection
                .set_artwork(&ids[id], &Artwork { source, cover }, day(9))
                .unwrap();
        }

        let (jobs, _queued) = AlbumJobs::unstarted();
        let report = report(&collection, &jobs).unwrap();

        // Rows name albums by their Deadwax IDs.
        assert_eq!(report.albums[0].id, ids["e"]);

        let rows: Vec<_> = report
            .albums
            .iter()
            .map(|r| {
                (
                    r.title.as_str(),
                    r.source.as_str(),
                    r.url.as_deref(),
                    r.width,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("E", NOT_LOOKED_UP, None, None),
                ("D", "Spotify", None, None),
                ("C", "Spotify", Some("https://spotify/c"), Some(640)),
                ("B", "iTunes", Some("https://itunes/b"), None),
                ("A", "iTunes", Some("https://itunes/a"), Some(4000)),
            ]
        );
        let totals: Vec<_> = report
            .totals
            .iter()
            .map(|t| (t.source.as_str(), t.albums))
            .collect();
        assert_eq!(
            totals,
            [
                ("iTunes", 2),
                ("Deezer", 0),
                ("MusicBrainz", 0),
                ("Spotify", 2),
                (NOT_LOOKED_UP, 1),
            ]
        );
    }

    #[test]
    fn the_artwork_report_only_counts_albums_not_looked_up_when_there_are_some() {
        let mut collection = Collection::open_in_memory().unwrap();
        let added = collection.add(&album("a", "A"), day(1)).unwrap();
        collection
            .set_artwork(
                added.id(),
                &Artwork {
                    source: ArtworkSource::Deezer,
                    cover: cover("https://deezer/a", Some(1000)),
                },
                day(1),
            )
            .unwrap();

        let (jobs, _queued) = AlbumJobs::unstarted();
        let totals = report(&collection, &jobs).unwrap().totals;

        assert_eq!(totals.len(), 4);
        assert_eq!(totals[1].albums, 1);
    }

    #[test]
    fn the_artwork_report_shows_each_albums_steps_and_where_they_stand() {
        let mut collection = Collection::open_in_memory().unwrap();
        let queued = collection
            .add(&album("a", "A"), day(1))
            .unwrap()
            .id()
            .clone();
        let done = collection
            .add(&album("b", "B"), day(2))
            .unwrap()
            .id()
            .clone();
        let spotifys = Artwork {
            source: ArtworkSource::Spotify,
            cover: None,
        };
        collection.set_artwork(&done, &spotifys, day(3)).unwrap();
        collection.finish(&done, Step::Sizes, day(3)).unwrap();
        let (jobs, _queued) = AlbumJobs::unstarted();
        jobs.queue(&queued);

        let report = report(&collection, &jobs).unwrap();

        let steps: Vec<Vec<(&str, &str)>> = report
            .albums
            .iter()
            .map(|row| {
                row.steps
                    .iter()
                    .map(|s| (s.step.as_str(), s.status.as_str()))
                    .collect()
            })
            .collect();
        assert_eq!(
            steps,
            [
                [
                    ("Lookup", "Done"),
                    ("Sizes", "Done"),
                    ("Palette", "Not started"),
                    ("Genre and label", "Not started"),
                ],
                [
                    ("Lookup", "Queued"),
                    ("Sizes", "Queued"),
                    ("Palette", "Queued"),
                    ("Genre and label", "Queued"),
                ],
            ]
        );
    }

    #[test]
    fn the_artwork_report_shows_each_albums_swatches_genre_and_label() {
        let mut collection = Collection::open_in_memory().unwrap();
        let found = collection
            .add(&album("a", "A"), day(1))
            .unwrap()
            .id()
            .clone();
        collection.add(&album("b", "B"), day(2)).unwrap();
        collection
            .set_palette(&found, &Palette::neutral(), day(3))
            .unwrap();
        collection
            .set_genre_and_label(
                &found,
                &GenreAndLabel {
                    genre: Some("Alternative".into()),
                    label: Some("XL Recordings".into()),
                },
                day(3),
            )
            .unwrap();
        let (jobs, _queued) = AlbumJobs::unstarted();

        let report = report(&collection, &jobs).unwrap();

        let [waiting, a] = &report.albums[..] else {
            panic!("{report:?}")
        };
        assert_eq!(a.palette, Some(Palette::neutral()));
        assert_eq!(a.genre.as_deref(), Some("Alternative"));
        assert_eq!(a.label.as_deref(), Some("XL Recordings"));
        assert_eq!(
            (&waiting.palette, &waiting.genre, &waiting.label),
            (&None, &None, &None)
        );
    }

    #[test]
    fn a_failed_step_shows_why() {
        assert_eq!(
            step_row(Step::Sizes, StepStatus::Failed("Deezer replied 404".into())),
            StepRow {
                step: "Sizes".into(),
                status: "Failed".into(),
                error: Some("Deezer replied 404".into()),
            }
        );
        assert_eq!(
            step_row(Step::Lookup, StepStatus::NotStarted).status,
            "Not started"
        );
    }

    /// The JSON `app/src/ArtworkReport.tsx` expects. Change both together.
    #[test]
    fn the_artwork_report_serialises_as_the_ui_expects() {
        let report = ArtworkReport {
            albums: vec![ArtworkRow {
                id: "a".into(),
                title: "A".into(),
                artist: "Radiohead".into(),
                source: "iTunes".into(),
                url: Some("https://itunes/a".into()),
                width: Some(4000),
                height: Some(3998),
                palette: Some(Palette::neutral()),
                genre: Some("Alternative".into()),
                label: None,
                steps: vec![
                    StepRow {
                        step: "Lookup".into(),
                        status: "Done".into(),
                        error: None,
                    },
                    StepRow {
                        step: "Sizes".into(),
                        status: "Failed".into(),
                        error: Some("iTunes replied 404 Not Found".into()),
                    },
                ],
            }],
            totals: vec![ArtworkTotal {
                source: "iTunes".into(),
                albums: 1,
            }],
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({
                "albums": [{
                    "id": "a", "title": "A", "artist": "Radiohead", "source": "iTunes",
                    "url": "https://itunes/a", "width": 4000, "height": 3998,
                    "palette": {
                        "key": ["#463c32", "#28221e", "#5a4e40"],
                        "ground": "#1e1a16", "rear": "#181512", "ink": "#eee6d6",
                        "muted": "#b0a696", "accent": "#c8aa78", "dark": true,
                        "deep": "#100d0b",
                    },
                    "genre": "Alternative", "label": null,
                    "steps": [
                        {"step": "Lookup", "status": "Done", "error": null},
                        {
                            "step": "Sizes", "status": "Failed",
                            "error": "iTunes replied 404 Not Found",
                        },
                    ],
                }],
                "totals": [{"source": "iTunes", "albums": 1}],
            })
        );
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
                spotify_id: GONE.into(),
                message: "m".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({"restored": 1, "failed": [{"spotifyId": GONE, "message": "m"}]})
        );
    }

    fn by(id: &str, title: &str, artist: &str) -> deadwax_core::collection::Album {
        deadwax_core::collection::Album {
            artist: artist.into(),
            ..album(id, title)
        }
    }

    #[test]
    fn importing_matches_the_prototypes_essays_to_albums_by_title_and_artist() {
        let root = tempfile::tempdir().unwrap();
        let notes = NotesDir::new(root.path().join("notes"));
        let mut collection = Collection::open_in_memory().unwrap();
        let mut add = |id: &str, title: &str, artist: &str| {
            collection
                .add(&by(id, title, artist), day(1))
                .unwrap()
                .id()
                .clone()
        };
        let pink_moon = add("pink", "Pink Moon", "Nick Drake");
        // Spotify's titles and artists, not quite the essays'.
        let in_rainbows = add("rainbows", "In Rainbows (Remastered)", "Radiohead");
        let mixing = add("mixing", "Mixing Colours", "Roger Eno, Brian Eno");
        add("ok", "OK Computer", "Radiohead");
        let collection = std::sync::Mutex::new(collection);

        let import = import_notes(&prototype_notes(), &collection, &notes).unwrap();

        let mut imported: Vec<_> = import.imported.iter().map(|i| i.id.clone()).collect();
        imported.sort();
        let mut expected = vec![pink_moon.clone(), in_rainbows.clone(), mixing.clone()];
        expected.sort();
        assert_eq!(imported, expected);
        let mut unmatched: Vec<_> = import
            .unmatched
            .iter()
            .map(|u| (u.file.as_str(), u.album_title.as_str(), u.artist.as_str()))
            .collect();
        unmatched.sort();
        assert_eq!(
            unmatched,
            [
                ("blue.json", "Blue", "Joni Mitchell"),
                (
                    "music-has-the-right-to-children.json",
                    "Music Has the Right to Children",
                    "Boards of Canada"
                ),
            ]
        );
        assert!(import.invalid.is_empty());
        // Each is now that album's notes, as the gatefold reads them.
        assert_eq!(
            notes.read(&pink_moon).unwrap().unwrap().headline,
            "Eleven Songs After Midnight"
        );
        assert_eq!(
            notes.read(&in_rainbows).unwrap().unwrap().album_title,
            "In Rainbows"
        );
        assert_eq!(notes.files().unwrap().len(), 3);
    }

    #[test]
    fn importing_every_prototype_essay_checks_each_against_the_schema() {
        let root = tempfile::tempdir().unwrap();
        let mut collection = Collection::open_in_memory().unwrap();
        for (n, (title, artist)) in [
            ("In Rainbows", "Radiohead"),
            ("Blue", "Joni Mitchell"),
            ("Pink Moon", "Nick Drake"),
            ("Mixing Colours", "Roger Eno, Brian Eno"),
            ("Music Has the Right to Children", "Boards of Canada"),
        ]
        .into_iter()
        .enumerate()
        {
            collection
                .add(&by(&n.to_string(), title, artist), day(1))
                .unwrap();
        }
        let collection = std::sync::Mutex::new(collection);

        let import = import_notes(
            &prototype_notes(),
            &collection,
            &NotesDir::new(root.path().join("notes")),
        )
        .unwrap();

        assert_eq!(import.imported.len(), 5);
        assert!(import.unmatched.is_empty() && import.invalid.is_empty());
    }

    #[test]
    fn importing_reports_a_file_that_isnt_notes_and_imports_the_rest() {
        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("prototype");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::copy(
            prototype_notes().join("pink-moon.json"),
            from.join("pink-moon.json"),
        )
        .unwrap();
        std::fs::write(from.join("broken.json"), r#"{ "albumTitle": "Blue" }"#).unwrap();
        let mut collection = Collection::open_in_memory().unwrap();
        collection
            .add(&by("pink", "Pink Moon", "Nick Drake"), day(1))
            .unwrap();
        let collection = std::sync::Mutex::new(collection);

        let import = import_notes(
            &from,
            &collection,
            &NotesDir::new(root.path().join("notes")),
        )
        .unwrap();

        assert_eq!(import.imported.len(), 1);
        assert_eq!(import.invalid.len(), 1);
        assert_eq!(import.invalid[0].file, "broken.json");
        assert!(
            import.invalid[0]
                .message
                .starts_with("It isn't valid liner notes: missing field"),
            "{}",
            import.invalid[0].message
        );
    }

    #[test]
    fn importing_from_a_folder_with_no_notes_says_so() {
        let root = tempfile::tempdir().unwrap();
        let collection = std::sync::Mutex::new(Collection::open_in_memory().unwrap());
        let notes = NotesDir::new(root.path().join("notes"));

        let error = import_notes(&root.path().join("nowhere"), &collection, &notes).unwrap_err();

        assert!(
            error.starts_with("There are no notes to import in "),
            "{error}"
        );
    }

    #[test]
    fn the_notes_report_says_what_is_wrong_with_each_file() {
        let root = tempfile::tempdir().unwrap();
        let notes = NotesDir::new(root.path().join("notes"));
        let mut collection = Collection::open_in_memory().unwrap();
        let pink_moon = collection
            .add(&by("pink", "Pink Moon", "Nick Drake"), day(1))
            .unwrap()
            .id()
            .clone();
        let blue = collection
            .add(&by("blue", "Blue", "Joni Mitchell"), day(1))
            .unwrap()
            .id()
            .clone();
        let essay = std::fs::read_to_string(prototype_notes().join("pink-moon.json")).unwrap();
        notes
            .write(&pink_moon, &notes::parse(&essay).unwrap())
            .unwrap();
        std::fs::write(notes.path().join(format!("{blue}.json")), "{").unwrap();
        notes
            .write(&AlbumId::from("gone"), &notes::parse(&essay).unwrap())
            .unwrap();

        let report = report_notes(&notes, &collection).unwrap();

        assert_eq!(report.folder, notes.path().display().to_string());
        let row = |id: &AlbumId| {
            report
                .files
                .iter()
                .find(|r| r.file == format!("{id}.json"))
                .unwrap()
        };
        assert_eq!(row(&pink_moon).problem, None);
        assert_eq!(row(&pink_moon).title.as_deref(), Some("Pink Moon"));
        assert!(
            row(&blue)
                .problem
                .as_deref()
                .unwrap()
                .starts_with("It isn't valid liner notes:")
        );
        assert_eq!(row(&blue).title.as_deref(), Some("Blue"));
        assert_eq!(row(&"gone".into()).problem.as_deref(), Some(NO_SUCH_ALBUM));
        assert_eq!(row(&"gone".into()).id, None);
    }

    /// The JSON `app/src/NotesReport.tsx` expects. Change both together.
    #[test]
    fn the_notes_import_and_report_serialise_as_the_ui_expects() {
        let import = NotesImport {
            imported: vec![ImportedNotes {
                id: "a".into(),
                title: "Pink Moon".into(),
                artist: "Nick Drake".into(),
            }],
            unmatched: vec![UnmatchedNotes {
                file: "blue.json".into(),
                album_title: "Blue".into(),
                artist: "Joni Mitchell".into(),
            }],
            invalid: vec![NotesProblem {
                file: "x.json".into(),
                message: "m".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&import).unwrap(),
            json!({
                "imported": [{"id": "a", "title": "Pink Moon", "artist": "Nick Drake"}],
                "unmatched": [{"file": "blue.json", "albumTitle": "Blue", "artist": "Joni Mitchell"}],
                "invalid": [{"file": "x.json", "message": "m"}],
            })
        );
        let report = NotesReport {
            folder: "/notes".into(),
            files: vec![NotesRow {
                file: "a.json".into(),
                id: Some("a".into()),
                title: Some("Pink Moon".into()),
                artist: Some("Nick Drake".into()),
                problem: None,
            }],
        };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({"folder": "/notes", "files": [{
                "file": "a.json", "id": "a", "title": "Pink Moon", "artist": "Nick Drake", "problem": null,
            }]})
        );
    }
}
