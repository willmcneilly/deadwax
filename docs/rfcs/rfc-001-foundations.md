# RFC-001: Foundations: a rough end-to-end player

**Status:** Accepted (2026-10-10) · **Author:** Will · **Notion:** https://app.notion.com/p/Foundations-a-rough-end-to-end-player-3f53af969b6f8117ba33c5b6bd0306d0

## Summary

This RFC sets up Deadwax and builds a rough version of the whole thing from end to end, as a spike. You sign in with Spotify, find albums with search, add them to a collection that starts empty, browse it as a grid of covers, and open an album to play it on your Sonos, your TV or the Spotify app. While it plays, a "now playing" view fills the screen with the cover at the highest resolution we can find. Deadwax is a remote control. Spotify plays the music on whichever Spotify Connect device you pick. The point of the project is to learn what works: how reliable Sonos is through Spotify's API, how often we find good high-res artwork, and how it feels to use. Project 2 starts from what we learn.

## Motivation

You want a player that feels like a record collection: only the albums you chose, presented well, played as albums. Before designing that properly, the riskiest assumptions need testing against reality:

- **Can a third-party app reliably play on your Sonos?** Spotify's documentation and years of developer reports say Sonos devices are sometimes missing from what the API can see. If that's bad in your home, it changes the whole design.
- **Can we find high-res artwork for most albums?** Spotify's own covers are about 640 pixels wide, which looks soft full-screen on a Retina display. Other sources have bigger ones, but we have to match each album to them.
- **What do Spotify's 2026 rules allow?** Spotify tightened what personal apps can do this year (see Proposal), and some of what we'd want is gone.

A rough end-to-end version answers all three faster than designing any one part carefully. It also sets up the repository, the checks and the way of working, the same as Uta's.

## Proposal

### The stack

The same as Uta's, so both projects work the same way:

- **App: Tauri 2** (currently 2.12.x; pin 2.x). A Rust side and a React + TypeScript UI, built with Vite.
- **Rust owns the data and the network.** The UI never calls Spotify or any other web service, and holds nothing it wasn't sent. It asks Rust through Tauri calls and draws what comes back, as in Uta.
- **macOS only** for building and testing.

### Signing in to Spotify

Spotify's sign-in for apps like this is **PKCE**, a version of OAuth designed for apps that can't keep a secret. A desktop app can't, because anyone could pull it out of the download. The app makes a one-off random code, sends a scrambled form of it when it opens Spotify's sign-in page in your browser, and proves it holds the original when it collects the tokens.

- **Opening the browser:** the official `tauri-plugin-opener`.
- **Getting the answer back:** after you approve, Spotify sends the browser to a "redirect" address. Spotify no longer allows `localhost`, only `http://127.0.0.1:<port>`. A port can be chosen at runtime if the address is registered without one. Deadwax opens a one-shot listener on a free port in Rust, catches the redirect, and shows a "you can close this tab" page. That's about 40 lines on top of the async runtime Tauri already uses, so we don't need `tauri-plugin-oauth`.
- **Tokens:** Spotify returns an **access token** (it lasts an hour) and a **refresh token** (it gets new access tokens without asking you again). Refreshing sometimes returns a new refresh token, and if it doesn't, the old one stays valid. Refresh tokens expire six months after sign-in, so Deadwax handles being signed out gracefully.
- **Where tokens live:** the macOS Keychain, through the `keyring` crate (4.x, using its native macOS store). They never reach the UI, a log or the database.
- **Your own Spotify app:** every Deadwax user registers a free Spotify developer app and gives Deadwax its client ID. Since February 2026, a new Spotify developer app allows at most 5 users, and the owner needs Premium. That's fine for a personal app, and it's the only way an open-source copy can work. The client ID isn't a secret. A one-time setup screen asks for it and saves it to a config file in the app-data folder, never in the code.

### Spotify's 2026 limits that shape this

Since February 2026, apps like ours ("development mode") have these limits:

