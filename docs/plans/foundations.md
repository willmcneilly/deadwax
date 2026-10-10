# Project: Foundations

**Status:** Created · **RFC:** [RFC-001](../rfcs/rfc-001-foundations.md) · **Notion:** https://app.notion.com/p/Foundations-3f53af969b6f819686cbe6437cf2c349

## Goal

Build the rough end-to-end player from RFC-001. You sign in with Spotify, search for albums, add them to a collection, open one, and play it on your Sonos, the TV or the Spotify app. A full-screen now playing view shows the sharpest cover we can find. Under it are the repository, the checks and the dev tooling the next project builds on. The project ends with a findings write-up on how reliable Sonos was, how often we found good artwork, and how it felt to use. It also says whether Deadwax feels right enough to carry on. If it does, the write-up is the starting point for RFC-002.

## Tickets

### 1. [DWX-1] Set up the repository, CI and agent guide (Chore)

**Goal:** The repository has its real shape: two Rust crates, a Tauri app that opens an empty Deadwax window, checks running on every PR, and a `CLAUDE.md` with real commands in place of the placeholders.

**Acceptance criteria**
- [ ] Cargo workspace (Rust 2024 edition) with `crates/deadwax-core` and `crates/deadwax-sources`, each building with a placeholder test. `rust-toolchain.toml` pins a stable Rust with `rustfmt` and `clippy`.
- [ ] `app/` holds a Tauri 2 app (React, strict TypeScript, Vite, npm), with its Rust side in `app/src-tauri`. `npm run tauri dev` opens an empty window titled "Deadwax". One component test runs against `@tauri-apps/api/mocks`.
- [ ] Styling is plain CSS with a handful of CSS variables in one file, as RFC-001 decided in place of `DESIGN.md`.
- [ ] GitHub Actions on `macos-15`, on PRs (and on `main` for caches), cancelling superseded runs:
  - `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`;
  - frontend typecheck, lint and test;
  - `tauri build`.
- [ ] `CLAUDE.md` has the real layout and commands. Its Design section says project 1 has no `DESIGN.md`: the whole UI is provisional, colours live only in the CSS variables, and no design decisions are logged. `.gitignore` covers `.dev-data/`. A `LICENSE` file (MIT) is added.
- [ ] This ticket's PR shows every check green.

**Out of scope:** Any Spotify, collection or UI behaviour. The fake-server test harness arrives with the first web client in ticket 2.

**Depends on:** Nothing.

**Context:** RFC-001, "The stack" and "Repository and checks"; open questions 2 (no `DESIGN.md`) and 4 (MIT).

### 2. [DWX-2] Sign in to Spotify (Feature)

**Goal:** The first time Deadwax opens, a setup screen asks for your Spotify client ID. You sign in through your browser, and Deadwax shows "Signed in as <your name>". It stays signed in across restarts, and the tokens never leave Rust.

**Acceptance criteria**
- [ ] A setup screen asks for the client ID, links to Spotify's dashboard with the registration steps, and saves the ID to a config file in the app-data folder. A menu item changes it later.
- [ ] PKCE sign-in in `deadwax-sources`: the browser opens with `tauri-plugin-opener`, and a one-shot listener on `127.0.0.1` at a free port catches the redirect and shows "you can close this tab". Tests:
  - the code challenge matches RFC 7636's worked example;
  - the listener extracts the code and rejects a reply whose `state` doesn't match.
- [ ] Tokens are stored in the macOS Keychain (`keyring` 4.x) behind a small trait. Tests use an in-memory store, never the real Keychain. A refresh test passes both with and without a new refresh token.
- [ ] When the refresh token is rejected (it expires after six months), Deadwax returns to the sign-in screen with a plain message, not an error.
- [ ] A shared Spotify HTTP client (`reqwest` 0.13) waits for `Retry-After` on a `429`. Test on a fake clock: `Retry-After: 2` retries after 2 seconds, and only then.
- [ ] A test lists every Tauri command's return type and fails if any can carry a token.

**Out of scope:** Search, the collection, and any other Spotify call beyond fetching your profile for the "Signed in as" line.

**Depends on:** 1.

