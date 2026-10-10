//! Deadwax's core: the collection, the database and the dev list. It never
//! touches the network. See RFC-001, "Repository and checks".

/// The crate version, until there is real API to test.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crate_builds() {
        assert!(!VERSION.is_empty());
    }
}
