import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Tree } from "./evidence.ts";
import {
  type Action,
  type Check,
  type Pr,
  type PrState,
  type Project,
  type Review,
  Refusal,
  type Services,
  type Ticket,
  type Todo,
  ciState,
  claim,
  commandLine,
  dependencies,
  matchTodos,
  merge,
  notesSection,
  pairCriteria,
  parseDependsOn,
  parseId,
  readyReport,
  sync,
  tick,
  verdict,
  verificationNotes,
  whyNotMergeable,
} from "./ticket.ts";

const PROJECT = "project-page";
const HEAD = "abcdef1234567";

/** A review of `commit`, the fake PR's head commit unless it says otherwise. */
const review = (body: string, commit = HEAD): Review => ({ body, commit });

/** A fake Notion and GitHub: tickets are [id, status, depends on, PR state] with PR n = 10000 + id. */
function fake(
  rows: [number, string, number[], PrState | "none"][],
  extra: { project?: Partial<Project>; todos?: Todo[]; pr?: Partial<Pr>; markdown?: string } = {},
): Services {
  const tickets: Ticket[] = rows.map(([id, status, , pr]) => ({
    pageId: `page-${id}`,
    id,
    name: `Ticket ${id}`,
    status,
    type: "Chore",
    pr: pr === "none" ? undefined : `https://github.com/willmcneilly/deadwax/pull/${10000 + id}`,
    projectId: PROJECT,
  }));
  const bodies = new Map(
    rows.map(([id, , deps]) => [
      `page-${id}`,
      `## Goal\nSomething, unlike DWX-999.\n## Depends on\n${deps.length ? deps.map((d) => `DWX-${d}`).join(" and ") : "Nothing."}\n## Context\nSee DWX-998.`,
    ]),
  );
  const states = new Map<number, PrState>(
    rows.filter(([, , , pr]) => pr !== "none").map(([id, , , pr]) => [10000 + id, pr as PrState]),
  );
  return {
    tickets: () => tickets,
    body: (pageId) => bodies.get(pageId) ?? "",
    project: (pageId) => ({ pageId, name: "Tooling", status: "Active", ...extra.project }),
    todos: () => extra.todos ?? [],
    markdown: () => ({ markdown: extra.markdown ?? "## Goal\nSomething.\n## Verification notes", truncated: false }),
    prStates: () => states,
    pr: (number) => ({
      number,
      url: `https://github.com/willmcneilly/deadwax/pull/${number}`,
      state: states.get(number) ?? "OPEN",
      branch: "dwx-1-thing",
      headSha: HEAD,
      checks: [{ name: "Rust", status: "COMPLETED", conclusion: "SUCCESS" }],
      reviews: [review("🤖 Claude (review):\n\n**Verdict: Ready to merge.**")],
      body: "",
      ...extra.pr,
    }),
  };
}

/** A Run that records each action, as a dry run would print it. */
function recorder(): { run: (a: Action) => string | undefined; actions: Action[] } {
  const actions: Action[] = [];
  return { actions, run: (a) => (actions.push(a), undefined) };
}

const summaries = (actions: Action[]) => actions.map((a) => a.summary);

describe("parseId", () => {
  it("takes DWX-n, dwx-n or a bare number", () => {
    expect([parseId("DWX-14"), parseId("dwx-7"), parseId("12")]).toEqual([14, 7, 12]);
  });

  it("refuses anything else", () => {
    expect(() => parseId("D-3")).toThrow(Refusal);
  });
});

describe("parseDependsOn", () => {
  it("reads the IDs under the Depends on heading only", () => {
    const body = "## Goal\nUnlike DWX-1.\n## Depends on\nDWX-53, DWX-54 and DWX-43, after DWX-53 lands.\n## Context\nDWX-9.";
    expect(parseDependsOn(body)).toEqual([53, 54, 43]);
  });

  it("is empty for Nothing, or no heading", () => {
    expect(parseDependsOn("## Depends on\nNothing.\n## Context")).toEqual([]);
    expect(parseDependsOn("## Goal\nDWX-3")).toEqual([]);
  });

  it("reads to the end when Depends on is the last section", () => {
    expect(parseDependsOn("## Depends on\n- DWX-2\n- DWX-3\n")).toEqual([2, 3]);
  });
});

