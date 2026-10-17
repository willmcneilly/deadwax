import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./git.ts";
import { gitTree } from "./ticketServices.ts";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "deadwax-tree-")));
  git(dir, ["init", "--quiet"]);
  mkdirSync(join(dir, "app", "src"), { recursive: true });
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "app", "src", "NowPlaying.test.tsx"), 'it("shows the cover and an Open in Spotify link", () => {});\nconst playback_bar = 1;\n');
  writeFileSync(join(dir, "docs", "plan.md"), "The test `keeps the old name in a plan` is quoted here.\n");
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Start"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("gitTree", () => {
  it("finds a phrase inside a longer one, in the working tree and at a commit", () => {
    for (const tree of [gitTree(dir), gitTree(dir, "HEAD")]) {
      expect(tree.phrasesFound(["shows the cover and an Open in Spotify link", "Open in Spotify"])).toEqual(
        new Set(["shows the cover and an Open in Spotify link", "Open in Spotify"]),
      );
    }
  });

  it("looks for phrases outside Markdown, and for names as whole words", () => {
    const tree = gitTree(dir, "HEAD");
    expect(tree.phrasesFound(["keeps the old name in a plan"])).toEqual(new Set());
    expect(tree.wordsFound(["playback_bar", "playback"])).toEqual(new Set(["playback_bar"]));
  });

  it("leaves out the PR body being checked, untracked in the checkout", () => {
    const body = join(dir, "pr-body.md");
    writeFileSync(body, "Proved by `made_up_test_name`.\n");
    const tree = gitTree(dir, undefined, body);
    expect(tree.wordsFound(["made_up_test_name"])).toEqual(new Set());
    expect(tree.files()).not.toContain("pr-body.md");
    expect(gitTree(dir).wordsFound(["made_up_test_name"])).toEqual(new Set(["made_up_test_name"]));
  });
});
