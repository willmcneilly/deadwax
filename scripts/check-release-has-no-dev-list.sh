#!/usr/bin/env bash
# Proves a release build of Deadwax contains no dev list and no Develop menu
# (RFC-001, "A dev list that survives resets"; DWX-5). Run it after
# `npm run tauri build`, from the repository root. CI runs it on every PR.
#
# The Rust side is compiled out with `debug_assertions`, and the UI's with
# `import.meta.env.DEV`. This looks for the strings they would bring with
# them: in the release binary for Rust, and in `app/dist` for the UI (Tauri
# compresses the UI into the binary, so it can't be searched there).
#
# So the check can't pass by looking for strings that never existed, every
# marker must also be in the source, and the UI's markers must be in a
# development bundle built with the same Vite config.

set -euo pipefail

binary=target/release/bundle/macos/Deadwax.app/Contents/MacOS/deadwax-app
dist=app/dist

# What the Rust side's dev list and Develop menu would leave in the binary.
rust_markers=(
  "dev-list.json"
  "Reset collection"
  "Restore from dev list"
  "reset-collection"
  "restore-from-dev-list"
  "dev_list_missing"
  "restore_from_dev_list"
  "commands/dev.rs"
)

# What the UI's dev list would leave in the bundle.
ui_markers=(
  "dev_list_missing"
  "restore_from_dev_list"
  "reset_collection"
  "from the dev list"
)

failed=0
fail() {
  echo "FAIL: $*" >&2
  failed=1
}

[[ -f $binary ]] || {
  echo "No release binary at $binary. Run npm run tauri build first." >&2
  exit 1
}
[[ -d $dist ]] || {
  echo "No UI bundle at $dist. Run npm run tauri build first." >&2
  exit 1
}

for marker in "${rust_markers[@]}"; do
  grep -rqF -- "$marker" app/src-tauri/src crates ||
    fail "\"$marker\" isn't in the Rust source any more: update this script"
  if grep -qaF -- "$marker" "$binary"; then
    fail "the release binary contains \"$marker\""
  fi
done

# A development bundle, to show the UI's markers are there when they should be.
dev_dist=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/deadwax-dev-dist.XXXXXX")
trap 'rm -rf "$dev_dist"' EXIT
(cd app && npx vite build --mode development --outDir "$dev_dist" --emptyOutDir --logLevel error)

for marker in "${ui_markers[@]}"; do
  grep -rqF -- "$marker" "$dev_dist" ||
    fail "a development bundle doesn't contain \"$marker\": update this script"
  if grep -rqF -- "$marker" "$dist"; then
    fail "the release UI bundle contains \"$marker\""
  fi
done

if ((failed)); then
  exit 1
fi
echo "The release build has no dev list and no Develop menu."