- **Search returns at most 10 results per request.** We page with "more results" rather than loading 50 at once.
- **Albums are fetched one at a time.** The "get several albums" call is gone.
- **Some album fields are gone,** such as record label and popularity. The barcode (UPC) was removed too, then restored in March 2026. We depend on it for artwork, so it's a risk if it goes again.
- **Rate limits** are counted over a rolling 30 seconds and aren't published. A `429` reply says how long to wait (`Retry-After`), and Deadwax waits that long before retrying.

### The collection

- **Stored in SQLite inside Rust** with `rusqlite` (0.40, bundled). It's synchronous and simple, which is the right size for a few hundred albums. We don't use `tauri-plugin-sql` because it's designed for the UI to run SQL itself, and that breaks the rule above.
- **What's stored:** each album's Spotify ID and when you added it. That's the collection. Alongside it is a **refreshable cache** of what we show: title, artist, year, tracklist, Spotify's cover URLs and the UPC. Spotify's developer terms allow caching metadata and covers only temporarily, and say to keep it reasonably up to date. So the cache is refreshed when you open an album if it's more than a week old, and the collection itself is just the list of IDs.
- **Adding** happens from search: each result has an "Add" button. **Removing** happens from the album page.

### A dev list that survives resets

While we're building, the database will be thrown away often, and tickets are worked in separate git worktrees (copies of the repository side by side). So development builds keep two things in different places:

- **The database lives in the checkout** (`.dev-data/`, ignored by git). Each worktree gets its own, so testing one branch can't damage another's data.
- **The dev list lives outside the repository**, in Deadwax's folder in `~/Library/Application Support`. It's one file shared by every checkout and worktree: album IDs and the dates they were added. Every add and remove in any development build updates it.

When a development build starts with an empty collection (a fresh worktree, or after a reset), it offers to restore from the dev list. A **Develop** menu has "Reset collection" and "Restore from dev list". Release builds don't have any of this, and keep their database in the app-data folder as usual.

### Finding albums

A search box at the top of the collection view. It searches albums only and shows 10 results, with cover, title, artist and year, and a "More" button that fetches the next 10. Albums already in your collection say so.

### High-res artwork, as an experiment

Spotify's covers top out at about 640 pixels, so we look elsewhere using the album's UPC. In the order we'd try them:

1. **iTunes Search API** (looked up by UPC). Apple's artwork URLs can ask for a size. Asking for something huge returns the original upload, which was 3,000–4,000 pixels in testing. The famous "100000x100000" trick no longer works. Apple asks for about 20 calls a minute at most.
2. **Deezer** (by UPC). It returns a 1,000-pixel cover reliably. Bigger sizes work through an undocumented URL change, so we don't rely on them.
3. **MusicBrainz and the Cover Art Archive** (by barcode). It's community-run with a 1,200-pixel version and sometimes the original scan. It allows one request a second and needs the app to identify itself. Deadwax sends the project's GitHub URL, never an email address.
4. **Spotify's own 640-pixel cover**, as the fallback.

If the UPC finds nothing, we try artist plus title, with "Deluxe Edition" and "Remastered" stripped out, and only accept an exact artist match. Deluxe editions and remasters often have different covers and barcodes, so matching will sometimes pick the wrong edition. That's one of the things this spike measures.

**What we keep:** the winning image's URL, its source and its size, not the image itself. Apple's terms expect artwork to be loaded from Apple rather than stored, and loading on demand keeps us clear of that. The grid uses Spotify's 640-pixel covers, which are plenty at grid size and much lighter. Only the album page and now playing load the high-res version.

**Measuring it:** a Develop-menu **Artwork report** lists every album with where its cover came from and its pixel size. After you've added a few dozen albums, it tells us how well this works in practice.

### Playing music

Deadwax is a remote control for **Spotify Connect**, Spotify's way of playing on another device. Your Sonos rooms, the TV's Spotify app, your phone and the Spotify desktop app are all Connect devices.