describe("dependencies", () => {
  const tickets = fake([
    [1, "Done", [], "MERGED"],
    [2, "Done", [], "OPEN"],
    [3, "In Review", [], "OPEN"],
    [4, "Done", [], "none"],
  ]);

  it("is met when Done and merged, or Done with no PR", () => {
    const deps = dependencies([1, 2, 3, 4, 5], tickets.tickets(), tickets.prStates());
    expect(deps.map((d) => [d.id, d.pr, d.met])).toEqual([
      [1, "merged", true],
      [2, "not merged", false],
      [3, "not merged", false],
      [4, "no PR", true],
      [5, "no PR", false], // Not in Notion at all.
    ]);
  });

  it("counts the ticket being merged as Done and merged", () => {
    const [dep] = dependencies([3], tickets.tickets(), tickets.prStates(), 3);
    expect(dep.met).toBe(true);
  });

  it("isn't met when GitHub doesn't know the PR", () => {
    const [dep] = dependencies([1], tickets.tickets(), new Map());
    expect(dep).toMatchObject({ pr: "unknown PR", met: false });
  });
});

describe("claim", () => {
  it("refuses a Backlog ticket", () => {
    const { run, actions } = recorder();
    const services = fake([[5, "Backlog", [], "none"]]);
    expect(() => claim(services, run, 5, "dwx-5-x")).toThrow("DWX-5 is Backlog, not Ready.");
    expect(actions).toEqual([]);
  });

  it("refuses a ticket with a dependency that's Done but not merged", () => {
    const { run, actions } = recorder();
    const services = fake([
      [1, "Done", [], "OPEN"],
      [5, "Ready", [1], "none"],
    ]);
    expect(() => claim(services, run, 5, "dwx-5-x")).toThrow("DWX-5 depends on DWX-1  Done, PR not merged");
    expect(actions).toEqual([]);
  });

  it("sets In Progress, the project Active if it was Planned, and comments", () => {
    const { run, actions } = recorder();
    const services = fake(
      [
        [1, "Done", [], "MERGED"],
        [5, "Ready", [1], "none"],
      ],
      { project: { status: "Planned" } },
    );
    claim(services, run, 5, "dwx-5-thing");
    expect(summaries(actions)).toEqual([
      "Set DWX-5 to In Progress.",
      "Set the project Tooling to Active.",
      'Comment "🤖 Claude: Started on branch dwx-5-thing."',
    ]);
    expect(actions[0].call.args).toEqual([
      "api",
      "v1/pages/page-5",
      "-X",
      "PATCH",
      "-d",
      '{"properties":{"Status":{"status":{"name":"In Progress"}}}}',
    ]);
    expect(JSON.parse(actions[2].call.args[3])).toEqual({
      parent: { page_id: "page-5" },
      rich_text: [{ text: { content: "🤖 Claude: Started on branch dwx-5-thing." } }],
    });
  });

  it("leaves an Active project alone", () => {
    const { run, actions } = recorder();
    claim(fake([[5, "Ready", [], "none"]]), run, 5, "b");
    expect(summaries(actions)).not.toContain("Set the project Tooling to Active.");
  });
});

