//! Tokens never reach the UI (CLAUDE.md, "Spotify rules"). This test reads
//! the source of every Tauri command, lists what each one returns, and fails
//! if any of those types could carry a token.
//!
//! It also checks that commands name albums by their Deadwax IDs (RFC-002,
//! "1. Deadwax's own album IDs"): every parameter or field called `id` or
//! `album_id` has the type `AlbumId`. A Spotify ID goes only in a field that
//! says so, such as `spotify_id`.
//!
//! A return type passes if it's built only from plain values (strings,
//! numbers, `bool`, `Option`, `Vec`, `Result`) and types defined in the same
//! file (`commands.rs`, or `commands/dev.rs` for the Develop menu), and no
//! type or field is named like a token or a secret. A type from anywhere else
//! fails until it's added here on purpose. The token types in
//! `deadwax-sources` also can't be serialised, so returning one wouldn't
//! compile, but this catches a token copied into a `String` field too, as
//! long as the field is named for what it holds.

use std::collections::{BTreeSet, HashMap};

use syn::{Fields, GenericArgument, Item, PathArguments, ReturnType, Type};

const COMMANDS: &str = include_str!("commands.rs");
/// The Develop menu's commands, in development builds only.
const DEV_COMMANDS: &str = include_str!("commands/dev.rs");
const LIB: &str = include_str!("lib.rs");

/// Types that hold plain values, or wrap the types inside them.
const PLAIN: &[&str] = &[
    "String", "str", "bool", "char", "u8", "u16", "u32", "u64", "usize", "i8", "i16", "i32", "i64",
    "isize", "f32", "f64", "Option", "Vec", "Result",
];

/// Types from elsewhere that hold only plain values, added here on purpose.
/// `AlbumId` is a Deadwax album ID: a `String` with its own type, from
/// `deadwax-core`. `Palette` is an album's colours, each a `Colour` (three
/// bytes, sent as `#rrggbb`), and a `bool`, from `deadwax_core::palette`.
const KNOWN: &[&str] = &["AlbumId", "Palette"];

/// Names that suggest something holds a credential.
const FORBIDDEN: &[&str] = &[
    "token",
    "secret",
    "verifier",
    "password",
    "credential",
    "bearer",
];

/// A command, what it takes and what it returns.
struct Command {
    name: String,
    params: Vec<(String, Type)>,
    returns: Option<Type>,
}

fn is_command(function: &syn::ItemFn) -> bool {
    function.attrs.iter().any(|attr| {
        let segments: Vec<String> = attr
            .path()
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        segments == ["tauri", "command"] || segments == ["command"]
    })
}

fn parse(source: &str) -> (Vec<Command>, HashMap<String, Item>) {
    let file = syn::parse_file(source).expect("commands.rs parses");
    let mut commands = Vec::new();
    let mut types = HashMap::new();
    for item in file.items {
        match item {
            Item::Fn(function) if is_command(&function) => commands.push(Command {
                name: function.sig.ident.to_string(),
                params: function
                    .sig
                    .inputs
                    .iter()
                    .filter_map(|input| match input {
                        syn::FnArg::Typed(typed) => match &*typed.pat {
                            syn::Pat::Ident(ident) => {
                                Some((ident.ident.to_string(), (*typed.ty).clone()))
                            }
                            _ => None,
                        },
                        syn::FnArg::Receiver(_) => None,
                    })
                    .collect(),
                returns: match function.sig.output {
                    ReturnType::Default => None,
                    ReturnType::Type(_, ty) => Some(*ty),
                },
            }),
            Item::Struct(ref s) => {
                types.insert(s.ident.to_string(), item);
            }
            Item::Enum(ref e) => {
                types.insert(e.ident.to_string(), item);
            }
            _ => {}
        }
    }
    (commands, types)
}