**Context:** RFC-001, "Signing in to Spotify", "Spotify's 2026 limits" (rate limits) and open question 3 (setup screen). The client ID config and the Keychain entry are shared by every checkout, so a fresh worktree is already signed in. Unsigned dev builds may make the Keychain ask for permission after each rebuild. If so, note it for Will in the PR, with the fix if there's a cheap one.

### 3. [DWX-3] Search Spotify and add albums to the collection (Feature)

**Goal:** A search box above the collection finds albums on Spotify, ten at a time. "Add" puts an album in your collection, which shows as a grid of covers and survives restarts.

**Acceptance criteria**
- [ ] `deadwax-core` stores the collection in SQLite (`rusqlite` 0.40, bundled): Spotify ID and date added. Beside it is a metadata cache: title, artist, year, tracklist, Spotify's cover URLs, UPC, and when it was fetched. Tests: add, remove, and adding the same album twice behave correctly and survive reopening the database.
- [ ] Development builds keep the database in the checkout's `.dev-data/`, and release builds in the app-data folder. Tested with temporary folders.
- [ ] Search returns albums in pages of 10, with cover, title, artist and year. "More" asks for the next offset. Albums already in the collection are marked. Tested against recorded responses.
- [ ] "Add" fetches the album (one at a time, as Spotify now requires), stores it, and it appears in the grid. The grid uses Spotify's covers, shown as they are: no crop, blur or overlay.
- [ ] UI tests for the search results and the grid run against the mocked back end.

**Out of scope:** The album page and removing from the UI (ticket 4), the dev list (ticket 5), and high-res artwork (ticket 7).

**Depends on:** 2.

**Context:** RFC-001, "The collection", "Finding albums", "Spotify's 2026 limits" and "A dev list that survives resets" (database location only).

### 4. [DWX-4] Open an album, and remove it from the collection (Feature)

**Goal:** Clicking a cover opens the album page: the cover, title, artist, year, tracklist and an Open in Spotify link. You can remove the album from there.

