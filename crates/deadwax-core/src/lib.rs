//! Deadwax's core: the collection, the database, the covers on disk, their
//! palettes, the liner notes and the dev list. It never touches the network. See RFC-001,
//! "Repository and checks".

pub mod collection;
pub mod covers;
/// Development builds only: release builds don't contain it (DWX-5).
#[cfg(debug_assertions)]
pub mod dev_list;
pub mod location;
pub mod notes;
pub mod palette;