/// The commands `lib.rs` registers with `generate_handler!`, including the
/// ones behind a `#[cfg]`.
fn registered() -> BTreeSet<String> {
    let start = LIB
        .find("generate_handler![")
        .expect("lib.rs registers commands");
    let list = &LIB[start + "generate_handler![".len()..];
    // The list ends at the `]` that closes it, not one closing a `#[cfg]`.
    let mut depth = 0;
    let end = list
        .char_indices()
        .find_map(|(i, c)| match c {
            '[' => {
                depth += 1;
                None
            }
            ']' if depth == 0 => Some(i),
            ']' => {
                depth -= 1;
                None
            }
            _ => None,
        })
        .unwrap();
    list[..end]
        .split(',')
        .map(|entry| {
            // Drop any attributes before the path.
            let path = entry.trim().rsplit(']').next().unwrap();
            path.trim().rsplit("::").next().unwrap().to_owned()
        })
        .filter(|name| !name.is_empty())
        .collect()
}

fn forbidden(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    FORBIDDEN.iter().any(|word| name.contains(word))
}

/// Returns why `ty` could carry a token, or `None` if it can't.
fn check(ty: &Type, types: &HashMap<String, Item>, seen: &mut BTreeSet<String>) -> Option<String> {
    match ty {
        Type::Tuple(tuple) => tuple.elems.iter().find_map(|t| check(t, types, seen)),
        Type::Reference(reference) => check(&reference.elem, types, seen),
        Type::Path(path) => {
            let segment = path.path.segments.last()?;
            let name = segment.ident.to_string();
            if forbidden(&name) {
                return Some(format!("`{name}` is named like a credential"));
            }
            if let PathArguments::AngleBracketed(args) = &segment.arguments {
                for arg in &args.args {
                    if let GenericArgument::Type(inner) = arg
                        && let Some(problem) = check(inner, types, seen)
                    {
                        return Some(problem);
                    }
                }
            }
            if PLAIN.contains(&name.as_str()) || KNOWN.contains(&name.as_str()) {
                return None;
            }
            let Some(item) = types.get(&name) else {
                return Some(format!(
                    "`{name}` isn't a plain value or a type defined in commands.rs, so this test can't see inside it"
                ));
            };
            if !seen.insert(name.clone()) {
                return None;
            }
            let fields: Vec<&Fields> = match item {
                Item::Struct(s) => vec![&s.fields],
                Item::Enum(e) => e.variants.iter().map(|v| &v.fields).collect(),
                _ => unreachable!(),
            };
            fields.into_iter().flatten().find_map(|field| {
                if let Some(ident) = &field.ident
                    && forbidden(&ident.to_string())
                {
                    return Some(format!("`{name}.{ident}` is named like a credential"));
                }
                check(&field.ty, types, seen)
            })
        }
        _ => Some("this test can't check that kind of type".into()),
    }
}

/// Every problem with every command's return type.
fn problems(source: &str) -> Vec<String> {
    let (commands, types) = parse(source);
    commands
        .iter()
        .filter_map(|command| {
            let returns = command.returns.as_ref()?;
            check(returns, &types, &mut BTreeSet::new())
                .map(|why| format!("{}: {why}", command.name))
        })
        .collect()
}

/// Names that mean "which album".
const ALBUM_IDENTITY: &[&str] = &["id", "album_id"];

/// Whether `ty` is `AlbumId`, maybe in an `Option` or behind a reference.
fn is_album_id(ty: &Type) -> bool {
    match ty {
        Type::Reference(reference) => is_album_id(&reference.elem),
        Type::Path(path) => {
            let Some(segment) = path.path.segments.last() else {
                return false;
            };
            if segment.ident == "AlbumId" {
                return true;
            }
            match &segment.arguments {
                PathArguments::AngleBracketed(args) if segment.ident == "Option" => args
                    .args
                    .iter()
                    .any(|arg| matches!(arg, GenericArgument::Type(inner) if is_album_id(inner))),
                _ => false,
            }
        }
        _ => false,
    }
}

