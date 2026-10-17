import { describe, expect, it } from "vitest";
import { type Tree, classify, evidenceProblems, quoted, totals } from "./evidence.ts";

/** A fake checkout: these files, whose text is what `read`, `wordsFound` and `phrasesFound` look in. */
function tree(files: Record<string, string>, ignored: string[] = []): Tree {
  return {
    files: () => Object.keys(files),
    wordsFound: (words) =>
      new Set(words.filter((w) => Object.values(files).some((text) => new RegExp(`(^|\\W)${w}(\\W|$)`).test(text)))),
    phrasesFound: (phrases) =>
      new Set(phrases.filter((p) => Object.entries(files).some(([path, text]) => !path.endsWith(".md") && text.includes(p)))),
    read: (path) => files[path] ?? "",
    ignored: (path) => ignored.some((i) => path === i || path.startsWith(`${i}/`)),
  };
}

const CHECKOUT = tree(
  {
    "Cargo.toml": "[workspace]\nmembers = []",
    "crates/deadwax-core/Cargo.toml": '[package]\nname = "deadwax-core"\nversion = "0.1.0"',
    "crates/deadwax-core/tests/collection.rs": "#[test]\nfn adds_an_album_once() {}\nconst PAGE_SIZE: usize = 50;",
    "crates/deadwax-core/src/collection.rs": "pub struct Collection;",
    "app/package.json": JSON.stringify({ scripts: { typecheck: "tsc -b", test: "vitest run" } }),
    "prototypes/crate/package.json": JSON.stringify({ scripts: { fixture: "node fixture.js" } }),
    "app/scripts/ticket.ts": "export function parseDependsOn() {}",
    "app/src/NowPlaying.test.tsx": 'it("moves the progress bar smoothly between polls", () => {});\nscreen.getByText("Open in Spotify");',
    "docs/plans/agent-tooling.md": "The test `keeps the old name in a plan` is quoted here.",
    "scripts/check": "#!/bin/sh",
  },
  ["target", "app/node_modules"],
);

const problems = (markdown: string) => evidenceProblems(markdown, CHECKOUT).map((p) => p.ref);

describe("quoted", () => {
  it("takes inline spans outside fences, and the lines of shell blocks", () => {
    const body = [
      "Run `scripts/check` and see `adds_an_album_once`.",
      "```bash",
      "cargo test -p deadwax-core \\",
      "  --test collection",
      "# a comment",
      "```",
      "```",
      "`not_a_span` in output",
      "```",
    ].join("\n");
    const { spans, shell, prose } = quoted(body);
    expect(spans).toEqual(["scripts/check", "adds_an_album_once"]);
    expect(shell).toEqual(["cargo test -p deadwax-core --test collection"]);
    expect(prose).not.toContain("adds_an_album_once");
  });

  it("leaves out names that are gone: struck through, or renamed with an arrow", () => {
    const { spans } = quoted("~~`lastDrag`, `THUMB_GRAB`~~ are gone, and `sliderScale` → `numberScale`, `old_name` -> `new_name`.");
    expect(spans).toEqual(["numberScale", "new_name"]);
  });
});

describe("classify", () => {
  it("tells names, phrases, paths and commands apart, and skips prose and placeholders", () => {
    expect(classify("adds_an_album_once")).toEqual({ kind: "name", ref: "adds_an_album_once", names: ["adds_an_album_once"] });
    expect(classify("commands::set_now_playing_fullscreen")).toMatchObject({ kind: "name", names: ["set_now_playing_fullscreen"] });
    expect(classify("parseDependsOn()")).toMatchObject({ kind: "name", names: ["parseDependsOn"] });
    expect(classify("shows the cover, title, artist and year")).toEqual({ kind: "phrase", ref: "shows the cover, title, artist and year" });
    expect(classify("isn't shown until the Develop menu asks for it")).toMatchObject({ kind: "phrase" });
    expect(classify("collection.rs:42")).toMatchObject({ kind: "path", path: "collection.rs" });
    expect(classify("app/scripts/")).toMatchObject({ kind: "path", path: "app/scripts" });
    expect(classify("RUST_LOG=debug cargo test -p deadwax-core")).toMatchObject({ kind: "command" });
    const skipped = [
      "merge",
      "Ready",
      "In Review",
      "show DWX-14",
      "clippy -D warnings",
      "aspect-ratio: 1; object-fit: contain",
      ".rs",
      "DWX-<n>",
      "PATCH v1/blocks/<id>",
      "a … b",
      "https://x.y/z",
      "~/.claude",
      "2.x",
    ];
    for (const span of skipped) expect(classify(span), span).toBeUndefined();
  });
});

