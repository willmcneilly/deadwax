// The jobs `scripts/check` runs: CLAUDE.md's checks, each with the files it
// reads. A job runs when its inputs differ from origin/main's, and a pass is
// stamped with their content, so the same inputs never run twice.
//
// An input is a file (`Cargo.toml`), a folder (`crates/`) or a path prefix
// ending in `*` (`crates/deadwax-core/src/dev_list*`). One starting with `!`
// takes them back out of the ones before it.

import type { Job } from "./checkPlan.ts";

/** Everything the Rust workspace reads, including the files its tests load. */
const RUST = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  "crates/",
  "app/src-tauri/",
  // A test checks the setup screen shows the redirect URI sign-in uses.
  "app/src/Setup.tsx",
];

/**
 * The frontend: the app without its Rust side. app/scripts/ is in it, so
 * these jobs check scripts/check itself.
 */
const FRONTEND = ["app/", "!app/src-tauri/"];

/**
 * The release build only breaks locally in ways CI wouldn't catch first when
 * the Tauri side, the npm manifest or the dev list's compiling out changed,
 * so it runs only then. Any Rust file containing `debug_assertions` is an
 * input too (`inputsContaining`). CI builds it on every PR (Will, 17 Oct).
 */
const RELEASE = [
  "app/src-tauri/",
  "app/package.json",
  "crates/deadwax-core/src/dev_list*",
  "scripts/check-release-has-no-dev-list.sh",
];

export const JOBS: readonly Job[] = [
  { name: "rust: fmt", inputs: RUST, command: ["cargo", "fmt", "--all", "--check"] },
  {
    name: "rust: clippy",
    inputs: RUST,
    command: ["cargo", "clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
    cargo: true,
  },
  // After clippy: both build in target/debug, and cargo locks it.
  {
    name: "rust: test",
    inputs: RUST,
    command: ["cargo", "test", "--workspace", "--locked"],
    after: ["rust: clippy"],
    cargo: true,
  },
  {
    name: "frontend: typecheck",
    inputs: FRONTEND,
    cwd: "app",
    command: ["npm", "run", "typecheck"],
    nodeModules: true,
  },
  {
    name: "frontend: lint",
    inputs: FRONTEND,
    cwd: "app",
    command: ["npm", "run", "lint"],
    nodeModules: true,
  },
  {
    name: "frontend: test",
    inputs: FRONTEND,
    cwd: "app",
    command: ["npm", "test"],
    nodeModules: true,
  },
  // After typecheck: tauri build runs `tsc -b` too, which writes the same
  // build info files. The script then builds a debug binary, which waits on
  // cargo's lock if clippy or the tests are still building.
  {
    name: "app: release build",
    inputs: RELEASE,
    inputsContaining: { text: "debug_assertions", suffix: ".rs" },
    command: [
      "sh",
      "-c",
      "(cd app && npm run tauri build -- --ci -- --locked) && scripts/check-release-has-no-dev-list.sh",
    ],
    after: ["frontend: typecheck"],
    nodeModules: true,
    cargo: true,
  },
];
