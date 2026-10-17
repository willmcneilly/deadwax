//! Each album's cover, kept on disk in sizes. See RFC-002, "2. Local
//! artwork, in sizes".
//!
//! The best cover found for an album is downloaded once, decoded with the
//! `image` crate and resized with `fast_image_resize`, into JPEGs at 320,
//! 640 and 1600 pixels plus a master capped at 3000. JPEG because WebKit
//! decodes it fastest. A cover smaller than a size isn't enlarged: its file
//! for that size is the cover at its own size.
//!
//! The files live in one folder per album, named by its Deadwax ID, inside
//! the artwork folder (`crate::location::artwork_dir`). A folder is written
//! whole or not at all, and removing an album deletes it.

use std::fs;
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};

use fast_image_resize::{ResizeError, Resizer};
use image::codecs::jpeg::JpegEncoder;
use image::{ImageError, ImageReader, RgbImage};

use crate::collection::AlbumId;

/// The JPEG quality of every size: no visible loss on a cover.
const JPEG_QUALITY: u8 = 90;

/// The sizes kept for each album.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Size {
    /// The grid, and a sleeve at the back of the crate.
    Small,
    /// The front sleeve.
    Medium,
    /// The album page and now playing.
    Large,
    /// The cover as found, capped at 3000 pixels.
    Master,
}

impl Size {
    /// Every size, largest first, the order they're made in.
    pub const ALL: [Size; 4] = [Self::Master, Self::Large, Self::Medium, Self::Small];

    /// Its name in a `cover://` URL.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Small => "320",
            Self::Medium => "640",
            Self::Large => "1600",
            Self::Master => "master",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|size| size.as_str() == name)
    }

    /// The longest edge it's allowed, in pixels.
    pub fn max_edge(self) -> u32 {
        match self {
            Self::Small => 320,
            Self::Medium => 640,
            Self::Large => 1600,
            Self::Master => 3000,
        }
    }

    fn file_name(self) -> String {
        format!("{}.jpg", self.as_str())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CoverError {
    #[error("couldn't read the cover: {0}")]
    Decode(#[from] ImageError),
    #[error("couldn't resize the cover: {0}")]
    Resize(#[from] ResizeError),
    #[error("couldn't save the cover: {0}")]
    Files(#[from] io::Error),
}

/// One size of a cover, as a JPEG.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendition {
    pub size: Size,
    pub width: u32,
    pub height: u32,
    pub jpeg: Vec<u8>,
}

/// Every size of one cover, ready to save.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Renditions(Vec<Rendition>);

impl Renditions {
    pub fn get(&self, size: Size) -> Option<&Rendition> {
        self.0.iter().find(|rendition| rendition.size == size)
    }
}

/// Decodes `image` (a JPEG or PNG, as downloaded) and makes every size.
/// It's a few hundred milliseconds of work for a big cover, so callers off
/// the UI's thread should run it as blocking work.
pub fn make(image: &[u8]) -> Result<Renditions, CoverError> {
    let decoded = ImageReader::new(Cursor::new(image))
        .with_guessed_format()?
        .decode()?
        // Covers with transparency, or in grey, become plain RGB for JPEG.
        .into_rgb8();
    let mut resizer = Resizer::new();
    let mut renditions = Vec::new();
    // Each size is made from the one before, which is quicker than from the
    // master every time and looks the same.
    let mut from = decoded;
    for size in Size::ALL {
        let (width, height) = fit(from.width(), from.height(), size.max_edge());
        if (width, height) != from.dimensions() {
            let mut resized = RgbImage::new(width, height);
            resizer.resize(&from, &mut resized, None)?;
            from = resized;
        }
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY).encode_image(&from)?;
        renditions.push(Rendition {
            size,
            width,
            height,
            jpeg,
        });
    }
    Ok(Renditions(renditions))
}

/// `width` × `height` scaled so its longest edge is at most `max_edge`,
/// keeping its shape. Never larger than it was.
fn fit(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge {
        return (width, height);
    }
    let scale = |edge: u32| {
        let scaled =
            (u64::from(edge) * u64::from(max_edge) + u64::from(longest) / 2) / u64::from(longest);
        u32::try_from(scaled).unwrap_or(max_edge).max(1)
    };
    (scale(width), scale(height))
}

/// The artwork folder: one folder of sizes for each album.
#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// The album's folder. `None` for an ID that isn't one Deadwax makes,
    /// so an ID from outside (a URL, say) can never name another path.
    pub fn folder(&self, id: &AlbumId) -> Option<PathBuf> {
        let parsed = uuid::Uuid::try_parse(id.as_str()).ok()?;
        // Only the form `AlbumId::new` writes: lower case, with hyphens.
        (parsed.to_string() == id.as_str()).then(|| self.dir.join(id.as_str()))
    }

    /// Where one size of the album's cover is, if it has been saved.
    pub fn file(&self, id: &AlbumId, size: Size) -> Option<PathBuf> {
        let path = self.folder(id)?.join(size.file_name());
        path.is_file().then_some(path)
    }

    /// Saves every size of the album's cover, replacing any already there.
    /// The files are written beside the folder first and then moved into
    /// place, so a failure part-way leaves nothing.
    pub fn save(&self, id: &AlbumId, renditions: &Renditions) -> Result<(), CoverError> {
        let folder = self.folder(id).ok_or_else(|| not_an_id(id))?;
        let partial = self.dir.join(format!(".{id}.partial"));
        let written = (|| {
            remove_dir(&partial)?;
            fs::create_dir_all(&partial)?;
            for rendition in &renditions.0 {
                fs::write(partial.join(rendition.size.file_name()), &rendition.jpeg)?;
            }
            remove_dir(&folder)?;
            fs::rename(&partial, &folder)
        })();
        if written.is_err() {
            let _ = remove_dir(&partial);
        }
        Ok(written?)
    }

    /// Deletes the album's folder. Fine if it has none.
    pub fn remove(&self, id: &AlbumId) -> Result<(), CoverError> {
        match self.folder(id) {
            Some(folder) => Ok(remove_dir(&folder)?),
            None => Ok(()),
        }
    }

    /// Deletes every album's folder.
    pub fn clear(&self) -> Result<(), CoverError> {
        Ok(remove_dir(&self.dir)?)
    }
}

fn not_an_id(id: &AlbumId) -> CoverError {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{id:?} isn't a Deadwax ID"),
    )
    .into()
}

