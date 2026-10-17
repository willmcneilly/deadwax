// The command line for `scripts/ticket`, which runs it with Node. The commands
// are in ticket.ts, and the Notion and GitHub behind them in ticketServices.ts.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal, claim, merge, parseId, ready, show, tick } from "./ticket.ts";
import { realServices } from "./ticketServices.ts";

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
