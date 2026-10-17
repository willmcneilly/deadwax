//! Where the database and the covers live. See RFC-001, "A dev list that
//! survives resets", and RFC-002, "2. Local artwork, in sizes".
//!
//! Development builds keep them in the checkout's `.dev-data/` (ignored by
//! git), so each worktree has its own and testing one branch can't damage
//! another's albums. Release builds keep them in the app-data folder, as
//! usual.

use std::path::{Path, PathBuf};

/// The database's file name, in either folder.
pub const DATABASE_FILE: &str = "deadwax.sqlite3";

/// The covers' folder, in either folder: `artwork/<deadwax-id>/`.
pub const ARTWORK_DIR: &str = "artwork";

/// The development data folder, at the top of a checkout.
pub const DEV_DATA_DIR: &str = ".dev-data";

/// What kind of build is running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Build {
    /// A development build, made from the checkout at `checkout`.
    Development {
        checkout: PathBuf,
    },
    Release,
}

/// Where this build keeps the database.
pub fn database_path(build: &Build, app_data_dir: &Path) -> PathBuf {
    match build {
        Build::Development { checkout } => checkout.join(DEV_DATA_DIR).join(DATABASE_FILE),
        Build::Release => app_data_dir.join(DATABASE_FILE),
    }
}

/// Where this build keeps the covers, one folder for each album.
pub fn artwork_dir(build: &Build, app_data_dir: &Path) -> PathBuf {
    match build {
        Build::Development { checkout } => checkout.join(DEV_DATA_DIR).join(ARTWORK_DIR),
        Build::Release => app_data_dir.join(ARTWORK_DIR),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collection::Collection;

    /// A checkout and an app-data folder, side by side in a temporary folder.
    fn folders() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let checkout = root.path().join("deadwax");
        let app_data = root
            .path()
            .join("Application Support/com.willmcneilly.deadwax");
        std::fs::create_dir_all(&checkout).unwrap();
        (root, checkout, app_data)
    }

    #[test]
    fn a_development_build_keeps_the_database_in_the_checkout() {
        let (_root, checkout, app_data) = folders();
        let build = Build::Development {
            checkout: checkout.clone(),
        };

        let path = database_path(&build, &app_data);
        Collection::open(&path).unwrap();

        assert_eq!(path, checkout.join(".dev-data/deadwax.sqlite3"));
        assert!(path.is_file());
        assert!(!app_data.exists());
    }

    #[test]
    fn a_release_build_keeps_the_database_in_app_data() {
        let (_root, checkout, app_data) = folders();

        let path = database_path(&Build::Release, &app_data);
        Collection::open(&path).unwrap();

        assert_eq!(path, app_data.join("deadwax.sqlite3"));
        assert!(path.is_file());
        assert!(!checkout.join(".dev-data").exists());
    }

    #[test]
    fn a_development_build_keeps_the_covers_in_the_checkout_and_a_release_build_in_app_data() {
        let (_root, checkout, app_data) = folders();
        let development = Build::Development {
            checkout: checkout.clone(),
        };

        assert_eq!(
            artwork_dir(&development, &app_data),
            checkout.join(".dev-data/artwork")
        );
        assert_eq!(
            artwork_dir(&Build::Release, &app_data),
            app_data.join("artwork")
        );
    }

    #[test]
    fn each_checkout_has_its_own_database() {
        let (root, _, app_data) = folders();
        let worktree = |name: &str| Build::Development {
            checkout: root.path().join(name),
        };

        assert_ne!(
            database_path(&worktree("main"), &app_data),
            database_path(&worktree("dwx-3"), &app_data)
        );
    }
}
