# Deadwax

Deadwax is a curated album player. It shows only the albums Will has added to the collection, with great artwork, credits and notes, and plays them through Spotify. It's a Tauri 2 app: a Rust core with a React UI, the same stack as Uta. Spotify does the playing. Deadwax is a controller that sends playback to a Spotify Connect device (Sonos speakers, a TV, the Spotify desktop app). Built and tested on macOS only. The code is public on GitHub.

The foundations are in RFC-001 (`docs/rfcs/rfc-001-foundations.md`): a rough end-to-end player, built as a spike to learn what works. Rust owns the data and the network. The UI never calls Spotify or any other web service: it asks Rust through Tauri commands and draws what comes back.

## Layout

```
Cargo.toml              workspace (Rust 2024 edition), release profile
rust-toolchain.toml     the pinned Rust version, with rustfmt and clippy
crates/deadwax-core     the collection, the database and the dev list. No network.
crates/deadwax-sources  the web clients: Spotify (sign-in, rate limits), iTunes, Deezer, MusicBrainz
app/                    Tauri app: React + TypeScript, Vite, npm
app/src                 the UI. `theme.css` holds the CSS variables
app/src-tauri           the app's Rust side (the `deadwax-app` crate)
docs/rfcs               RFCs (Notion is the source of truth once accepted)
docs/plans              project plans: tickets, order, checkpoints
.github/workflows       CI
.dev-data/              a development build's database, one per checkout (ignored by git)
```

## Commands

Run everything from the repository root unless it says `app/`.

```bash
# Rust
cargo fmt --all                                     # format
cargo fmt --all --check                             # CI check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# Frontend (in app/)
npm ci
npm run typecheck                                   # tsc -b
npm run lint                                        # eslint, then stylelint
npm test                                            # vitest, jsdom
npm run tauri dev                                   # open the app with hot reload
npm run tauri build -- --ci                         # release build: target/release/bundle/macos/Deadwax.app
```

`cargo build`/`clippy`/`test` compile the app crate in dev mode, so they don't need `app/dist`. Only `tauri build` needs the frontend built, and it does that itself.

**Before opening a PR, run all of the above checks and fix everything they report.** CI runs the same set on `macos-15`.

## Spotify rules

These aren't negotiable. The repo is public, and Deadwax runs on Will's own Spotify account.

- **No client secret, ever.** Sign-in uses Spotify's PKCE flow. The client ID isn't a secret, but it comes from local config, not the code, so anyone running Deadwax registers their own Spotify app.
- **Tokens stay in Rust.** Access and refresh tokens live in the macOS Keychain. They're never logged, written to a file or the database, or sent to the UI.
- **Respect rate limits.** A `429` is retried after its `Retry-After`, never in a tight loop.
- **No audio leaves Spotify.** Deadwax never downloads, records or caches audio. The collection holds Spotify IDs and metadata, not files.
- **Tests never call the real Spotify API** (or any other web API). They run against recorded or hand-written responses.

## Code conventions

- Rust 2024 edition. `cargo fmt` defaults. Clippy warnings are errors in CI. The Rust version is pinned in `rust-toolchain.toml`.
- Frontend: React function components, strict TypeScript, no `any`. Tests next to the component (`Foo.test.tsx`). UI tests run against Tauri's mocked back end (`@tauri-apps/api/mocks`), never a real one.
- Pin major versions: Tauri 2.x.

## Design

- **Project 1 has no `DESIGN.md`** (RFC-001, open question 2). The whole UI is provisional: project 2 starts `DESIGN.md` from what we learn.
- Styling is plain CSS. Colours live only in the CSS variables in `app/src/theme.css`, and `npm run lint` fails on a colour written anywhere else in CSS.
- No design decisions are logged in project 1, so skip the `work-ticket` skill's steps on design tokens and provisional design decisions (`provisional: D-n`).

## Working on tickets

Work is planned in Notion (Will's personal workspace, never Stora): RFCs → Projects → Tickets, on the Deadwax page. Use the `notion` skill and its `ntn.sh` wrapper for all Notion access. The `work-ticket` skill has the full process.

- Tickets have IDs `DWX-n` and a status: Backlog · Ready · In Progress · Blocked · In Review · Done. Only start a `Ready` ticket whose dependencies are `Done` and merged.
- Branch: `dwx-<n>-<short-slug>`, e.g. `dwx-2-spotify-sign-in`, from an up-to-date `main`.
- PR title: `DWX-<n>: <ticket name>`. The body has what changed and why, the acceptance criteria with evidence, "For Will to try" steps, and follow-ups.
- Stay in scope. Anything else worth doing goes under follow-ups in the PR, not in the diff.
- Ideas Will has along the way that aren't about the current PR go in the scratchpad (`/note`, the `scratchpad` skill), and they're reviewed between projects.
- New concepts go in the Notion **Glossary** so Will can follow how Deadwax is built: an RFC lists its new terms for review, and a ticket adds any that came up during the work.
- When the way we work changes (a skill, a rule, a new tool or step), add an entry to the Notion **Process log**: what wasn't working, with evidence, and what changed.
- Before In Review: tick the met criteria on the ticket and fill in its Verification notes.
- Comments you post to Notion start with `🤖 Claude:`, because the CLI posts as Will.
- Reviews run in a loop without Will: the implementer starts each round with the `review-round` workflow, which starts a fresh `pr-reviewer` agent that nobody can brief, and fixes what it finds until they agree.
- Never merge without Will's go-ahead.
- Don't write temp files to `/tmp`; use the session scratchpad.
