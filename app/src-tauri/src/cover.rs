//! `cover://`, the URL scheme the UI loads covers from (RFC-002, "How the
//! UI loads them"). `cover://localhost/<deadwax-id>/<size>` is one size of
//! the album's cover on disk (`deadwax_core::covers`), so an `<img>` reads
//! it straight from the disk through Rust.
//!
//! We answer it ourselves rather than use Tauri's asset protocol, which
//! sends no caching headers, sniffs each file's type and needs permission
//! to read whole folders. This maps an ID and a size to one file, and
//! serves nothing else: anything it doesn't know is a 404.

use deadwax_core::collection::AlbumId;
use deadwax_core::covers::{Size, Store};
use tauri::http::{Response, StatusCode, header};

/// The scheme's name, as Tauri registers it.
pub const SCHEME: &str = "cover";

/// A size of an album's cover never changes once it's on disk: an album
/// gets new sizes only as a new album, with a new ID. So the web view may
/// keep it for good.
const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// Where the UI loads one size of the album's cover from.
pub fn url(id: &AlbumId, size: Size) -> String {
    format!("{SCHEME}://localhost/{id}/{}", size.as_str())
}

/// The reply to a request for `path` (the URL's path, such as
/// `/<deadwax-id>/320`).
pub fn respond(covers: &Store, path: &str) -> Response<Vec<u8>> {
    let file = path
        .strip_prefix('/')
        .and_then(|rest| rest.split_once('/'))
        .and_then(|(id, size)| Some((AlbumId::from(id), Size::parse(size)?)))
        .and_then(|(id, size)| covers.file(&id, size));
    let Some(jpeg) = file.and_then(|file| std::fs::read(file).ok()) else {
        return not_found();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CACHE_CONTROL, CACHE_CONTROL)
        .body(jpeg)
        .expect("a plain response builds")
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .expect("a plain response builds")
}

#[cfg(test)]
mod tests {
    use deadwax_core::covers::{self, testing};

    use super::*;

    /// A store with one album's sizes, and that album's ID.
    fn store() -> (tempfile::TempDir, Store, AlbumId) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("artwork"));
        let id = AlbumId::new();
        store
            .save(&id, &covers::make(&testing::jpeg(2000, 2000)).unwrap())
            .unwrap();
        (dir, store, id)
    }

    #[test]
    fn the_url_names_the_album_and_the_size() {
        let id = AlbumId::from("6f1c1b8e-0a4f-4c43-9c39-4f2b8e2b3a10");

        assert_eq!(
            url(&id, Size::Small),
            "cover://localhost/6f1c1b8e-0a4f-4c43-9c39-4f2b8e2b3a10/320"
        );
        assert_eq!(
            url(&id, Size::Large),
            "cover://localhost/6f1c1b8e-0a4f-4c43-9c39-4f2b8e2b3a10/1600"
        );
    }

    #[test]
    fn serves_each_size_as_a_jpeg_the_web_view_can_keep() {
        let (_dir, store, id) = store();

        for size in Size::ALL {
            let response = respond(&store, &format!("/{id}/{}", size.as_str()));

            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/jpeg");
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable"
            );
            let on_disk = std::fs::read(store.file(&id, size).unwrap()).unwrap();
            assert_eq!(response.body(), &on_disk);
        }
    }

    #[test]
    fn an_unknown_album_size_or_path_is_a_404() {
        let (_dir, store, id) = store();
        let unknown = AlbumId::new();

        for path in [
            format!("/{unknown}/320"),
            format!("/{id}/321"),
            format!("/{id}/320.jpg"),
            format!("/{id}"),
            format!("/{id}/"),
            format!("/{id}/320/more"),
            format!("/../{id}/320"),
            format!("/{id}/../{id}/320"),
            "/../artwork/320".into(),
            "/..%2F..%2Fetc/320".into(),
            "/".into(),
            String::new(),
        ] {
            let response = respond(&store, &path);

            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
            assert!(response.body().is_empty(), "{path}");
        }
    }

    #[test]
    fn a_path_out_of_the_artwork_folder_is_a_404_even_when_the_file_is_there() {
        let (dir, store, id) = store();
        // A JPEG just outside the artwork folder, where `../` would reach.
        std::fs::write(dir.path().join("320.jpg"), testing::jpeg(10, 10)).unwrap();

        for path in ["/../320".to_owned(), format!("/{id}/../../320")] {
            assert_eq!(respond(&store, &path).status(), StatusCode::NOT_FOUND);
        }
    }
}
