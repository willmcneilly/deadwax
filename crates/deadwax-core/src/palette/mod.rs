//! Each album's palette: its cover's key colours, and the colours derived
//! from them for the back of its sleeve and its glow. See RFC-002, "2. Local
//! artwork, in sizes" (Palette).
//!
//! It's the crate prototype's `palette.ts`, ported step for step so the same
//! cover gives the same colours, with the `palette` crate doing the OKLCH
//! maths. The album job queue runs it once on the album's 320 and stores the
//! result, so the UI never reads pixels.
//!
//! The printed colours are derived, not lifted: the cover's main colour is
//! pushed to a deep dark or a pale light (never a mid-tone), and text colours
//! are walked in lightness, keeping their hue, until they reach a contrast
//! target. Body text (`ink`) reaches 7:1 against its paper (`ground`), and
//! the accent and secondary text (`muted`) 4.5:1. Unlike the prototype, the
//! targets are checked on the colours as stored, and are always met.

use std::fmt;
use std::io::Cursor;

use ::palette::convert::IntoColorUnclamped;
use ::palette::{LinSrgb, Oklab, OklabHue, Oklch, Srgb};
use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeError, ResizeOptions, Resizer};
use image::{ImageError, ImageReader};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// The cover is read at this many pixels square, as the prototype's canvas
/// did.
pub const SAMPLE: u32 = 64;

/// Body text's contrast with its paper: WCAG AAA, because it's long reading.
pub const INK_CONTRAST: f64 = 7.0;
/// The accent's and secondary text's contrast with the paper.
pub const TEXT_CONTRAST: f64 = 4.5;

/// An sRGB colour, stored and sent to the UI as `#rrggbb`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Colour(pub [u8; 3]);

impl Colour {
    /// `#rrggbb`.
    pub fn hex(self) -> String {
        let [r, g, b] = self.0;
        format!("#{r:02x}{g:02x}{b:02x}")
    }

    fn parse(hex: &str) -> Option<Self> {
        let digits = hex.strip_prefix('#').filter(|d| d.len() == 6)?;
        let channel = |i: usize| u8::from_str_radix(digits.get(i..i + 2)?, 16).ok();
        Some(Self([channel(0)?, channel(2)?, channel(4)?]))
    }

    /// The WCAG contrast ratio between two colours, from 1 to 21.
    pub fn contrast(self, other: Colour) -> f64 {
        contrast(self.rgb(), other.rgb())
    }

    fn rgb(self) -> Rgb {
        self.0.map(f64::from)
    }

    fn from_rgb(rgb: Rgb) -> Self {
        Self(rgb.map(|c| c.round().clamp(0.0, 255.0) as u8))
    }
}

impl fmt::Debug for Colour {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hex())
    }
}

impl Serialize for Colour {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.hex())
    }
}

impl<'de> Deserialize<'de> for Colour {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let hex = String::deserialize(deserializer)?;
        Self::parse(&hex)
            .ok_or_else(|| serde::de::Error::custom(format!("{hex:?} isn't a #rrggbb colour")))
    }
}

/// An album's colours.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Palette {
    /// The glow's colours: the cover's key colours, most characterful first,
    /// with dark ones lifted and bright ones calmed. Three to five.
    pub key: Vec<Colour>,
    /// The paper: the back of the sleeve, the inside of the gatefold.
    pub ground: Colour,
    /// The paper's reverse, a shade off.
    pub rear: Colour,
    /// Body text, at least 7:1 on the ground.
    pub ink: Colour,
    /// Secondary text, at least 4.5:1.
    pub muted: Colour,
    /// The album's colour, at least 4.5:1.
    pub accent: Colour,
    /// Whether the paper is dark, with light text.
    pub dark: bool,
    /// The room behind the glow.
    pub deep: Colour,
}

