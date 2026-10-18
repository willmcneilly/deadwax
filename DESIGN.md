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

MEASUREMENTS

## Rules

RULES

## Do's and Don'ts

DOS
