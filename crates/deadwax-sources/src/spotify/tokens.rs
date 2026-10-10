//! Spotify's tokens, and where they're kept.
//!
//! The rules (CLAUDE.md, "Spotify rules"): tokens live in the macOS Keychain
//! and never reach a log, a file, the database or the UI. So `Tokens` can't be
//! serialised by anything outside this module, its `Debug` hides the values,
//! and nothing hands out the refresh token at all.

use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// An access token and the refresh token that renews it.
///
/// Deliberately not `Serialize`: a Tauri command can't return one, or
/// anything that contains one.
#[derive(Clone, PartialEq, Eq)]
pub struct Tokens {
    access: String,
    refresh: String,
    /// Seconds since the Unix epoch.
    expires_at: u64,
}

impl Tokens {
    pub(crate) fn new(access: String, refresh: String, expires_at: SystemTime) -> Self {
        Self {
            access,
            refresh,
            expires_at: expires_at
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        }
    }

    pub(crate) fn access(&self) -> &str {
        &self.access
    }

    pub(crate) fn refresh(&self) -> &str {
        &self.refresh
    }

    pub(crate) fn expires_at(&self) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(self.expires_at)
    }

    /// The form kept in the Keychain. Only the stores in this module use it.
    fn to_json(&self) -> String {
        serde_json::to_string(&Stored {
            access: &self.access,
            refresh: &self.refresh,
            expires_at: self.expires_at,
        })
        .expect("tokens serialise")
    }

    fn from_json(json: &str) -> Result<Self, StoreError> {
        let stored: StoredOwned = serde_json::from_str(json)
            .map_err(|_| StoreError("the saved sign-in is unreadable".into()))?;
        Ok(Self {
            access: stored.access,
            refresh: stored.refresh,
            expires_at: stored.expires_at,
        })
    }
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tokens")
            .field("access", &"[redacted]")
            .field("refresh", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Serialize)]
struct Stored<'a> {
    access: &'a str,
    refresh: &'a str,
    expires_at: u64,
}

#[derive(Deserialize)]
struct StoredOwned {
    access: String,
    refresh: String,
    expires_at: u64,
}

/// A failure reading or writing the token store. The message never includes
/// a token.
#[derive(Debug, thiserror::Error)]
#[error("couldn't use the saved Spotify sign-in: {0}")]
pub struct StoreError(String);

/// Where the tokens are kept between runs.
pub trait TokenStore: Send + Sync + 'static {
    fn load(&self) -> Result<Option<Tokens>, StoreError>;
    fn save(&self, tokens: &Tokens) -> Result<(), StoreError>;
    /// Forgets the tokens. Clearing an empty store is fine.
    fn clear(&self) -> Result<(), StoreError>;
}

/// The macOS Keychain, as a generic password: service
/// `com.willmcneilly.deadwax`, account `spotify`. One entry, shared by every
/// checkout and build of Deadwax.
pub struct KeychainStore {
    entry: keyring::Entry,
}

impl KeychainStore {
    pub const SERVICE: &str = "com.willmcneilly.deadwax";
    pub const ACCOUNT: &str = "spotify";

    pub fn new() -> Result<Self, StoreError> {
        let entry = keyring::Entry::new(Self::SERVICE, Self::ACCOUNT).map_err(keychain_error)?;
        Ok(Self { entry })
    }
}

impl TokenStore for KeychainStore {
    fn load(&self) -> Result<Option<Tokens>, StoreError> {
        match self.entry.get_password() {
            Ok(json) => Tokens::from_json(&json).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keychain_error(error)),
        }
    }

    fn save(&self, tokens: &Tokens) -> Result<(), StoreError> {
        self.entry
            .set_password(&tokens.to_json())
            .map_err(keychain_error)
    }

    fn clear(&self) -> Result<(), StoreError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keychain_error(error)),
        }
    }
}

/// Keyring's errors describe the failure, never the stored secret.
fn keychain_error(error: keyring::Error) -> StoreError {
    StoreError(format!("Keychain: {error}"))
}

/// A store that only lives in memory. Tests use it, never the real Keychain.
#[derive(Default)]
pub struct MemoryStore {
    json: Mutex<Option<String>>,
}

impl TokenStore for MemoryStore {
    fn load(&self) -> Result<Option<Tokens>, StoreError> {
        self.json
            .lock()
            .unwrap()
            .as_deref()
            .map(Tokens::from_json)
            .transpose()
    }

    fn save(&self, tokens: &Tokens) -> Result<(), StoreError> {
        // Round-trips through the same JSON as the Keychain, so tests cover
        // the stored form too.
        *self.json.lock().unwrap() = Some(tokens.to_json());
        Ok(())
    }

    fn clear(&self) -> Result<(), StoreError> {
        *self.json.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> Tokens {
        Tokens::new(
            "access-secret".into(),
            "refresh-secret".into(),
            UNIX_EPOCH + Duration::from_secs(1_800_000_000),
        )
    }

    #[test]
    fn memory_store_round_trips_and_clears() {
        let store = MemoryStore::default();
        assert_eq!(store.load().unwrap(), None);

        store.save(&tokens()).unwrap();
        assert_eq!(store.load().unwrap(), Some(tokens()));

        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
        store.clear().unwrap();
    }

    #[test]
    fn debug_output_hides_the_tokens() {
        let debug = format!("{:?}", tokens());
        assert!(!debug.contains("access-secret"));
        assert!(!debug.contains("refresh-secret"));
    }

    #[test]
    fn an_unreadable_entry_is_an_error_that_does_not_echo_it() {
        let error = Tokens::from_json("not json, maybe a token").unwrap_err();
        assert!(!error.to_string().contains("maybe a token"));
    }
}