describe("matchTodos", () => {
  const todos: Todo[] = [
    { blockId: "a", text: "`show` and `ready` give the right answers", checked: false },
    { blockId: "b", text: "Process log entry added", checked: false },
    { blockId: "c", text: "Process log entry added, with evidence.", checked: false },
    { blockId: "d", text: "Unit tests cover dependency checking", checked: true },
  ];

  it("matches by part of the text, ignoring case, backticks and spacing", () => {
    expect(matchTodos(todos, ["SHOW and  ready give"]).map((t) => t.blockId)).toEqual(["a"]);
    expect(matchTodos(todos, ["`show` and `ready`"]).map((t) => t.blockId)).toEqual(["a"]);
  });

  it("takes the exact match when several contain it", () => {
    expect(todos.filter((t) => t.text.toLowerCase().includes("process log entry added"))).toHaveLength(2);
    expect(matchTodos(todos, ["process log entry added"]).map((t) => t.blockId)).toEqual(["b"]);
  });

  it("refuses an ambiguous criterion, naming the candidates", () => {
    expect(() => matchTodos(todos, ["Process log"])).toThrow(/"Process log" matches 2 criteria:\n {4}- Process log entry added\n/);
  });

  it("refuses a criterion that matches nothing, listing the criteria", () => {
    expect(() => matchTodos(todos, ["golden WAVs"])).toThrow(/No criterion matches "golden WAVs"\.[\s\S]*\[x\] Unit tests/);
  });

  it("refuses an empty criterion", () => {
    expect(() => matchTodos(todos, [" "])).toThrow(Refusal);
  });

  it("names a checkbox once when two criteria match it", () => {
    expect(matchTodos(todos, ["show", "ready give"])).toHaveLength(1);
  });
});

describe("tick", () => {
  const todos: Todo[] = [
    { blockId: "a", text: "First criterion", checked: false },
    { blockId: "b", text: "Second criterion", checked: true },
  ];

  it("ticks unticked matches, and says which were already ticked", () => {
    const { run, actions } = recorder();
    const out = tick(fake([[5, "Done", [], "none"]], { todos }), run, 5, ["first", "second"]);
    expect(actions.map((a) => a.call.args)).toEqual([["api", "v1/blocks/a", "-X", "PATCH", "-d", '{"to_do":{"checked":true}}']]);
    expect(out).toEqual(["Already ticked: Second criterion"]);
  });

  it("ticks nothing if any criterion fails", () => {
    const { run, actions } = recorder();
    expect(() => tick(fake([[5, "Done", [], "none"]], { todos }), run, 5, ["first", "third"])).toThrow(Refusal);
    expect(actions).toEqual([]);
  });
});

describe("verdict", () => {
  it.each([
    ["🤖 Claude (review):\n\n**Verdict: Ready to merge.** No blocking findings.", "Ready to merge"],
    ["🤖 Claude (re-review of 67d1d6c): **Ready to merge.** 0 blocking.", "Ready to merge"],
    ["🤖 Claude (review):\n\n**Verdict: Changes needed.** It's not ready to merge until …", "Changes needed"],
    ["🤖 Claude (review): Not ready to merge yet.\n\n**Verdict: Changes needed.**", "Changes needed"],
    ["🤖 Claude (review): changes needed, then ready to merge", "Changes needed"],
    ["🤖 Claude (review):\n\n**Verdict: Not ready to merge.**", "Changes needed"],
    ["🤖 Claude (review): not ready to merge, two blocking.", "Changes needed"],
    ["🤖 Claude (review):\n\n## Verdict: Ready to merge\n\nNo blocking findings.", "Ready to merge"],
    ["🤖 Claude (review): it was not ready to merge before.\n\n## Verdict: Ready to merge", "Ready to merge"],
    ["🤖 Claude (review):\n\n## Verdict: Changes needed\n\nThen it's ready to merge.", "Changes needed"],
    ["🤖 Claude (review): nothing to say", undefined],
  ])("reads %j", (body, expected) => {
    expect(verdict(body)).toBe(expected);
  });
});

