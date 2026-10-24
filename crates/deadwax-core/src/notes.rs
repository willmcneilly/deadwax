//! Liner notes: a researched long-form essay about one album, which the
//! sleeve opens as a gatefold. See RFC-002, "5. Liner notes in the app".
//!
//! Each album's notes are a JSON file named by its Deadwax ID, in the notes
//! folder (`crate::location::notes_dir`): `notes/<deadwax-id>.json`. Nothing
//! in Deadwax writes new notes yet (that's the AI album builder project), so
//! the folder holds whatever was put there, and a file is checked against the
//! schema every time it's read. A file that doesn't match is treated as no
//! notes, never as a broken page, and the Develop menu's Liner notes report
//! says what's wrong with it.
//!
//! The schema is the prototype's (`Notes` in `prototypes/crate/src/types.ts`,
//! PR #9), field for field.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::collection::AlbumId;

/// One album's liner notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notes {
    /// The album and artist the essay is about, as it names them. Importing
    /// matches them to an album in the collection.
    pub album_title: String,
    pub artist: String,
    pub headline: String,
    pub standfirst: String,
    /// The essay. `*x*` is italic, and `[[Track]]` mentions a track by its
    /// title.
    pub sections: Vec<Section>,
    pub quotes: Vec<Quote>,
    pub facts: Vec<Fact>,
    pub credits: Vec<Credit>,
    pub sources: Vec<Source>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Section {
    pub heading: String,
    pub paragraphs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_quote: Option<PullQuote>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullQuote {
    pub text: String,
    /// Null for one taken from the essay itself.
    pub attribution: Option<String>,
}

/// A short quote from an interview, with who said it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quote {
    pub text: String,
    pub who: String,
    /// Which of `sources` it's from, from 0.
    pub source_index: u32,
}

/// A figure and what it counts, for the title page: "2", "nights".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fact {
    pub figure: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credit {
    pub role: String,
    pub names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub title: String,
    pub publisher: String,
    pub url: String,
    pub year: Option<i32>,
}

#[derive(Debug, thiserror::Error)]
pub enum NotesError {
    /// The file is there but isn't notes: not JSON, or not the schema.
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Reads notes from JSON, checking it against the schema.
pub fn parse(json: &str) -> Result<Notes, NotesError> {
    serde_json::from_str(json).map_err(|e| NotesError::Invalid(e.to_string()))
}

/// The notes folder: one file for each album that has notes.
#[derive(Clone, Debug)]
pub struct NotesDir {
    dir: PathBuf,
}

/// A file in the notes folder, and what's in it.
#[derive(Debug)]
pub struct NotesFile {
    /// Its name, such as `<deadwax-id>.json`.
    pub name: String,
    /// The album it's for, from its name. `None` for a file not named like
    /// one.
    pub id: Option<AlbumId>,
    pub notes: Result<Notes, NotesError>,
}

impl NotesDir {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// Where an album's notes are. `None` for an ID that couldn't be a file
    /// name in the folder, such as one with a `/` or `..` in it: the UI sends
    /// IDs, and nothing else checks their shape.
    fn file(&self, id: &AlbumId) -> Option<PathBuf> {
        let id = id.as_str();
        let plain = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        plain.then(|| self.dir.join(format!("{id}.json")))
    }

    /// The album's notes. `None` if it has none: no file, or an ID that
    /// can't have one. A file that isn't valid notes is an error, for the
    /// caller to report and treat as none.
    pub fn read(&self, id: &AlbumId) -> Result<Option<Notes>, NotesError> {
        let Some(path) = self.file(id) else {
            return Ok(None);
        };
        match fs::read_to_string(&path) {
            Ok(json) => parse(&json).map(Some),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                Err(NotesError::Invalid("It isn't UTF-8 text.".into()))
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Writes the album's notes, replacing any it had. Written to a
    /// temporary file first, so a reader never sees half a file.
    pub fn write(&self, id: &AlbumId, notes: &Notes) -> Result<(), NotesError> {
        let path = self
            .file(id)
            .ok_or_else(|| NotesError::Invalid(format!("{id} can't name a notes file.")))?;
        fs::create_dir_all(&self.dir)?;
        let json =
            serde_json::to_string_pretty(notes).map_err(|e| NotesError::Invalid(e.to_string()))?;
        let partial = path.with_extension("json.partial");
        fs::write(&partial, json)?;
        fs::rename(&partial, &path)?;
        Ok(())
    }

    /// Every `.json` file in the folder, by name, each read and checked. An
    /// empty list if there's no folder yet.
    pub fn files(&self) -> Result<Vec<NotesFile>, NotesError> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".json") else {
                continue;
            };
            let id = AlbumId::from(stem);
            let id = self.file(&id).is_some().then_some(id);
            let notes = match fs::read_to_string(entry.path()) {
                Ok(json) => parse(&json),
                Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                    Err(NotesError::Invalid("It isn't UTF-8 text.".into()))
                }
                Err(e) => Err(e.into()),
            };
            files.push(NotesFile { name, id, notes });
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(files)
    }
}

/// Whether notes about `title` by `artist` are about this album: the same
/// title and artist, ignoring case, punctuation and a store's additions to
/// the title such as "(Remastered)" or "- 2009 Remaster". Several artists
/// match in any order and however they're joined: Spotify's "Roger Eno,
/// Brian Eno" is the notes' "Roger Eno & Brian Eno".
pub fn is_about(notes: &Notes, title: &str, artist: &str) -> bool {
    let same = |a: &str, b: &str| {
        let (a, b) = (comparable(a), comparable(b));
        !a.is_empty() && a == b
    };
    let artists = |a: &str| {
        let mut names: Vec<String> = a
            .split([',', '&', '/'])
            .flat_map(|part| part.split(" and "))
            .map(comparable)
            .filter(|name| !name.is_empty())
            .collect();
        names.sort();
        names
    };
    same(&clean_title(&notes.album_title), &clean_title(title))
        && (same(&notes.artist, artist) || {
            let names = artists(&notes.artist);
            !names.is_empty() && names == artists(artist)
        })
}

/// Words that mark a bracketed part, or a part after " - ", as a store's
/// addition rather than the album's title (the prototype's `cleanTitle`).
const NOISE: [&str; 9] = [
    "remaster",
    "re-master",
    "deluxe",
    "edition",
    "version",
    "anniversary",
    "expanded",
    "mono",
    "stereo",
];

fn is_noise(part: &str) -> bool {
    let part = part.to_lowercase();
    NOISE.iter().any(|w| part.contains(w))
}

/// The title without bracketed or dashed additions that are only noise.
fn clean_title(title: &str) -> String {
    let mut out = String::new();
    let mut rest = title;
    while let Some(open) = rest.find(['(', '[']) {
        let close = rest[open..].find([')', ']']).map(|c| open + c);
        let Some(close) = close else { break };
        let inside = &rest[open + 1..close];
        out.push_str(&rest[..open]);
        if !is_noise(inside) {
            out.push_str(&rest[open..=close]);
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    if let Some(dash) = out.find(" - ")
        && is_noise(&out[dash..])
    {
        out.truncate(dash);
    }
    out
}

/// Lowercase letters and digits only, with "&" read as "and".
fn comparable(text: &str) -> String {
    text.replace('&', " and ")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

#[cfg(test)]
mod tests;
