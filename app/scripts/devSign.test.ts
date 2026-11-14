// scripts/dev-sign, cargo's runner on macOS (DWX-36), run for real against
// stand-ins for `security` and `codesign`, so no test touches a keychain.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./git.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "dev-sign");
const HASH = "0123456789ABCDEF0123456789ABCDEF01234567";
const FOUND = `  1) ${HASH} "Apple Development: Will (ABCDE12345)"\n     1 valid identities found\n`;
const ADHOC = "Executable=/x\nIdentifier=deadwax_app-1234\nSignature=adhoc\nTeamIdentifier=not set\n";
const OURS = "Executable=/x\nIdentifier=com.willmcneilly.deadwax.dev\nAuthority=Apple Development: Will (ABCDE12345)\nTeamIdentifier=ABCDE12345\n";

let dir: string;
let script: string;
let log: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "deadwax-dev-sign-")));
  script = join(dir, "scripts", "dev-sign");
  log = join(dir, "calls.log");
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(SCRIPT, script);
  // Stand-ins: each logs its arguments. `security` prints $STUB_IDENTITIES;
  // `codesign -dvv` prints $STUB_DETAILS; signing exits $STUB_SIGN_EXIT.
  executable(
    join(dir, "bin", "security"),
    `#!/bin/sh\necho "security $*" >> "${log}"\nprintf '%s' "$STUB_IDENTITIES"\n`,
  );
  executable(
    join(dir, "bin", "codesign"),
    [
      "#!/bin/sh",
      `echo "codesign $*" >> "${log}"`,
      'if [ "$1" = "-dvv" ]; then printf "%s" "$STUB_DETAILS" >&2; exit 0; fi',
      'if [ "$STUB_SIGN_EXIT" != 0 ]; then echo "error: The specified item could not be found in the keychain." >&2; fi',
      'exit "$STUB_SIGN_EXIT"',
      "",
    ].join("\n"),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function executable(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A stand-in binary at `relative` under the temp folder, which says it ran. */
function binary(relative: string): string {
  const path = join(dir, relative);
  executable(path, `#!/bin/sh\necho "ran $(basename "$0") $*"\n`);
  return path;
}

type Stubs = { identities?: string; details?: string; signExit?: number; env?: Record<string, string> };

function run(args: string[], stubs: Stubs = {}) {
  const result = spawnSync(script, args, {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      HOME: dir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      STUB_IDENTITIES: stubs.identities ?? "     0 valid identities found\n",
      STUB_DETAILS: stubs.details ?? ADHOC,
      STUB_SIGN_EXIT: String(stubs.signExit ?? 0),
      ...stubs.env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

const signings = (calls: string[]) => calls.filter((call) => call.startsWith("codesign --force"));

describe("dev-sign run", () => {
  it("runs a test binary untouched, without looking for an identity", () => {
    const test = binary("target/debug/deps/deadwax_core-a490");
    const result = run(["run", test, "--quiet"]);
    expect(result).toMatchObject({ status: 0, stdout: "ran deadwax_core-a490 --quiet\n", stderr: "", calls: [] });
  });

  it("runs a release deadwax-app untouched", () => {
    const app = binary("target/release/deadwax-app");
    expect(run(["run", app], { identities: FOUND })).toMatchObject({ status: 0, stderr: "", calls: [] });
  });

  it("signs a debug deadwax-app with the Apple Development identity and a fixed identifier, then runs it", () => {
    const app = binary("target/debug/deadwax-app");
    const result = run(["run", app, "--flag"], { identities: FOUND });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran deadwax-app --flag\n");
    expect(result.stderr).toBe("");
    expect(signings(result.calls)).toEqual([
      `codesign --force --sign ${HASH} --identifier com.willmcneilly.deadwax.dev --timestamp=none ${app}`,
    ]);
  });

  it("signs a debug deadwax-app built for an explicit target triple", () => {
    const app = binary("target/aarch64-apple-darwin/debug/deadwax-app");
    expect(signings(run(["run", app], { identities: FOUND }).calls)).toHaveLength(1);
  });

  it("doesn't sign again a build that's already signed with the identifier and a Team ID", () => {
    const app = binary("target/debug/deadwax-app");
    const result = run(["run", app], { identities: FOUND, details: OURS });
    expect(result).toMatchObject({ status: 0, stdout: "ran deadwax-app \n", stderr: "" });
    expect(result.calls).toEqual([`codesign -dvv ${app}`]);
  });

  it("without a certificate, runs the app ad-hoc signed after one line saying how to set it up", () => {
    const app = binary("target/debug/deadwax-app");
    const result = run(["run", app], { identities: "     0 valid identities found\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran deadwax-app \n");
    expect(result.stderr).toBe(
      "dev-sign: no Apple Development certificate, so deadwax-app runs ad-hoc signed and the Keychain will ask again (one-time setup: scripts/dev-sign --help).\n",
    );
    expect(signings(result.calls)).toEqual([]);
  });

  it("ignores identities that aren't Apple Development", () => {
    const app = binary("target/debug/deadwax-app");
    const other = `  1) ${HASH} "Developer ID Application: Someone (ZZZ)"\n`;
    const result = run(["run", app], { identities: other });
    expect(signings(result.calls)).toEqual([]);
    expect(result.stderr).toContain("no Apple Development certificate");
  });

  it("when codesign fails, still runs the app, after one line saying why", () => {
    const app = binary("target/debug/deadwax-app");
    const result = run(["run", app], { identities: FOUND, signExit: 1 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran deadwax-app \n");
    expect(result.stderr).toBe(
      "dev-sign: codesign failed, so deadwax-app runs ad-hoc signed: error: The specified item could not be found in the keychain.\n",
    );
  });

  it("passes on the app's exit status", () => {
    const app = join(dir, "target/debug/deadwax-app");
    executable(app, "#!/bin/sh\nexit 3\n");
    expect(run(["run", app], { identities: FOUND }).status).toBe(3);
  });

  it("uses DEADWAX_SIGNING_IDENTITY before searching", () => {
    const app = binary("target/debug/deadwax-app");
    const result = run(["run", app], { identities: FOUND, env: { DEADWAX_SIGNING_IDENTITY: "Apple Development: Chosen" } });
    expect(signings(result.calls)).toEqual([
      `codesign --force --sign Apple Development: Chosen --identifier com.willmcneilly.deadwax.dev --timestamp=none ${app}`,
    ]);
    expect(result.calls.some((call) => call.startsWith("security"))).toBe(false);
  });

  it("uses git config deadwax.signingIdentity before searching", () => {
    git(dir, ["init", "--quiet"]);
    git(dir, ["config", "deadwax.signingIdentity", "FEDCBA"]);
    const app = binary("target/debug/deadwax-app");
    const result = run(["run", app], { identities: FOUND });
    expect(signings(result.calls)).toEqual([
      `codesign --force --sign FEDCBA --identifier com.willmcneilly.deadwax.dev --timestamp=none ${app}`,
    ]);
  });
});

describe("dev-sign --help", () => {
  it("has the one-time Xcode steps and the two prompts to expect", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Manage Certificates → + → Apple Development");
    expect(result.stdout).toContain("codesign wants to sign using key");
    expect(result.stdout).toContain("com.willmcneilly.deadwax");
  });
});
