use super::*;

/// Notes as small as the schema allows, with one of everything.
const VALID: &str = r#"{
  "albumTitle": "Pink Moon",
  "artist": "Nick Drake",
  "headline": "Eleven Songs After Midnight",
  "standfirst": "Two nights in Chelsea.",
  "sections": [
    {
      "heading": "Two nights",
      "paragraphs": ["It opens with [[Pink Moon]].", "*Pink Moon* came out in 1972."],
      "pullQuote": { "text": "Nobody else in the room.", "attribution": null }
    },
    { "heading": "After", "paragraphs": ["Then nothing."] }
  ],
  "quotes": [{ "text": "Very stark.", "who": "John Wood", "sourceIndex": 0 }],
  "facts": [{ "figure": "2", "label": "nights" }],
  "credits": [{ "role": "Engineer", "names": ["John Wood"] }],
  "sources": [{ "title": "Interview", "publisher": "Sounds", "url": "https://example.com", "year": null }]
}"#;

fn folder() -> (tempfile::TempDir, NotesDir) {
    let root = tempfile::tempdir().unwrap();
    let dir = NotesDir::new(root.path().join("notes"));
    (root, dir)
}

fn put(dir: &NotesDir, name: &str, json: &str) {
    fs::create_dir_all(dir.path()).unwrap();
    fs::write(dir.path().join(name), json).unwrap();
}

fn invalid(result: Result<Option<Notes>, NotesError>) -> String {
    match result {
        Err(NotesError::Invalid(reason)) => reason,
        other => panic!("expected invalid notes, got {other:?}"),
    }
}

#[test]
fn a_valid_file_is_returned() {
    let (_root, dir) = folder();
    put(&dir, "deadwax-1.json", VALID);

    let notes = dir.read(&AlbumId::from("deadwax-1")).unwrap().unwrap();

    assert_eq!(notes.album_title, "Pink Moon");
    assert_eq!(notes.sections.len(), 2);
    assert_eq!(
        notes.sections[0].pull_quote,
        Some(PullQuote {
            text: "Nobody else in the room.".into(),
            attribution: None
        })
    );
    assert_eq!(notes.sections[1].pull_quote, None);
    assert_eq!(notes.quotes[0].source_index, 0);
    assert_eq!(notes.sources[0].year, None);
}

#[test]
fn an_album_with_no_file_has_no_notes() {
    let (_root, dir) = folder();
    assert!(dir.read(&AlbumId::from("deadwax-1")).unwrap().is_none());

    put(&dir, "deadwax-2.json", VALID);
    assert!(dir.read(&AlbumId::from("deadwax-1")).unwrap().is_none());
}

#[test]
fn a_file_that_isnt_json_is_invalid() {
    let (_root, dir) = folder();
    put(&dir, "deadwax-1.json", "{ not json");

    let reason = invalid(dir.read(&AlbumId::from("deadwax-1")));

    assert!(reason.contains("line 1"), "{reason}");
}

