//! PKCE (RFC 7636): proving to Spotify that the app collecting the tokens is
//! the one that started the sign-in, without a client secret.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// The one-off secret for a single sign-in. It never leaves Rust, and only
/// Spotify's token endpoint ever sees it.
pub struct Verifier(String);

impl Verifier {
    /// 32 random bytes, base64url-encoded: 43 characters, within RFC 7636's
    /// 43 to 128.
    pub fn generate() -> Self {
        Self(random_base64url())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The `S256` code challenge: base64url(SHA-256(verifier)), no padding.
    pub fn challenge(&self) -> String {
        URL_SAFE_NO_PAD.encode(Sha256::digest(self.0.as_bytes()))
    }
}

/// The `state` value that ties Spotify's redirect to this sign-in.
pub fn generate_state() -> String {
    random_base64url()
}

fn random_base64url() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 7636, Appendix B.
    #[test]
    fn challenge_matches_the_rfc_7636_worked_example() {
        let verifier = Verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(
            verifier.challenge(),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_verifiers_are_unreserved_characters_of_a_valid_length() {
        let verifier = Verifier::generate();
        let value = verifier.as_str();
        assert!((43..=128).contains(&value.len()));
        assert!(
            value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c))
        );
        assert_ne!(value, Verifier::generate().as_str());
    }
}