**Acceptance criteria**
- [ ] The album page shows the cover (Spotify's for now), title, artist, year and tracklist, from the cache.
- [ ] Opening an album whose cache is over a week old fetches it again and updates the page. Tested with a fake clock and recorded responses.
- [ ] An "Open in Spotify" link opens the album on Spotify, through `tauri-plugin-opener`.
- [ ] "Remove" takes the album out of the collection and returns to the grid.
- [ ] UI tests for the album page run against the mocked back end.

**Out of scope:** Playing (ticket 6) and high-res artwork (ticket 7).

**Depends on:** 3.

**Context:** RFC-001, "The collection" (refreshable cache, removing) and "Spotify's attribution rules".

### 5. [DWX-5] Keep a dev list that survives resets (Feature)

**Goal:** Development builds mirror the collection to a dev list outside the repository, shared by every worktree. A Develop menu resets the collection and restores it, and a fresh worktree offers to restore on start.

**Acceptance criteria**
- [ ] In development builds, every add and remove updates the dev list (album IDs and dates added) in Deadwax's folder in `~/Library/Application Support`. Tested with temporary folders.
- [ ] When a development build starts with an empty collection and the dev list has albums, it offers to restore them. Restoring fetches each album one at a time and keeps the original dates added.
- [ ] A Develop menu has "Reset collection" and "Restore from dev list".
- [ ] Release builds don't contain the dev list or the Develop menu. A test or a CI check proves it, not just a reading of the code.

**Out of scope:** The Artwork report (ticket 7 adds it to the Develop menu).

**Depends on:** 3. It can run alongside ticket 4.

**Context:** RFC-001, "A dev list that survives resets" and open question 1.

### 6. [DWX-6] Play an album on a chosen Spotify Connect device (Feature)

**Goal:** On the album page you pick a device, press Play, and the album starts there, from the first track or a track you click. A playback bar shows what's playing with play/pause, next and previous. When a device is missing, Deadwax says so and what to do.

**Acceptance criteria**
- [ ] A device picker lists what Spotify reports now. Deadwax remembers the last device by name and selects it again when it's listed.
- [ ] Play sends the album and the device, from the first track or a clicked track. The list is refreshed just before playing. Tested against recorded responses.
- [ ] When the remembered device isn't listed, the user sees "<name> isn't showing up. Open Spotify on it, or play something there, then try again", not an error. Failures from Spotify are shown too, never swallowed. Tested.
- [ ] A playback bar has play/pause, next and previous, and shows the current track. While it's visible, Deadwax asks Spotify what's playing every couple of seconds, so it follows changes made from your phone.
- [ ] UI tests for the device picker, the missing-device message and the playback bar run against the mocked back end.

**Out of scope:** Now playing (ticket 8). Shuffle, queues and playlists aren't in Deadwax at all.

**Depends on:** 4. It can run alongside ticket 7.

**Context:** RFC-001, "Playing music" and "Risks & unknowns" (Sonos).

### 7. [DWX-7] Find high-res artwork, with an Artwork report (Feature)

**Goal:** Each album gets the sharpest cover we can find, looked up by UPC and then by artist and title. The album page shows it. A Develop-menu Artwork report lists every album's cover source and size.

**Acceptance criteria**
- [ ] Clients for iTunes Search, Deezer, and MusicBrainz with the Cover Art Archive, in `deadwax-sources`. Each respects its source's limits (iTunes about 20 a minute, MusicBrainz one a second). The MusicBrainz request identifies the app with the GitHub URL and contains no email address. Tested.
- [ ] Lookup tries iTunes, then Deezer, then MusicBrainz, then falls back to Spotify's cover. With fake responses, tests prove:
  - the order is followed;
  - a UPC miss falls back to artist and title, with "Deluxe Edition" and "Remastered" stripped;
  - a result whose artist doesn't match exactly is rejected;
  - with no match, the cover is Spotify's.
- [ ] Only the winning URL, its source and its pixel size are stored, never the image. Lookup runs in the background when an album is added or restored, and when an album without a result is opened.
- [ ] The album page loads the high-res cover. The grid keeps Spotify's covers.
- [ ] The Develop menu's Artwork report lists every album with its cover source and pixel size, and totals by source.

**Out of scope:** Storing images locally, and anything bigger than Deezer's documented 1,000 pixels (we don't rely on undocumented URLs).

**Depends on:** 4, 5. It can run alongside ticket 6.

**Context:** RFC-001, "High-res artwork, as an experiment" and open question 5.

### 8. [DWX-8] Fill the screen with now playing (Feature)

**Goal:** From the playback bar you open now playing: the high-res cover fills the screen with the album, the track, a progress bar and the controls. It follows whatever Spotify plays, and Escape leaves it.

**Acceptance criteria**
- [ ] Now playing uses Tauri's simple fullscreen (no animation into a new Space). Escape leaves it.
- [ ] It shows the high-res cover as it is (small rounded corners at most), the album, the track, a progress bar, the controls and an Open in Spotify link.
- [ ] It follows what Spotify is playing, including a track change made from another device, within a couple of seconds. The progress bar moves smoothly between polls. Tested with a fake back end that changes track.
- [ ] UI tests for now playing run against the mocked back end.

**Out of scope:** Any visual design beyond "big cover, readable text". That's project 2.

**Depends on:** 6, 7.

**Context:** RFC-001, "Now playing" and "Spotify's attribution rules".

### 9. [DWX-9] Write up what the spike found (Spike)

**Goal:** A findings page in Notion's Research database, linked to RFC-001, saying what worked and what didn't, and whether it feels good enough to carry on. If it does, it's the starting point for RFC-002.

**Timebox:** Will tries it as soon as ticket 8 merges, with no fixed period of use. The write-up takes half a day.

**Acceptance criteria**
- [ ] Will has run RFC-001's manual checks, including each device again after an hour idle, and a deluxe edition and a compilation in the collection.
- [ ] The page covers:
  - how reliable each device was, with what happened when it failed;
  - the Artwork report's numbers, by source, with the wrong matches Will spotted;
  - what Spotify's rules got in the way of;
  - what felt good and what didn't;
  - what to keep, clean up or rethink;
  - whether to carry on to RFC-002.