/// Every command parameter and every field of a type in `source` that names
/// an album by anything but its Deadwax ID.
fn identity_problems(source: &str) -> Vec<String> {
    let (commands, types) = parse(source);
    let params = commands.iter().flat_map(|command| {
        command
            .params
            .iter()
            .map(move |(name, ty)| (format!("{}({name})", command.name), name.clone(), ty))
    });
    let mut types: Vec<(&String, &Item)> = types.iter().collect();
    types.sort_by_key(|(name, _)| *name);
    let fields = types.into_iter().flat_map(|(type_name, item)| {
        let fields: Vec<&Fields> = match item {
            Item::Struct(s) => vec![&s.fields],
            Item::Enum(e) => e.variants.iter().map(|v| &v.fields).collect(),
            _ => unreachable!(),
        };
        fields.into_iter().flatten().filter_map(move |field| {
            let ident = field.ident.as_ref()?.to_string();
            Some((format!("{type_name}.{ident}"), ident, &field.ty))
        })
    });
    params
        .chain(fields)
        .filter(|(_, name, ty)| ALBUM_IDENTITY.contains(&name.as_str()) && !is_album_id(ty))
        .map(|(place, _, _)| format!("{place} names an album by something other than its AlbumId"))
        .collect()
}

#[test]
fn every_command_names_albums_by_their_deadwax_ids() {
    for source in [COMMANDS, DEV_COMMANDS] {
        assert_eq!(identity_problems(source), Vec::<String>::new());
    }
}

#[test]
fn no_command_can_return_a_token() {
    for source in [COMMANDS, DEV_COMMANDS] {
        let (commands, _) = parse(source);
        let names: Vec<&str> = commands.iter().map(|c| c.name.as_str()).collect();
        // The list this test checks, so a failure shows what it looked at.
        println!("commands: {names:?}");
        assert!(!commands.is_empty());

        assert_eq!(problems(source), Vec::<String>::new());
    }
}

#[test]
fn every_registered_command_is_checked() {
    let defined: BTreeSet<String> = [COMMANDS, DEV_COMMANDS]
        .into_iter()
        .flat_map(|source| parse(source).0)
        .map(|c| c.name)
        .collect();
    assert_eq!(registered(), defined);
}

// The checker itself: it has to catch the cases it exists for.

#[test]
fn catches_a_token_type() {
    let source = "#[tauri::command] fn leak() -> Result<Tokens, String> { todo!() }";
    assert_eq!(
        problems(source),
        ["leak: `Tokens` is named like a credential"]
    );
}

#[test]
fn catches_a_token_field_in_a_nested_type() {
    let source = "
        struct Outer { inner: Vec<Inner> }
        enum Inner { A { access_token: String } }
        #[tauri::command] async fn leak() -> Option<Outer> { todo!() }
    ";
    assert_eq!(
        problems(source),
        ["leak: `Inner.access_token` is named like a credential"]
    );
}

#[test]
fn catches_a_type_it_cannot_see_inside() {
    let source = "#[tauri::command] fn leak() -> deadwax_sources::Anything { todo!() }";
    assert_eq!(problems(source).len(), 1);
}

#[test]
fn catches_a_spotify_id_as_an_albums_identity() {
    let source = "
        struct AlbumCard { id: String, title: String }
        struct NowPlayingTrack { album_id: Option<String> }
        #[tauri::command] fn get_album(state: State<'_, AppState>, id: String) -> Result<AlbumCard, String> { todo!() }
    ";
    assert_eq!(
        identity_problems(source),
        [
            "get_album(id) names an album by something other than its AlbumId",
            "AlbumCard.id names an album by something other than its AlbumId",
            "NowPlayingTrack.album_id names an album by something other than its AlbumId",
        ]
    );
}

#[test]
fn allows_deadwax_ids_and_spotify_ids_that_say_so() {
    let source = "
        struct AlbumPage { id: AlbumId, spotify_id: String }
        struct NowPlayingTrack { album_id: Option<AlbumId>, spotify_album_id: Option<String> }
        #[tauri::command] fn get_album(id: AlbumId) -> Result<AlbumPage, String> { todo!() }
        #[tauri::command] fn add_album(spotify_id: String) -> Result<AlbumPage, String> { todo!() }
    ";
    assert_eq!(identity_problems(source), Vec::<String>::new());
    // And `AlbumId` can't carry a token.
    assert_eq!(problems(source), Vec::<String>::new());
}

#[test]
fn allows_plain_types() {
    let source = "
        struct Album { title: String, year: Option<u16>, tracks: Vec<String> }
        #[tauri::command] fn album() -> Result<Album, String> { todo!() }
        #[tauri::command] fn nothing() {}
        #[tauri::command] fn unit() -> Result<(), String> { todo!() }
    ";
    assert_eq!(problems(source), Vec::<String>::new());
}
