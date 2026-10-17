# Project: The crate

**Status:** Created · **RFC:** [RFC-002](../rfcs/rfc-002-the-crate-for-real.md) · **Notion:** https://app.notion.com/p/The-crate-3fc3af969b6f816ea4d7dcb82c43a503

## Goal

Deadwax becomes the crate prototype, playing real music. You flip through your own collection as a crate of records with genre dividers, pull one out, turn it over and drop the needle. It plays on your Sonos through Spotify Connect while the record floats in a glow of its own colours. Search, choosing where the sound plays, the account screens and the liner notes work as PR #16 and PR #9 designed them.

Underneath, there are three changes:
- albums have Deadwax IDs;
- artwork is stored locally in sizes, with its palette;
- every album has a genre and a label.

The app works after every ticket. At the end, `prototypes/crate` and the old UI are gone, and `DESIGN.md` exists.

## Tickets

### 1. [DWX-17] Give albums their own Deadwax IDs (Chore)

**Goal:** Every album has a Deadwax ID that never changes. The Spotify ID becomes where the album plays, not what it is. Nothing looks different.

**Acceptance criteria**
- [ ] A schema migration (version 2 to 3) gives every album a Deadwax ID and keeps its Spotify ID, date added, cache and artwork. It runs in one transaction. Tests:
  - a version-2 database with albums, cache and artwork migrates with everything intact;
  - a failure part-way leaves version 2 untouched.
- [ ] Every command takes and returns Deadwax IDs, including `NowPlaying.albumId`, the `artwork-found` event and the Develop menu's commands. Only the Spotify client sees Spotify IDs.
- [ ] A test fails if a command type uses a Spotify ID as an album's identity, other than on its Spotify-source field.
- [ ] The dev list keeps Spotify IDs. Restoring from it makes new Deadwax IDs and keeps the dates added. Tested.
- [ ] The existing UI works exactly as before: search, add, open, remove, play, now playing, Artwork report. Its tests pass on the new IDs.

**Out of scope:** Local artwork (ticket 2). Any visible change.

**Depends on:** Nothing.

**Context:** RFC-002, "1. Deadwax's own album IDs" and "How we'll verify it" (migration, commands).

### 2. [DWX-18] Keep each album's artwork locally, in sizes (Feature)

**Goal:** When an album is added, Rust downloads its best cover and makes sizes from it. The UI loads them from disk through `cover://`, so the grid and the album page show artwork instantly, even offline. Albums already in the collection catch up in the background.

**Acceptance criteria**
- [ ] The artwork queue becomes the **album job queue**. Each album records which steps have finished, and a failed step stores nothing and is retried later. Downloading and making sizes is the first step after lookup.
- [ ] Sizes come from `image` and `fast_image_resize`: JPEGs at 320, 640 and 1600 pixels, plus a master capped at 3000. Release builds keep them in `artwork/<deadwax-id>/` in app data, and development builds in `.dev-data/`. Removing an album deletes its folder. Tests run against a fake image server and temporary folders, and check pixel sizes.
- [ ] `cover://localhost/<deadwax-id>/<size>` serves the file with the right type and caching headers. An unknown ID, an unknown size or `../` returns 404. Tested.
- [ ] On first launch after the update, every album without local artwork is queued. Until its artwork arrives, its Spotify cover shows, then the cover updates in place.
- [ ] The grid uses the 320 and the album page the 1600. The Develop menu's report shows each album's steps and their status.

**Out of scope:** The palette, genre and label (ticket 3). Decoding images ahead of time in the crate (ticket 4).

**Depends on:** 1.

**Context:** RFC-002, "2. Local artwork, in sizes" (except Palette), and "Risks & unknowns" (disk use, backfill).

### 3. [DWX-19] Work out each album's palette, genre and label (Feature)

**Goal:** Two new steps in the album job queue:
- one ports the prototype's palette to Rust, so each album has its sleeve's printed colours and its glow colours, with guaranteed contrast;
- the other finds each album's genre from iTunes and its label from MusicBrainz.

The Develop menu's report shows them.