- **Choosing a device:** a device picker shows what Spotify reports as available right now. Deadwax remembers the last device you used by name, and selects it again if it's in the list.
- **Playing an album:** Deadwax tells Spotify "play this album on this device", from the first track, or from a track you click in the tracklist.
- **Controls:** play/pause, next, previous. While a view showing playback is open, Deadwax asks Spotify what's playing every couple of seconds. Spotify doesn't push updates to apps like this.
- **When a device is missing:** Spotify says some devices won't be listed, devices can drop out of the list when asleep, and device IDs only last "to some extent". So Deadwax refreshes the list before playing, matches the remembered device by name, and if it isn't there, says so plainly ("Living Room isn't showing up. Open Spotify on it, or play something there, then try again"). Deadwax never fails silently.

Shuffle, queueing and playlists don't exist in Deadwax. You play albums.

### Now playing

When an album starts playing, you can open **now playing**. It fills the screen with the high-res cover, the album and track, a progress bar and the controls, and Escape leaves it. It uses Tauri's "simple fullscreen" (since Tauri 2.10), which goes fullscreen without the macOS animation into a new desktop Space. It follows whatever Spotify is playing, even if you changed track from your phone.

### Spotify's attribution rules

Spotify's developer policy requires content to be credited to Spotify, and covers and metadata to link back to the album on Spotify. Every album page and the now playing view will have an "Open in Spotify" link. Covers are shown as they are: no blur, overlays or cropping, and only small rounded corners. Doing the Spotify branding properly (logo, placement) is a design job for project 2. The spike just meets the rule with the link. "Deadwax" is fine as a name: the policy only forbids names that start with "Spot" or sound like "Spotify".

### Repository and checks

- **Layout**, following Uta:
  - `crates/deadwax-core`: the collection, the database and the dev list, with no network.
  - `crates/deadwax-sources`: the Spotify, iTunes, Deezer and MusicBrainz clients, sign-in and rate-limit handling.
  - `app/`: the Tauri app, with its Rust side in `app/src-tauri`.
- **HTTP** with `reqwest` (0.13, which uses rustls by default).
- **Tests never touch the internet.** Each web client is tested against a local fake server that replays recorded or hand-written responses, including errors, `429`s and odd data.
- **CI on every PR, on `macos-15`**, the same as Uta's minus the audio jobs: formatting, Clippy with warnings as errors, Rust tests, frontend typecheck, lint and tests, and a full app build.
- **`CLAUDE.md`** gets the commands and layout once they exist.
- **Licence:** MIT, with a `LICENSE` file added in the first ticket.

### How the spike ends

The last ticket is a short **findings** write-up:
- how reliable each device was;
- the artwork report's numbers;
- what Spotify's rules got in the way of;
- what felt good and what didn't;
- what to keep, clean up or rethink.

It goes to Notion's Research database and is the starting point for RFC-002.

## What it looks like to you

The first time you open Deadwax, it asks you to sign in. Your browser opens Spotify's approval page, you click Agree, and the browser says you can close the tab. Deadwax shows an empty collection with a search box.

You search "In Rainbows", see the album with its cover, and click Add. It appears in your collection grid. You add a dozen more. You open one and see a large, sharp cover, the tracklist and an Open in Spotify link. You pick Living Room from the device picker and press Play, and the Sonos starts the album from the first track a moment later. You open now playing, and the cover fills the screen. Skip a track on your phone and Deadwax catches up within a couple of seconds.

The next day you choose the TV instead. If it's asleep and Spotify can't see it, Deadwax tells you so and what to do.

When you reset the database while we're building, Deadwax offers to bring your albums back from the dev list. The Artwork report shows, album by album, where each cover came from and how big it is.

It will look rough. This project is about finding out what works, not how it should look.

## Alternatives considered

