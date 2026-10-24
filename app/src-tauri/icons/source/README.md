# The app icon's source

The groove-D: a capital D drawn with two of a record's grooves. The orange label is the D's counter,
and the empty band between it and the first groove is the dead wax.

`deadwax-icon.svg` draws every size, from 16 px to 1024. It's on a 1024 canvas with the macOS icon body
(824 × 824 at 100, 100, corner radius 185) and the colours of `app/src/theme.css`: room `#120f0c`,
room-ink `#f1e9db`, accent `#c2410c`.

## How it's built

Each groove is a straight line from the stem, a semicircle around the label, and a straight line back.

| | |
|---|---|
| Grooves | 2 |
| Groove width | 36 |
| Gap between grooves | 34 |
| Dead wax (label to first groove) | 56 |
| Label radius | 100 |
| Spindle hole radius | 28 |
| Straight length (stem to curve) | 150 |
| Nudge right of centre | 36 |
| Nudge up | −5 |

The first groove's centre line is at label + dead wax + width ÷ 2 from the label's centre, and the next
is width + gap further out. The mark is centred on x = 512, then nudged.

## Making the icon set

Render the SVG to a 1024 px PNG and give it to Tauri, which makes every file in the folder above:

```bash
rsvg-convert -w 1024 -h 1024 app/src-tauri/icons/source/deadwax-icon.svg -o icon-1024.png
cd app && npx tauri icon ../icon-1024.png -o <scratch folder>
```

Then copy over only the files already in `app/src-tauri/icons`. Tauri also makes iOS and Android sets,
which Deadwax doesn't need.
