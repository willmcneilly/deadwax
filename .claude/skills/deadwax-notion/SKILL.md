---
name: deadwax-notion
description: How to read and write Deadwax's Notion (RFCs, Projects, Tickets, Research, Scratchpad, Glossary, Design decisions, Process log) in Will's personal workspace, with the project's ntn.sh wrapper. Use for anything in Notion while working on Deadwax: reading or updating a ticket, RFC or project, changing a status, adding a PR link, reading or posting comments, or querying what work is ready. Not the global `notion` skill, which defaults to Stora.
---

# Deadwax's Notion via `ntn.sh`

## A ticket's steps: `scripts/ticket`

Claiming, ticking criteria, merging and unblocking a ticket, and finding what's ready, are each one command in `scripts/ticket` (`--help` for the details). Use it rather than building those calls by hand:

```bash
scripts/ticket show DWX-n                        # page ID, status, type, project, PR, and each dependency
scripts/ticket ready                             # what can start now, what's waiting, what's running
scripts/ticket claim DWX-n --branch <branch>     # In Progress, project Active, the Started comment
scripts/ticket tick DWX-n "<criterion>" …        # tick acceptance criteria by their text
scripts/ticket merge DWX-n                       # merge the PR, Done, unblock, project Done
```

Every command takes `--dry-run`, which prints the `ntn.sh`, `gh` and `git` calls it would make. A ticket's dependencies are the `DWX-n` IDs under its `## Depends on` heading. Everything else goes through the wrapper below.

## Always use the wrapper

```bash
.claude/skills/deadwax-notion/ntn.sh <args>
```

Below, `N` means `.claude/skills/deadwax-notion/ntn.sh`.

- **Workspace.** It pins `NOTION_WORKSPACE_ID` to Will's **personal** workspace ("Will"). Bare `ntn` defaults to the **Stora** work workspace: never use it for this project. `N whoami` should say "Will".
- **Stdin.** Run without a terminal, `ntn api` waits on an open stdin forever, so the wrapper closes stdin for you. Don't add `</dev/null`. To pipe a body in, put `--stdin` first: `N --stdin pages update <id> < body.md`, or `N --stdin api v1/pages < body.json` for a large JSON body.
- **Named data sources.** `N <source> query [args]`, `N <source> create -d '<json>'` (sets `parent` for you) and `N <source> id`. The sources are in the table below.
- **Output.** `query` prints TSV (page id, then the properties); add `--json` before piping it to `jq` or `json.load`. Sort with `--sort "Prop desc"` (or `-s`), not `--sorts`.

## Deadwax IDs

