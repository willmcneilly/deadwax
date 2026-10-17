//! Each album's genre and label (RFC-002, "3. Genre and label"). Spotify no
//! longer gives either to apps in development mode.
//!
//! - **Genre:** iTunes's `primaryGenreName`, found by barcode. It's one
//!   coarse genre that's nearly always there ("Alternative", "Jazz"), which
//!   is what a crate divider wants.
//! - **Label:** the first label in MusicBrainz's `label-info`, from the
//!   release found by barcode. If MusicBrainz has none, it's iTunes's
//!   `copyright` line with ℗/© and the year taken out.
//!
//! Both are the same searches the artwork lookup makes first, so when it has
//! just run for the album, its replies are reused (`super::replies`).

use deadwax_core::collection::{Album, GenreAndLabel};

use super::{ArtworkError, By, Finder, is_barcode, same_artist};
use crate::clock::Clock;

/// MusicBrainz's label for a release that has none, such as a self-release.
const NO_LABEL: &str = "[no label]";

/// What comes before the label's name in a copyright line for a licensed
/// album.
const LICENSED_TO: [&str; 2] = ["under exclusive license to ", "under exclusive licence to "];

impl<C: Clock + Clone> Finder<C> {
    /// The album's genre and label, from its barcode. An album without one
    /// has neither: an artist and title can find another edition.
    pub async fn genre_and_label(&self, album: &Album) -> Result<GenreAndLabel, ArtworkError> {
        let Some(upc) = album.upc.as_deref().filter(|upc| is_barcode(upc)) else {
            return Ok(GenreAndLabel::default());
        };
        let itunes = self
            .itunes_albums(By::Upc(upc))
            .await?
            .into_iter()
            .find(|found| {
                found
                    .artist_name
                    .as_deref()
                    .is_some_and(|artist| same_artist(&album.artist, artist))
            });
        let label = self
            .musicbrainz_releases(By::Upc(upc))
            .await?
            .into_iter()
            .filter(|release| same_artist(&album.artist, &release.artist()))
            .flat_map(|release| release.label_info)
            .filter_map(|info| info.label)
            .map(|label| label.name)
            .find(|name| !name.trim().is_empty() && name != NO_LABEL);
        let (genre, copyright) = match itunes {
            Some(found) => (found.primary_genre_name, found.copyright),
            None => (None, None),
        };
        Ok(GenreAndLabel {
            genre: genre.filter(|genre| !genre.trim().is_empty()),
            label: label.or_else(|| copyright.as_deref().and_then(strip_copyright)),
        })
    }
}

/// The label in an iTunes copyright line, without ℗, © or years:
/// "℗ 2013 Erased Tapes Records Ltd." → "Erased Tapes Records Ltd.". When
/// the line licenses the album to someone, that's the label: "℗ 2007 LLLP
/// LLP under exclusive license to XL Recordings Ltd" → "XL Recordings Ltd".
/// `None` if nothing's left.
pub fn strip_copyright(line: &str) -> Option<String> {
    let licensee = line.char_indices().find_map(|(at, _)| {
        LICENSED_TO.iter().find_map(|phrase| {
            line.get(at..at + phrase.len())
                .is_some_and(|text| text.eq_ignore_ascii_case(phrase))
                .then_some(at + phrase.len())
        })
    });
    let line = licensee.map_or(line, |at| &line[at..]);
    let words: Vec<&str> = line
        .split_whitespace()
        .map(|word| {
            word.trim_start_matches(['℗', '©'])
                .trim_start_matches("(P)")
                .trim_start_matches("(p)")
                .trim_start_matches("(C)")
                .trim_start_matches("(c)")
        })
        .filter(|word| !is_year(word.trim_end_matches([',', ';'])) && !word.is_empty())
        .collect();
    let label = words
        .join(" ")
        .trim_matches([',', ';', '-', ' '])
        .to_owned();
    (!label.is_empty()).then_some(label)
}

/// A year, or a range of years: "2007", "2007-2008".
fn is_year(word: &str) -> bool {
    !word.is_empty()
        && word
            .split(['-', '–', '/'])
            .all(|part| part.len() == 4 && part.bytes().all(|b| b.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_symbol_and_year_from_a_copyright_line() {
        for (line, label) in [
            (
                "℗ 2013 Erased Tapes Records Ltd.",
                "Erased Tapes Records Ltd.",
            ),
            ("© 2019 Warp Records", "Warp Records"),
            ("℗2016 Ninja Tune", "Ninja Tune"),
            ("(P) 1959 Columbia Records", "Columbia Records"),
            ("℗ 2007-2008 4AD Ltd", "4AD Ltd"),
            ("2011 Domino Recording Co Ltd", "Domino Recording Co Ltd"),
            ("Blue Note Records, ℗ 1964", "Blue Note Records"),
        ] {
            assert_eq!(strip_copyright(line).as_deref(), Some(label), "{line}");
        }
    }

    #[test]
    fn a_licensed_album_takes_the_licensees_name() {
        assert_eq!(
            strip_copyright("℗ 2007 LLLP LLP under exclusive license to XL Recordings Ltd")
                .as_deref(),
            Some("XL Recordings Ltd")
        );
        assert_eq!(
            strip_copyright("℗ 2020 Artist, under exclusive licence to Partisan Records")
                .as_deref(),
            Some("Partisan Records")
        );
    }

    #[test]
    fn a_line_with_only_a_symbol_and_year_has_no_label() {
        assert_eq!(strip_copyright("℗ 2007"), None);
        assert_eq!(strip_copyright("  "), None);
    }

    #[test]
    fn a_four_digit_name_isnt_mistaken_for_a_year_unless_its_digits() {
        assert_eq!(
            strip_copyright("℗ 2001 Kitsuné").as_deref(),
            Some("Kitsuné")
        );
        assert_eq!(
            strip_copyright("℗ 2015 İstanbul UNDER EXCLUSIVE LICENSE TO Ba Da Bing").as_deref(),
            Some("Ba Da Bing")
        );
        assert!(!is_year("4AD"));
        assert!(!is_year("2007-"));
    }
}
