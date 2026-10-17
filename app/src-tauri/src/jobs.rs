//! The album job queue: the work each album needs after it's added, done in
//! the background, one album at a time (RFC-002, "2. Local artwork, in
//! sizes"). It grew out of DWX-7's artwork queue.
//!
//! An album's steps run in order (`Step::ALL`):
//! 1. **Lookup:** find its sharpest cover (DWX-7).
//! 2. **Sizes:** download that cover and keep it on disk in sizes
//!    (`deadwax_core::covers`), which `cover://` serves.
//! 3. **Palette:** work out its colours from the 320 (`deadwax_core::palette`,
//!    DWX-19). An album with no cover anywhere gets the neutral palette.
//! 4. **Genre and label:** from iTunes and MusicBrainz, reusing the lookup's
//!    replies when it has just run (DWX-19).
//!
//! Each album records which steps it has finished. A step is recorded with
//! its result, so a failed step stores nothing, and the album stops there
//! and runs again later: after `RETRY_AFTER`, when its page opens, or at the
//! next launch, which queues every album with steps left. That's also how
//! albums from before the queue, or from before a step was added, catch up.
//!
//! One worker takes the queue an album at a time, so the sources' limits are
//! kept however many are queued, and an album queued twice runs once. When
//! an album's cover is on disk, or its palette, genre and label are stored,
//! the UI is told, so it updates in place.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use deadwax_core::collection::{AlbumId, Collected, Collection, Step};
use deadwax_core::covers::{self, Size, Store};
use deadwax_core::palette::{self, Palette};
use deadwax_sources::artwork::Finder;
use deadwax_sources::clock::Clock;
use tokio::sync::mpsc;

/// The event the UI gets, with the album's Deadwax ID, when what it shows
/// for the album has changed: its cover is on disk, or its palette, genre
/// and label are stored.
pub const ALBUM_UPDATED: &str = "album-updated";

/// How long a failed album waits before it's queued again. A network blip
/// mends itself; a cover that's gone for good costs one try this often.
pub const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

/// Where an album's step stands, for the Develop menu's report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepStatus {
    Done,
    /// The album is queued, or running now.
    Queued,
    /// The step failed the last time the album ran, and will run again.
    Failed(String),
    /// An earlier step hasn't finished, and the album isn't queued.
    NotStarted,
}

/// A step that failed, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobError {
    pub step: Step,
    pub message: String,
}

/// What the worker and the queue's users share.
#[derive(Clone)]
struct Queue {
    sender: mpsc::UnboundedSender<AlbumId>,
    /// Queued or running now.
    pending: Arc<Mutex<HashSet<AlbumId>>>,
    /// Each album's failed step, from its last run.
    failures: Arc<Mutex<HashMap<AlbumId, JobError>>>,
}

impl Queue {
    fn new() -> (Self, mpsc::UnboundedReceiver<AlbumId>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let queue = Self {
            sender,
            pending: Arc::default(),
            failures: Arc::default(),
        };
        (queue, receiver)
    }

    fn queue(&self, id: &AlbumId) {
        if self
            .pending
            .lock()
            .expect("pending lock")
            .insert(id.clone())
        {
            // The worker only stops when the app does.
            let _ = self.sender.send(id.clone());
        }
    }
}

pub struct AlbumJobs {
    queue: Queue,
}

