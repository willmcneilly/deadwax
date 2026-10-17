# RFC-002: The crate, for real

**Status:** Accepted (2026-10-17) · **Author:** Will · **Notion:** https://app.notion.com/p/The-crate-for-real-3fc3af969b6f8159b696c04363552f22

## Summary

Deadwax's real app becomes the crate prototype. You flip through your own collection as a crate of records, with genre dividers. You pull a record out, turn it over to its tracklist, and drop the needle. Your record then floats in a glow made of its colours while your Sonos plays it through Spotify Connect. Search, choosing where the sound plays, and the account screens work as the second prototype designed them (PR #16).

To make that instant and possible, three things change underneath:
- Deadwax stores each album's artwork locally, in a few sizes, and works out its colours once.
- It looks up a genre and a label for each album.
- Albums get their own Deadwax IDs, so Spotify becomes one source among future others.

The app keeps working after every ticket, and the prototypes are deleted once the app does everything they do.

## Motivation

Project 1 proved the plumbing. Sign-in, search, the collection, Spotify Connect on the Sonos, high-res artwork and now playing all work. Its UI was a deliberately rough grid. Separately, two browser prototypes showed what Deadwax should feel like:
- the crate, the sleeve, the glow and the gatefold (PR #9);
- the Spotify Connect parts designed into that world (PR #16).

Neither prototype plays real music, and the app doesn't look like either. Until they meet, Deadwax isn't something Will wants to use every day.

This is a **vertical slice**: the smallest version of every layer that makes the whole experience real. Each part that needs to go deeper becomes its own project later:
- the album pipeline;
- the AI album builder;
- lyrics;
- now playing that reacts to the music;
- local media.

The slice comes first because those projects all need somewhere to land. The gatefold has to exist before the AI fills it, and the crate before the pipeline feeds it.

Three decisions from 2026-10-17 shape this RFC:
- **Personal use first.** Deadwax is a personal, non-commercial, open-source project. Doing what a personal music library does (keeping artwork locally, as iTunes does) is fine. Commercial questions wait until Deadwax proves itself.
- **Store artwork locally.** This reverses RFC-001's open question 5 (load high-res covers on demand). Digging through the crate has to feel instant, and that can't depend on the network.
- **The design prototype is the new standard.** Everything in the current UI that the prototype replaces goes: the grid, the album page, the playback bar, the dropdown device picker and the macOS fullscreen now playing.

## Proposal

### 1. Deadwax's own album IDs

Today every table and every command uses the Spotify album ID as the album's identity (`collection`, `album_cache` and `artwork` in `deadwax-core`, and `AlbumCard.id`, `play_album` and `NowPlaying.albumId` in the UI). That ties Deadwax to Spotify for good.

Each album gets a **Deadwax ID**: a random identifier made when it's added, which never changes. The Spotify ID becomes a column on the album: where to play it, not what it is. Later, a local folder or a MusicBrainz release can be another column, and nothing above the database notices.

- A **schema migration** (the database's `user_version` goes from 2 to 3) gives every existing album a Deadwax ID and keeps its Spotify ID, date added, cache and artwork. It runs once, inside a transaction, so a failure leaves the old database untouched.
- Commands take and return Deadwax IDs. Only the Spotify client sees Spotify IDs.
- The dev list keeps Spotify IDs, since restoring an album means fetching it from Spotify. Restoring makes new Deadwax IDs, which is fine because a dev database is disposable.

This lands first, as a small chore. Everything after it builds on the new IDs.

### 2. Local artwork, in sizes

Artwork lookup stays as DWX-7 built it: by UPC, then by name, trying iTunes, then Deezer, then MusicBrainz and the Cover Art Archive, and falling back to Spotify. Two things change:
- **What happens with the winner.** Rust downloads it once.
- **When it runs.** The lookup moves into a slightly broader **album job queue**, and each album records which steps it has finished. The queue is the same single background worker the artwork already uses.

When the download finishes:
1. **Sizes ("renditions").** Rust decodes the image with the `image` crate and resizes it with `fast_image_resize`, which uses the Mac's SIMD instructions and is about ten times faster than `image`'s own resizer. It makes JPEGs at 320, 640 and 1600 pixels, plus a master capped at 3000 pixels. A sleeve at the back of the crate draws the 320, the front sleeve the 640, and the pulled-out record and now playing the 1600. JPEG wins because WebKit decodes it fastest. AVIF and WebP save disk space, which doesn't matter on a local disk, and they cost decode time, which does.
2. **Palette.** The prototype's palette code (`palette.ts`) is ported to Rust and run on the 320. It finds the cover's key colours, then works out the sleeve's printed colours in OKLCH. OKLCH is a way of describing colour where equal steps look equally different to the eye. Body text is at least 7:1 against its paper, and accent and secondary text at least 4.5:1. The glow's colours come from the same code. The result is stored with the album, so the UI never reads pixels. The palette is deterministic, with no AI: the same cover always gives the same colours. That's deliberately a starting point. Will's view, from building the prototype, is that AI looking at the artwork would catch nuance a histogram can't, such as which colour actually carries the cover's mood. That analysis belongs to the AI album builder project: an album's build can choose or adjust its colours (the accent, the glow) on top of this palette, which stays the fallback and keeps the contrast guarantees.
3. **Files.**
   - Release builds keep the images in `artwork/<deadwax-id>/` in the app-data folder.
   - Development builds keep them in the checkout's `.dev-data/`, beside the database.
   - Removing an album deletes its folder.

**How the UI loads them.** Rust registers a **custom URL scheme**, `cover://localhost/<deadwax-id>/<size>`. A custom URL scheme is a made-up kind of web address that the app itself answers, so `<img src="cover://…">` reads straight from the disk through Rust. We chose it over Tauri's built-in asset protocol for three reasons:
- The asset protocol sends no caching headers.
- It sniffs each file's type and reads the whole file on every request.
- It needs a broad permission to read folders on disk.

Our own handler maps an ID to a file, sets the type and caching headers, and serves nothing else.

**Making it feel instant:**
- The crate draws only the sleeves near the front, as the prototype does.
- It asks WebKit to decode the next few sleeves' images (`img.decode()`) before they come into view, so no frame waits on a JPEG.
- Pulling a record out shows the 640 at once and swaps in the 1600 when it's decoded.

**Filling the existing collection.** On first launch after the update, every album without local artwork joins the queue. iTunes allows about 20 requests a minute, so a collection of 100 albums takes around five minutes. Meanwhile the crate shows Spotify's cover, which the cache already has, with a neutral palette. Each sleeve updates in place when its own artwork arrives.

### 3. Genre and label

Spotify no longer gives either to apps in development mode: album genres are always empty, and `label` has been removed. So both come from elsewhere, as steps in the album job queue:
- **Genre: iTunes's `primaryGenreName`,** found by UPC lookup (`/lookup?upc=`). It's one coarse genre that's always there ("Alternative", "Jazz", "Electronic"), which is exactly what a crate divider wants. We already call iTunes for artwork, so it's often the same request.
- **Label: MusicBrainz's `label-info`,** from the release found by barcode, for example "XL Recordings". If MusicBrainz has nothing, the label comes from iTunes's `copyright` text, with the year and ℗/© stripped.

Both are stored in the album cache. Sorting the crate by genre puts albums with no genre under "Unsorted".

Finer genres and styles (MusicBrainz genres, Discogs styles) are for the album pipeline project.

### 4. The UI: the prototypes become the app

The app's UI is rebuilt from `prototypes/crate`, component by component, on the real Tauri commands. PR #16 copied the app's command types into the prototype on purpose (`src/connect/api.ts`), so the port swaps the pretend Spotify for the real one.

**What comes over:**
- **The crate:** flipping with the scroll wheel and arrow keys, handwritten dividers, and sorting by genre, artist or decade. Only the sleeves near the front are drawn.
- **The sleeve:** pull out, turn over to the tracklist in sides, pick a track.
- **The needle drop:** pressing a track turns the record to its front and warms the glow to a third, with "starting" and the clock held at 0:00. When Spotify confirms, the glow comes up fully. Space pauses, and ← → skip.
- **Now playing:** the floating sleeve in its glow. It follows changes made from your phone, and the record turns back to its tracklist when the music stops under it.
- **A stranger's record:** Spotify plays something outside the collection, and it rises in a plain paper sleeve with Spotify's cover, a neutral glow and **Add to the crate**.
- **Search:** a full-screen wall of covers, with records already in the crate dimmed, **More**, and one-click add with its flourish. On first run Deadwax goes straight to search.
- **Where the sound plays:** out of sight while the remembered device works. You change it by clicking "on Kitchen", by clicking the device on the playing chip, or with D. A missing device gets the existing sentence, in the small device list where you pressed play.
- **Errors:** one quiet line at the top that fades after 8 seconds, and "Spotify isn't answering" after two failed polls.
- **Account:** plain centred cards for client ID setup, sign-in, waiting for the browser, signed out and expired.
- **The gatefold:** liner notes that unfold sideways, with the four type styles, finding the playing track. See section 5.

**What the back end gains**, from PR #16's list of gaps:
- **`NowPlaying` carries the track's Spotify ID, disc and track number,** so the sleeve highlights the right track exactly instead of matching by title. Spotify still sends all three.
- **A transfer command** (`PUT /me/player`) moves playback to another device and keeps the position. Without it, changing device restarts the track. It's still available in development mode.
- **Plain error sentences.** The network error becomes "Couldn't reach Spotify. Check the connection, then try again." instead of exposing the HTTP library's text. Other failures keep their sentences.
- **An expired sign-in from any command** sends the UI back to the sign-in card. Today only `get_session` notices it.

**What goes:**
- The grid, the album page, the playback bar and the dropdown device picker.
- The macOS fullscreen command. The window can still go fullscreen the normal way, but now playing no longer forces it.
- The Develop menu stays (Reset, Restore, Artwork report). The prototype's dev panel stays only as the mocked back end used in tests, not in the app.

**Performance first.** The first UI ticket is a spike: the crate and the pulled-out sleeve in the real app, with your real collection, measured in Safari's Web Inspector. Its Frames timeline shows every frame against the 16 ms line that 60 fps needs. Will found the prototype sluggish in Chrome, and PR #16 lists the likely costs:
- the 3D crate still compositing under the search overlay;
- five drifting full-screen gradients in the glow;
- `backdrop-filter` blur;
- the paper grain;
- a poll replacing the playback state every 2 seconds even when nothing changed.

The spike's job is to meet the target in the next section, simplifying effects until it does. Pre-drawn texture images instead of live blur and gradients is the first thing to try, which was already #9's lesson. What it learns goes into `DESIGN.md`. The rest of the UI isn't built until the spike passes.

**The target ("frame budget"):**
- A steady 60 fps while flipping through the real collection and the 400-record stress test.
- A pulled-out sleeve's large artwork drawn within 100 ms.
- The glow's drift never dropping a frame.

These are a starting point (Will's call). We'll tighten them if they turn out to be too easy.

### 5. Liner notes in the app

The gatefold comes over as a reader. The UI asks Rust for an album's notes with a `get_notes` command, because the UI never fetches anything itself. Rust reads `notes/<deadwax-id>.json` from the app-data folder:
- If the file exists, the sleeve shows **Liner notes**.
- If it doesn't, nothing shows.
- A file that doesn't match the notes schema is reported to the Develop menu and treated as no notes, never as a broken page.

The five essays from PR #9 move out of the repository and into that folder:
- a Develop menu item, "Import prototype notes", matches them to albums in the collection by title and artist;
- the schema stays as PR #9 defined it (`Notes` in `types.ts`).

Writing new notes, and the album builder's components, belong to the AI album builder project. This RFC only gives it a place to put its output.

### 6. `DESIGN.md` starts here

RFC-001 left `DESIGN.md` to project 2. It starts with what the prototypes settled:
- the colour rules (OKLCH, 7:1 and 4.5:1, the glow);
- the type styles;
- the frame budget and the performance lessons from the spike;
- the interaction patterns from PR #16: the needle drop, the stranger's sleeve, the device that stays out of sight, the quiet line, and plain account cards.

Design decisions are logged from now on, with the `work-ticket` skill's design steps switched back on.

**Album colours are data, not design tokens.** CLAUDE.md says colours live only in `theme.css`, and the lint fails on a colour in a `style` prop. A sleeve's printed colours and the glow come from each cover, so they can't be in `theme.css`. The proposal:
- Rust returns the palette as data.
- One component, `AlbumColours`, sets it as CSS custom properties (`--album-ink`, `--album-glow-1` and so on) on the sleeve.
- All other CSS uses only those properties and `theme.css`.
- The lint allows colours in `style` props in that one file and nowhere else.

### 7. Order of work

1. Deadwax IDs (chore).
2. Local artwork: the download, the sizes, the `cover://` scheme, the backfill.
3. The palette in Rust.
4. Genre and label.
5. **The performance spike:** the crate and the sleeve in the app, against the frame budget. `DESIGN.md` starts.
6. The crate and the sleeve in full, with sorting and dividers.
7. Playing: the needle drop, now playing, the stranger's record, NowPlaying's track IDs.
8. Where the sound plays, with the transfer command.
9. Search and add, and first run.
10. Account cards and quiet errors.
11. The gatefold and the notes import.
12. Delete `prototypes/crate` and the old components, and tidy up.

Steps 2–4 are back end only, so the old UI keeps working on top of them. From step 5, each ticket replaces part of the old UI. The app always runs, and it's always usable for playing an album. Steps 3 and 4 can run alongside each other, and so can 8, 9 and 10.

## What it looks like to you

You open Deadwax and your collection is a crate. You scroll and the records flip past, with a handwritten divider for Jazz, then Electronic. Every sleeve is sharp the moment it comes into view: nothing loads.

You pull out *In Rainbows* and it turns over to its back: Side A, Side B, the label (XL Recordings) and the year. You press "Reckoner". The record turns to its front, the glow warms a little and the clock waits at 0:00. A moment later the Sonos starts, the glow comes up in the cover's colours, and the clock runs.

Your partner skips a track from their phone. The title on the sleeve moves with it. Later they put on something that isn't in your crate. It rises in a plain paper sleeve, and a quiet **Add to the crate** sits on the line below.

You want it in the kitchen instead. You click "on Living Room", pick Kitchen, and it carries on from where it was.

You press the search icon. A wall of covers comes up, and the albums you already have are dimmed. You add two. Each one drops toward the crate, and when you close search the crate is turned to the last one you added. A few seconds later its sleeve has its own colours.

On *Pink Moon* there's a **Liner notes** button. The sleeve opens like a gatefold and the essay unfolds, with the playing track marked.

If Spotify stops answering, one quiet line says so at the top and fades. The crate, the sleeves and the notes all keep working.

## Alternatives considered

- **Swap the prototype's code in whole and wire it up afterwards.** It's the quickest way to see it, but it would drop the tests and lint in one big step and leave the app half-working until the end. The gaps PR #16 found (track IDs, transfer, genres, the colour rule) would be hidden instead of decided.
- **Load covers on demand and store only their colours** (RFC-001's approach). Every flip would wait on Apple's servers, and the prototype only felt good with local covers. It loses on the main requirement.
- **Tauri's asset protocol for local images.** It's built in, but it has no caching headers, it sniffs each file's type and reads the whole file on every request, and it needs a broad folder permission (see section 2).
- **The `localhost` plugin**, which serves the app from a local web server. It opens a network port for something a custom scheme does without one.
- **Working out the palette in the UI from local images**, as the prototype does with a canvas. That would mean reading pixels in the UI on every launch. In Rust it's done once, tested, and stored. Off-the-shelf palette crates (`kmeans_colors`, `color-thief`) were considered, but we already tuned the prototype's own method by eye on these covers, so we port it, using the `palette` crate for the OKLCH maths.
- **Genre from MusicBrainz or Discogs.** MusicBrainz genres are richer but patchy: none for Kiasmos's *Blurred* in a live test. Discogs has the best styles but needs a personal token stored as a secret, and we couldn't check its terms. iTunes always has one coarse genre, which suits dividers. The others are for the pipeline project.
- **AVIF or WebP for the sizes.** Smaller files, which don't matter on a local disk, but slower to decode, which matters while flipping. Lossy WebP also needs a C library.
- **Keep Spotify IDs as the album identity until the local media project.** It's cheaper today, but every ticket in this RFC adds code keyed by Spotify IDs, so the migration only gets bigger.
- **Split this into several RFCs** (artwork, then UI). Each half on its own isn't something Will would use: local artwork under the old grid changes nothing visible, and the new UI without local artwork is the sluggish prototype. It's one large project of about twelve tickets.

## Risks & unknowns

- **The frame budget may not be reachable with every effect.** WebKit composites 3D scenes differently from Chrome, and nobody has measured the prototype in it. We'd simplify effects in this order: live blur, then grain, then the glow's drift. The spike comes before the UI work so we find out early. *This is a guess at the cause, not a measurement.*
- **WebKit's caching of custom-scheme images is unconfirmed.** Apple leaves it to the web view. If the same image is re-read from disk on every flip, decoding ahead may not be enough. Then we'd keep decoded images for the sleeves near the front in memory.
- **Artwork disk use.** A 3000 px master plus three sizes is about 2–3 MB an album, so 500 albums is about 1–1.5 GB in Application Support. That's acceptable for a personal library. *The per-album figure is an estimate.*
- **The backfill is slow on a big collection** because of iTunes's limit of about 20 requests a minute. The crate still works with Spotify's covers meanwhile, and the Artwork report shows progress.
- **The schema migration touches every row.** It's tested against a copy of a real version-2 database, and it runs in one transaction.
- **Matching the five essays to albums by title** could miss one with an edition suffix. They're imported once by hand, so a miss is fixed by hand.
- **Size.** About twelve tickets is bigger than Foundations. If it drags, steps 11 and 12 can move to the start of the next project without breaking anything.

## How we'll verify it

**Automated (Rust, against hand-written responses and temporary folders):**
- Migration: a version-2 database with albums, cache and artwork becomes version 3. Every album has a Deadwax ID, and its Spotify ID, date added, cache and artwork are unchanged. A failure part-way leaves version 2 intact.
- Commands take and return Deadwax IDs, and no command type exposes a Spotify ID as an album's identity, except on its Spotify-source field.
- Artwork: a fake image server's image produces the three sizes and a master of the right pixel dimensions. A failed download stores nothing and retries later. Removing an album deletes its folder.
- `cover://`: a known ID and size returns the file with the right type and caching headers. An unknown ID, an unknown size or a path like `../` returns 404.
- Palette: for a set of test images (very dark, very light, monochrome, saturated), ink is at least 7:1 and accent and secondary text at least 4.5:1 against the paper. The Rust palette matches the prototype's for the same image, within a small tolerance.
- Genre and label: a recorded iTunes UPC lookup gives "Alternative". A recorded MusicBrainz release gives "XL Recordings". The copyright fallback strips "℗ 2007". An album with no genre sorts under "Unsorted".
- Playback: `NowPlaying` carries the track's ID, disc and number. The transfer command sends one device ID and the play state. The network error sentence is the plain one.
- Notes: a valid file is returned, a missing file returns none, and an invalid file returns none and is reported.
- The existing checks stay green: tokens never leave Rust, 429 waits for Retry-After, and the release build has no dev list or Develop menu.

**Automated (UI, against the mocked back end):**
- The crate sorts by genre, artist and decade, with dividers and counts.
- The sleeve turns over, and picking a track calls `play_album` with the track's real Spotify ID.
- The needle drop shows "starting" until the mocked playback confirms. A track change from elsewhere moves the highlight.
- A stranger's record shows **Add to the crate**, and adding it turns it into a sleeve.
- Search dims records already in the crate, and adding calls `add_album`.
- A missing device shows the sentence where you pressed play. Choosing a new device mid-play calls transfer.
- An error shows one quiet line that fades. An expired sign-in from any command shows the sign-in card.
- The gatefold shows for an album with notes and not for one without.
- The lint rejects a colour in a `style` prop anywhere except `AlbumColours`.

**Manual (Will):**
1. After the migration, your collection, dates and artwork are all still there.
2. The backfill: watch sleeves pick up their own artwork and colours. The Artwork report reaches every album.
3. Flip through the real collection and through `?many`, with the Frames timeline open. Do you see a steady 60 fps, and large artwork within 100 ms of pulling a record out?
4. Play an album on the Sonos: the needle drop, then confirmation. Skip from your phone, and change device mid-track. Does it carry on from the same place?
5. Put on something from outside the collection from your phone, then add it from the stranger's sleeve.
6. Search, add two albums, and close search.
7. Turn the Wi-Fi off. Does the crate still work, with one quiet line?
8. Open the liner notes for one of the five albums while it plays.

## Open questions

1. **Resolved: yes, except Spotify's own covers.** Will's call on 2026-10-17. Artwork from other sources can have wear, Spotify's covers stay unaltered, and Open in Spotify stays on every sleeve and on now playing. Was: **can covers be worn and blurred?** RFC-001 said covers are shown as they are: no blur, overlays or cropping, to meet Spotify's rule for its content. The prototype puts wear on sleeves and blur behind some controls. Most covers now come from Apple, Deezer or the Cover Art Archive, and Spotify's rule covers Spotify's content. **Recommendation:** allow wear on artwork from other sources, which is most sleeves. Keep Spotify's own covers unaltered: the stranger's sleeve and any album that fell back to Spotify's cover. Keep **Open in Spotify** on every sleeve and on now playing.
2. **Resolved: yes, through `AlbumColours` only.** Will's call on 2026-10-17. Was: **may album colours go in a `style` prop through one component?** This needs CLAUDE.md's colour rule and the lint to allow one exception (section 6). **Recommendation:** yes. The alternative is generating CSS classes for every album at runtime, which is the same thing with more machinery.
3. **Resolved: yes, in the last ticket.** Will's call on 2026-10-17. Was: **delete `prototypes/crate` at the end?** **Recommendation:** yes, in the last ticket. It's in git history, and keeping a second copy of the UI invites drift. The fixture script and the dev panel's scenarios live on in the UI tests' mocked back end.
4. **Resolved: no, a real sleeve with its palette but no wear.** Will's call on 2026-10-17. Was: **should the glow and the sleeve treat a Spotify-fallback cover differently?** These are albums where no other source had artwork. **Recommendation:** no. Give it a real sleeve with its palette but no wear (as in 1), so it reads as yours. If it turns out to look wrong, revisit it in `DESIGN.md`.

## New terms

- **Deadwax ID:** the identifier Deadwax gives an album when it's added. It never changes, and it doesn't depend on Spotify or any other source.
- **Vertical slice:** a piece of work that goes through every layer (data, back end, UI) thinly enough to ship something usable end to end.
- **Rendition:** one of the sizes Deadwax makes from an album's artwork, so each place draws an image no bigger than it needs.
- **Custom URL scheme:** a made-up kind of address, like `cover://`, that the app answers itself, so the UI can load local files through Rust.
- **Album job queue:** the background worker that runs each new album's steps (artwork, sizes, palette, genre and label) and records which have finished.
- **Album palette:** the colours worked out from an album's cover, used for its sleeve's printing and its glow, with guaranteed contrast for text.
- **OKLCH:** a way of describing colour by lightness, chroma and hue, where equal steps look equally different, which makes contrast predictable.
- **Frame budget:** the time the app has to draw each frame, 16 ms at 60 fps. Anything slower shows as stutter.
- **Crate:** the collection shown as records you flip through, sorted and divided by genre, artist or decade.
- **Needle drop:** the moment between pressing a track and Spotify confirming it's playing, shown by the record settling and the glow warming.
- **Stranger's record:** something Spotify is playing that isn't in the collection, shown in a plain paper sleeve with an Add to the crate button.
- **Gatefold:** the liner-notes view, where the sleeve opens out and the essay unfolds sideways panel by panel.
- **Transfer playback:** moving whatever Spotify is playing to another device without restarting it.
