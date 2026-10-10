# Deadwax

Deadwax is a curated album player. It shows only the albums Will has added to the collection, with great artwork, credits and notes, and plays them through Spotify. It's a Tauri 2 app: a Rust core with a React UI, the same stack as Uta. Spotify does the playing. Deadwax is a controller that sends playback to a Spotify Connect device (Sonos speakers, a TV, the Spotify desktop app). Built and tested on macOS only. The code is public on GitHub.

The foundations are in RFC-001 (`docs/rfcs/`), which isn't written yet. Until it's accepted, the layout, commands and architecture below are placeholders, and the first ticket (DWX-1) fills them in.

## Layout

To be set by RFC-001 and DWX-1. The plan is to mirror Uta:

```
Cargo.toml            workspace
crates/               the Rust core (no UI)
app/                  Tauri app: React + TypeScript, Vite, npm
app/src-tauri         the app's Rust side
DESIGN.md             design tokens and the reasons for them
docs/rfcs             RFCs (Notion is the source of truth once accepted)
docs/plans            project plans: tickets, order, checkpoints
.github/workflows     CI
```

## Commands

To be filled in by DWX-1. **Before opening a PR, run all of the checks listed here and fix everything they report.** CI runs the same set.

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

- `DESIGN.md` will be the source of truth for how Deadwax looks, as in Uta: tokens generated into the app, no colour written directly in the code.
- When UI work needs something `DESIGN.md` doesn't cover, build it from the principles, mark the code `provisional: D-n`, log it in the **Design decisions** database in Notion, and list it in the PR. Will decides each between projects. The `work-ticket` skill has the steps.

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