#[test]
fn a_file_missing_a_field_is_invalid() {
    let (_root, dir) = folder();
    put(
        &dir,
        "deadwax-1.json",
        &VALID.replace(r#""headline": "Eleven Songs After Midnight","#, ""),
    );

    let reason = invalid(dir.read(&AlbumId::from("deadwax-1")));

    assert!(reason.contains("missing field `headline`"), "{reason}");
}

#[test]
fn a_file_with_a_field_the_schema_doesnt_have_is_invalid() {
    let (_root, dir) = folder();
    put(
        &dir,
        "deadwax-1.json",
        &VALID.replace(r#""headline""#, r#""subtitle": "x", "headline""#),
    );

    let reason = invalid(dir.read(&AlbumId::from("deadwax-1")));

    assert!(reason.contains("unknown field `subtitle`"), "{reason}");
}

#[test]
fn a_file_with_a_field_of_the_wrong_type_is_invalid() {
    let (_root, dir) = folder();
    put(
        &dir,
        "deadwax-1.json",
        &VALID.replace(r#""sourceIndex": 0"#, r#""sourceIndex": "first""#),
    );

    invalid(dir.read(&AlbumId::from("deadwax-1")));
}

#[test]
fn a_file_that_isnt_text_is_invalid() {
    let (_root, dir) = folder();
    fs::create_dir_all(dir.path()).unwrap();
    fs::write(dir.path().join("deadwax-1.json"), [0xff, 0xfe, 0x00]).unwrap();

    invalid(dir.read(&AlbumId::from("deadwax-1")));
}

#[test]
fn an_id_that_isnt_a_plain_name_reads_nothing_outside_the_folder() {
    let (root, dir) = folder();
    // A valid file beside the folder, where `../outside` would find it.
    fs::write(root.path().join("outside.json"), VALID).unwrap();
    put(&dir, "deadwax-1.json", VALID);

    for id in ["../outside", "..", "", "a/b", "deadwax-1.json", "deadwax 1"] {
        assert!(dir.read(&AlbumId::from(id)).unwrap().is_none(), "{id:?}");
    }
}

#[test]
fn writing_then_reading_gives_the_same_notes() {
    let (_root, dir) = folder();
    let notes = parse(VALID).unwrap();
    let id = AlbumId::new();

    dir.write(&id, &notes).unwrap();

    assert_eq!(dir.read(&id).unwrap(), Some(notes));
    assert!(dir.path().join(format!("{id}.json")).is_file());
    assert!(!dir.path().join(format!("{id}.json.partial")).exists());
}

#[test]
fn writing_replaces_an_albums_notes() {
    let (_root, dir) = folder();
    let id = AlbumId::from("deadwax-1");
    put(&dir, "deadwax-1.json", "{ not json");

    dir.write(&id, &parse(VALID).unwrap()).unwrap();

    assert!(dir.read(&id).unwrap().is_some());
}

#[test]
fn writing_refuses_an_id_that_isnt_a_plain_name() {
    let (_root, dir) = folder();
    let result = dir.write(&AlbumId::from("../outside"), &parse(VALID).unwrap());
    assert!(matches!(result, Err(NotesError::Invalid(_))));
}

#[test]
fn the_files_are_listed_with_what_is_wrong_with_each() {
    let (_root, dir) = folder();
    assert!(dir.files().unwrap().is_empty());

    put(&dir, "b.json", VALID);
    put(&dir, "a.json", "[]");
    put(&dir, "readme.txt", "not notes");
    put(&dir, "c d.json", VALID);

    let files = dir.files().unwrap();

    let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["a.json", "b.json", "c d.json"]);
    assert!(matches!(files[0].notes, Err(NotesError::Invalid(_))));
    assert_eq!(files[0].id, Some(AlbumId::from("a")));
    assert!(files[1].notes.is_ok());
    assert_eq!(files[2].id, None);
}

#[test]
fn notes_are_about_an_album_with_the_same_title_and_artist() {
    let notes = parse(VALID).unwrap();

    assert!(is_about(&notes, "Pink Moon", "Nick Drake"));
    assert!(is_about(&notes, "PINK MOON", "nick drake"));
    assert!(is_about(&notes, "Pink Moon (Remastered)", "Nick Drake"));
    assert!(is_about(&notes, "Pink Moon [2009 Remaster]", "Nick Drake"));
    assert!(is_about(&notes, "Pink Moon - Deluxe Edition", "Nick Drake"));
    assert!(!is_about(&notes, "Pink Moon", "Nick Cave"));
    assert!(!is_about(&notes, "Bryter Layter", "Nick Drake"));
    assert!(!is_about(&notes, "Pink Moon (Live)", "Nick Drake"));
}

#[test]
fn matching_ignores_punctuation_and_reads_an_ampersand_as_and() {
    let mut notes = parse(VALID).unwrap();
    notes.album_title = "Music Has the Right to Children".into();
    notes.artist = "Boards of Canada".into();

    assert!(is_about(
        &notes,
        "Music Has The Right To Children",
        "Boards Of Canada"
    ));

    notes.album_title = "Songs: Ohia".into();
    notes.artist = "Simon & Garfunkel".into();
    assert!(is_about(&notes, "Songs Ohia", "Simon and Garfunkel"));
}

#[test]
fn several_artists_match_however_they_are_joined() {
    let mut notes = parse(VALID).unwrap();
    notes.album_title = "Mixing Colours".into();
    notes.artist = "Roger Eno & Brian Eno".into();

    assert!(is_about(&notes, "Mixing Colours", "Roger Eno, Brian Eno"));
    assert!(is_about(&notes, "Mixing Colours", "Brian Eno, Roger Eno"));
    assert!(!is_about(&notes, "Mixing Colours", "Brian Eno"));
    assert!(!is_about(
        &notes,
        "Mixing Colours",
        "Roger Eno, Brian Eno, Harold Budd"
    ));
}
