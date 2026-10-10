//! Tokens never reach the UI (CLAUDE.md, "Spotify rules"). This test reads
//! the source of every Tauri command, lists what each one returns, and fails
//! if any of those types could carry a token.
//!
//! A return type passes if it's built only from plain values (strings,
//! numbers, `bool`, `Option`, `Vec`, `Result`) and types defined in the same
//! file (`commands.rs`, or `commands/dev.rs` for the Develop menu), and no type or field is named like a token or a secret. A
//! type from anywhere else fails until it's added here on purpose. The
//! token types in `deadwax-sources` also can't be serialised, so returning
//! one wouldn't compile, but this catches a token copied into a `String`
//! field too, as long as the field is named for what it holds.

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

/// Names that suggest something holds a credential.
const FORBIDDEN: &[&str] = &[
    "token",
    "secret",
    "verifier",
    "password",
    "credential",
    "bearer",
];

/// A command and what it returns.
struct Command {
    name: String,
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
            if PLAIN.contains(&name.as_str()) {
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
fn allows_plain_types() {
    let source = "
        struct Album { title: String, year: Option<u16>, tracks: Vec<String> }
        #[tauri::command] fn album() -> Result<Album, String> { todo!() }
        #[tauri::command] fn nothing() {}
        #[tauri::command] fn unit() -> Result<(), String> { todo!() }
    ";
    assert_eq!(problems(source), Vec::<String>::new());
}
