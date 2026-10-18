# Deadwax design

## Overview

Deadwax is a crate of records you flip through, pull out and play. It should feel like handling the real thing: the sleeves move as soon as you touch them, the artwork is sharp the moment a record is out, and the glow behind a playing record drifts without a stutter. **Performance comes first.** An effect that costs frames doesn't ship, however good it looks in a still.

This document starts with the frame budget and what measuring the crate taught us (DWX-20, RFC-002 "4. The UI" and "6. `DESIGN.md` starts here"). The colour rules, the type and the interaction patterns come in with the tickets that build them (DWX-21 to DWX-26), and DWX-27 makes it one document.

## The frame budget

| | Target |
|---|---|
| Flipping through the crate, the real collection and a 400-record crate | A steady 60 fps |
| A pulled-out sleeve's large artwork | Drawn within 100 ms of pulling it out |
| The glow's drift behind a playing record | Drops no frames |

These are a starting point (Will's call in RFC-002). We tighten them if they turn out too easy.

## How we measure

Measure in WebKit, not Chrome: Deadwax runs in WKWebView, which composites differently, and the prototype that felt sluggish in Chrome had never been measured in it.

**The crate spike** (Develop › Crate spike, in development builds) is the prototype's crate, pulled-out sleeve and glow, drawn from the real collection's artwork on disk (`cover://`) and palettes. A panel at the top left turns each effect up, down or off. Its code is in `app/src/crate-spike`.

**`scripts/crate-spike`** measures it in this checkout's running dev app (`scripts/dev-app start`), without anyone at the keyboard. It sends each run to the app through Vite's dev server, and the app holds its window in front, filling the screen, while it measures. `scripts/crate-spike --list` shows the runs, and `--only <text>` picks some. Each run reports:
- **Frames,** from `requestAnimationFrame`, which WebKit drives from the display and holds back while the page's rendering is late: frames per second, frames dropped against the 60 fps clock, late frames (a gap over 25 ms, the hitch you see), and the longest gap.
- **The large cover:** the time from pulling a record out to its 1600 being decoded and on screen.
- **CPU,** averaged over the run, of WebKit's GPU process (which draws the layers), its web-content process (the page) and the WindowServer (which puts them on screen). WebKit runs CSS animations of transform and opacity in Core Animation, outside the page, so a frame dropped there doesn't show in the page's frames. Their cost does show here.
- **React's longest commit,** so a frame lost to script can be told from one lost to drawing.

**The Frames timeline** in Web Inspector (right-click › Inspect Element in a development build, then Timelines) shows the same rendering frames against the 16.7 ms line, with what each spent its time on. Use it to find out *why* a frame was slow; use `scripts/crate-spike` to compare one change against another.

**Instruments' Animation Hitches** (`xcrun xctrace record --template "Animation Hitches" --attach <pid>`) sees frames Core Animation itself was late with, which neither of the above can.

The 400-record crate repeats the collection with a different URL for each repeat (`?copy=n`), so WebKit loads and decodes every one as a different image, as it would 400 different albums. Development builds run React in development mode, so script costs are pessimistic; drawing costs are the same as in a release build.

## What we measured

Measured on 2026-10-18 on Will's MacBook Pro (M4, 24 GB, macOS 15.0), in a development build with the window filling the built-in display (1512 × 916 points at 2x), three runs of each. The real collection is four albums, so "real" is a small crate; the 400-record crate is the stress test. Each table changes one thing at a time, so each row is a before and after. The raw rows are in `.dev-data/crate-spike/results.jsonl` (not in the repository), and `scripts/crate-spike` makes them again.

### Flipping

Flipping one record every 100 ms (a fast scroll wheel), 40 flips on the real crate and 80 on the 400. The range is across the three runs. "Page work" is each flip's own work in the page (React, then the style and layout it causes); React's share was 1 to 3 ms in every row.

| Change, each on top of the one before | Real crate | 400 records | Page work per flip |
|---|---|---|---|
| The prototype, as PR #16 left it | 55 fps, 28 dropped, a late frame on every flip | 35–44 fps, 217–330 dropped | 40 ms (real), 62 ms (400) |
| The wear and grain images as `blob:` URLs, not `data:` | **60 fps, 0 dropped** | 56–60 fps, 1–31 dropped | **3–4 ms** |
| Decoding the next covers ahead with `img.decode()` | 60 fps, 0 dropped | 52–60 fps, 2–65 dropped | 3 ms |

Then each of these on its own, on top of the last row:

| Change | Real crate | 400 records |
|---|---|---|
| One size (the 640) for every sleeve, not the 320 behind | 60 fps, 0–1 dropped | 60 fps, 1–2 dropped |
| The grain still, not moving | 60 fps, 1–2 dropped | 60 fps, 3–4 dropped |
| No grain | 60 fps, 0–1 dropped | 60 fps, 1–4 dropped |
| No wear | 60 fps, 0 dropped | 60 fps, 1–2 dropped |
| No shade on the sleeves behind | 60 fps, 0 dropped | 60 fps, 2–5 dropped |
| **6 sleeves drawn behind the front one, not 11** | 60 fps, 0 dropped | **60 fps, 0–1 dropped** |
| No CSS transitions (sleeves jump) | 60 fps, 0 dropped | 60 fps, 0–3 dropped |
| A flat crate (the same places in 2D, no perspective) | 60 fps, 0 dropped | **60 fps, 0 dropped** |

Flipping every 40 ms (holding an arrow key) gave the same picture: the prototype at 56–57 fps on the real crate and 31–33 fps on the 400, and 59–60 fps once the textures were `blob:` URLs.

**What it was.** The prototype draws its wear and grain once, into images, so they cost nothing to scale (#9's lesson). But it hands them to CSS as `data:` URLs in custom properties on the root, each a whole PNG written out as text. Every time a sleeve's style changed, WebKit resolved those properties again, which took 30 to 60 ms a flip, the same whether the crate was 3D or flat, with transitions or without. The same images as `blob:` URLs (a short `blob:…` address to the same bytes) cost 3 ms. Nothing else on the list came close.

### The pulled-out sleeve

The time from pulling a record out to its 1600 cover on screen, seven pulls a run on the real crate and eight on the 400, from the middle of the crate. "Cold" loads a 1600 WebKit hasn't seen. The time is measured one frame after the paint, so it's up to 17 ms pessimistic.

| Change | Large cover, median (worst) | Within 100 ms | Frames dropped flying out |
|---|---|---|---|
| The prototype, cold | 199 ms (236) | 0 of 21 | 72–88 |
| The prototype, cold, no CSS filter on the cover | 120 ms (220) | 3 of 21 | 13–23 |
| The prototype, warm (seen before) | 171 ms (214) | 0 of 21 | 59–78 |
| Decoding the 1600 ahead | 162 ms (194) | 0 of 21 | 59–70 |
| Decoding ahead, no filter | 123 ms (186) | 3 of 14 | 7–12 |
| … and the back built only when first turned over | 98 ms (128) | 9 of 14 | 4–5 |
| … no deep shadow instead | 104 ms (121) | 5 of 14 | 3–6 |
| … the 1600 from the first frame, without the 640 under it | 112 ms (144) | 3 of 14 | 8–16 |
| … no flight from the crate (it appears in place) | 122 ms (154) | 2 of 14 | 8–17 |
| **The final cuts (below), real crate** | **57 ms (147)** | **19 of 21** | 7–20 |
| **The final cuts, 400 records** | **54 ms (118)** | **23 of 24** | 10–15 |
| The final cuts and no deep shadow, real crate | 57 ms (145) | 20 of 21 | 9–16 |

**What it is.** Once decoded ahead, the 1600 is loaded and decoded within 5 ms of the pull. What it waits for is the pulled-out sleeve's own first frame: building the front and back, their wear and shadows, and starting the flight, 60 to 80 ms with the final cuts. The CSS filter (`contrast(1.04) saturate(0.9) sepia(0.07)`) was the biggest single cost: taking it off saved 40 to 80 ms and most of the flight's dropped frames. Cold, a 1600 also takes about 80 ms to come off disk through `cover://`, which decoding ahead hides.

### The glow, the blur, the grain and the poll

A record out and playing, floating in its glow, measured over 10 seconds after the glow had faded in. CPU is the average over the whole run, in percent of one core.

| Change | Frames | GPU process | Page |
|---|---|---|---|
| The prototype: five drifting radial gradients, `backdrop-filter` on the playing chip, moving grain, the state replaced on every poll | 60 fps, 0 dropped | 6% | 13% |
| No `backdrop-filter` | 60 fps, 0 dropped | 6% | 13% |
| The grain still | 60 fps, 0 dropped | 5–6% | 9% |
| No grain | 60 fps, 0 dropped | 5% | 9% |
| The glow's pools as pre-drawn images, not live gradients | 60 fps, 0 dropped | 6% | 13% |
| Not replacing an unchanged state on each poll | 60 fps, 0 dropped | 6–7% | 13% |
| No glow at all | 60 fps, 0 dropped | 5% | 12% |

React's longest commit on a poll was 1 ms, and 0 ms when an unchanged state was kept.

**What this can't see.** The glow's drift, the float and the flight are CSS animations of `transform`, which WebKit hands to Core Animation, so they run outside the page. A frame Core Animation drops there doesn't hold back `requestAnimationFrame`, and it doesn't show in Web Inspector's Frames timeline either. The CPU columns show those processes did little work (the GPU process at 2 to 7% of a core), but "drops no frames" for the glow still needs an eye on it. Instruments' Animation Hitches template, tried on this Mac, recorded no display frames for any process (0 to 3 surface swaps a second), so it couldn't measure it either.

### Search over the crate

Search's wall of 400 covers opening over the crate, then scrolling up and down for 3 seconds.

| Change | Opening | Scrolling |
|---|---|---|
| The prototype: the 3D crate stays drawn, dimmed, under the overlay | 52–58 fps, 3–9 dropped | 60 fps, 0 dropped |
| The crate hidden once it has dimmed | 55 fps, 5–6 dropped | 60 fps, 0 dropped |
| No grain | 51–57 fps, 4–11 dropped | 60 fps, 0 dropped |

The opening's dropped frames are mounting 400 `<img>`s at once, not the crate under it.

### The final cuts

What `scripts/crate-spike` calls `final`: the prototype with only the changes that bought frames or time, and every other effect kept as it was (the glow's gradients, `backdrop-filter`, the moving grain, the crate under search, the state replaced on each poll).
- the wear and grain as `blob:` URLs, not `data:` URLs in custom properties;
- 6 sleeves drawn behind the front one, not 11;
- no CSS filter on the pulled-out cover;
- the pulled-out sleeve's back built when it's first turned over;
- the next covers, and the front record's 1600, decoded ahead with `img.decode()`.

| Against the budget | Prototype | Final cuts | Met? |
|---|---|---|---|
| Flipping the real crate, every 100 ms | 55 fps, 28 dropped | 58.9–60 fps, 0–5 dropped | Yes |
| Flipping the real crate, every 40 ms | 56–57 fps, 8–12 dropped | 59–59.9 fps, 0–2 dropped | Yes |
| Flipping 400 records, every 100 ms | 35–44 fps, 217–330 dropped | 59.5–60 fps, 0–5 dropped | Yes |
| Flipping 400 records, every 40 ms | 31–33 fps, 218–236 dropped | 59.5–60 fps, 0–2 dropped | Yes |
| The large cover, real crate | 199 ms median, none within 100 ms | 57 ms median, 19 of 21 within 100 ms, worst 147 ms | **Mostly** |
| The large cover, 400 records | 250 ms median, none within 100 ms | 54 ms median, 23 of 24 within 100 ms, worst 118 ms | **Mostly** |
| The glow's drift, 10 seconds | 60 fps, 0 dropped | 60 fps, 0 dropped | Yes, as far as the page can see (above) |
| Search opening over 400 records | 52–58 fps, 3–9 dropped | 56–60 fps, 1–5 dropped | Not in the budget |

The few dropped frames left in flipping come mostly from the first of the three runs, while WebKit warms up.

**What's left over budget:** about 1 pull in 15 still takes longer than 100 ms (118 to 147 ms at worst), always in the sleeve's own first frame, not the image. The cuts that would take the rest are bigger changes than a spike should make: building the pulled-out sleeve before it's pulled (it's the record in front, so it's known), or a simpler sleeve for the flight. That's a decision for Will before DWX-21: accept "within 100 ms nearly always" for now, or have DWX-21 build the sleeve ahead.

## Verdicts on PR #16's suspects

PR #16 listed five likely costs from the prototype feeling sluggish in Chrome. In WebKit none of them was the problem.

| Effect | Verdict | Measured |
|---|---|---|
| The 3D crate under the search overlay | **Keep.** | Scrolling search held 60 fps with no dropped frames with the crate drawn under it or hidden. Opening search drops 3 to 9 frames either way: that's mounting 400 covers at once (for DWX-24). |
| The glow's five drifting gradients | **Keep.** | 60 fps, no dropped frames over 10 seconds. Pre-drawn images instead were no cheaper (6% of a core in the GPU process either way). |
| `backdrop-filter` | **Keep, on small things.** | On the playing chip it cost nothing measurable (60 fps; 6% GPU with or without). It wasn't measured over large areas. |
| The paper grain | **Keep, moving.** | No dropped frames anywhere, moving or still. Moving costs about 4% of a core in the page over still. |
| Redrawing on every poll | **Keep, but skip an unchanged state.** | A poll's re-render took 1 ms and dropped no frames. Keeping an unchanged state costs 0 ms and is simpler to reason about. |

What was the problem, and what was cut, is in "The final cuts" above.

## Rules

These came out of the measurements. Each UI ticket keeps to them, and a ticket that changes the crate, the sleeve or the glow measures it again (`scripts/crate-spike`) and puts the numbers in its PR.

1. **No large values in CSS custom properties.** A texture or image goes to CSS as a short URL: a file, `cover://`, or a `blob:` URL made once. Never a `data:` URL in a custom property: WebKit resolves it again on every style change, which cost 30 to 60 ms a flip.
2. **Draw 6 sleeves behind the front one, and 3 already flipped past.** With 11, the 400-record crate dropped frames; with 6 it held 60 fps.
3. **No CSS `filter` on artwork,** and nothing that moves with one. If a cover needs a tint, it's drawn into the image once. (A Spotify cover is shown as it is anyway: RFC-001, "Spotify's attribution rules".)
4. **Build what isn't seen yet when it's needed.** The pulled-out sleeve builds its back the first time it's turned over, not when it comes out.
5. **Decode the front record's 1600 ahead** with `img.decode()`, and keep a reference to it, so pulling it out never waits on the disk (about 80 ms cold). Decoding the crate's own covers ahead, as the final cuts also do, bought no frames (WebKit already decodes them off the main thread) and cost about a tenth of a core more at 400 records. It's optional: DWX-21 can leave it out if it measures the same.
6. **In a 3D scene,** these are allowed: transforms and opacity, CSS transitions of them, pre-drawn images (wear, shade), and box shadows on the sleeves. Not allowed: CSS filters, and anything that makes WebKit redo style for the whole scene on each change (rule 1).
7. **Animate only `transform` and `opacity`.** The glow's drift, the float, the flight and the flip all do, so Core Animation runs them outside the page.
8. **Keep the playback state when a poll brings nothing new,** so nothing re-renders.

## Do's and Don'ts

- **Do** measure in the app, in WebKit, with `scripts/crate-spike`, before and after an effect. Chrome's numbers don't carry over.
- **Do** compare runs on the same machine, with the window filling the screen and nothing else busy.
- **Don't** trust a still. The prototype looked right and flipped at 35 fps on 400 records.
- **Don't** add an effect to the crate or the sleeve without a row in a table like the ones above.