impl AlbumJobs {
    /// Starts the worker, and queues every album in the collection with
    /// steps left, so albums from before the queue (or whose steps failed
    /// last time) catch up. `updated` is called with each album whose cover
    /// is now on disk. A failed album is queued again after `retry_after`.
    pub fn start<C: Clock + Clone>(
        finder: Finder<C>,
        collection: Arc<Mutex<Collection>>,
        covers: Store,
        retry_after: Duration,
        updated: impl Fn(&AlbumId) + Send + 'static,
    ) -> Result<Self, String> {
        let (queue, mut receiver) = Queue::new();
        let worker = queue.clone();
        let waiting = collection.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(id) = receiver.recv().await {
                let outcome = run(&finder, &collection, &covers, &id, SystemTime::now()).await;
                let mut failures = worker.failures.lock().expect("failures lock");
                match outcome {
                    Ok(changed) => {
                        failures.remove(&id);
                        if changed {
                            updated(&id);
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "Couldn't finish {}'s {} step: {}",
                            id,
                            error.step.as_str(),
                            error.message
                        );
                        failures.insert(id.clone(), error);
                        let retry = worker.clone();
                        let id = id.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(retry_after).await;
                            retry.queue(&id);
                        });
                    }
                }
                drop(failures);
                worker.pending.lock().expect("pending lock").remove(&id);
            }
        });
        let jobs = Self { queue };
        jobs.queue_unfinished(&waiting)?;
        Ok(jobs)
    }

    /// A queue with no worker, for tests: they read what was queued from the
    /// receiver.
    #[cfg(test)]
    pub fn unstarted() -> (Self, mpsc::UnboundedReceiver<AlbumId>) {
        let (queue, receiver) = Queue::new();
        (Self { queue }, receiver)
    }

    /// What has been queued so far, for tests of an `unstarted` queue.
    #[cfg(test)]
    pub fn queued(receiver: &mut mpsc::UnboundedReceiver<AlbumId>) -> Vec<AlbumId> {
        std::iter::from_fn(|| receiver.try_recv().ok()).collect()
    }

    /// Queues the album, unless it's already queued.
    pub fn queue(&self, id: &AlbumId) {
        self.queue.queue(id);
    }

    /// Queues every album in the collection with steps left. Starting and
    /// restoring from the dev list use it.
    pub fn queue_unfinished(&self, collection: &Mutex<Collection>) -> Result<(), String> {
        let unfinished: Vec<AlbumId> = collection
            .lock()
            .expect("collection lock")
            .albums()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|collected| !collected.unfinished().is_empty())
            .map(|collected| collected.id)
            .collect();
        for id in unfinished {
            self.queue(&id);
        }
        Ok(())
    }

    /// Where each of the album's steps stands.
    pub fn statuses(&self, collected: &Collected) -> Vec<(Step, StepStatus)> {
        let pending = self
            .queue
            .pending
            .lock()
            .expect("pending lock")
            .contains(&collected.id);
        let failure = self
            .queue
            .failures
            .lock()
            .expect("failures lock")
            .get(&collected.id)
            .cloned();
        Step::ALL
            .into_iter()
            .map(|step| {
                let status = if collected.finished.contains(&step) {
                    StepStatus::Done
                } else if pending {
                    StepStatus::Queued
                } else {
                    match &failure {
                        Some(failed) if failed.step == step => {
                            StepStatus::Failed(failed.message.clone())
                        }
                        _ => StepStatus::NotStarted,
                    }
                };
                (step, status)
            })
            .collect()
    }
}

/// Runs the album's unfinished steps in order, stopping at the first that
/// fails, or if the album leaves the collection. Returns whether what the
/// UI shows has changed: its cover is now on disk, or its palette, genre or
/// label is stored.
pub async fn run<C: Clock + Clone>(
    finder: &Finder<C>,
    collection: &Mutex<Collection>,
    covers: &Store,
    id: &AlbumId,
    now: SystemTime,
) -> Result<bool, JobError> {
    let mut changed = false;
    for step in Step::ALL {
        let fail = |message: String| JobError { step, message };
        let collected = collection
            .lock()
            .expect("collection lock")
            .get(id)
            .map_err(|e| fail(e.to_string()))?;
        let Some(collected) = collected else {
            return Ok(false);
        };
        if collected.finished.contains(&step) {
            continue;
        }
        let still_there = match step {
            Step::Lookup => look_up(finder, collection, &collected, now).await,
            Step::Sizes => make_sizes(finder, collection, covers, &collected, now).await,
            Step::Palette => make_palette(collection, covers, &collected, now).await,
            Step::GenreAndLabel => find_genre_and_label(finder, collection, &collected, now).await,
        }
        .map_err(fail)?;
        if !still_there {
            return Ok(false);
        }
        changed |= match step {
            Step::Lookup => false,
            Step::Sizes => collected.artwork.is_some_and(|a| a.cover.is_some()),
            Step::Palette | Step::GenreAndLabel => true,
        };
    }
    Ok(changed)
}