/// Removes the folder and everything in it. Fine if it isn't there.
fn remove_dir(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Test images, for this crate's tests and the app's (the `testing`
/// feature).
#[cfg(any(test, feature = "testing"))]
pub mod testing {
    use std::io::Cursor;

    use image::{ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

    /// A `width` × `height` JPEG, with a gradient so it isn't one colour.
    pub fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_fn(width, height, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
        bytes.into_inner()
    }

    /// A `width` × `height` PNG with transparency.
    pub fn png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, _| Rgba([200, 30, 30, (x % 256) as u8]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pixel size of a JPEG, read back from its bytes.
    fn dimensions(jpeg: &[u8]) -> (u32, u32) {
        let image = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).unwrap();
        (image.width(), image.height())
    }

    fn sizes(renditions: &Renditions) -> Vec<(&'static str, (u32, u32))> {
        Size::ALL
            .into_iter()
            .map(|size| {
                let rendition = renditions.get(size).unwrap();
                assert_eq!(
                    dimensions(&rendition.jpeg),
                    (rendition.width, rendition.height)
                );
                (size.as_str(), (rendition.width, rendition.height))
            })
            .collect()
    }

    #[test]
    fn a_big_cover_makes_every_size_and_a_master_capped_at_3000() {
        let renditions = make(&testing::jpeg(4000, 4000)).unwrap();

        assert_eq!(
            sizes(&renditions),
            [
                ("master", (3000, 3000)),
                ("1600", (1600, 1600)),
                ("640", (640, 640)),
                ("320", (320, 320)),
            ]
        );
    }

    #[test]
    fn a_small_cover_isnt_enlarged() {
        let renditions = make(&testing::jpeg(640, 640)).unwrap();

        assert_eq!(
            sizes(&renditions),
            [
                ("master", (640, 640)),
                ("1600", (640, 640)),
                ("640", (640, 640)),
                ("320", (320, 320)),
            ]
        );
    }

    #[test]
    fn a_cover_that_isnt_square_keeps_its_shape() {
        let renditions = make(&testing::jpeg(2000, 1000)).unwrap();

        assert_eq!(
            sizes(&renditions),
            [
                ("master", (2000, 1000)),
                ("1600", (1600, 800)),
                ("640", (640, 320)),
                ("320", (320, 160)),
            ]
        );
    }

    #[test]
    fn a_png_with_transparency_becomes_jpegs() {
        let renditions = make(&testing::png(1200, 1200)).unwrap();

        assert_eq!(sizes(&renditions)[3], ("320", (320, 320)));
    }

    #[test]
    fn something_that_isnt_an_image_is_an_error() {
        assert!(matches!(
            make(b"<html>Not found</html>"),
            Err(CoverError::Decode(_))
        ));
    }

    #[test]
    fn sizes_have_the_names_cover_urls_use() {
        for size in Size::ALL {
            assert_eq!(Size::parse(size.as_str()), Some(size));
        }
        assert_eq!(Size::parse("320"), Some(Size::Small));
        assert_eq!(Size::parse("1600"), Some(Size::Large));
        assert_eq!(Size::parse("999"), None);
    }

    fn store() -> (tempfile::TempDir, Store) {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path().join("artwork"));
        (root, store)
    }

    #[test]
    fn saves_each_size_in_the_albums_folder() {
        let (root, store) = store();
        let id = AlbumId::new();

        store
            .save(&id, &make(&testing::jpeg(800, 800)).unwrap())
            .unwrap();

        let folder = root.path().join("artwork").join(id.as_str());
        let mut files: Vec<String> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        files.sort();
        assert_eq!(files, ["1600.jpg", "320.jpg", "640.jpg", "master.jpg"]);
        let small = store.file(&id, Size::Small).unwrap();
        assert_eq!(small, folder.join("320.jpg"));
        assert_eq!(dimensions(&fs::read(small).unwrap()), (320, 320));
        // Nothing is left beside it.
        assert_eq!(
            fs::read_dir(root.path().join("artwork")).unwrap().count(),
            1
        );
    }

    #[test]
    fn saving_again_replaces_the_sizes() {
        let (_root, store) = store();
        let id = AlbumId::new();
        store
            .save(&id, &make(&testing::jpeg(400, 400)).unwrap())
            .unwrap();

        store
            .save(&id, &make(&testing::jpeg(800, 800)).unwrap())
            .unwrap();

        let master = fs::read(store.file(&id, Size::Master).unwrap()).unwrap();
        assert_eq!(dimensions(&master), (800, 800));
    }

    #[test]
    fn removing_deletes_the_albums_folder_and_only_that() {
        let (root, store) = store();
        let (kept, removed) = (AlbumId::new(), AlbumId::new());
        let renditions = make(&testing::jpeg(400, 400)).unwrap();
        store.save(&kept, &renditions).unwrap();
        store.save(&removed, &renditions).unwrap();

        store.remove(&removed).unwrap();
        store.remove(&removed).unwrap();

        assert!(!root.path().join("artwork").join(removed.as_str()).exists());
        assert!(store.file(&kept, Size::Small).is_some());
    }

    #[test]
    fn clearing_deletes_every_folder() {
        let (root, store) = store();
        store
            .save(&AlbumId::new(), &make(&testing::jpeg(400, 400)).unwrap())
            .unwrap();

        store.clear().unwrap();
        store.clear().unwrap();

        assert!(!root.path().join("artwork").exists());
    }

    #[test]
    fn only_a_deadwax_id_names_a_folder() {
        let (root, store) = store();
        let id = AlbumId::new();

        assert_eq!(
            store.folder(&id),
            Some(root.path().join("artwork").join(id.as_str()))
        );
        for outside in ["..", "../..", "", "a/b", "x", &id.as_str().to_uppercase()] {
            assert_eq!(store.folder(&AlbumId::from(outside)), None, "{outside:?}");
            assert_eq!(store.file(&AlbumId::from(outside), Size::Small), None);
        }
        assert!(
            store
                .save(&AlbumId::from(".."), &make(&testing::jpeg(10, 10)).unwrap())
                .is_err()
        );
        store.remove(&AlbumId::from("..")).unwrap();
        assert!(root.path().exists());
    }

    #[test]
    fn a_size_not_saved_has_no_file() {
        let (_root, store) = store();

        assert_eq!(store.file(&AlbumId::new(), Size::Small), None);
    }
}
