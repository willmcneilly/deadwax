import { describe, expect, it } from "vitest";
import { JOBS } from "./checkJobs.ts";
import {
  type Job,
  type TreeFile,
  inputKey,
  isInput,
  plan,
  withFilesContaining,
} from "./checkPlan.ts";

/** A small tree shaped like Deadwax's. */
const BASE: TreeFile[] = [
  { hash: "1", path: "Cargo.toml" },
  { hash: "2", path: "Cargo.lock" },
  { hash: "3", path: "app/package.json" },
  { hash: "4", path: "app/src/App.tsx" },
  { hash: "5", path: "app/src/Setup.tsx" },
  { hash: "6", path: "app/src-tauri/src/lib.rs" },
  { hash: "7", path: "app/src-tauri/tauri.conf.json" },
  { hash: "8", path: "crates/deadwax-core/src/collection.rs" },
  { hash: "9", path: "crates/deadwax-core/src/dev_list.rs" },
  { hash: "a", path: "crates/deadwax-sources/src/spotify/albums.rs" },
  { hash: "b", path: "docs/plans/agent-tooling.md" },
  { hash: "c", path: "app/scripts/check.ts" },
  { hash: "d", path: "scripts/check-release-has-no-dev-list.sh" },
];

/** BASE with the given files' content changed. */
const changing = (...paths: string[]) =>
  BASE.map((file) => (paths.includes(file.path) ? { ...file, hash: `${file.hash}-new` } : file));

/** What check.ts would find containing `debug_assertions` in this tree. */
const CONTAINING_DEBUG_ASSERTIONS = ["crates/deadwax-core/src/collection.rs"];

const jobs = (found: readonly string[] = CONTAINING_DEBUG_ASSERTIONS) =>
  JOBS.map((job) => (job.inputsContaining ? withFilesContaining(job, found) : job));

const running = (tree: TreeFile[], found?: readonly string[]) =>
  plan(jobs(found), tree, BASE, () => false)
    .filter((p) => p.status === "run")
    .map((p) => p.job.name);

const RUST = ["rust: fmt", "rust: clippy", "rust: test"];
const FRONTEND = ["frontend: typecheck", "frontend: lint", "frontend: test"];
const RELEASE = "app: release build";

describe("isInput", () => {
  it("matches a folder by prefix and a file exactly", () => {
    expect(isInput(["crates/"], "crates/deadwax-core/src/lib.rs")).toBe(true);
    expect(isInput(["Cargo.toml"], "Cargo.toml")).toBe(true);
    expect(isInput(["Cargo.toml"], "app/src-tauri/Cargo.toml")).toBe(false);
    expect(isInput(["crates/"], "crates")).toBe(false);
  });

  it("matches a path prefix ending in *", () => {
    const devList = ["crates/deadwax-core/src/dev_list*"];
    expect(isInput(devList, "crates/deadwax-core/src/dev_list.rs")).toBe(true);
    expect(isInput(devList, "crates/deadwax-core/src/dev_list/mod.rs")).toBe(true);
    expect(isInput(devList, "crates/deadwax-core/src/collection.rs")).toBe(false);
  });

  it("takes an excluded folder back out", () => {
    const frontend = ["app/", "!app/src-tauri/"];
    expect(isInput(frontend, "app/src/App.tsx")).toBe(true);
    expect(isInput(frontend, "app/src-tauri/src/lib.rs")).toBe(false);
  });
});

describe("plan", () => {
  it("runs no Rust jobs for a frontend-only change", () => {
    expect(running(changing("app/src/App.tsx"))).toEqual(FRONTEND);
  });

  it("runs no frontend jobs for a Rust-only change", () => {
    expect(running(changing("crates/deadwax-sources/src/spotify/albums.rs"))).toEqual(RUST);
  });

  it("runs the release build for the Tauri side, its config and the npm manifest", () => {
    expect(running(changing("app/src-tauri/src/lib.rs"))).toEqual([...RUST, RELEASE]);
    expect(running(changing("app/src-tauri/tauri.conf.json"))).toEqual([...RUST, RELEASE]);
    expect(running(changing("app/package.json"))).toEqual([...FRONTEND, RELEASE]);
  });

  it("runs the release build for the dev list and for its own check", () => {
    expect(running(changing("crates/deadwax-core/src/dev_list.rs"))).toEqual([...RUST, RELEASE]);
    expect(running(changing("scripts/check-release-has-no-dev-list.sh"))).toEqual([RELEASE]);
  });

  it("runs the release build for a Rust file containing debug_assertions, and not for another", () => {
    expect(running(changing("crates/deadwax-core/src/collection.rs"))).toEqual([...RUST, RELEASE]);
    expect(running(changing("crates/deadwax-sources/src/spotify/albums.rs")).includes(RELEASE)).toBe(false);
  });

  it("doesn't run the release build for the rest of the frontend or Cargo.lock", () => {
    expect(running(changing("app/src/App.tsx")).includes(RELEASE)).toBe(false);
    expect(running(changing("Cargo.lock")).includes(RELEASE)).toBe(false);
  });

  it("runs both for the setup screen, which a Rust test reads", () => {
    expect(running(changing("app/src/Setup.tsx"))).toEqual([...RUST, ...FRONTEND]);
  });

  it("checks scripts/check itself with the frontend jobs", () => {
    expect(running(changing("app/scripts/check.ts"))).toEqual(FRONTEND);
  });

  it("runs nothing for a docs change", () => {
    expect(running(changing("docs/plans/agent-tooling.md"))).toEqual([]);
  });

  it("runs everything with --all", () => {
    const all = plan(jobs(), BASE, BASE, () => false, { all: true });
    expect(all.map((p) => p.status)).toEqual(JOBS.map(() => "run"));
  });

  it("skips what has passed with the same inputs, unless asked to rerun", () => {
    const tree = changing("crates/deadwax-sources/src/spotify/albums.rs");
    const fmt = JOBS.find((job) => job.name === "rust: fmt")!;
    const stamped = (key: string) => key === inputKey(fmt, tree);
    const planned = plan(JOBS, tree, BASE, stamped);
    expect(planned.find((p) => p.job === fmt)?.status).toBe("passed");
    const rerun = plan(JOBS, tree, BASE, stamped, { rerun: true });
    expect(rerun.find((p) => p.job === fmt)?.status).toBe("run");
  });
});

describe("withFilesContaining", () => {
  const job: Job = { name: "a", inputs: ["a/"], command: ["true"] };

  it("adds the files found to the job's inputs", () => {
    expect(withFilesContaining(job, ["b/x.rs"]).inputs).toEqual(["a/", "b/x.rs"]);
    expect(withFilesContaining(job, [])).toBe(job);
  });
});

describe("inputKey", () => {
  const job: Job = { name: "a", inputs: ["a/"], command: ["true"] };
  const tree: TreeFile[] = [
    { hash: "1", path: "a/x" },
    { hash: "2", path: "b/y" },
  ];

  it("changes with an input's content, and not with anything else", () => {
    const key = inputKey(job, tree);
    expect(inputKey(job, [{ hash: "9", path: "a/x" }, tree[1]])).not.toBe(key);
    expect(inputKey(job, [tree[0], { hash: "9", path: "b/y" }])).toBe(key);
  });

  it("changes with the job's command or environment", () => {
    const key = inputKey(job, tree);
    expect(inputKey({ ...job, command: ["false"] }, tree)).not.toBe(key);
    expect(inputKey({ ...job, env: { A: "1" } }, tree)).not.toBe(key);
  });
});
