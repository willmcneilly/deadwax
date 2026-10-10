//! Telling whether another service's album is ours, by artist and title.
//!
//! Deluxe editions and remasters often have their own barcode and cover, and
//! services name them differently ("In Rainbows (Deluxe Edition)", "OK
//! Computer - Remastered"). So we take those words out of titles before
//! searching and comparing. Artists must match exactly, apart from case and
//! spacing: a near miss is a different artist, or a compilation.

/// Words that mark an edition rather than a different album.
const EDITION_WORDS: &[&str] = &["deluxe", "remaster"];

/// `title` without its edition: any part in brackets, or after " - ", that
/// mentions "Deluxe" or "Remaster(ed)". "In Rainbows (Deluxe Edition)" and
/// "In Rainbows - 2016 Remaster" are both "In Rainbows".
pub fn strip_edition(title: &str) -> String {
    let mut kept = String::new();
    let mut rest = title;
    while let Some(open) = rest.find(['(', '[']) {
        let close = if rest[open..].starts_with('(') {
            ')'
        } else {
            ']'
        };
        let Some(length) = rest[open..].find(close) else {
            break;
        };
        let group = &rest[open..=open + length];
        kept.push_str(&rest[..open]);
        if !is_edition(group) {
            kept.push_str(group);
        }
        rest = &rest[open + length + 1..];
    }
    kept.push_str(rest);
    let kept = match kept.rsplit_once(" - ") {
        Some((before, after)) if is_edition(after) => before.to_owned(),
        _ => kept,
    };
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_edition(text: &str) -> bool {
    let text = text.to_lowercase();
    EDITION_WORDS.iter().any(|word| text.contains(word))
}

/// Lower case, with runs of spaces made one.
fn normalise(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Whether two artist names are the same, apart from case and spacing.
pub fn same_artist(ours: &str, theirs: &str) -> bool {
    !ours.trim().is_empty() && normalise(ours) == normalise(theirs)
}

/// Whether two titles are the same album, once their editions are taken out.
pub fn same_title(ours: &str, theirs: &str) -> bool {
    normalise(&strip_edition(ours)) == normalise(&strip_edition(theirs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_deluxe_editions_and_remasters() {
        for (title, stripped) in [
            ("In Rainbows (Deluxe Edition)", "In Rainbows"),
            ("In Rainbows [Deluxe Edition]", "In Rainbows"),
            ("OK Computer (Remastered)", "OK Computer"),
            ("Abbey Road (Remastered 2009)", "Abbey Road"),
            ("Rumours - Remastered", "Rumours"),
            ("Kind of Blue - 2016 Remaster", "Kind of Blue"),
            ("Rumours (Super Deluxe) [Remastered]", "Rumours"),
            (
                "Lift Your Skinny Fists Like Antennas to Heaven",
                "Lift Your Skinny Fists Like Antennas to Heaven",
            ),
        ] {
            assert_eq!(strip_edition(title), stripped, "{title}");
        }
    }

    #[test]
    fn keeps_brackets_and_dashes_that_arent_editions() {
        for title in [
            "(What's the Story) Morning Glory?",
            "Hail to the Thief (Live)",
            "Music for the Masses - Live",
            "Tago Mago (",
        ] {
            assert_eq!(strip_edition(title), title);
        }
    }

    #[test]
    fn artists_match_exactly_apart_from_case_and_spacing() {
        assert!(same_artist("Radiohead", "Radiohead"));
        assert!(same_artist(
            "Godspeed You! Black Emperor",
            "godspeed you!  black emperor"
        ));
        assert!(!same_artist("Radiohead", "Radiohead Tribute Band"));
        assert!(!same_artist("Radiohead", "Various Artists"));
        assert!(!same_artist("Radiohead", "Thom Yorke"));
        assert!(!same_artist("", ""));
    }

    #[test]
    fn titles_match_once_their_editions_are_stripped() {
        assert!(same_title("In Rainbows (Deluxe Edition)", "In Rainbows"));
        assert!(same_title("OK Computer", "OK COMPUTER - Remastered"));
        assert!(!same_title("In Rainbows", "In Rainbows (Disk 2)"));
    }
}