describe("ciState", () => {
  const run = (conclusion: string, status = "COMPLETED"): Check => ({ name: conclusion, status, conclusion });
  it.each<[Check[], string]>([
    [[run("SUCCESS"), run("SKIPPED"), { name: "status", state: "SUCCESS" }], "passing"],
    [[run("SUCCESS"), run("", "IN_PROGRESS")], "pending"],
    [[run("SUCCESS"), { name: "status", state: "PENDING" }], "pending"],
    [[run("FAILURE"), run("", "QUEUED")], "failed"],
    [[{ name: "status", state: "ERROR" }], "failed"],
    [[], "none"],
  ])("%j is %s", (checks, expected) => {
    expect(ciState(checks)).toBe(expected);
  });
});

describe("whyNotMergeable", () => {
  const pr = fake([[1, "In Review", [], "OPEN"]]).pr(10001);

  it("is undefined when the newest review says Ready to merge and CI is green", () => {
    expect(whyNotMergeable(pr)).toBeUndefined();
  });

  it("goes by the newest reviewer review, skipping replies", () => {
    const reviews = ["🤖 Claude (review): **Ready to merge.**", "🤖 Claude (re-review of abc): **Changes needed.**", "Fixed in 123."].map((b) => review(b));
    expect(whyNotMergeable({ ...pr, reviews })).toBe("The newest review of PR #10001 says Changes needed.");
    expect(whyNotMergeable({ ...pr, reviews: reviews.slice(1).reverse() })).toBe("The newest review of PR #10001 says Changes needed.");
    expect(whyNotMergeable({ ...pr, reviews: [...reviews, review("🤖 Claude (re-review of def): Ready to merge.")] })).toBeUndefined();
  });

  it("refuses when the newest review is of an earlier commit, even with CI green", () => {
    const reviews = [review("🤖 Claude (review): **Verdict: Ready to merge.**", "0123456789abc")];
    expect(whyNotMergeable({ ...pr, reviews })).toBe(
      "The newest review of PR #10001 is of 0123456, not the head commit abcdef1. Run another review round.",
    );
  });

  it("refuses with no review, or CI not green", () => {
    expect(whyNotMergeable({ ...pr, reviews: [review("LGTM")] })).toMatch(/has no review yet/);
    expect(whyNotMergeable({ ...pr, checks: [{ name: "Rust", status: "IN_PROGRESS" }] })).toBe(
      "PR #10001 has CI still running (Rust) on abcdef1.",
    );
    expect(whyNotMergeable({ ...pr, checks: [{ name: "Lint", status: "COMPLETED", conclusion: "FAILURE" }] })).toBe(
      "PR #10001 has CI failing (Lint) on abcdef1.",
    );
  });
});

describe("merge", () => {
  // 7 is being merged. 8 waits on 7 alone; 9 on 7 and 6, which isn't merged;
  // 10 doesn't need 7; 11 was Ready already.
  const rows: [number, string, number[], PrState | "none"][] = [
    [6, "Done", [], "OPEN"],
    [7, "In Review", [], "OPEN"],
    [8, "Backlog", [7], "none"],
    [9, "Backlog", [7, 6], "none"],
    [10, "Backlog", [], "none"],
  ];

  it("merges, deletes the branch, sets Done and readies only what 7 unblocks", () => {
    const { run, actions } = recorder();
    const out = merge(fake(rows), run, 7);
    expect(summaries(actions)).toEqual([
      "Squash merge PR #10007 at abcdef1.",
      "Delete the remote branch dwx-1-thing.",
      "Set DWX-7 to Done.",
      "Set DWX-8 to Ready (Ticket 8).",
    ]);
    expect(actions.slice(0, 2).map((a) => commandLine(a.call))).toEqual([
      "gh pr merge 10007 --squash --match-head-commit abcdef1234567",
      "git push origin --delete dwx-1-thing",
    ]);
    // What's ready afterwards counts 7 as merged and 8 as Ready.
    expect(out).toContain("Ready to start (Ready, with every dependency Done and merged):");
    expect(out).toContain("  DWX-8  Ticket 8  (Tooling)");
  });

  it("sets the project Done when every other ticket is", () => {
    const { run, actions } = recorder();
    merge(fake([[6, "Done", [], "MERGED"], [7, "In Review", [], "OPEN"]]), run, 7);
    expect(summaries(actions).at(-1)).toBe("Set the project Tooling to Done: every ticket is.");
  });

  it("skips the merge for a PR that's already merged, and a ticket already Done", () => {
    const { run, actions } = recorder();
    const out = merge(fake([[7, "Done", [], "MERGED"], [8, "Backlog", [7], "none"]], { project: { status: "Done" } }), run, 7);
    expect(out[0]).toBe("PR #10007 is already merged.");
    expect(summaries(actions)).toEqual(["Set DWX-8 to Ready (Ticket 8)."]);
  });

  it("refuses when the newest review isn't Ready to merge, changing nothing", () => {
    const { run, actions } = recorder();
    const services = fake(rows, { pr: { reviews: [review("🤖 Claude (review): **Verdict: Changes needed.**")] } });
    expect(() => merge(services, run, 7)).toThrow("Not merging: The newest review of PR #10007 says Changes needed.");
    expect(actions).toEqual([]);
  });

  it("refuses a ticket that isn't In Review, or has no PR", () => {
    const { run } = recorder();
    expect(() => merge(fake([[7, "In Progress", [], "OPEN"]]), run, 7)).toThrow("DWX-7 is In Progress, not In Review.");
    expect(() => merge(fake([[7, "In Review", [], "none"]]), run, 7)).toThrow("DWX-7 has no PR link.");
  });
});

