# Crate prototype

A throwaway sketch of how Deadwax could feel: flip through a crate of records
with the scroll wheel, pull one out, turn it over for the tracklist, pick a
track, and watch it hover in a glow made of its own colours.

It runs in a browser, with no Tauri and no Spotify. Albums come from the
iTunes Search API, and a pretend Spotify stands in for the app's back end
(see [Spotify, pretend](#spotify-pretend) below).

```bash
npm install
npm run fixture   # once: tracklists and artwork into public/ (about 7 minutes)
npm run dev       # http://localhost:5199
```

The fixture is two lists: `scripts/albums.json` is the collection, and
`scripts/catalogue.json` is more albums that only search finds.
`npm run fixture -- catalogue` builds just the second.

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

## Spotify, pretend

`src/connect/api.ts` has the app's types and command names, copied from
`app/src/api.ts`, and answers from a pretend Spotify in `src/connect/fake.ts`.
It behaves like the real thing: play takes 1–3 seconds to start, the app asks
what's playing every 2 seconds, speakers fall asleep and drop off the list,
and Spotify has bad days. RFC-002 swaps `api.ts` for the app's own.

The collection, the remembered device, the client ID and being signed in are
kept in localStorage, so they survive a reload. Clear the site's data to start
again.

**Press ` (backtick) for the dev panel**, or add `?dev` to the address. It
changes the pretend Spotify while you watch.

### Trying every state

**Search and add**
- The search icon (top right) opens search over everything. Type an artist or
  an album: "radiohead" shows albums you have and don't. Records already in the
  crate are dimmed and say so. Hover a cover for **+ Add**. Short searches like
  "a" have a **More** at the end.
- Close it (esc) and the crate is turned to the last record you added.
- First run: dev panel › Collection › **Empty (first run)**. Search opens by
  itself. Close it to see the empty crate. **The fixture's** puts the
  collection back.

**Where the sound plays**
- It plays on the remembered device (Kitchen) without asking.
- To change it: click **on Kitchen** at the end of the now-playing line, or
  the device on the playing chip in the crate, or press D. Choosing another
  device plays the track again there.
- First play: dev panel › **Forget** the remembered device, then pick a track:
  it asks where once.
- A missing device: untick **Kitchen** in the dev panel. Whatever was playing
  there stops, and a floating record turns over to its tracklist. Pick a track:
  the app's "Kitchen isn't showing up…" sentence comes up with the devices that
  are there. Living Room can't be controlled, and Bedroom is asleep.

**Playing**
- Pick a track: the needle drops. The record settles, the glow warms, and the
  line says "starting" until Spotify confirms. **Slow to start** stretches the
  wait to 5–7 seconds.
- Space pauses (the glow dims and stops drifting), and ← → skip.
- Someone on their phone: **Skip**, **Pause**, and **Another album**. While a
  record floats, the new album swaps in by itself (the old one goes back).
  **Move to iPhone** changes the device it reports.
- **Not in the crate** plays something from outside the collection: a plain
  sleeve with a neutral glow, and **Add to the crate** on the line beneath.
  Add it and it becomes one of yours, glow and all. Open it from the chip if
  you're at the crate.
- **Advert**: Spotify won't say what it is, so the chip and line say so.

**Spotify's errors**
- **The next action gets:** 429 waited out (the action is just slow), 429 too
  long, 502, or no network. Then press space, skip, play, search or add. One
  quiet line at the top says what happened and fades.
- **Down: every call fails**: after two failed polls the line says Spotify
  isn't answering. The crate still works, because the collection is local.

**Account**
- **No client ID** (the setup card: anything but 32 letters and numbers is
  refused), **Signed out**, **Expired**, **Signed in**. Signing in waits about
  3 seconds for "the browser". **Sign-in fails in the browser** makes it fail.
