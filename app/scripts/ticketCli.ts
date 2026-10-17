// The command line for `scripts/ticket`, which runs it with Node. The commands
// are in ticket.ts, and the Notion and GitHub behind them in ticketServices.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceProblems } from "./evidence.ts";
import { Refusal, claim, describeProblems, merge, parseId, ready, show, sync, tick } from "./ticket.ts";
import { gitTree, realServices } from "./ticketServices.ts";

const HELP = `Usage: scripts/ticket <command> [args] [--dry-run]

A Deadwax ticket's Notion and GitHub steps, each one command. Notion is Will's
personal workspace, through .claude/skills/deadwax-notion/ntn.sh. A ticket's
dependencies are the DWX-n IDs under its body's "Depends on" heading, and one
is met when it's Done and its PR is merged (or it has no PR).

Commands:
  show DWX-n
      The ticket's page ID, status, type, project and PR, and each dependency
      with its status and whether its PR is merged.

  ready
      Every Ready ticket whose dependencies are all met: they can all run
      alongside each other. Then Ready tickets still waiting on something,
      and what's In Progress or In Review now.

  claim DWX-n --branch <name>
      Refuses unless the ticket is Ready and its dependencies are met. Sets it
      In Progress, sets its project Active if it was Planned, and comments
      "🤖 Claude: Started on branch <name>." on it.

  tick DWX-n <criterion>...
      Ticks the acceptance criteria checkboxes each <criterion> names: the one
      whose text contains it (ignoring case, backticks and spacing), or, if
      several do, the one whose text is exactly it. Ticks nothing if any
      criterion matches no checkbox or several, and lists them all.

  evidence-check <file> [--ref <commit>]
      Checks that everything a PR body (in <file>) quotes in backticks is in
      the branch: a name (snake_case or camelCase, such as a Rust test's) is
      a whole word in a tracked file; words in plain English (a vitest test's
      name, or a label the UI shows) appear word for word in a tracked file
      that isn't Markdown; a path is a tracked file or folder; a command's
      script, npm script, cargo package (-p) and test target (--test), and
      any path in it, exist. Shell lines in bash blocks are commands too.
      Placeholders (<n>, …), globs and paths git ignores are skipped, and so
      is a name that's gone: struck through (~~\`lastDrag\`~~) or renamed
      (\`sliderScale\` → \`numberScale\`). It also refuses totals ("76 tests"):
      name the tests, don't count them. Checks the working tree, or the
      commit --ref names.

  sync DWX-n --pr <n> <file>
      Makes the ticket and the PR match <file>, the PR body: runs
      evidence-check on it, then updates the PR's description, ticks and
      unticks the ticket's criteria to match the PR's "- [x]" and "- [ ]"
      lines under "## Acceptance criteria" (each line starts with the
      ticket's text for that criterion), replaces the ticket's Verification
      notes with the PR's acceptance criteria, "For Will to try" and
      follow-ups, and sets the ticket's PR link and In Review. Changes only
      what differs, so running it again after a fix updates everything in
      one go, and once more changes nothing.

  merge DWX-n
      Refuses unless the ticket is In Review (or Done), the newest review on
      its PR says Ready to merge and was of the PR's head commit, and CI is
      green on that commit.
      Squash merges the PR and deletes its remote branch (git push origin
      --delete, not gh's --delete-branch, which fails from a worktree). Sets
      the ticket Done, sets each Backlog ticket it unblocks to Ready, sets the
      project Done if every ticket in it is, and prints what's ready now.
      Already merged: skips to the Notion steps.

Options:
  --dry-run  Read Notion and GitHub as usual, but change nothing: print each
             change and the ntn.sh, gh or git command that would make it.

Exit status: 0 done, 1 refused or failed (it says why), 2 bad usage.`;

const checkout = resolve(fileURLToPath(new URL("../..", import.meta.url)));

class Usage extends Error {}

/** The value after `--name`, or undefined. Removes both from `args`. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Usage(`${name} needs a value.`);
  args.splice(at, 2);
  return value;
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Usage(`${name} is required.`);
  return value;
}

function main(argv: string[]): number {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return args.length === 0 ? 2 : 0;
  }
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  const command = rest.shift();
  const services = realServices(checkout);
  const run = services.run(dryRun);

  const ticketArg = () => {
    const id = rest.shift();
    if (id === undefined) throw new Usage(`${command} needs a ticket: DWX-n.`);
    return parseId(id);
  };
  const noMore = () => {
    if (rest.length > 0) throw new Usage(`Unexpected: ${rest.join(" ")}`);
  };

  try {
    let out: string[];
    switch (command) {
      case "show": {
        const id = ticketArg();
        noMore();
        out = show(services, id);
        break;
      }
      case "ready":
        noMore();
        out = ready(services);
        break;
      case "claim": {
        const branch = required(rest, "--branch");
        const id = ticketArg();
        noMore();
        out = claim(services, run, id, branch);
        break;
      }
      case "tick": {
        const id = ticketArg();
        if (rest.length === 0) throw new Usage("tick needs at least one criterion.");
        out = tick(services, run, id, rest);
        break;
      }
      case "merge": {
        const id = ticketArg();
        noMore();
        out = merge(services, run, id);
        break;
      }
      case "evidence-check": {
        const ref = option(rest, "--ref");
        const file = rest.shift();
        if (file === undefined) throw new Usage("evidence-check needs a file: the PR body.");
        noMore();
        const problems = evidenceProblems(readFileSync(file, "utf8"), gitTree(checkout, ref, file));
        if (problems.length > 0) throw new Refusal(describeProblems(file, problems));
        out = [`Every reference in ${file} is in ${ref ?? "the working tree"}.`];
        break;
      }
      case "sync": {
        const pr = Number(required(rest, "--pr"));
        if (!Number.isInteger(pr) || pr <= 0) throw new Usage("--pr needs a PR number.");
        const id = ticketArg();
        const file = rest.shift();
        if (file === undefined) throw new Usage("sync needs a file: the PR body.");
        noMore();
        out = sync(services, run, gitTree(checkout, undefined, file), id, pr, file, readFileSync(file, "utf8"));
        break;
      }
      default:
        throw new Usage(`Unknown command: ${command}`);
    }
    if (out.length > 0) console.log(out.join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof Usage) {
      console.error(`${error.message}\n\n${HELP}`);
      return 2;
    }
    if (error instanceof Refusal) {
      console.error(error.message);
      return 1;
    }
    // A failed ntn.sh, gh or git call: execFileSync puts its stderr on the error.
    const stderr = (error as { stderr?: string }).stderr;
    console.error(`${(error as Error).message}${stderr ? `\n${stderr}` : ""}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