- **Building inside Spotify with Spicetify.** It adds custom pages to the Spotify desktop app. **Why not:** you'd still see Spotify's home feed, recommendations and podcasts around your collection, which is the opposite of the idea. It also breaks when Spotify updates.
- **Playing audio inside Deadwax with Spotify's Web Playback SDK.** That would make Deadwax its own speaker. **Why not:** it needs browser DRM, which Spotify only supports in desktop browsers. Whether it works in Tauri's Mac web view is unconfirmed, and reports from other embedded web views are bad. It isn't needed for Sonos or the TV. The Spotify desktop app covers "play on this Mac".
- **Playing audio inside Deadwax with librespot.** It's an open-source Spotify Connect receiver in Rust. **Why not now:** it's unofficial, against Spotify's terms, and breaks when Spotify changes its protocol. It's a possible add-on later, if we want Deadwax itself as a device.
- **AirPlay to the Sonos.** **Why not:** the Mac would have to play the audio and stay awake. Through Connect the speaker streams directly from Spotify.
- **`tauri-plugin-sql` for storage.** It's designed for the UI to run SQL, which breaks the rule that Rust owns the data.
- **`tauri-plugin-oauth` for sign-in.** It works and supports Tauri 2, but our own listener is about 40 lines, and it keeps everything in Rust.
- **A custom URL scheme (`deadwax://`) for the sign-in redirect.** On macOS it only works from an app installed in Applications, which makes development awkward. Spotify's redirect page doesn't confirm it's supported either.
- **Tauri's Stronghold plugin for tokens.** It needs its own password to unlock, which is heavier than the Keychain.
- **Storing high-res images locally.** It would be faster and work offline, but Apple's terms expect artwork to be loaded from Apple. We can revisit this in project 2 if loading is slow.

## Risks & unknowns

- **Sonos may not show up reliably. This is the biggest risk.** Spotify's docs say some devices aren't listed. Developers have reported Sonos missing, restricted or without an ID for years, partly because device discovery depends on the local network. We'll find out how bad it is in your home. If it's bad, the options are Sonos's own local API, or accepting the "wake it first" step.
- **Spotify keeps changing the rules.** 2025 and 2026 each brought new limits, and the UPC was removed and restored within a month. If the UPC goes, artwork matching falls back to artist and title, which is weaker.
- **Artwork matching will sometimes be wrong**: deluxe editions, remasters, regional releases, compilations. The artwork report will show how often.
- **Whether iTunes lookup by UPC works is untested.** Lookup by artist and title is the fallback.
- **Big images in the web view.** A 4,000-pixel cover is about 64 MB once decoded. That's fine one at a time. The grid uses Spotify's small covers so a few hundred albums don't add up. (The memory figure is my estimate, not measured.)
- **Six-month sign-in.** Refresh tokens expire, so you'll be asked to sign in again twice a year. That's minor, but it has to be handled cleanly.
- **Spotify's caching terms are a grey area for a personal collection.** Treating Spotify data as a refreshable cache, keyed by album IDs we own, is the reading that's clearly within the terms.

## How we'll verify it

**Automated, on every PR:**
- **Sign-in:** the PKCE code challenge matches the worked example in the PKCE standard (RFC 7636). The listener extracts the code and rejects a reply whose `state` doesn't match. A token refresh with and without a new refresh token keeps a working token.
- **Tokens stay in Rust:** no Tauri command returns a token. A test lists the commands' return types to check this.
- **Rate limits:** a `429` with `Retry-After: 2` is retried after 2 seconds (on a fake clock), and only then.
- **Collection:** adding, removing, and adding the same album twice behave correctly and survive reopening the database. The dev list writes on every change, restores into an empty collection, and isn't compiled into release builds. Development builds put the database in the checkout and the dev list in app data (tested with temporary folders).
- **Search:** results come back as pages of 10, "more" asks for the next offset, and albums already in the collection are marked.
- **Artwork:** given fake responses, the source order is followed. A UPC miss falls back to artist and title, a wrong-artist result is rejected, and with no match the cover falls back to Spotify's. The request to MusicBrainz identifies the app and contains no email address.
- **Playback:** "play album on device" sends the album and the device. A remembered device that's missing from the list produces the "isn't showing up" message rather than an error.
- **UI:** the collection grid, search, album page and now playing render correctly against Tauri's mocked back end.
- **App:** the full Tauri app builds.