Deadwax page: `3f53af96-9b6f-8158-8e74-d4b019f6d391` (https://app.notion.com/p/Deadwax-3f53af969b6f81588e74d4b019f6d391)

| Database | Source name in `N` | Database ID |
|---|---|---|
| RFCs | `rfcs` | `04bf6b6c-8e9e-484f-81c7-bdbc4bcc41fe` |
| Projects | `projects` | `dadc2a71-c9ca-431b-be06-2dd8523bc34d` |
| Tickets | `tickets` | `06e45f97-abbd-418d-b721-384ac13667f8` |
| Research | `research` | `2b6d1589-d8a4-44ef-a4cc-98d881c54b4d` |
| Scratchpad | `scratchpad` | `76857396-0d46-4962-a1bd-e64b439fd575` |
| Glossary | `glossary` | `3ee85ace-2264-4f2b-a3cc-1cc58b8e9642` |
| Design decisions | `decisions` | `028cb0ff-c8a4-444c-b53e-928f3529286f` |
| Process log | `process-log` | `28103c78-e50f-4990-a6ae-47bd1494936b` |

A new database gets a line in `ntn.sh`'s `source_id` and a row here.

Will's Notion user ID (for `people` properties such as RFC Author): `eafd9c84-49ac-412c-91f2-650a1edfa069`

**Properties** (names are exact):
- **RFCs:** `Name` (title), `Number` (auto, DWX-RFC-n: Notion prefixes are unique per workspace and Uta has `RFC`. Call it RFC-n everywhere else), `Status` (Draft · In Discussion · Accepted · Rejected · Superseded), `Author` (people), `Date accepted` (date), `Projects` (relation)
- **Projects:** `Name`, `Status` (Planned · Active · Done), `RFCs` (relation), `Tickets` (relation), `Progress` (rollup, read-only)
- **Research:** `Name` (title), `Date` (date gathered), `RFCs` (relation; the back-link on RFCs is `Research`)
- **Tickets:** `Name`, `ID` (auto, DWX-n), `Status` (Backlog · Ready · In Progress · Blocked · In Review · Done), `Type` (Feature · Bug · Chore · Spike), `Project` (relation), `PR` (url)
- **Scratchpad:** see the `scratchpad` skill. RFCs and Projects have a `Scratchpad notes` back-link to it.
- **Design decisions:** the provisional design decisions log (see the `work-ticket` skill). `Name` (title, the decision in a few words), `ID` (auto, a plain number: Notion wants a prefix of at least two characters, so call number n `D-n` everywhere else), `Status` (Open · Revised · Adopted · Rejected), `Needed` (text: what the ticket needed that `DESIGN.md` doesn't cover), `Chosen and why` (text), `Principles` (text: the `DESIGN.md` principles relied on), `Alternatives` (text), `Screenshot` (files), `Ticket` (relation to Tickets; the back-link on Tickets is `Design decisions`)
- **Process log:** `Name` (title, the change in one line), `Date` (date of the change), `Status` (Proposed · Trying · Working · Replaced · Reverted), `Area` (select: Planning · Building · Review · Learning · Tooling · Design), `Lives in` (text: the skills, files or memory that hold it)
- **Glossary:** `Term` (title), `Area` (select: Spotify · Music metadata · Collection model · Design · Testing · Stack and Rust), `Definition` (text, one plain sentence), `Related` (relation to other terms, one-way, so set it on both terms), `Introduced in` (relation to RFCs; the back-link on RFCs is `Glossary`)

The Deadwax page body contains `<database …>` tags. If you ever update that page, keep them exactly as they are, or the databases get removed from the page.

## Page templates

**Research body:** one opening paragraph saying what it's for (which RFC or question) and when it was gathered, then a section per topic. Every claim carries a source link, and anything from a secondary source or a search snippet says so.

**RFC body:** `## Summary` · `## Motivation` · `## Proposal` · `## What it looks like to you` (the result the user sees and hears) · `## Alternatives considered` · `## Risks & unknowns` · `## How we'll verify it` (required) · `## Open questions` · `## New terms` (if any)

**Process log entry body:** `## What wasn't working` (with evidence: Will's words, PR numbers, timings) · `## What changed` · `## How it's going` (dated bullets, added at each check-in). A `Proposed` entry uses `## What isn't working` · `## The idea` · `## Status`.

**Glossary entry body:** it's about the concept, not the code, so no file or function names. A paragraph or two explaining it in plain words for someone who knows web development and music deeply but not Rust or the Spotify platform. Then, where they fit:
- `**Think of it as:**` an analogy from web, React or Canvas work.
- `**Why it matters in Deadwax:**` the decision it drove, or what goes wrong without it.

Before adding a term, query the Glossary for it so you don't add a duplicate. If it's there but the new work changes its meaning in Deadwax, update that entry instead.

**Ticket body:**
- `## Goal`
- `## Acceptance criteria` (a checklist, `- [ ]`)
- `## Out of scope`
- `## Depends on` (DWX-n IDs, or "Nothing")
- `## Context` (RFC link and the sections this implements)
- `## Verification notes`: left empty at creation. The implementer fills it in before moving the ticket to In Review, saying what was checked and how.

Branches and PR titles use the ticket ID: branch `dwx-12-short-name`, PR title `DWX-12: …`.

## Two tools: `pages` for content, `api` for properties

- `N pages get <id>` returns the page as Markdown with properties as YAML frontmatter. Best way to read a ticket/RFC.
- `N pages create --content '# Title\n\nBody'` creates a page. A leading `# H1` becomes the title and is removed from the body. With no `--parent` it lands at the workspace root.
- `N pages update <id> --content '...'` (or `N --stdin pages update <id> < body.md`) **replaces the whole body**. Read it first, edit, write back. Never blind-overwrite an RFC someone has edited.
- `N pages trash <id> --yes` (`--yes` is required when non-interactive).
- `N api <path> [-X METHOD] -d '<json>'` is the raw API, needed for properties, databases and comments. `N api ls` lists endpoints; `N api <path> -X POST --spec` shows the schema.

## Recipes

**Create a row with properties and body in one call.** `markdown` is a top-level field, and `create` adds the `parent`:
```bash
N tickets create -d '{
  "properties":{"Name":{"title":[{"text":{"content":"Ticket title"}}]},
                "Status":{"status":{"name":"Backlog"}},
                "Project":{"relation":[{"id":"<project page id>"}]}},
  "markdown":"## Goal\n..."}'
```

Markdown code fences with no language become `javascript` code blocks, and leading indentation is trimmed. To fix a diagram, find the block with `N api v1/blocks/<page>/children page_size==100` and PATCH it with `{"code":{"language":"plain text"}}`.

**Update properties** (status, PR link):
```bash
N api v1/pages/<id> -X PATCH -d '{"properties":{"Status":{"status":{"name":"In Review"}},"PR":{"url":"https://github.com/..."}}}'
```

**Query a data source.** Default output is TSV (id, ID, title, props…), and `--json` gives full objects:
```bash
N tickets query --filter '{"property":"ID","unique_id":{"equals":12}}'   # find DWX-12
N scratchpad query --json --filter '{"property":"Status","status":{"equals":"Raw"}}' | jq -r '.results[].id'
```
`N datasources resolve <database-id>` turns any other database ID into its data source ID.

**Comments:**
```bash
N api v1/comments block_id==<page id>                     # list
N api v1/comments -d '{"parent":{"page_id":"<id>"},"rich_text":[{"text":{"content":"🤖 Claude: ..."}}]}'
```
Comments posted via the CLI show as authored by Will, so **always prefix yours with `🤖 Claude:`** to tell them apart.
- **Inline comments** live on individual blocks. Walk the whole page with `.claude/skills/rfc/comments.py`.
- **Replying** in a thread: `-d '{"discussion_id":"...","rich_text":[...]}'`.
- **Rewriting a block's text deletes the inline threads anchored to it.**

**Create a database** (under a page). Property types that were tested and work: `title`, `status` with custom options (each option's `group` is `To-do` | `In progress` | `Complete`), `unique_id` with a `prefix` (gives IDs like DWX-1), `relation` with `"type":"dual_property"` (creates the back-link on the other database), `url`, `select`, `date`, `people`.
```bash
N api v1/databases -d '{"parent":{"type":"page_id","page_id":"<page>"},
  "title":[{"text":{"content":"Tickets"}}],
  "initial_data_source":{"properties":{"Name":{"title":{}}, "ID":{"unique_id":{"prefix":"DWX"}}}}}'
```
The response's `data_sources[0].id` is the data source ID. Add it to `source_id` in `ntn.sh`, and the database to the table above.

## Rules

- Moving an RFC to **Accepted** is Will's call only. Never do it on your own judgement.
- Show Will a breakdown before creating projects or tickets in bulk.
- Don't write temp files to `/tmp`. Use the session scratchpad.
