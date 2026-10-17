use std::io::Cursor;

use image::{ImageFormat, Rgb as Pixel, RgbImage};
use serde::Deserialize;

use super::*;
use crate::covers::{self, Size};

/// The test images, each 64 × 64 raw RGB, and what the prototype's
/// `palette.ts` gave for them. `prototypes/crate/scripts/palette-fixtures.ts`
/// made both.
const FIXTURES: [(&str, &[u8], &str); 5] = [
    (
        "very-dark",
        include_bytes!("fixtures/very-dark.rgb"),
        include_str!("fixtures/very-dark.json"),
    ),
    (
        "very-light",
        include_bytes!("fixtures/very-light.rgb"),
        include_str!("fixtures/very-light.json"),
    ),
    (
        "monochrome",
        include_bytes!("fixtures/monochrome.rgb"),
        include_str!("fixtures/monochrome.json"),
    ),
    (
        "saturated",
        include_bytes!("fixtures/saturated.rgb"),
        include_str!("fixtures/saturated.json"),
    ),
    (
        "mixed",
        include_bytes!("fixtures/mixed.rgb"),
        include_str!("fixtures/mixed.json"),
    ),
];

/// The prototype's palette, unrounded, as `palette.ts` returns it.
#[derive(Deserialize)]
struct Prototype {
    key: Vec<Rgb>,
    ground: Rgb,
    rear: Rgb,
    ink: Rgb,
    muted: Rgb,
    accent: Rgb,
    dark: bool,
    deep: Rgb,
}

/// The palette's contrast promises, on the colours as stored.
fn assert_contrast(name: &str, palette: &Palette) {
    let ink = palette.ink.contrast(palette.ground);
    let accent = palette.accent.contrast(palette.ground);
    let muted = palette.muted.contrast(palette.ground);
    assert!(
        ink >= INK_CONTRAST,
        "{name}: ink is {ink:.2}:1 in {palette:?}"
    );
    assert!(
        accent >= TEXT_CONTRAST,
        "{name}: the accent is {accent:.2}:1 in {palette:?}"
    );
    assert!(
        muted >= TEXT_CONTRAST,
        "{name}: secondary text is {muted:.2}:1 in {palette:?}"
    );
}

#[test]
fn ink_is_7_to_1_and_accent_and_secondary_text_4_5_to_1_on_every_test_image() {
    for (name, pixels, _) in FIXTURES {
        assert_contrast(name, &of_pixels(pixels));
    }
}

#[test]
fn matches_the_prototypes_palette_within_2_on_each_channel() {
    for (name, pixels, expected) in FIXTURES {
        let ours = of_pixels(pixels);
        let theirs: Prototype = serde_json::from_str(expected).unwrap();
        let close = |field: &str, ours: Colour, theirs: Rgb| {
            for (channel, (a, b)) in ours.rgb().iter().zip(theirs).enumerate() {
                assert!(
                    (a - b).abs() <= 2.0,
                    "{name}: {field}'s channel {channel} is {a}, the prototype's {b:.2}",
                );
            }
        };
        assert_eq!(ours.key.len(), theirs.key.len(), "{name}: key colours");
        for (i, (&a, &b)) in ours.key.iter().zip(&theirs.key).enumerate() {
            close(&format!("key {i}"), a, b);
        }
        close("ground", ours.ground, theirs.ground);
        close("rear", ours.rear, theirs.rear);
        close("ink", ours.ink, theirs.ink);
        close("muted", ours.muted, theirs.muted);
        close("accent", ours.accent, theirs.accent);
        close("deep", ours.deep, theirs.deep);
        assert_eq!(ours.dark, theirs.dark, "{name}: dark");
    }
}

#[test]
fn the_test_images_cover_dark_and_light_paper() {
    let dark: Vec<bool> = FIXTURES
        .iter()
        .map(|(_, pixels, _)| of_pixels(pixels).dark)
        .collect();
    assert!(dark.contains(&true) && dark.contains(&false), "{dark:?}");
}

#[test]
fn every_flat_colour_meets_the_contrast_targets() {
    // Every colour a cover could be one flat area of, in steps of 17.
    for r in (0..=255).step_by(17) {
        for g in (0..=255).step_by(17) {
            for b in (0..=255).step_by(17) {
                let pixels = [r, g, b].repeat(16);
                assert_contrast(&format!("rgb({r}, {g}, {b})"), &of_pixels(&pixels));
            }
        }
    }
}

#[test]
fn runs_on_an_albums_320() {
    let cover = RgbImage::from_fn(900, 900, |x, y| {
        if y < 450 {
            Pixel([240, 120 + (x % 40) as u8, 40])
        } else {
            Pixel([20, 40, 90])
        }
    });
    let mut jpeg = Cursor::new(Vec::new());
    cover.write_to(&mut jpeg, ImageFormat::Jpeg).unwrap();
    let renditions = covers::make(&jpeg.into_inner()).unwrap();
    let small = renditions.get(Size::Small).unwrap();
    assert_eq!((small.width, small.height), (320, 320));

    let palette = of_image(&small.jpeg).unwrap();

    assert_contrast("the 320", &palette);
    // Half orange, half navy: the orange is the most characterful key.
    let [r, g, b] = palette.key[0].0;
    assert!(r > 200 && g > 90 && b < 80, "{palette:?}");
}

#[test]
fn a_cover_that_isnt_an_image_is_an_error() {
    assert!(of_image(b"<html>Moved</html>").is_err());
}

#[test]
fn no_pixels_give_the_neutral_palette() {
    assert_eq!(of_pixels(&[]), Palette::neutral());
}

#[test]
fn the_neutral_palette_meets_the_contrast_targets() {
    assert_contrast("neutral", &Palette::neutral());
}

#[test]
fn colours_are_stored_as_hex() {
    let json = serde_json::to_value(Palette::neutral()).unwrap();
    assert_eq!(json["ground"], "#1e1a16");
    assert_eq!(json["key"][0], "#463c32");
    let back: Palette = serde_json::from_value(json).unwrap();
    assert_eq!(back, Palette::neutral());
    assert!(serde_json::from_str::<Colour>(r##""#12345""##).is_err());
    assert!(serde_json::from_str::<Colour>(r#""12345678""#).is_err());
    assert!(serde_json::from_str::<Colour>(r##""#gg0000""##).is_err());
}