describe("evidenceProblems", () => {
  it("passes a body whose names, test names, paths and commands are all there", () => {
    const body = [
      "- [x] **It adds once.** `adds_an_album_once` in `collection.rs` uses `PAGE_SIZE`; see `crates/deadwax-core/src/collection.rs:12` and `app/scripts/`.",
      "- [x] **It moves.** `moves the progress bar smoothly between polls`, and `Open in Spotify` is shown.",
      "Run `npm run typecheck`, `scripts/check` and `cargo test -p deadwax-core --test collection`, and `npm run fixture` in the prototype.",
      "Build output in `target/release/bundle`; deps in `app/node_modules`. `parseDependsOn` reads it.",
    ].join("\n");
    expect(evidenceProblems(body, CHECKOUT)).toEqual([]);
  });

  it("names a Rust test that was renamed, saying it isn't in the code", () => {
    expect(evidenceProblems("Proved by `the_old_test_name`.", CHECKOUT)).toEqual([{ ref: "the_old_test_name", why: "isn't in the code" }]);
  });

  it("names a vitest test that was renamed, even when a doc still quotes the old name", () => {
    expect(problems("`moves the progress bar smoothly between answers` and `keeps the old name in a plan`")).toEqual([
      "moves the progress bar smoothly between answers",
      "keeps the old name in a plan",
    ]);
  });

  it("names a missing file, script, npm script, package and test target", () => {
    expect(problems("`crates/deadwax-core/src/gone.rs` and `moved.rs`")).toEqual(["crates/deadwax-core/src/gone.rs", "moved.rs"]);
    const why = evidenceProblems("`scripts/nope --help`, `npm run lint`, `cargo test -p deadwax-gone --test sound`", CHECKOUT).map((p) => p.why);
    expect(why).toEqual(["no scripts/nope script", 'no npm script "lint" in any package.json', "no package deadwax-gone", "no test target sound"]);
  });

  it("checks paths in shell blocks, but not output blocks", () => {
    const body = "```bash\ncargo run -p deadwax-core -- import docs/albums target/import\n```\n```\ndocs/missing.json\n```";
    expect(evidenceProblems(body, CHECKOUT)).toEqual([
      { ref: "cargo run -p deadwax-core -- import docs/albums target/import", why: "no docs/albums" },
    ]);
  });

  it("reports each reference once", () => {
    expect(problems("`gone_test` and again `gone_test`")).toEqual(["gone_test"]);
  });

  it("refuses totals of tests, pointing at the rule", () => {
    const found = evidenceProblems("`npm test` (76 tests) passes, `adds_an_album_once` among them.", CHECKOUT);
    expect(found).toHaveLength(1);
    expect(found[0].ref).toBe("76 tests");
    expect(found[0].why).toContain("name the tests");
  });
});

describe("totals", () => {
  it("finds counts of tests and passes in prose", () => {
    expect(totals("46 tests, 6 unit tests, 130 Rust tests and 1,024 passed; 3 rounds; two tests")).toEqual([
      "46 tests",
      "6 unit tests",
      "130 Rust tests",
      "1,024 passed",
    ]);
  });

  it("doesn't take a sentence running on, or a count of CI checks, for one", () => {
    expect(totals("It starts on port 1442 but the test uses another, and 3 checks passed.")).toEqual([]);
  });
});
