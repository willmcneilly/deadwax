# Project: Agent tooling

**Status:** Created · **RFC:** none (a port of Uta's Agent tooling project, below) · **Notion:** [Agent tooling](https://app.notion.com/p/Agent-tooling-3fc3af969b6f81feab36c9fbeaa32a0a)

## Goal

Deadwax's agents stop working out the same mechanical steps by hand on every ticket. Uta already turned those steps into scripts the skills call: running the checks, starting the app, setting up a review, and the ticket's Notion bookkeeping. This project brings them over, adapted to Deadwax, along with the smaller process fixes Uta made after Deadwax copied its process. When it's done, Deadwax's `.claude/` and `scripts/` work the way Uta's do, and nothing in them refers to Uta.

## Where this comes from

Deadwax copied Uta's skills, agent and workflow on 10 October (`f2323d7`). The next day, Uta ran its Agent tooling project (UTA-58 to UTA-63, plan in `~/Sites/uta/docs/plans/agent-tooling.md`). It came from an audit of 50 ticket sessions and 48 review runs. It made these changes:

| Uta change | Deadwax today |
|---|---|
| `effort:` set per stage: high for `rfc`, `plan-project` and `pr-reviewer`, medium for `work-ticket` | Not set |
| The project Notion skill renamed `uta-notion`, so it no longer has the same name as Will's global `notion` skill | Still `notion`. The global one (Stora by default) has the same name and shows up in this session's skill list |
| `ntn.sh` closes stdin itself and knows the data sources by name (`ntn.sh tickets query`) | Every recipe adds `</dev/null` and uses raw data source IDs |
| CLAUDE.md "Shell and tools": zsh quirks, never `sleep`, no Prettier | Missing |
| `work-ticket` names the session after the ticket | Missing |
| Merge without `gh pr merge --delete-branch`, which fails from a worktree | `work-ticket` still says `--delete-branch` |
| A `tidy` skill, run after every merge | Missing |
| `scripts/check`, `scripts/warm` and git hooks | "Run all of the above" by hand, cold builds in every worktree, nothing checks a push |
| `scripts/dev-app` | `work-ticket` describes a hand-written wait for `tauri dev`. Deadwax and Uta both use port 1420, and Uta's audit found Deadwax holding it in UTA-52 and UTA-56 |
| `scripts/review-setup`, `ci-wait` and `mutate`. The reviewer trusts green CI | The reviewer gathers by hand, runs every check locally in a fresh worktree, and breaks code by hand |
| `scripts/ticket`: show, ready, claim, tick, merge | Built by hand from `ntn.sh` calls on every ticket |
| `scripts/ticket evidence-check` and `sync`: the PR body is the only copy of the evidence | Evidence is written three times: PR body, ticket ticks, Verification notes |

Deadwax's own PRs already show the same problems the audit found in Uta:
- **Overstated evidence.** PR 7's first round blocked partly because "the PR and ticket cite tests as if something did" test the wiring.
- **Local re-runs that match CI.** PR 7's last round said "Every check is green locally and in CI", after a full local run.
- **Rounds.** PRs 7 and 8 each took three review rounds.

**No RFC.** As in Uta, this is process work, and its evidence is the audit and the table above, not a product decision.

## Conventions for every ticket in this project

- **Port, then adapt.** Start from Uta's code at `~/Sites/uta` (`app/scripts/*.ts`, `scripts/*`, `.githooks/*`, `.claude/`), and copy it into Deadwax. Then change what's specific to Uta: names, paths, jobs, mutations, the Notion data sources. Bring the tests too. Leave out what Deadwax doesn't have, and list it in the PR: RTSan, golden WAVs, timing reports, `DESIGN.md` tokens, design decisions, the `uta` CLI.
- **Where the scripts live:** as in Uta. `scripts/<name>` is a thin shell wrapper with a `--help`. The logic is TypeScript in `app/scripts/`, run by Node 22 without a build step, so the app's typecheck, lint, tests and CI cover it.
- **The skills call the scripts.** Each ticket updates the skills, the agent and CLAUDE.md where they describe the steps it replaces. A script nobody is told about doesn't help.
- **Tests never call the real Notion or GitHub,** in line with CLAUDE.md's rule for web APIs. The scripts are written against a services interface that the tests replace with a fake, as in Uta.
- **Process log:** each ticket adds a Deadwax Process log entry (Status `Trying`). Its "Why" points to the matching Uta entry and gives any Deadwax evidence.
- **Skill changes reach new sessions only.** Don't merge in a way that leaves a running session's instructions pointing at something removed.

## Tickets

### 1. [DWX-10] Bring over Uta's small process fixes (Chore)

**Goal:** the small fixes Uta made to its skills and docs since 10 October are in Deadwax, so sessions stop tripping on the same known problems. None of them needs a script.

**Acceptance criteria:**
- [ ] The project Notion skill is renamed `deadwax-notion` (`.claude/skills/deadwax-notion/`), and every reference to it is updated: CLAUDE.md, the other skills, `pr-reviewer.md`, and the `ntn.sh` allow rule in `.claude/settings.json`.
- [ ] `ntn.sh` closes stdin unless `--stdin` comes first, and knows Deadwax's eight data sources by name (`tickets`, `projects`, `rfcs`, `research`, `scratchpad`, `glossary`, `decisions`, `process-log`): `ntn.sh <source> query`, `ntn.sh <source> create -d`, `ntn.sh <source> id`. Every skill recipe that used a raw data source ID or `</dev/null` uses the new form, and each changed recipe works (run each once, read-only).
- [ ] `effort:` is set in the frontmatter: high for `rfc`, `plan-project` and `pr-reviewer`, medium for `work-ticket`.
- [ ] CLAUDE.md has a "Shell and tools" section of under 10 lines: the zsh quirks, never `sleep` to wait, and no Prettier.
- [ ] `work-ticket` names the session after the ticket (`DWX-<n>: <ticket name>`) when it claims the ticket, and merges without `--delete-branch` (it squash merges, then runs `git push origin --delete <branch>`).
- [ ] A `tidy` skill, adapted from Uta's, clears worktrees, build output and merged branches whose work is on `main`. `work-ticket` runs it after a merge. It leaves out the rows about `scripts/warm`, `dev-app` and review worktrees; tickets 2–4 add those when the scripts arrive.
- [ ] Process log entry added.

**Out of scope:** any script beyond `ntn.sh`. The reviewer's "style never harms function" rule, which relies on `DESIGN.md`, so it waits until project 2 starts one.

**Depends on:** Nothing.

**Context:** Uta commits `b976c53` (effort), `619e67b` (lessons from UTA-40), `a737da0` (tidy), `3c1597d` (UTA-58) and `6bc89b6` (session names).

### 2. [DWX-11] One check script, with warm builds in every worktree (Chore)

**Goal:** an agent runs every check a change needs with one command, `scripts/check`. It skips what hasn't changed and what has already passed. A push can't go out unchecked, and a new worktree starts from a warm Rust build.

**Acceptance criteria:**
- [ ] `scripts/check` runs, against `origin/main`, in parallel where jobs don't share a build:
  - Rust (fmt, clippy, test) when `crates/`, `app/src-tauri/` or `Cargo.*` changed;
  - the frontend (typecheck, lint, test) when anything else under `app/` changed;
  - the release build, `tauri build` followed by `scripts/check-release-has-no-dev-list.sh`, only when it could break (decision 1);
  - everything with `--all`, and ignoring earlier passes with `--rerun`.

  Show a frontend-only and a Rust-only change running only their own jobs.
- [ ] Each pass is stamped with the content it checked, so a second run on the same tree finishes in under 2 seconds and says it already passed. It warns when `origin/main` has moved on, and lists the commits.
- [ ] `.githooks/pre-push` lets a push through when its tree has passed, and otherwise runs `scripts/check`. `.githooks/post-checkout` runs `scripts/warm` in a new worktree. A one-time setup sets `core.hooksPath`, and CLAUDE.md says how.
- [ ] `scripts/warm` clones the main checkout's `target/` into a new worktree with APFS copy-on-write. A new worktree's first `cargo test --workspace` is measurably faster than a cold one. Record both times.
- [ ] `app/scripts/` is covered by the app's typecheck, lint and tests, and so by CI. CI itself still runs the full set unchanged.
- [ ] CLAUDE.md, `work-ticket` (steps 2 and 5), `pr-reviewer.md` and `tidy` point at `scripts/check` and `scripts/warm`.
- [ ] Process log entry added.

**Out of scope:** changing what CI runs. The reviewer trusting CI (ticket 4).

**Depends on:** Nothing. It can run alongside ticket 1, which changes different lines of the same docs.

**Context:** UTA-59 (`36d7c23`). Uta's `app/scripts/check*.ts`, `checkPlan.ts`, `checkJobs.ts`, `warm*.ts`, `git.ts` and `.githooks/`.

### 3. [DWX-12] Start the app for Will with one command (Chore)

**Goal:** when Will needs the app, the agent runs `scripts/dev-app start`. It opens this branch's app on a free port and either says it's open or says why it failed. Deadwax and Uta stop fighting over port 1420.

**Acceptance criteria:**
- [ ] `scripts/dev-app start` opens the app from a worktree, prints the branch, commit and port, and returns. The app stays up after the shell that started it exits.
- [ ] It picks a free port pair from 1440 upwards, so it stays clear of Uta's 1420. `vite.config.ts` reads the port from an environment variable and defaults to 1440. With the port held by another process, it takes the next free one and leaves the other process alone.
- [ ] Another checkout's Deadwax app keeps running, and each window's title names its branch (`Deadwax · <branch>`).
- [ ] A failed build returns non-zero within a few seconds of the failure, with the log's tail.
- [ ] `scripts/dev-app status` and `stop` work, and `stop` leaves no Vite or `deadwax-app` processes behind.
- [ ] `work-ticket` steps 9 and 10, and `tidy`, use the script. The hand-written wait is gone.
- [ ] Process log entry added.

**Out of scope:** Spotify's sign-in redirect, which is fixed at `127.0.0.1:43117`, so only one dev app can be signing in at a time. That's rare, and the Keychain tokens are shared, so one sign-in covers every checkout. Screenshots.

**Depends on:** Ticket 2, which sets up `app/scripts/` and its shared git helpers.

**Context:** UTA-60 (`e2cddd1`). Uta's `app/scripts/devApp*.ts`. Deadwax's `app/vite.config.ts` and `app/src-tauri/tauri.conf.json`.

### 4. [DWX-13] Let the reviewer trust CI and set up in one command (Chore)

**Goal:** a review round spends its time reviewing. One command gathers the PR, its history and its CI, and sets up a worktree that stays warm between rounds. The reviewer checks that CI is green on the exact commit instead of re-running everything, and breaks the code on purpose with a script that always puts it back.

**Acceptance criteria:**
- [ ] `scripts/review-setup <pr> [--round r | --commit sha]` prints, in one call, the PR, the ticket's page ID, earlier reviews with threaded replies, CI by commit, and the diff stats. It creates or resets the worktree at `.claude/worktrees/review-pr-<n>`. It does this with no errors for PR 8 and PR 8 round 2, and `--commit` leaves out what came later.
- [ ] `scripts/ci-wait <pr> --commit <sha>` exits 0 for green, 1 for red, 2 when the commit has no checks, and 3 on timeout.
- [ ] `scripts/mutate` makes one exact replacement, runs the tests, and always restores the file, even when interrupted. It prints CAUGHT, MISSED or DIDN'T BUILD. At least two named mutations for the Spotify rules each print CAUGHT, for example `retry-after` (ignore `Retry-After`, caught by `retries_a_429_after_its_retry_after_and_only_then`) and one for the auth header or the token rules. A test checks that each one's text still matches the code.
- [ ] `pr-reviewer.md` uses all three. On green CI for the reviewed commit, it runs locally only the tests behind each criterion and its mutations. On red, missing or another commit's CI, it runs `scripts/check --all --rerun`. A re-review re-runs only the mutations behind the findings it's resolving. `review-round.js`'s `checks_green` description matches.
- [ ] A `review-round` dry run on a recent PR completes with the new steps. Record its time and tool calls.
- [ ] Process log entry added.

**Out of scope:** the reviewer's independence. It's still briefed with the PR number and nothing else. The evidence check (ticket 6).

**Depends on:** Ticket 1 (the reviewer's Notion references) and ticket 2 (`scripts/check`, `app/scripts/`).

**Context:** UTA-61 (`5bd2ea5`). Uta's `app/scripts/reviewSetup*.ts`, `ciWait*.ts`, `mutate*.ts` and `mutations.ts`. Deadwax's `pr-reviewer.md` and `review-round.js`.

### 5. [DWX-14] Script the ticket's Notion steps (Chore)

**Goal:** finding what's ready, and claiming, ticking and merging a ticket, are each one command. Agents stop building Notion calls by hand.

**Acceptance criteria:**
- [ ] `scripts/ticket show DWX-n` gives the page ID, status, type, project, and each dependency with its status and whether its PR is merged. `scripts/ticket ready` lists every Ready ticket whose dependencies are Done and merged, and which can run alongside each other. Both give the right answers for this project (check by hand once).
- [ ] `claim DWX-n --branch <name>` refuses a ticket that isn't Ready or has an unmerged dependency. Otherwise it sets In Progress (and the project Active) and posts the `🤖 Claude:` Started comment.
- [ ] `tick DWX-n <criterion>…` ticks by matching text, and fails clearly on no match or an ambiguous one.
- [ ] `merge DWX-n` refuses unless the newest review says Ready to merge and CI is green on the head commit. It squash merges, deletes the remote branch, sets Done, moves newly unblocked tickets to Ready, sets the project Done when every ticket is, and prints what's ready now.
- [ ] Every command has `--dry-run`. Unit tests cover the dependency checks, unblocking and tick matching, against a fake Notion and GitHub.
- [ ] `work-ticket` steps 1, 2 and 10 and the `deadwax-notion` skill use it. The hand-written recipes it replaces are gone.
- [ ] Process log entry added.

**Out of scope:** `decision new`. Project 1 logs no design decisions, so it waits until `DESIGN.md` arrives. Planning-side scripts (creating tickets from a plan). The PR body and Verification notes (ticket 6).

**Depends on:** Ticket 1 (`ntn.sh`'s named data sources).

**Context:** UTA-62 (`747b4d0`). Uta's `app/scripts/ticket*.ts`.

### 6. [DWX-15] Keep a ticket's evidence in one place (Chore)

**Goal:** a ticket's evidence is written once, in the PR body, and everything else is made from it. A test that's been renamed and a claim that's out of date are caught before the reviewer sees them.

**Acceptance criteria:**
- [ ] `scripts/ticket evidence-check <file>` checks that each name, path and command in backticks exists in the branch. That covers Rust `fn` names, vitest test names, files, npm scripts and `scripts/`. It also refuses a total of tests. It passes on PR 8's body against its merge commit, and fails, naming the reference, when a test the body names is renamed.
- [ ] `scripts/ticket sync DWX-n --pr <n> <file>` runs the check, updates the PR body, ticks the ticket to match the PR's `[x]` and `[ ]` (by the ticket's exact wording), replaces the Verification notes, and sets the PR link and In Review. A second run changes nothing. `--dry-run` on a recent ticket shows the right result, and a real run is tried on a scratch Notion page, not a live ticket.
- [ ] `work-ticket` steps 6–8 and its review loop keep the PR body as a file and use `sync`, and say to name tests, not count them. `pr-reviewer.md`'s honesty check starts with `evidence-check`.
- [ ] Process log entry added.

**Out of scope:** what the evidence says, and the PR body's sections. Notion pages other than tickets.

**Depends on:** Ticket 5 (`scripts/ticket` and its services), and ticket 4 for the `pr-reviewer.md` change (it builds on the new gathering section).

**Context:** UTA-63 (`09a5088`). Uta's `app/scripts/evidence*.ts` and `ticket.ts`.

## Order and checkpoints

- **First, in parallel:** ticket 1 and ticket 2.
- **Then, in parallel:** ticket 3 (after ticket 2), ticket 4 (after ticket 1 and ticket 2) and ticket 5 (after ticket 1).
- **Last:** ticket 6, after ticket 4 and ticket 5.

This can run alongside DWX-9, which only writes a findings document.

Checkpoints for Will:
- **After ticket 3:** the next handover should have the app open without being asked, in a window titled with its branch, while Uta's app runs too.
- **After ticket 4:** compare the next ticket's review rounds with PRs 7 and 8 (three rounds each, with every check run locally).
- **After ticket 6:** the next ticket should have no review finding about stale or overstated evidence.

## How we'll know it helped

Record these in the Process log entries for the first two tickets of the next project:
- review rounds per PR, and how many findings were about the evidence rather than the code;
- reviewer minutes and tool calls per round;
- how often Will asks for the app to be opened or restarted;
- tool calls per ticket session.

## Not in this project

- **`scripts/ticket decision new`, and the reviewer's rule that decoration must never compete with what works.** Both rely on `DESIGN.md`, which project 2 starts. Bring them over then.
- **Uta's sound-work kit, timing baselines, RTSan and golden WAVs.** Deadwax doesn't make sound.
- **Sharing one copy of the scripts between Uta and Deadwax** (decision 2).
- **The scratchpad's one open note** (store high-res covers locally to extract their colours) is about the product, not tooling. It's for RFC-002.

## Decisions

1. **`scripts/check` runs the release build locally only when it could break:** when `app/src-tauri/`, the Tauri config, `app/package.json`, `crates/deadwax-core/src/dev_list*`, or any Rust file containing `debug_assertions` changed. CI builds it on every PR and covers the rest. Ticket 2 updates CLAUDE.md's "run all of the above" rule to match. (Will, 17 Oct.)
2. **Copy and adapt the scripts rather than share them with Uta.** The two would need to agree on every change, each repository would stop being self-contained, and most of the scripts already differ (jobs, mutations, data sources). Look again if a third project needs them. (Will, 17 Oct.)