**Manual, by you:**
1. Sign in from scratch, then quit and reopen. You should still be signed in.
2. Search, add 10–20 albums you know well, including a deluxe edition and a compilation, then remove one.
3. Play an album on Sonos, on the TV and on the Spotify desktop app. Try each again with the device idle for an hour.
4. Open now playing. Is the cover sharp? Change track from your phone and watch it catch up.
5. Reset the collection and restore it from the dev list.
6. Open the Artwork report. Do the sources and sizes match what you saw?

## Open questions

1. **Resolved: the dev list lives outside the repository,** in Deadwax's app-data folder, so every worktree shares it and it never reaches the public repo. Each checkout keeps its own database (see "A dev list that survives resets").
2. **Resolved: no `DESIGN.md` in project 1.** Will's call. Was: should project 1 have a `DESIGN.md`? Uta has a design system with generated tokens and a lint for raw colours. For a rough spike, that's a lot of setup for a UI we expect to redo. **Recommendation:** skip it in project 1. Write plain CSS with a handful of CSS variables, mark the whole UI provisional, and don't log design decisions. Project 2 starts `DESIGN.md` from what we learn.
3. **Resolved: (a), a setup screen.** Will's call on 2026-10-10. Was: how should the client ID get into the app?

   *What it is.* Spotify only lets registered apps use its API. You register one for free on Spotify's developer dashboard: give it a name, add the redirect address (`http://127.0.0.1`), and add your Spotify account to its list of up to 5 users. Spotify gives back a **client ID**, a public identifier like a username for the app. It isn't a password. Spotify sees it in every sign-in, and PKCE is what makes sign-in safe without a secret.

   *Why it can't just be built in.* Since February 2026, each Spotify app allows only 5 users, and those users must be added by hand by the app's owner. If Deadwax shipped with your client ID, nobody else could use it, and every stranger who tried would be asking you to add them. So each person who runs Deadwax registers their own Spotify app and uses their own client ID. That's you, today.

   *The options for getting it into Deadwax:*
   - **(a) A setup screen.** The first time Deadwax opens, it asks for your client ID with a link to the dashboard and the steps, checks it by starting sign-in, and saves it to a small config file in its app-data folder. Change it later from a menu.
   - **(b) Built in at compile time.** You put the client ID in an environment variable when building. It's simpler to code, but anyone else building from the repo must do the same, and it ends up inside the app binary.
   - **(c) A config file you edit by hand.** It's the simplest to build, but there's no guidance when it's missing.

   **Recommendation was:** (a). It's a small screen, it's the only option that works for someone who downloads the code and just runs it, and you only see it once.
4. **Resolved: MIT.** Will's call. Was: which licence? **Recommendation:** MIT. It's the simplest and the most common for small apps.
5. **Resolved: load high-res covers on demand.** Will's call. Was: should high-res covers be loaded on demand, not stored? **Recommendation:** yes, for the spike (see Proposal). Revisit in project 2 if loading is slow.

## New terms

- **PKCE:** a way to sign in to a service from an app that can't keep a secret, by proving you started the sign-in rather than presenting a password.
- **Access token / refresh token:** a short-lived pass for API calls, and a longer-lived one that gets new passes without signing in again.
- **Redirect URI (loopback):** the address Spotify sends the browser back to after sign-in. For a desktop app, a port on `127.0.0.1` that the app listens on.
- **Spotify Connect device:** anything Spotify can play on and control remotely, such as a Sonos room, a TV app or a phone.
- **Development mode:** Spotify's tier for personal and in-progress apps. Up to 5 users, a reduced API and lower rate limits.
- **UPC:** the barcode number of a specific release, used to match an album across Spotify, Apple, Deezer and MusicBrainz.
- **Release / release group (MusicBrainz):** a release is one specific edition (the 2007 CD, the 2016 vinyl). A release group is the album that all those editions belong to.
- **Refreshable cache:** data we keep only to show it quickly and re-fetch when it's old, as opposed to data we own (the collection).
- **Dev list:** the development-only file outside the repository that mirrors the collection, so it survives database resets and is shared by every worktree.
