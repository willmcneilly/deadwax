//! Looking for each album's high-res cover in the background (DWX-7; RFC-001,
//! "High-res artwork, as an experiment").
//!
//! An album is queued when it's added or restored, and when its page opens
//! without a result yet. One worker takes the queue an album at a time, so
//! the sources' limits are kept however many are queued, and an album queued
//! twice is looked up once. When a result is stored, the UI is told, so an
//! open album page can show it.
//!
//! A failed lookup stores nothing, so the album is looked up again the next
//! time its page opens.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use deadwax_core::collection::Collection;
use deadwax_sources::artwork::Finder;
use deadwax_sources::clock::Clock;
use tokio::sync::mpsc;

/// The event the UI gets, with the album's ID, when its artwork is stored.
pub const ARTWORK_FOUND: &str = "artwork-found";

pub struct ArtworkQueue {
    sender: mpsc::UnboundedSender<String>,
    /// Queued or being looked up now.
    pending: Arc<Mutex<HashSet<String>>>,
}

impl ArtworkQueue {
    /// Starts the worker. `found` is called with each album whose artwork is
    /// stored.
    pub fn start<C: Clock + Clone>(
        finder: Finder<C>,
        collection: Arc<Mutex<Collection>>,
        found: impl Fn(&str) + Send + 'static,
    ) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<String>();
        let pending = Arc::new(Mutex::new(HashSet::new()));
        let worker_pending = pending.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(id) = receiver.recv().await {
                match look_for(&finder, &collection, &id, SystemTime::now()).await {
                    Ok(true) => found(&id),
                    Ok(false) => {}
                    // Nothing is stored, so opening the album tries again.
                    Err(error) => eprintln!("Couldn't look for the artwork for {id}: {error}"),
                }
                worker_pending.lock().expect("pending lock").remove(&id);
            }
        });
        Self { sender, pending }
    }

    /// A queue with no worker, for tests: they read what was queued from the
    /// receiver.
    #[cfg(test)]
    pub fn unstarted() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let queue = Self {
            sender,
            pending: Arc::new(Mutex::new(HashSet::new())),
        };
        (queue, receiver)
    }

    /// What has been queued so far, for tests of an `unstarted` queue.
    #[cfg(test)]
    pub fn queued(receiver: &mut mpsc::UnboundedReceiver<String>) -> Vec<String> {
        std::iter::from_fn(|| receiver.try_recv().ok()).collect()
    }

    /// Queues the album, unless it's already queued.
    pub fn look_for(&self, id: &str) {
        if self
            .pending
            .lock()
            .expect("pending lock")
            .insert(id.to_owned())
        {
            // The worker only stops when the app does.
            let _ = self.sender.send(id.to_owned());
        }
    }

    /// Queues every album in the collection without a result yet. Restoring
    /// from the dev list uses it.
    #[cfg(debug_assertions)]
    pub fn look_for_missing(&self, collection: &Mutex<Collection>) -> Result<(), String> {
        let missing: Vec<String> = collection
            .lock()
            .expect("collection lock")
            .albums()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|collected| collected.artwork.is_none())
            .map(|collected| collected.album.spotify_id)
            .collect();
        for id in missing {
            self.look_for(&id);
        }
        Ok(())
    }
}