/// Looks for the album's sharpest cover and stores it. Returns whether the
/// album was still in the collection. The collection isn't locked while we
/// wait on the web.
async fn look_up<C: Clock + Clone>(
    finder: &Finder<C>,
    collection: &Mutex<Collection>,
    collected: &Collected,
    now: SystemTime,
) -> Result<bool, String> {
    let artwork = finder
        .find(&collected.album)
        .await
        .map_err(|e| e.to_string())?;
    collection
        .lock()
        .expect("collection lock")
        .set_artwork(&collected.id, &artwork, now)
        .map_err(|e| e.to_string())
}

/// Downloads the cover the lookup found, saves its sizes and records the
/// step. An album whose lookup found no cover at all finishes with nothing
/// to make. Returns whether the album was still in the collection: if it
/// was removed meanwhile, the sizes just saved are deleted again.
async fn make_sizes<C: Clock + Clone>(
    finder: &Finder<C>,
    collection: &Mutex<Collection>,
    covers: &Store,
    collected: &Collected,
    now: SystemTime,
) -> Result<bool, String> {
    let id = &collected.id;
    let found = collected
        .artwork
        .as_ref()
        .and_then(|artwork| Some((artwork.source, artwork.cover.as_ref()?)));
    if let Some((source, cover)) = found {
        let image = finder
            .download(source, cover)
            .await
            .map_err(|e| e.to_string())?;
        // Decoding and resizing is a few hundred milliseconds of work.
        let renditions = tokio::task::spawn_blocking(move || covers::make(&image))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        covers.save(id, &renditions).map_err(|e| e.to_string())?;
    }
    let recorded = collection
        .lock()
        .expect("collection lock")
        .finish(id, Step::Sizes, now);
    if !matches!(recorded, Ok(true)) {
        covers.remove(id).map_err(|e| e.to_string())?;
    }
    recorded.map_err(|e| e.to_string())
}

