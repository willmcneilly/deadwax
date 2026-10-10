//! Deadwax's config file, `config.json` in the app-data folder. It's shared
//! by every checkout and build, so a fresh worktree already knows your client
//! ID. It never holds a token (those live in the Keychain).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The client ID of your own Spotify developer app (RFC-001, open
    /// question 3). Not a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spotify_client_id: Option<String>,
    /// The name of the Spotify Connect device you last chose. Matched by
    /// name, because Spotify's device IDs don't last (RFC-001, "Playing
    /// music").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_device: Option<String>,
}

pub fn path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("config.json")
}

/// Reads the config. A missing file is an empty config.
pub fn load(path: &Path) -> io::Result<Config> {
    match fs::read_to_string(path) {
        Ok(json) => serde_json::from_str(&json).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(error),
    }
}

/// Writes the config, creating the folder if needed. Writes a temporary file
/// and renames it, so a crash can't leave half a file.
pub fn save(path: &Path, config: &Config) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_string_pretty(config)? + "\n")?;
    fs::rename(&temporary, path)
}

/// Checks a pasted client ID and tidies it. Spotify's client IDs are 32
/// hexadecimal characters.
pub fn parse_client_id(input: &str) -> Result<String, String> {
    let id = input.trim().to_ascii_lowercase();
    if id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(id)
    } else {
        Err(
            "That doesn't look like a Spotify client ID. It's 32 letters and numbers, \
             shown under your app's name on the dashboard."
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn a_missing_file_is_an_empty_config() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&path(dir.path())).unwrap(), Config::default());
    }

    #[test]
    fn saves_and_loads_the_client_id_creating_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = path(&dir.path().join("com.willmcneilly.deadwax"));
        let config = Config {
            spotify_client_id: Some(ID.into()),
            last_device: Some("Living Room".into()),
        };

        save(&path, &config).unwrap();

        assert_eq!(load(&path).unwrap(), config);
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("\"spotifyClientId\"")
        );
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("\"lastDevice\": \"Living Room\"")
        );
    }

    #[test]
    fn client_ids_are_trimmed_and_checked() {
        assert_eq!(
            parse_client_id(&format!("  {}\n", ID.to_uppercase())).unwrap(),
            ID
        );
        assert!(parse_client_id("").is_err());
        assert!(parse_client_id("not-a-client-id").is_err());
        assert!(parse_client_id(&ID.replace('a', "g")).is_err());
    }
}