impl Palette {
    /// The colours of an album with no cover to read: warm and dark.
    pub fn neutral() -> Self {
        Self {
            key: vec![
                Colour([70, 60, 50]),
                Colour([40, 34, 30]),
                Colour([90, 78, 64]),
            ],
            ground: Colour([30, 26, 22]),
            rear: Colour([24, 21, 18]),
            ink: Colour(PAPER.map(|c| c as u8)),
            muted: Colour([176, 166, 150]),
            accent: Colour([200, 170, 120]),
            dark: true,
            deep: Colour([16, 13, 11]),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PaletteError {
    #[error("couldn't read the cover: {0}")]
    Decode(#[from] ImageError),
    #[error("couldn't shrink the cover: {0}")]
    Resize(#[from] ResizeError),
}

/// The palette of a cover image (a JPEG or PNG), read at `SAMPLE` pixels
/// square. Decoding and shrinking a 320 takes a few milliseconds.
pub fn of_image(image: &[u8]) -> Result<Palette, PaletteError> {
    let decoded = ImageReader::new(Cursor::new(image))
        .with_guessed_format()
        .map_err(ImageError::IoError)?
        .decode()?
        .into_rgb8();
    let mut sample = Image::new(SAMPLE, SAMPLE, PixelType::U8x3);
    // A bilinear filter, which came closest to the prototype's canvas in
    // Chromium on real covers. Lanczos would ring, inventing colours at edges.
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Bilinear));
    Resizer::new().resize(&decoded, &mut sample, &options)?;
    Ok(of_pixels(sample.buffer()))
}

/// The palette of raw RGB pixels, three bytes each. No pixels at all give
/// the neutral palette.
pub fn of_pixels(rgb: &[u8]) -> Palette {
    let pixels: &[[u8; 3]] = rgb.as_chunks::<3>().0;
    if pixels.is_empty() {
        return Palette::neutral();
    }
    extract(pixels)
}

type Rgb = [f64; 3];

const PAPER: Rgb = [238.0, 230.0, 214.0];
const SOOT: Rgb = [20.0, 17.0, 14.0];

/// A group of similar colours: their average and how many pixels.
#[derive(Clone, Copy)]
struct Swatch {
    rgb: Rgb,
    count: u32,
}

fn extract(pixels: &[[u8; 3]]) -> Palette {
    // Bin each pixel by the top four bits of each channel. Bins keep the
    // order they were first seen in, as the prototype's `Map` did, so ties
    // in the sorts below break the same way.
    let mut bins: Vec<([u32; 3], u32)> = Vec::new();
    let mut index = vec![usize::MAX; 1 << 12];
    for &[r, g, b] in pixels {
        let key = (usize::from(r >> 4) << 8) | (usize::from(g >> 4) << 4) | usize::from(b >> 4);
        if index[key] == usize::MAX {
            index[key] = bins.len();
            bins.push(([0; 3], 0));
        }
        let (sum, count) = &mut bins[index[key]];
        sum[0] += u32::from(r);
        sum[1] += u32::from(g);
        sum[2] += u32::from(b);
        *count += 1;
    }
    let mut colours: Vec<Swatch> = bins
        .into_iter()
        .map(|(sum, count)| Swatch {
            rgb: sum.map(|v| f64::from(v) / f64::from(count)),
            count,
        })
        .collect();
    // Stable, like JavaScript's sort.
    colours.sort_by_key(|c| std::cmp::Reverse(c.count));

    // Merge near neighbours so one big flat area doesn't fill every slot.
    let mut merged: Vec<Swatch> = Vec::new();
    for c in colours {
        match merged.iter_mut().find(|m| distance(m.rgb, c.rgb) < 46.0) {
            Some(near) => near.count += c.count,
            None => merged.push(c),
        }
    }
    merged.sort_by_key(|m| std::cmp::Reverse(m.count));
    let top = &merged[..merged.len().min(12)];

    let dominant = merged[0].rgb;
    let mut scored: Vec<(Rgb, f64)> = top
        .iter()
        .map(|m| {
            (
                m.rgb,
                f64::from(m.count).sqrt() * (0.35 + saturation(m.rgb)),
            )
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let key: Vec<Rgb> = scored.into_iter().take(5).map(|(rgb, _)| rgb).collect();

    let enough = pixels.len() as f64 * 0.015;
    let candidates: Vec<Rgb> = top
        .iter()
        .filter(|m| f64::from(m.count) >= enough)
        .map(|m| m.rgb)
        .collect();
    let printed = print_colours(dominant, &candidates);

    // The glow wants colour, not mud: lift dark keys a little, cap bright ones.
    let mut glow: Vec<Rgb> = key
        .iter()
        .map(|&c| {
            let l = luminance(c);
            if l < 0.02 {
                mix(c, dominant, 0.3)
            } else if l > 0.55 {
                mix(c, SOOT, 0.35)
            } else {
                c
            }
        })
        .collect();
    while glow.len() < 3 {
        let first = glow.first().copied().unwrap_or(dominant);
        glow.push(mix(first, SOOT, 0.4));
    }

    Palette {
        key: glow.into_iter().map(Colour::from_rgb).collect(),
        deep: Colour::from_rgb(mix(dominant, SOOT, 0.82)),
        ..printed
    }
}

// ---------- WCAG contrast, on sRGB from 0 to 255 ----------

fn lin(c: f64) -> f64 {
    let v = c / 255.0;
    if v <= 0.03928 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn luminance([r, g, b]: Rgb) -> f64 {
    0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    let (light, dark) = if x >= y { (x, y) } else { (y, x) };
    (light + 0.05) / (dark + 0.05)
}

fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t)
}

fn saturation([r, g, b]: Rgb) -> f64 {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max == 0.0 { 0.0 } else { (max - min) / max }
}

fn distance(a: Rgb, b: Rgb) -> f64 {
    ((a[0] - b[0]) * 0.3)
        .hypot((a[1] - b[1]) * 0.59)
        .hypot((a[2] - b[2]) * 0.11)
        * 2.0
}

// ---------- OKLCH, for changing lightness without changing the colour ----------

/// Lightness, chroma and hue in radians.
#[derive(Clone, Copy)]
struct Lch {
    l: f64,
    c: f64,
    h: f64,
}

fn oklch(rgb: Rgb) -> Lch {
    let colour: Oklch<f64> =
        Srgb::new(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0).into_color_unclamped();
    Lch {
        l: colour.l,
        c: colour.chroma,
        h: colour.hue.into_raw_radians(),
    }
}

/// Linear sRGB from 0 to 1, possibly out of gamut.
fn raw_rgb(Lch { l, c, h }: Lch) -> [f64; 3] {
    let lab: Oklab<f64> = Oklch::new(l, c, OklabHue::from_radians(h)).into_color_unclamped();
    let linear: LinSrgb<f64> = lab.into_color_unclamped();
    [linear.red, linear.green, linear.blue]
}

/// Back to sRGB, giving up chroma (never lightness or hue) to stay in gamut.
fn rgb(colour: Lch) -> Rgb {
    let mut c = colour.c;
    for _ in 0..40 {
        let v = raw_rgb(Lch { c, ..colour });
        if v.iter().all(|x| (-0.0005..=1.0005).contains(x)) {
            break;
        }
        c *= 0.9;
    }
    let [r, g, b] = raw_rgb(Lch { c, ..colour }).map(|x| x.clamp(0.0, 1.0));
    let encoded: Srgb<f64> = Srgb::from_linear(LinSrgb::new(r, g, b));
    [encoded.red, encoded.green, encoded.blue].map(|x| (x * 255.0).round())
}

/// Walks a colour's lightness away from the paper until it reaches the
/// target. If the end of the range is reached first, which the prototype
/// allowed, it's white or black, which always does.
fn reach(colour: Lch, paper: Rgb, target: f64, dark: bool) -> Rgb {
    let mut l = colour.l;
    let step = if dark { 0.01 } else { -0.01 };
    let mut out = rgb(colour);
    while contrast(out, paper) < target && (0.0..=1.0).contains(&l) {
        l += step;
        out = rgb(Lch { l, ..colour });
    }
    if contrast(out, paper) < target {
        out = if dark { [255.0; 3] } else { [0.0; 3] };
    }
    out
}

fn print_colours(dominant: Rgb, candidates: &[Rgb]) -> Palette {
    let Lch { l, c, h } = oklch(dominant);
    let dark = l < 0.62;
    // Paper: the main colour, taken to a deep dark or a pale light, keeping
    // its hue and some of its colour.
    let (ground, rear) = if dark {
        let l = l.clamp(0.17, 0.25);
        (
            Lch {
                l,
                c: c.min(0.08),
                h,
            },
            Lch {
                l: l - 0.035,
                c: c.min(0.07),
                h,
            },
        )
    } else {
        let l = l.max(0.93);
        (
            Lch {
                l,
                c: c.min(0.045),
                h,
            },
            Lch {
                l: l - 0.05,
                c: c.min(0.04),
                h,
            },
        )
    };
    let (ground, rear) = (rgb(ground), rgb(rear));

    // Ink: almost white or almost black, tinted with the paper's hue.
    let ink = reach(
        Lch {
            l: if dark { 0.9 } else { 0.3 },
            c: 0.015,
            h,
        },
        ground,
        INK_CONTRAST,
        dark,
    );

    // Accent: the most colourful of the cover's main colours, as it is if it
    // reads, otherwise moved in lightness only. Grey covers fall back to the
    // ink's hue.
    let colourful = candidates
        .iter()
        .map(|&c| oklch(c))
        .filter(|c| c.c > 0.06)
        .reduce(|best, c| if c.c > best.c { c } else { best });
    let accent = match colourful {
        Some(colourful) => reach(colourful, ground, TEXT_CONTRAST, dark),
        None => reach(
            Lch {
                l: if dark { 0.75 } else { 0.45 },
                c: 0.03,
                h,
            },
            ground,
            TEXT_CONTRAST,
            dark,
        ),
    };

    // Secondary text: between ink and paper, as quiet as 4.5:1 allows. The
    // prototype stops at 4.6 before rounding, which leaves room for it, but
    // the rounded colour is checked too.
    let mut muted = ink;
    let mut t = 0.0;
    while t <= 1.0 {
        let next = mix(ink, ground, t);
        if contrast(next, ground) < 4.6 {
            break;
        }
        muted = next;
        t += 0.02;
    }
    let mut muted = Colour::from_rgb(muted);
    let ground = Colour::from_rgb(ground);
    if muted.contrast(ground) < TEXT_CONTRAST {
        muted = Colour::from_rgb(ink);
    }

    Palette {
        key: Vec::new(),
        ground,
        rear: Colour::from_rgb(rear),
        ink: Colour::from_rgb(ink),
        muted,
        accent: Colour::from_rgb(accent),
        dark,
        deep: ground,
    }
}

#[cfg(test)]
mod tests;