/// Works out the album's palette from its 320 and stores it. An album with
/// no cover on disk gets the neutral palette. Returns whether the album was
/// still in the collection.
async fn make_palette(
    collection: &Mutex<Collection>,
    covers: &Store,
    collected: &Collected,
    now: SystemTime,
) -> Result<bool, String> {
    let palette = if collected.has_local_cover() {
        let file = covers
            .file(&collected.id, Size::Small)
            .ok_or_else(|| "its 320 isn't on disk".to_owned())?;
        // Reading a 320 is a few milliseconds of work.
        tokio::task::spawn_blocking(move || {
            let image = std::fs::read(&file).map_err(|e| e.to_string())?;
            palette::of_image(&image).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??
    } else {
        Palette::neutral()
    };
    collection
        .lock()
        .expect("collection lock")
        .set_palette(&collected.id, &palette, now)
        .map_err(|e| e.to_string())
}

/// Looks for the album's genre and label and stores them. Returns whether
/// the album was still in the collection. The collection isn't locked while
/// we wait on the web.
async fn find_genre_and_label<C: Clock + Clone>(
    finder: &Finder<C>,
    collection: &Mutex<Collection>,
    collected: &Collected,
    now: SystemTime,
) -> Result<bool, String> {
    let found = finder
        .genre_and_label(&collected.album)
        .await
        .map_err(|e| e.to_string())?;
    collection
        .lock()
        .expect("collection lock")
        .set_genre_and_label(&collected.id, &found, now)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use deadwax_core::collection::{Album, Artwork, ArtworkSource, Cover, GenreAndLabel};
    use deadwax_core::covers::{Size, testing};
    use deadwax_sources::artwork::Endpoints;
    use deadwax_sources::clock::SystemClock;
    use serde_json::json;
    use wiremock::matchers::{method, path, path_regex, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    /// An album whose Spotify cover is `image` on the fake server.
    fn album(spotify_id: &str, server: &MockServer, image: &str) -> Album {
        Album {
            spotify_id: spotify_id.into(),
            title: "In Rainbows".into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            tracks: Vec::new(),
            covers: vec![Cover {
                url: format!("{}/images/{image}", server.uri()),
                width: Some(640),
                height: Some(640),
            }],
            upc: None,
        }
    }

    /// A finder whose sources find nothing, so every lookup ends with
    /// Spotify's cover, and a fake image server with a 640-pixel cover at
    /// `/images/cover.jpg`.
    async fn finds_nothing(server: &MockServer) -> Finder<SystemClock> {
        Mock::given(method("GET"))
            .and(path_regex("^/(itunes|deezer|mb)/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [], "data": [], "releases": [],
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/images/cover.jpg"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(testing::jpeg(640, 640)))
            .mount(server)
            .await;
        Finder::new(
            SystemClock,
            Endpoints {
                itunes: format!("{}/itunes", server.uri()),
                deezer: format!("{}/deezer", server.uri()),
                musicbrainz: format!("{}/mb", server.uri()),
                cover_art_archive: format!("{}/caa", server.uri()),
            },
        )
    }

    /// A collection of the albums with these Spotify IDs, whose covers are
    /// `image` on the fake server, and their Deadwax IDs in the same order.
    fn collection(
        server: &MockServer,
        image: &str,
        spotify_ids: &[&str],
    ) -> (Arc<Mutex<Collection>>, Vec<AlbumId>) {
        let mut collection = Collection::open_in_memory().unwrap();
        let ids = spotify_ids
            .iter()
            .map(|id| {
                let added = collection
                    .add(&album(id, server, image), SystemTime::now())
                    .unwrap();
                added.id().clone()
            })
            .collect();
        (Arc::new(Mutex::new(collection)), ids)
    }

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("artwork"));
        (dir, store)
    }

    fn get(collection: &Mutex<Collection>, id: &AlbumId) -> Collected {
        collection.lock().unwrap().get(id).unwrap().unwrap()
    }

    /// A JPEG's pixel size. Making sizes from it never enlarges it, so its
    /// master is its own size.
    fn pixels(path: &Path) -> (u32, u32) {
        let renditions = covers::make(&std::fs::read(path).unwrap()).unwrap();
        let master = renditions.get(Size::Master).unwrap();
        (master.width, master.height)
    }

    #[tokio::test]
    async fn runs_the_lookup_then_makes_the_sizes_from_what_it_found() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a"]);
        let (_dir, covers) = store();

        let changed = run(&finder, &collection, &covers, &ids[0], SystemTime::now()).await;

        assert_eq!(changed, Ok(true));
        let a = get(&collection, &ids[0]);
        assert_eq!(a.finished, Step::ALL);
        assert_eq!(a.artwork.as_ref().unwrap().source, ArtworkSource::Spotify);
        assert!(a.has_local_cover());
        assert_eq!(
            pixels(&covers.file(&ids[0], Size::Small).unwrap()),
            (320, 320)
        );
        assert_eq!(
            pixels(&covers.file(&ids[0], Size::Medium).unwrap()),
            (640, 640)
        );
        // Spotify's 640 isn't enlarged.
        assert_eq!(
            pixels(&covers.file(&ids[0], Size::Large).unwrap()),
            (640, 640)
        );
        assert_eq!(
            pixels(&covers.file(&ids[0], Size::Master).unwrap()),
            (640, 640)
        );
        let downloads = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|request| request.url.path() == "/images/cover.jpg")
            .count();
        assert_eq!(downloads, 1);
    }

    #[tokio::test]
    async fn a_finished_album_isnt_run_again() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a"]);
        let (_dir, covers) = store();
        run(&finder, &collection, &covers, &ids[0], SystemTime::now())
            .await
            .unwrap();
        let asked = server.received_requests().await.unwrap().len();

        let changed = run(&finder, &collection, &covers, &ids[0], SystemTime::now()).await;

        assert_eq!(changed, Ok(false));
        assert_eq!(server.received_requests().await.unwrap().len(), asked);
    }

    #[tokio::test]
    async fn an_album_with_its_lookup_done_only_makes_its_sizes() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "nothing-here.jpg", &["a"]);
        let (_dir, covers) = store();
        let itunes = Artwork {
            source: ArtworkSource::Itunes,
            cover: Some(Cover {
                url: format!("{}/images/cover.jpg", server.uri()),
                width: None,
                height: None,
            }),
        };
        collection
            .lock()
            .unwrap()
            .set_artwork(&ids[0], &itunes, SystemTime::now())
            .unwrap();

        run(&finder, &collection, &covers, &ids[0], SystemTime::now())
            .await
            .unwrap();

        let paths: Vec<String> = server
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .map(|request| request.url.path().to_owned())
            .collect();
        assert_eq!(paths, ["/images/cover.jpg"]);
        assert!(covers.file(&ids[0], Size::Small).is_some());
    }

    #[tokio::test]
    async fn an_album_not_in_the_collection_isnt_run() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, _) = collection(&server, "cover.jpg", &[]);
        let (_dir, covers) = store();

        let changed = run(
            &finder,
            &collection,
            &covers,
            &AlbumId::new(),
            SystemTime::now(),
        )
        .await;

        assert_eq!(changed, Ok(false));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_lookup_stores_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/itunes/search"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a"]);
        let (dir, covers) = store();

        let result = run(&finder, &collection, &covers, &ids[0], SystemTime::now()).await;

        assert_eq!(result.unwrap_err().step, Step::Lookup);
        let a = get(&collection, &ids[0]);
        assert_eq!(a.artwork, None);
        assert_eq!(a.finished, []);
        assert!(!dir.path().join("artwork").exists());
    }

    #[tokio::test]
    async fn a_failed_download_stores_nothing_but_keeps_the_lookup() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/images/gone.jpg"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "gone.jpg", &["a"]);
        let (dir, covers) = store();

        let result = run(&finder, &collection, &covers, &ids[0], SystemTime::now()).await;

        assert_eq!(result.unwrap_err().step, Step::Sizes);
        let a = get(&collection, &ids[0]);
        assert_eq!(a.finished, [Step::Lookup]);
        assert!(!a.has_local_cover());
        assert!(!dir.path().join("artwork").exists());
    }

    #[tokio::test]
    async fn a_download_that_isnt_an_image_stores_nothing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/images/page.jpg"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>Moved</html>"))
            .mount(&server)
            .await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "page.jpg", &["a"]);
        let (dir, covers) = store();

        let result = run(&finder, &collection, &covers, &ids[0], SystemTime::now()).await;

        assert_eq!(result.unwrap_err().step, Step::Sizes);
        assert_eq!(get(&collection, &ids[0]).finished, [Step::Lookup]);
        assert!(!dir.path().join("artwork").exists());
    }

    #[tokio::test]
    async fn an_album_with_no_cover_anywhere_finishes_with_nothing_to_make() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let mut collection = Collection::open_in_memory().unwrap();
        let mut coverless = album("a", &server, "cover.jpg");
        coverless.covers.clear();
        let id = collection
            .add(&coverless, SystemTime::now())
            .unwrap()
            .id()
            .clone();
        let collection = Mutex::new(collection);
        let (dir, covers) = store();

        let changed = run(&finder, &collection, &covers, &id, SystemTime::now()).await;

        // Its palette and genre and label are stored, which the UI shows.
        assert_eq!(changed, Ok(true));
        let a = get(&collection, &id);
        assert_eq!(a.unfinished(), []);
        assert!(!a.has_local_cover());
        assert!(!dir.path().join("artwork").exists());
        assert_eq!(a.palette, Some(Palette::neutral()));
        assert_eq!(a.genre_and_label, Some(GenreAndLabel::default()));
    }

    #[tokio::test]
    async fn an_album_removed_while_its_sizes_are_made_leaves_no_folder() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a"]);
        let (dir, covers) = store();
        let artwork = Artwork {
            source: ArtworkSource::Spotify,
            cover: album("a", &server, "cover.jpg").covers.pop(),
        };
        collection
            .lock()
            .unwrap()
            .set_artwork(&ids[0], &artwork, SystemTime::now())
            .unwrap();
        let before_removal = get(&collection, &ids[0]);
        collection.lock().unwrap().remove(&ids[0]).unwrap();

        let still_there = make_sizes(
            &finder,
            &collection,
            &covers,
            &before_removal,
            SystemTime::now(),
        )
        .await;

        assert_eq!(still_there, Ok(false));
        assert!(!dir.path().join("artwork").join(ids[0].as_str()).exists());
    }

    #[test]
    fn an_album_already_queued_isnt_queued_again() {
        let (jobs, mut receiver) = AlbumJobs::unstarted();
        let (a, b) = (AlbumId::new(), AlbumId::new());

        jobs.queue(&a);
        jobs.queue(&b);
        jobs.queue(&a);

        assert_eq!(AlbumJobs::queued(&mut receiver), [a, b]);
    }

    #[tokio::test]
    async fn queues_only_the_albums_with_steps_left() {
        let server = MockServer::start().await;
        let (collection, ids) = collection(&server, "cover.jpg", &["done", "half", "new"]);
        {
            let mut collection = collection.lock().unwrap();
            let spotifys = Artwork {
                source: ArtworkSource::Spotify,
                cover: None,
            };
            for id in &ids[..2] {
                collection
                    .set_artwork(id, &spotifys, SystemTime::now())
                    .unwrap();
            }
            for step in [Step::Sizes, Step::Palette, Step::GenreAndLabel] {
                collection.finish(&ids[0], step, SystemTime::now()).unwrap();
            }
        }
        let (jobs, mut receiver) = AlbumJobs::unstarted();

        jobs.queue_unfinished(&collection).unwrap();

        let mut queued = AlbumJobs::queued(&mut receiver);
        queued.sort();
        let mut expected = ids[1..].to_vec();
        expected.sort();
        assert_eq!(queued, expected);
    }

    #[tokio::test]
    async fn statuses_say_which_steps_are_done_queued_failed_or_not_started() {
        let server = MockServer::start().await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a"]);
        let (jobs, _receiver) = AlbumJobs::unstarted();
        let a = || get(&collection, &ids[0]);
        use StepStatus::*;

        assert_eq!(
            jobs.statuses(&a()),
            Step::ALL.map(|step| (step, NotStarted))
        );

        jobs.queue(&ids[0]);
        assert_eq!(jobs.statuses(&a()), Step::ALL.map(|step| (step, Queued)));

        jobs.queue.pending.lock().unwrap().clear();
        collection
            .lock()
            .unwrap()
            .set_artwork(
                &ids[0],
                &Artwork {
                    source: ArtworkSource::Spotify,
                    cover: None,
                },
                SystemTime::now(),
            )
            .unwrap();
        jobs.queue.failures.lock().unwrap().insert(
            ids[0].clone(),
            JobError {
                step: Step::Sizes,
                message: "Spotify replied 404 Not Found".into(),
            },
        );
        assert_eq!(
            jobs.statuses(&a()),
            [
                (Step::Lookup, Done),
                (Step::Sizes, Failed("Spotify replied 404 Not Found".into())),
                (Step::Palette, NotStarted),
                (Step::GenreAndLabel, NotStarted),
            ]
        );
    }

    #[tokio::test]
    async fn the_queue_runs_albums_in_the_background_and_says_when_their_covers_are_on_disk() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a", "b"]);
        let (_dir, covers) = store();
        let (tell, mut told) = mpsc::unbounded_channel();
        let jobs = AlbumJobs::start(
            finder,
            collection.clone(),
            covers.clone(),
            RETRY_AFTER,
            move |id| tell.send(id.clone()).unwrap(),
        )
        .unwrap();

        jobs.queue(&ids[0]);
        jobs.queue(&ids[0]);
        jobs.queue_unfinished(&collection).unwrap();

        let mut updated = Vec::new();
        for _ in 0..2 {
            let id = tokio::time::timeout(Duration::from_secs(10), told.recv())
                .await
                .unwrap()
                .unwrap();
            updated.push(id);
        }
        updated.sort();
        let mut expected = ids.clone();
        expected.sort();
        assert_eq!(updated, expected);
        for id in &ids {
            assert!(get(&collection, id).has_local_cover());
            assert!(covers.file(id, Size::Large).is_some());
        }
    }

    #[tokio::test]
    async fn starting_the_queue_catches_up_the_albums_already_waiting() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a", "b"]);
        // One from before the queue, with its lookup done, and one new.
        let spotifys = Artwork {
            source: ArtworkSource::Spotify,
            cover: album("a", &server, "cover.jpg").covers.pop(),
        };
        collection
            .lock()
            .unwrap()
            .set_artwork(&ids[0], &spotifys, SystemTime::now())
            .unwrap();
        let (_dir, covers) = store();
        let (tell, mut told) = mpsc::unbounded_channel();

        // Nothing is queued by hand: starting does it.
        let _jobs = AlbumJobs::start(
            finder,
            collection.clone(),
            covers.clone(),
            RETRY_AFTER,
            move |id| tell.send(id.clone()).unwrap(),
        )
        .unwrap();

        let mut updated = Vec::new();
        for _ in 0..2 {
            let id = tokio::time::timeout(Duration::from_secs(10), told.recv())
                .await
                .unwrap()
                .unwrap();
            updated.push(id);
        }
        updated.sort();
        let mut expected = ids.clone();
        expected.sort();
        assert_eq!(updated, expected);
        for id in &ids {
            assert!(get(&collection, id).has_local_cover());
            assert!(covers.file(id, Size::Small).is_some());
        }
    }

    #[tokio::test]
    async fn a_failed_album_is_tried_again_later() {
        let server = MockServer::start().await;
        // The first download fails; the next works.
        Mock::given(method("GET"))
            .and(path("/images/cover.jpg"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(&server)
            .await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a"]);
        let (_dir, covers) = store();
        let (tell, mut told) = mpsc::unbounded_channel();
        let jobs = AlbumJobs::start(
            finder,
            collection.clone(),
            covers.clone(),
            Duration::from_millis(50),
            move |id| tell.send(id.clone()).unwrap(),
        )
        .unwrap();

        jobs.queue(&ids[0]);

        let id = tokio::time::timeout(Duration::from_secs(10), told.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(id, ids[0]);
        assert!(get(&collection, &ids[0]).has_local_cover());
        assert_eq!(
            jobs.statuses(&get(&collection, &ids[0])),
            Step::ALL.map(|step| (step, StepStatus::Done))
        );
    }

    // The palette, and the genre and label (DWX-19).

    const UPC: &str = "634904032463";

    /// iTunes and MusicBrainz know the album by its barcode.
    async fn genre_and_label_by_barcode(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/itunes/lookup"))
            .and(query_param("upc", UPC))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "resultCount": 1,
                "results": [{
                    "wrapperType": "collection",
                    "artistName": "Radiohead",
                    "collectionName": "In Rainbows",
                    "primaryGenreName": "Alternative",
                    "copyright": "℗ 2007 XL Recordings Ltd",
                }],
            })))
            .with_priority(1)
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/mb/ws/2/release/"))
            .and(query_param("query", format!("barcode:{UPC}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "count": 1,
                "releases": [{
                    "id": "1a33443c-3fff-450f-8298-efbc65659d32",
                    "title": "In Rainbows",
                    "artist-credit": [{"name": "Radiohead"}],
                    "label-info": [{"label": {"name": "XL Recordings"}}],
                }],
            })))
            .with_priority(1)
            .mount(server)
            .await;
    }

    /// A collection of one album with a barcode, whose Spotify cover is
    /// `/images/cover.jpg`.
    fn collection_with_barcode(server: &MockServer) -> (Arc<Mutex<Collection>>, AlbumId) {
        let mut collection = Collection::open_in_memory().unwrap();
        let album = Album {
            upc: Some(UPC.into()),
            ..album("a", server, "cover.jpg")
        };
        let id = collection
            .add(&album, SystemTime::now())
            .unwrap()
            .id()
            .clone();
        (Arc::new(Mutex::new(collection)), id)
    }

    fn requests(paths: Vec<wiremock::Request>) -> Vec<String> {
        paths
            .into_iter()
            .map(|request| request.url.path().to_owned())
            .collect()
    }

    #[tokio::test]
    async fn makes_the_palette_from_the_320_and_finds_the_genre_and_label() {
        let server = MockServer::start().await;
        genre_and_label_by_barcode(&server).await;
        let finder = finds_nothing(&server).await;
        let (collection, id) = collection_with_barcode(&server);
        let (_dir, covers) = store();

        run(&finder, &collection, &covers, &id, SystemTime::now())
            .await
            .unwrap();

        let a = get(&collection, &id);
        assert_eq!(a.finished, Step::ALL);
        let small = std::fs::read(covers.file(&id, Size::Small).unwrap()).unwrap();
        assert_eq!(a.palette, Some(palette::of_image(&small).unwrap()));
        assert_ne!(a.palette, Some(Palette::neutral()));
        assert_eq!(
            a.genre_and_label,
            Some(GenreAndLabel {
                genre: Some("Alternative".into()),
                label: Some("XL Recordings".into()),
            })
        );
        // The genre reused the lookup's iTunes reply.
        let itunes = requests(server.received_requests().await.unwrap())
            .into_iter()
            .filter(|path| path == "/itunes/lookup")
            .count();
        assert_eq!(itunes, 1);
    }

    #[tokio::test]
    async fn an_album_from_before_its_palette_genre_and_label_only_backfills_them() {
        let server = MockServer::start().await;
        genre_and_label_by_barcode(&server).await;
        let finder = finds_nothing(&server).await;
        let (collection, id) = collection_with_barcode(&server);
        let (_dir, covers) = store();
        // Its lookup and sizes were done before DWX-19.
        let artwork = Artwork {
            source: ArtworkSource::Spotify,
            cover: album("a", &server, "cover.jpg").covers.pop(),
        };
        covers
            .save(&id, &covers::make(&testing::jpeg(640, 640)).unwrap())
            .unwrap();
        {
            let mut collection = collection.lock().unwrap();
            collection
                .set_artwork(&id, &artwork, SystemTime::now())
                .unwrap();
            collection
                .finish(&id, Step::Sizes, SystemTime::now())
                .unwrap();
        }
        let (jobs, mut receiver) = AlbumJobs::unstarted();
        jobs.queue_unfinished(&collection).unwrap();
        assert_eq!(AlbumJobs::queued(&mut receiver), [id.clone()]);

        let changed = run(&finder, &collection, &covers, &id, SystemTime::now()).await;

        assert_eq!(changed, Ok(true));
        assert_eq!(
            requests(server.received_requests().await.unwrap()),
            ["/itunes/lookup", "/mb/ws/2/release/"]
        );
        let a = get(&collection, &id);
        assert_eq!(a.finished, Step::ALL);
        assert!(a.palette.is_some());
        assert_eq!(
            a.genre_and_label.unwrap().genre.as_deref(),
            Some("Alternative")
        );
    }

    #[tokio::test]
    async fn a_failed_genre_and_label_keeps_the_cover_and_palette() {
        let server = MockServer::start().await;
        // iTunes has the cover, so the lookup doesn't ask MusicBrainz.
        Mock::given(method("GET"))
            .and(path("/itunes/lookup"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [{
                    "wrapperType": "collection",
                    "artistName": "Radiohead",
                    "collectionName": "In Rainbows",
                    "artworkUrl100": format!("{}/images/cover.jpg", server.uri()),
                    "primaryGenreName": "Alternative",
                }],
            })))
            .with_priority(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/mb/ws/2/release/"))
            .respond_with(ResponseTemplate::new(503))
            .with_priority(1)
            .mount(&server)
            .await;
        let finder = finds_nothing(&server).await;
        let (collection, id) = collection_with_barcode(&server);
        let (_dir, covers) = store();

        let result = run(&finder, &collection, &covers, &id, SystemTime::now()).await;

        assert_eq!(result.unwrap_err().step, Step::GenreAndLabel);
        let a = get(&collection, &id);
        assert_eq!(a.finished, [Step::Lookup, Step::Sizes, Step::Palette]);
        assert!(a.has_local_cover());
        assert!(a.palette.is_some());
        assert_eq!(a.genre_and_label, None);
    }

    #[tokio::test]
    async fn a_320_missing_from_disk_fails_the_palette_step() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let (collection, ids) = collection(&server, "cover.jpg", &["a"]);
        let (_dir, covers) = store();
        {
            let mut collection = collection.lock().unwrap();
            let artwork = Artwork {
                source: ArtworkSource::Spotify,
                cover: album("a", &server, "cover.jpg").covers.pop(),
            };
            collection
                .set_artwork(&ids[0], &artwork, SystemTime::now())
                .unwrap();
            collection
                .finish(&ids[0], Step::Sizes, SystemTime::now())
                .unwrap();
        }

        let result = run(&finder, &collection, &covers, &ids[0], SystemTime::now()).await;

        assert_eq!(result.unwrap_err().step, Step::Palette);
        assert_eq!(get(&collection, &ids[0]).palette, None);
    }
}