- [ ] Bugs found along the way are listed as candidate tickets or scratchpad notes, not fixed here.

**Out of scope:** Product code, and a PR: the findings live in Notion only. Any fix goes in its own ticket.

**Depends on:** 8.

**Context:** RFC-001, "How the spike ends" and "How we'll verify it" (manual checks).

## Order and checkpoints

```
1 ──► 2 ──► 3 ──┬──► 4 ──┬──► 6 ─────┐
                │        └──► 7 ──┬──┴──► 8 ──► 9
                └──► 5 ───────────┘
```

- 1, 2 and 3 run in order. After 3, tickets 4 and 5 can run in parallel. After 4, ticket 6 can start; 7 needs both 4 and 5. 6 and 7 can run in parallel, and 8 needs both.
- **Do 5 early.** Until it lands, every database reset loses the albums Will has added.
- **Do 6 before 7 if only one runs at a time.** Sonos reliability is the RFC's biggest risk, and 6 is where we first find out.
- **Checkpoint after 2:** register a Spotify app, enter its client ID, sign in, quit and reopen. You should still be signed in (manual check 1).
- **Checkpoint after 4:** search, add 10–20 albums you know well (include a deluxe edition and a compilation), open a few, remove one (manual check 2).
- **Checkpoint after 5:** reset the collection from the Develop menu and restore it (manual check 5).
- **Checkpoint after 6:** play an album on the Sonos, the TV and the Spotify desktop app (the first pass of manual check 3). This is the moment the experiment depends on most.
- **Checkpoint after 7:** open the Artwork report and compare it with what you see (manual check 6).
- **Checkpoint after 8:** open now playing. Is the cover sharp? Change track from your phone and watch it catch up (manual check 4).

## Coverage

| RFC-001 verification item | Ticket |
|---|---|
| Sign-in: PKCE challenge, `state` check, refresh with and without a new token | 2 |
| Tokens stay in Rust: no command returns a token | 2 |
| Rate limits: `429` waits for `Retry-After` on a fake clock | 2 |
| Collection: add, remove, duplicates, survives reopening | 3 |
| Dev list: writes on every change, restores, not in release builds | 5 |
| Database in the checkout, dev list in app data (temporary folders) | 3 (database), 5 (dev list) |
| Search: pages of 10, "more" offset, already-added marked | 3 |
| Artwork: source order, UPC fallback, wrong artist rejected, Spotify fallback, MusicBrainz identifies the app with no email | 7 |
| Playback: sends album and device; missing device gives the message | 6 |
| UI: grid, search, album page, now playing against the mocked back end | 3, 4, 8 (and 6 for playback) |
| App builds | 1, then every ticket |
| Manual 1: sign in, quit, reopen | 2 |
| Manual 2: add 10–20 albums, remove one | 3, 4 |
| Manual 3: Sonos, TV, desktop app, and again after an hour idle | 6, 9 |
| Manual 4: now playing sharp, follows the phone | 8 |
| Manual 5: reset and restore | 5 |
| Manual 6: Artwork report matches what you saw | 7, 9 |

Every part of the Proposal is covered by a ticket except what's below.

## Not in this project

- **`DESIGN.md`, the design tokens and the Spotify branding.** RFC-001 left these to project 2, which starts from what this project teaches.
- **Storing images locally.** Apple's terms expect artwork to be loaded from Apple. Revisit in project 2 if loading is slow.
- **Sonos's own local API, librespot and the Web Playback SDK.** Only if the findings say Spotify Connect isn't good enough.
- **Shuffle, queues and playlists.** Deadwax plays albums.
- **Signing, notarisation and distributing the app.** The RFC doesn't cover them. CI only proves the release build builds.
- **Other platforms.** macOS only.

## Open questions

1. **Resolved: no waiting period before the findings.** Will's call. Will tries it as soon as ticket 8 merges. If it feels right, we carry on to RFC-002. Was: how long should Will use Deadwax before the write-up? The recommendation had been about a week.
2. **Resolved: findings live in Notion only.** Will's call. Ticket 9 has no PR, and RFC-002 links to the Research page. Was: should the spike's findings also be committed to the repository?