**Acceptance criteria**
- [ ] `palette.ts` is ported to Rust, using the `palette` crate for OKLCH, and runs on the 320. Tests on very dark, very light, monochrome and saturated images check that ink is at least 7:1 against the paper, and accent and secondary text at least 4.5:1. For the same images, the Rust palette's key colours are within 2 units on each RGB channel of the prototype's, and the contrast targets are always met exactly.
- [ ] Genre comes from iTunes's `primaryGenreName`, found by UPC lookup. Label comes from MusicBrainz's `label-info`, found by barcode. If MusicBrainz has nothing, the label comes from iTunes's `copyright`, with ℗/© and the year stripped. Tested against recorded responses, including the fallback.
- [ ] Both respect their sources' rate limits (iTunes about 20 a minute, MusicBrainz one a second), and lookups share requests with the artwork step where they can.
- [ ] The palette, genre and label are stored with the album, and existing albums are backfilled through the queue.
- [ ] The Develop menu's report shows each album's swatches, genre and label.

**Out of scope:** Showing the palette in the UI (tickets 4 and 5). Finer genres or styles (the album pipeline project). AI colour choice (the AI album builder project).

**Depends on:** 2.

**Context:** RFC-002, "2. Local artwork" (Palette) and "3. Genre and label". Palette parity: resolved open question 2.

### 4. [DWX-20] Measure the crate in WebKit against the frame budget (Spike)

**Goal:** Put the prototype's crate and pulled-out sleeve in the real app, on your real collection's local artwork and palettes. Measure them in Safari's Web Inspector and simplify effects until they meet the frame budget. The output is `DESIGN.md` with the measurements and the performance rules that came out of them.

**Timebox:** Two days.

