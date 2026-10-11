# Crate prototype

A throwaway sketch of how Deadwax could feel: flip through a crate of records
with the scroll wheel, pull one out, turn it over for the tracklist, pick a
track, and watch it hover in a glow made of its own colours.

It runs in a browser, with no Tauri and no Spotify. Albums come from the
iTunes Search API and playback is a fake clock.

```bash
npm install
npm run fixture   # once: tracklists and artwork into public/ (about 4 minutes)
npm run dev       # http://localhost:5199
```

Scroll or use the arrow keys to flip, click or press Enter to pull a record out,
pick a track on the back, click the sleeve to turn it over again, press Space to
pause, and press Esc to put it back.

Sort the crate by genre, artist or decade from the top left. Shift-scroll or
`[` `]` jump between dividers. Add `?many` to the address for a 400-record
crate, and press H for a frame-rate meter.

## Liner notes

An album with an essay in `public/notes/<album-slug>.json` gets a **Liner
notes** button once it's pulled out. The sleeve opens like a gatefold and the
essay keeps unfolding sideways, panel by panel, as you scroll. Four type
styles are at the bottom left. While the album plays, its track is
highlighted, and the button at the bottom right turns to where the essay
mentions it. Five albums have notes so far: In Rainbows, Blue, Pink Moon,
Mixing Colours and Music Has the Right to Children. Claude researched and wrote
each one from the sources listed at its end.

`?colours` shows every album's printed colours (paper, text, accent) with
their contrast ratios. Press T to switch the record's type between serif and
grotesk.