describe("readyReport", () => {
  it("splits Ready tickets into startable and waiting, and lists what's running", () => {
    const report = readyReport(
      fake([
        [1, "Done", [], "MERGED"],
        [2, "In Progress", [], "none"],
        [3, "Ready", [1], "none"],
        [4, "Ready", [2], "none"],
        [5, "Ready", [], "none"],
        [6, "In Review", [], "OPEN"],
      ]),
    );
    expect(report.startable.map((t) => t.id)).toEqual([3, 5]);
    expect(report.waiting.map(({ ticket, deps }) => [ticket.id, deps.map((d) => d.id)])).toEqual([[4, [2]]]);
    expect(report.running.map((t) => t.id)).toEqual([2, 6]);
  });
});

describe("commandLine", () => {
  it("quotes what the shell would split, and names ntn.sh by its path", () => {
    expect(commandLine({ tool: "ntn.sh", args: ["api", "v1/comments", "-d", `{"a":"it's"}`] })).toBe(
      `.claude/skills/deadwax-notion/ntn.sh api v1/comments -d '{"a":"it'\\''s"}'`,
    );
  });
});

describe("pairCriteria", () => {
  const todos: Todo[] = [
    { blockId: "b1", text: "`evidence-check` passes on PR 8's body.", checked: false },
    { blockId: "b2", text: "Process log entry added", checked: true },
  ];

  it("pairs each PR line with the checkbox whose text starts it, ignoring bold, backticks and the full stop", () => {
    const pairs = pairCriteria(todos, [
      { text: "**Process log entry added:** [link](https://x.y).", checked: true },
      { text: "**`evidence-check` passes on PR 8's body.** I ran it at 4a90161.", checked: false },
    ]);
    expect(pairs.map((p) => p.todo.blockId)).toEqual(["b2", "b1"]);
  });

  it("refuses a PR line no checkbox starts, and a checkbox the PR leaves out, listing the ticket's criteria", () => {
    expect(() => pairCriteria(todos, [{ text: "**Evidence checking works.**", checked: true }])).toThrow(
      /No ticket criterion starts the PR's "\*\*Evidence checking works\.\*\*"[\s\S]*leave out "`evidence-check` passes[\s\S]*Process log entry added/,
    );
  });

  it("refuses two PR lines for one checkbox", () => {
    expect(() =>
      pairCriteria(todos, [
        { text: "Process log entry added.", checked: true },
        { text: "Process log entry added, again.", checked: true },
        { text: "`evidence-check` passes on PR 8's body.", checked: true },
      ]),
    ).toThrow(/Two of the PR's criteria start with "Process log entry added"/);
  });
});

describe("verificationNotes", () => {
  const body = [
    "Intro, not copied.",
    "## Acceptance criteria",
    "- [x] **Done thing.** `a_test`.",
    "- [ ] **Not done.** Because.",
    "### A subsection",
    "## For Will to try",
    "1. Open it.",
    "## Design decisions",
    "None.",
    "## Follow-ups",
    "- Later.",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");

  it("copies the criteria as ✓ and ✗, For Will to try and follow-ups, one level down, ending with a hash", () => {
    const { notes, hash } = verificationNotes(body, { number: 15, url: "https://github.com/willmcneilly/deadwax/pull/15" });
    expect(notes).toBe(
      [
        "From [PR #15](https://github.com/willmcneilly/deadwax/pull/15).",
        "",
        "### Acceptance criteria",
        "",
        "- ✓ **Done thing.** `a_test`.",
        "- ✗ **Not done.** Because.",
        "**A subsection**",
        "",
        "### For Will to try",
        "",
        "1. Open it.",
        "",
        "### Follow-ups",
        "",
        "- Later.",
        "",
        `Synced by scripts/ticket sync · ${hash}`,
      ].join("\n"),
    );
    expect(verificationNotes(body.replace("Because", "Since"), { number: 15, url: "u" }).hash).not.toBe(hash);
  });

  it("refuses a body without For Will to try", () => {
    expect(() => verificationNotes("## Acceptance criteria\n- [x] A", { number: 1, url: "u" })).toThrow(/For Will to try/);
  });
});

describe("notesSection", () => {
  it("runs from the heading to the next level-1 or level-2 heading, or the end", () => {
    expect(notesSection("## Goal\nG\n## Verification notes\n- a\n### Sub\n- b")).toBe("## Verification notes\n- a\n### Sub\n- b");
    expect(notesSection("## Verification notes\n- a\n## After\nx")).toBe("## Verification notes\n- a");
    expect(notesSection("## Goal")).toBeUndefined();
  });

  it("doesn't end at a # line inside a code block", () => {
    const notes = "## Verification notes\n### For Will to try\n```bash\n# build it first\ncargo build\n```\n- after";
    expect(notesSection(`## Goal\nG\n${notes}`)).toBe(notes);
  });
});

describe("sync", () => {
  const everything: Tree = {
    files: () => [],
    wordsFound: (words) => new Set(words),
    phrasesFound: (phrases) => new Set(phrases),
    read: () => "",
    ignored: () => false,
  };
  const todos: Todo[] = [
    { blockId: "b1", text: "First criterion", checked: false },
    { blockId: "b2", text: "Second criterion", checked: true },
  ];
  const body = [
    "Changed things.",
    "## Acceptance criteria",
    "- [x] **First criterion.** `first_test` proves it.",
    "- [ ] **Second criterion.** Not yet.",
    "## For Will to try",
    "Nothing.",
  ].join("\n");
  const url = "https://github.com/willmcneilly/deadwax/pull/10007";

  it("updates the PR body, ticks to match, replaces the notes, and sets the PR link and In Review", () => {
    const { run, actions } = recorder();
    const out = sync(fake([[7, "In Progress", [], "none"]], { todos }), run, everything, 7, 10007, "pr.md", body);
    expect(out.slice(0, 3)).toEqual(["", "The Verification notes would be:", `  From [PR #10007](${url}).`]);
    expect(summaries(actions)).toEqual([
      "Update PR #10007's description from pr.md.",
      "Tick: First criterion",
      "Untick: Second criterion",
      `Replace DWX-7's Verification notes with PR #10007's criteria, "For Will to try" and follow-ups.`,
      `Set DWX-7's PR to ${url} and status to In Review.`,
    ]);
    expect(actions[0].call.args).toEqual(["api", "repos/{owner}/{repo}/pulls/10007", "-X", "PATCH", "-F", `body=@${resolve("pr.md")}`]);
    const notes = JSON.parse(actions[3].call.args[5]) as { update_content: { content_updates: { old_str: string; new_str: string }[] } };
    expect(notes.update_content.content_updates[0].old_str).toBe("## Verification notes");
    expect(notes.update_content.content_updates[0].new_str).toMatch(/^## Verification notes\n\nFrom \[PR #10007\][\s\S]*- ✗ \*\*Second criterion/);
  });

  it("replaces notes written by hand, up to the end of the page", () => {
    const { run, actions } = recorder();
    const markdown = "## Goal\nG\n## Verification notes\n- Checked by hand.\n### For Will to try\n- Old step.";
    sync(fake([[7, "In Review", [], "OPEN"]], { todos, markdown }), run, everything, 7, 10007, "pr.md", body);
    const notes = JSON.parse(actions.find((a) => a.summary.startsWith("Replace"))?.call.args[5] ?? "{}") as {
      update_content: { content_updates: { old_str: string }[] };
    };
    expect(notes.update_content.content_updates[0].old_str).toBe("## Verification notes\n- Checked by hand.\n### For Will to try\n- Old step.");
  });

  it("changes nothing when everything already matches", () => {
    const { hash, notes } = verificationNotes(body, { number: 10007, url });
    const services = fake([[7, "In Review", [], "OPEN"]], {
      todos: [
        { ...todos[0], checked: true },
        { ...todos[1], checked: false },
      ],
      // As GitHub can give it back: CRLF line ends.
      pr: { body: `${body.replace(/\n/g, "\r\n")}\n` },
      markdown: `## Goal\nG\n## Verification notes\n${notes}`,
    });
    expect(hash).toHaveLength(12);
    const { run, actions } = recorder();
    expect(sync(services, run, everything, 7, 10007, "pr.md", body)).toEqual(["Nothing to change: PR #10007 and DWX-7 already match pr.md."]);
    expect(actions).toEqual([]);
  });

  it("refuses, changing nothing, when the body quotes what isn't in the branch", () => {
    const nothing: Tree = { ...everything, wordsFound: () => new Set() };
    const { run, actions } = recorder();
    expect(() => sync(fake([[7, "In Progress", [], "none"]], { todos }), run, nothing, 7, 10007, "pr.md", body)).toThrow(
      /pr\.md has evidence to fix:\n {2}first_test {2}isn't in the code/,
    );
    expect(actions).toEqual([]);
  });

  it("refuses a ticket that isn't claimed, or links another PR", () => {
    const { run } = recorder();
    expect(() => sync(fake([[7, "Ready", [], "none"]], { todos }), run, everything, 7, 10007, "pr.md", body)).toThrow(/Ready\. Claim it first/);
    expect(() => sync(fake([[7, "In Review", [], "OPEN"]], { todos }), run, everything, 7, 99, "pr.md", body)).toThrow(/links PR #10007, not #99/);
  });

  it("refuses a page without Verification notes, or one Notion cut short", () => {
    const { run, actions } = recorder();
    expect(() => sync(fake([[7, "In Progress", [], "none"]], { todos, markdown: "## Goal\nG" }), run, everything, 7, 10007, "pr.md", body)).toThrow(
      /no "## Verification notes" heading/,
    );
    const services = fake([[7, "In Progress", [], "none"]], { todos });
    const cut: Services = { ...services, markdown: () => ({ markdown: "## Verification notes", truncated: true }) };
    expect(() => sync(cut, run, everything, 7, 10007, "pr.md", body)).toThrow(/cut DWX-7's page short/);
    expect(actions).toEqual([]);
  });

  it("leaves a Done ticket's status alone", () => {
    const { run, actions } = recorder();
    sync(fake([[7, "Done", [], "MERGED"]], { todos }), run, everything, 7, 10007, "pr.md", body);
    expect(summaries(actions).some((s) => s.includes("status"))).toBe(false);
  });
});