**Acceptance criteria**
- [ ] The crate (flipping, dividers, only the sleeves near the front drawn, upcoming images decoded ahead with `img.decode()`) and the pulled-out sleeve with its glow run in a development build. They're measured with the Frames timeline on the real collection and on a 400-record crate.
- [ ] `DESIGN.md` exists. It records:
  - the frame budget (a steady 60 fps while flipping, large artwork within 100 ms, the glow's drift dropping no frames);
  - the measurements before and after each simplification;
  - the rules that came out of them, for example which effects are allowed in a 3D scene.
- [ ] Each effect PR #16 flagged has a verdict, with the measurement: the 3D crate under the search overlay, the glow's gradients, `backdrop-filter`, the grain, and redrawing on every poll.
- [ ] If the budget can't be met, the findings say which effects were cut and what's left. Will decides before ticket 5 starts.
- [ ] The merged PR contains `DESIGN.md` and any measuring tools worth keeping. The spike's UI code is thrown away or kept behind the dev build, not wired into the app.

**Out of scope:** Building the crate for real (ticket 5). Search, playing and the gatefold.

**Depends on:** 3.

**Context:** RFC-002, "4. The UI" (Performance first and the frame budget), "6. `DESIGN.md` starts here", and "Risks & unknowns" (frame budget, caching).

### 5. [DWX-21] Replace the grid and album page with the crate and the sleeve (Feature)

**Goal:** The collection is a crate. You flip through it, sorted by genre, artist or decade with handwritten dividers, pull a record out and turn it over to its tracklist in sides. Picking a track plays it, still through today's device picker and playback bar. The grid and the album page are gone.

**Acceptance criteria**
- [ ] The crate follows ticket 4's rules. It sorts by genre (albums with none go under "Unsorted"), artist or decade, and its dividers show counts. UI tests run against the mocked back end.
- [ ] The sleeve pulls out, turns over to its tracklist in sides, and shows the label and year. Picking a track calls `play_album` with that track's real Spotify ID. Tested.
- [ ] **Album colours:** one component, `AlbumColours`, sets the palette as CSS custom properties. CLAUDE.md's colour rule and the lint allow colours in a `style` prop in that file only. A test proves the lint rejects them anywhere else.
- [ ] Wear appears on artwork from other sources, but never on Spotify's covers. **Open in Spotify** is on every sleeve. A quiet "Take it out of the crate" at the foot of the sleeve's back, under **Open in Spotify**, removes the album after a confirmation. Tested.
- [ ] The grid, the album page and their tests are removed. `DESIGN.md` gains the crate and sleeve patterns.
- [ ] It meets the frame budget in the Frames timeline, with the numbers in the PR.

**Out of scope:** The needle drop, now playing and the glow while playing (ticket 6). Search (ticket 8).

**Depends on:** 4.

**Context:** RFC-002, "4. The UI" (the crate, the sleeve, What goes), "6. `DESIGN.md`" (album colours), and resolved open questions 1, 2 and 4.

### 6. [DWX-22] Drop the needle, and play in the glow (Feature)

**Goal:** Pressing a track drops the needle. The record turns to its front, the glow warms, and when Spotify confirms the glow comes up fully and the clock runs. Now playing is the floating record in its glow, and it follows changes made from your phone. Something outside the collection rises in a stranger's sleeve. The playback bar, the old now playing view and the fullscreen command are gone.

**Acceptance criteria**
- [ ] `NowPlaying` carries the track's Spotify ID, disc and number. The sleeve highlights the playing track by ID. Tested in Rust and in the UI.
- [ ] The needle drop shows "starting" with the clock at 0:00 until the mocked playback confirms. Space pauses, and ← → skip. Tested.
- [ ] Changes made elsewhere are followed:
  - a skip moves the highlight;
  - a new album swaps the record;
  - a pause shows "paused";
  - when the music stops, the record turns back to its tracklist.

  An advert shows as "An advert". Tested.
- [ ] A stranger's record rises in a plain sleeve with Spotify's cover, unaltered, a neutral glow and **Add to the crate**. Adding it turns it into a real sleeve. Tested.
- [ ] Polling doesn't redraw when nothing changed, and the clock redraws only its own line, as PR #16 recommended. **Open in Spotify** is on now playing.
- [ ] `PlaybackBar`, `NowPlaying`, `set_now_playing_fullscreen` and their tests are removed. `DESIGN.md` gains the needle drop and the stranger's sleeve.

**Out of scope:** Choosing devices differently and transfer (ticket 7). Quiet errors (ticket 9).

**Depends on:** 5.

**Context:** RFC-002, "4. The UI" (the needle drop, now playing, a stranger's record, What the back end gains: track IDs).

### 7. [DWX-23] Keep the device out of sight, and transfer between them (Feature)

**Goal:** Play just plays on the remembered device. You change it only on purpose, and a running track moves to the new device without restarting. A missing device is explained where you pressed play. The dropdown device picker is gone.

**Acceptance criteria**
- [ ] With a remembered device, Play goes straight there. The first play with none asks once: "Where should it play?" Tested.
- [ ] You can change device from the "on Kitchen" line, from the device on the playing chip, or with D, all through the same small device list. Tested.
- [ ] A transfer command (`PUT /me/player` with one device ID) moves playback and keeps the position. Choosing a device while something plays calls it. Tested against hand-written responses and in the UI.
- [ ] A missing device shows the existing sentence in the device list, and picking another plays there. Tested.
- [ ] `DevicePicker` and its tests are removed. `DESIGN.md` gains the device that stays out of sight.

**Out of scope:** Search and account screens.

**Depends on:** 6.

**Context:** RFC-002, "4. The UI" (Where the sound plays, What the back end gains: transfer).

### 8. [DWX-24] Search as a wall of covers, and go straight there on first run (Feature)

**Goal:** A faint search icon opens a full-screen wall of covers. Albums you already have are dimmed, and adding one sends it into the crate with a flourish. An empty collection opens straight onto search. The old search box is gone.

**Acceptance criteria**
- [ ] The search overlay shows results as a wall, with **More** at the end and records already in the crate dimmed with "In your crate". Tested against the mocked back end.
- [ ] Add calls `add_album` and plays the flourish. Closing search turns the crate to the last record added. Tested.
- [ ] While search is open, the crate is hidden or unmounted, following ticket 4's verdict. It meets the frame budget.
- [ ] With an empty collection, Deadwax opens on search with "Your crate is empty. Find the first record for it." Closing it leaves the same line and a button. Tested.
- [ ] `Search` and its tests are removed. `DESIGN.md` gains the search wall.

**Out of scope:** Account screens and errors (ticket 9).

**Depends on:** 5. It can run alongside 6, 7 and 10.

**Context:** RFC-002, "4. The UI" (Search) and "What it looks like to you".

### 9. [DWX-25] Plain account cards and one quiet line for errors (Feature)

**Goal:** Client ID setup, signing in, waiting for the browser, signed out and expired are plain centred cards. Spotify's errors are one quiet line that fades, and the crate keeps working while Spotify is unreachable.

**Acceptance criteria**
- [ ] The account cards replace `Setup` and `SignIn`. They cover setup, sign-in, waiting for the browser, signed out and expired. Tested against the mocked back end.
- [ ] A command failing because the sign-in expired, from anywhere, shows the expired card. Tested.
- [ ] Errors show as one line at the top that fades after 8 seconds. Two failed polls in a row show "Spotify isn't answering. Deadwax will keep trying." Tested with a fake clock.
- [ ] The network error sentence becomes "Couldn't reach Spotify. Check the connection, then try again." The other sentences are checked against what Rust really says. Tested in Rust.
- [ ] With the network off, the crate, the sleeves and the liner notes still work (Will's manual check). `DESIGN.md` gains the quiet line and the account cards.

**Out of scope:** The Develop menu's dialogs, which stay as they are.

**Depends on:** 6. It can run alongside 7, 8 and 10.

**Context:** RFC-002, "4. The UI" (Errors, Account, What the back end gains: errors and expired sign-in).

### 10. [DWX-26] Open the liner notes in a gatefold (Feature)

**Goal:** An album with a notes file has **Liner notes** on its sleeve. It opens like a gatefold and the essay unfolds sideways, finding the playing track. The five essays from PR #9 are imported from the Develop menu.

**Acceptance criteria**
- [ ] A `get_notes` command reads `notes/<deadwax-id>.json` from app data. It returns the notes, or none for a missing or invalid file, and reports an invalid file to the Develop menu. Tested in Rust.
- [ ] The gatefold shows for an album with notes and not for one without. It has the four type styles, and it highlights where the essay mentions the playing track. Tested against the mocked back end.
- [ ] "Import prototype notes" in the Develop menu matches the five essays to albums in the collection by title and artist, and reports any it couldn't match. It's compiled only into development builds. Tested.
- [ ] The notes schema stays as PR #9 defined it. `DESIGN.md` gains the gatefold.

**Out of scope:** Writing new notes, and the album builder's components (the AI album builder project).

**Depends on:** 5. It can run alongside 6 to 9.

**Context:** RFC-002, "5. Liner notes in the app".

### 11. [DWX-27] Finish `DESIGN.md` and delete the prototype (Chore)

**Goal:** The app does everything `prototypes/crate` did, so the prototype goes. Its test scenarios live on in the mocked back end. `DESIGN.md` reads as one document, and design decisions are logged from now on.

**Acceptance criteria**
- [ ] Each of the prototype's dev-panel scenarios is covered by a UI test against the mocked back end, or listed with a reason why not. These include slow play, a sleeping device, a skip from the phone, a stranger, an advert, the errors and an empty collection.
- [ ] `prototypes/crate`, its launch configuration and anything else that only served it are deleted. Every check passes.
- [ ] `DESIGN.md` is consistent from end to end: the colour rules, the type, the frame budget, and the patterns tickets 5 to 10 added. CLAUDE.md's Design section points to it and drops the "project 1 has no `DESIGN.md`" lines.
- [ ] The `work-ticket` skill's design steps (the tokens and the provisional design decisions log) are switched back on, with a Process log entry.

**Out of scope:** New design work.

**Depends on:** 6, 7, 8, 9, 10.

**Context:** RFC-002, "6. `DESIGN.md` starts here" and resolved open question 3.

## Order and checkpoints

```
1 ──► 2 ──► 3 ──► 4 ──► 5 ──┬──► 6 ──┬──► 7 ──┐
                            │        └──► 9 ──┤
                            ├──► 8 ───────────┼──► 11
                            └──► 10 ──────────┘
```

- **1 to 5 run in order.** Tickets 1 to 3 are back end work under the old UI, which keeps working. Ticket 4 is the gate for all the UI work.
- **After 5, the work can run in parallel:** 6, 8 and 10 can run alongside each other. 7 and 9 follow 6. 11 comes last.
- **If only one runs at a time:** 6, then 7, 8, 9 and 10. Playing comes first because it's what you'll use most.
- **Checkpoint after 1:** everything works as before. Your collection and dates are all still there (manual check 1).
- **Checkpoint after 3:** the Develop menu's report shows every album's local artwork, swatches, genre and label. Turn the Wi-Fi off: the grid still shows every cover (manual check 2).
- **Checkpoint after 4:** read `DESIGN.md`'s measurements, and decide on any effects that were cut (manual check 3, first pass).
- **Checkpoint after 5:** flip through your real crate and pull records out (manual check 3).
- **Checkpoint after 6:** play an album on the Sonos, skip from your phone, then put on something outside the collection and add it (manual checks 4 and 5, without transfer).
- **Checkpoint after 7:** change device mid-track. Does it carry on from the same place (manual check 4)?
- **Checkpoint after 8:** search and add two albums (manual check 6).
- **Checkpoint after 9:** turn the Wi-Fi off. You should see one quiet line, and the crate should still work (manual check 7).
- **Checkpoint after 10:** open the liner notes for one of the five albums while it plays (manual check 8).

## Coverage

| RFC-002 verification item | Ticket |
|---|---|
| Migration 2 → 3 keeps everything; a failure leaves version 2 | 1 |
| Commands use Deadwax IDs; no command uses a Spotify ID as identity | 1 |
| Artwork: sizes and master at the right dimensions, failure retried, folder deleted on remove | 2 |
| `cover://`: headers, 404 for unknown ID, size or `../` | 2 |
| Palette: contrast on test images; matches the prototype | 3 |
| Genre and label: iTunes, MusicBrainz, copyright fallback, "Unsorted" | 3, 5 |
| `NowPlaying` carries track ID, disc and number | 6 |
| Transfer sends one device ID | 7 |
| Plain network error sentence | 9 |
| Notes: valid, missing, invalid | 10 |
| Existing checks stay green (tokens, 429, release build) | every ticket |
| UI: crate sorting, dividers, counts | 5 |
| UI: sleeve turns, track plays with its real Spotify ID | 5 |
| UI: needle drop, a change from elsewhere moves the highlight | 6 |
| UI: stranger's record and Add to the crate | 6 |
| UI: search dims records in the crate, add calls `add_album` | 8 |
| UI: missing device message; changing device mid-play calls transfer | 7 |
| UI: quiet line fades; expired sign-in shows the card | 9 |
| UI: gatefold for an album with notes only | 10 |
| Lint rejects a `style` colour outside `AlbumColours` | 5 |
| Manual 1: migration keeps your collection | 1 |
| Manual 2: backfill reaches every album | 2, 3 |
| Manual 3: 60 fps and 100 ms in the Frames timeline | 4, 5 |
| Manual 4: Sonos, phone skip, change device mid-track | 6, 7 |
| Manual 5: stranger's record, then add it | 6 |
| Manual 6: search and add two | 8 |
| Manual 7: Wi-Fi off | 9 |
| Manual 8: liner notes while playing | 10 |

Every part of the Proposal is covered by a ticket.

## Not in this project

- **The album pipeline:** finer genres and styles (MusicBrainz genres, Discogs), more artwork sources, asset optimisation beyond the sizes, and lyrics.
- **The AI album builder:** writing notes, the gatefold's components and layout choices, and AI colour choice on top of the palette.
- **Now playing that reacts to the music,** including the microphone spike.
- **Local media and the Player interface.** Deadwax IDs (ticket 1) prepare for it.
- **Signing and distributing the app.**

## Open questions

1. **Resolved: at the foot of the sleeve's back.** Will's call on 2026-10-17. Was: **where does removing an album go?** The prototype has no remove, and the album page that has it today is replaced in ticket 5. **Recommendation:** a quiet "Take it out of the crate" at the foot of the sleeve's back, under **Open in Spotify**, asking for confirmation, so it's there when you need it and invisible while you're digging.
2. **Resolved: within 2 units per RGB channel, with contrast met exactly.** Will's call on 2026-10-17. Was: **how close must the Rust palette be to the prototype's?** Exact matches are unlikely, because of rounding and a different colour library. **Recommendation:** within 2 units on each RGB channel for the key colours, with the contrast targets always met exactly. Will compares a few albums side by side in the Develop report at the ticket 3 checkpoint.
3. **Resolved: one project of eleven tickets.** Will's call on 2026-10-17. Was: **eleven tickets is above the usual range** (4 to 8, and more than 10 means something's too small or the RFC's too big). RFC-002 expected about twelve. **Recommendation:** keep one project. Every ticket is a real PR and the order matters. As the RFC suggested, if it drags, 10 and 11 can move to the start of the next project.