/// Looks for the album's artwork and stores it, unless it has some already
/// or has left the collection. Returns whether it stored any.
pub async fn look_for<C: Clock + Clone>(
    finder: &Finder<C>,
    collection: &Mutex<Collection>,
    id: &str,
    now: SystemTime,
) -> Result<bool, String> {
    let collected = collection
        .lock()
        .expect("collection lock")
        .get(id)
        .map_err(|e| e.to_string())?;
    let Some(collected) = collected.filter(|c| c.artwork.is_none()) else {
        return Ok(false);
    };
    // The collection isn't locked while we wait on the web.
    let artwork = finder
        .find(&collected.album)
        .await
        .map_err(|e| e.to_string())?;
    collection
        .lock()
        .expect("collection lock")
        .set_artwork(id, &artwork, now)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use deadwax_core::collection::{Album, Artwork, ArtworkSource, Cover};
    use deadwax_sources::artwork::Endpoints;
    use deadwax_sources::clock::SystemClock;
    use serde_json::json;
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    fn album(id: &str) -> Album {
        Album {
            spotify_id: id.into(),
            title: "In Rainbows".into(),
            artist: "Radiohead".into(),
            year: Some(2007),
            tracks: Vec::new(),
            covers: vec![Cover {
                url: format!("https://i.scdn.co/image/{id}"),
                width: Some(640),
                height: Some(640),
            }],
            upc: None,
        }
    }

    /// A finder whose sources find nothing, so every lookup ends with
    /// Spotify's cover.
    async fn finds_nothing(server: &MockServer) -> Finder<SystemClock> {
        Mock::given(method("GET"))
            .and(path_regex("^/(itunes|deezer|mb)/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "results": [], "data": [], "releases": [],
            })))
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

    fn collection(ids: &[&str]) -> Arc<Mutex<Collection>> {
        let mut collection = Collection::open_in_memory().unwrap();
        for id in ids {
            collection.add(&album(id), SystemTime::now()).unwrap();
        }
        Arc::new(Mutex::new(collection))
    }

    fn spotifys(id: &str) -> Artwork {
        Artwork {
            source: ArtworkSource::Spotify,
            cover: album(id).covers.into_iter().next(),
        }
    }

    #[tokio::test]
    async fn stores_what_it_finds() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let collection = collection(&["a"]);

        assert_eq!(
            look_for(&finder, &collection, "a", SystemTime::now()).await,
            Ok(true)
        );

        let artwork = collection
            .lock()
            .unwrap()
            .get("a")
            .unwrap()
            .unwrap()
            .artwork;
        assert_eq!(artwork, Some(spotifys("a")));
    }

    #[tokio::test]
    async fn an_album_with_a_result_isnt_looked_up_again() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let collection = collection(&["a"]);
        look_for(&finder, &collection, "a", SystemTime::now())
            .await
            .unwrap();
        let asked = server.received_requests().await.unwrap().len();

        assert_eq!(
            look_for(&finder, &collection, "a", SystemTime::now()).await,
            Ok(false)
        );
        assert_eq!(server.received_requests().await.unwrap().len(), asked);
    }

    #[tokio::test]
    async fn an_album_not_in_the_collection_isnt_looked_up() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let collection = collection(&[]);

        assert_eq!(
            look_for(&finder, &collection, "a", SystemTime::now()).await,
            Ok(false)
        );
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
        let collection = collection(&["a"]);

        assert!(
            look_for(&finder, &collection, "a", SystemTime::now())
                .await
                .is_err()
        );
        let artwork = collection
            .lock()
            .unwrap()
            .get("a")
            .unwrap()
            .unwrap()
            .artwork;
        assert_eq!(artwork, None);
    }

    #[test]
    fn an_album_already_queued_isnt_queued_again() {
        let (queue, mut receiver) = ArtworkQueue::unstarted();

        queue.look_for("a");
        queue.look_for("b");
        queue.look_for("a");

        assert_eq!(ArtworkQueue::queued(&mut receiver), ["a", "b"]);
    }

    #[test]
    fn queues_only_the_albums_without_a_result() {
        let collection = collection(&["a", "b"]);
        collection
            .lock()
            .unwrap()
            .set_artwork("a", &spotifys("a"), SystemTime::now())
            .unwrap();
        let (queue, mut receiver) = ArtworkQueue::unstarted();

        queue.look_for_missing(&collection).unwrap();

        assert_eq!(ArtworkQueue::queued(&mut receiver), ["b"]);
    }

    #[tokio::test]
    async fn the_queue_looks_up_albums_in_the_background_and_says_so() {
        let server = MockServer::start().await;
        let finder = finds_nothing(&server).await;
        let collection = collection(&["a", "b"]);
        let (tell, mut told) = mpsc::unbounded_channel();
        let queue = ArtworkQueue::start(finder, collection.clone(), move |id| {
            tell.send(id.to_owned()).unwrap();
        });

        queue.look_for("a");
        queue.look_for("a");
        queue.look_for_missing(&collection).unwrap();

        let mut found = Vec::new();
        for _ in 0..2 {
            let id = tokio::time::timeout(Duration::from_secs(10), told.recv())
                .await
                .unwrap()
                .unwrap();
            found.push(id);
        }
        found.sort();
        assert_eq!(found, ["a", "b"]);
        let collection = collection.lock().unwrap();
        for id in ["a", "b"] {
            let artwork = collection.get(id).unwrap().unwrap().artwork;
            assert_eq!(artwork, Some(spotifys(id)));
        }
    }
}
