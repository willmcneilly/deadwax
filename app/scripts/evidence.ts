// `scripts/ticket evidence-check`: every name, path and command a PR body
// quotes in backticks must exist in the branch, so a renamed test or a moved
// file is caught before a reviewer reads it. Written against `Tree`, so the
// tests can hand it a fake checkout; ticketServices.ts has the git one.

/** The checkout a PR body is checked against: the working tree, or a commit. */
export type Tree = {
  /** Every tracked file's path, from the repository root. */
  files(): string[];
  /** Of these words, the ones that appear as a whole word in some tracked text file. */
  wordsFound(words: string[]): Set<string>;
  /** Of these phrases, the ones that appear exactly in some tracked text file other than Markdown (the docs quote names that may be gone). */
  phrasesFound(phrases: string[]): Set<string>;
  /** A tracked file's text. */
  read(path: string): string;
  /** Whether git ignores a path: local state such as node_modules or a worktree, not part of the branch. */
  ignored(path: string): boolean;
};

/** A reference the body makes, and why it's wrong. */
export type Problem = { ref: string; why: string };

/** What a quoted reference is, and so how it's checked. */
type Reference =
  | { kind: "name"; ref: string; names: string[] }
  | { kind: "phrase"; ref: string }
  | { kind: "path"; ref: string; path: string }
  | { kind: "command"; ref: string };

const EXTENSIONS = /\.(rs|ts|tsx|js|mjs|cjs|json|md|toml|css|html|sh|yml|yaml|lock|txt|py|svg|png|jpg|sql)$/;

/** The words that start a command a PR quotes, after any `NAME=value` settings. */
const COMMANDS = new Set(["cargo", "npm", "npx", "node", "gh", "git"]);

/** Placeholders, globs, elisions, URLs and shell variables: written to stand for something, not to name it. */
const PLACEHOLDER = /[<>{}*$…]|\.\.\.|:\/\/|^~|^\//;

/** A whole-word name worth checking: snake_case with letters either side of an underscore, or camelCase. */
const isName = (word: string) => /[A-Za-z0-9]_[A-Za-z0-9]/.test(word) || /[a-z][A-Z]/.test(word);

/**
 * Words in plain English, as a vitest test's name or a label in the UI is
 * written: "opens from the playback bar, simply fullscreen, and Escape leaves it".
 * Three or more words of letters (with apostrophes, inner hyphens and a comma
 * after), so code, output and commands (`aspect-ratio: 1`, `🤖 Claude:`,
 * `show DWX-14`, `clippy -D warnings`) aren't taken for one.
 */
const isPhrase = (text: string) => /^[A-Za-z][A-Za-z'’]*(?:-[A-Za-z'’]+)*,?(?: [A-Za-z][A-Za-z'’]*(?:-[A-Za-z'’]+)*,?){2,}$/.test(text);

/** The text of every inline code span outside fenced blocks, and every line of the shell blocks. */
export function quoted(markdown: string): { spans: string[]; shell: string[]; prose: string } {
  const spans: string[] = [];
  const shell: string[] = [];
  const prose: string[] = [];
  let fence: { marker: string; shell: boolean } | undefined;
  let continued = "";
  for (const line of markdown.split("\n")) {
    const opens = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (fence) {
      if (opens && opens[1].startsWith(fence.marker) && !opens[2]) fence = undefined;
      else if (fence.shell) {
        const text = line.trim();
        if (text.endsWith("\\")) continued += `${text.slice(0, -1)} `;
        else if (continued || (text && !text.startsWith("#"))) {
          shell.push((continued + text).replace(/^\$\s+/, "").replace(/\s+/g, " "));
          continued = "";
        }
      }
      continue;
    }
    if (opens) {
      fence = { marker: opens[1], shell: ["bash", "sh", "zsh", "shell", "console"].includes(opens[2].toLowerCase()) };
      continue;
    }
    // A name that's gone is struck through (~~`lastDrag`~~) or renamed (`sliderScale` → `numberScale`): not checked.
    const current = line.replace(/~~.*?~~/g, " ").replace(/`[^`]+`\s*(→|->)/g, " $1");
    // Inline spans: a run of backticks up to the same run. Double backticks let a span hold one.
    prose.push(current.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (_, _ticks: string, text: string) => (spans.push(text.trim()), " ")));
  }
  return { spans, shell, prose: prose.join("\n") };
}

/** What a span refers to, or undefined for prose, output and placeholders, which aren't checked. */
export function classify(span: string): Reference | undefined {
  const text = span.trim();
  if (!text || PLACEHOLDER.test(text)) return undefined;
  const words = text.split(/\s+/);
  const first = words.find((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
  if (words.length > 1) {
    if (first !== undefined && (COMMANDS.has(first) || first.startsWith("scripts/"))) return { kind: "command", ref: text };
    return isPhrase(text) ? { kind: "phrase", ref: text } : undefined;
  }
  // A path, perhaps with a line number: `now_playing.rs:42`, `app/scripts/`.
  const path = text.replace(/:\d+(-\d+)?$/, "").replace(/\/+$/, "");
  if (text.includes("/") || EXTENSIONS.test(path)) {
    // An extension on its own (`.rs`) is a kind of file, not one.
    return /^\.\w+$/.test(path) ? undefined : { kind: "path", ref: text, path };
  }
  // A name, or a path to one: `commands::set_now_playing_fullscreen`, `WebviewWindow::set_simple_fullscreen()`, `format!`.
  const bare = text.replace(/\(.*\)$/, "").replace(/!$/, "");
  const segments = bare.split(/::|\./);
  if (segments.every((s) => /^[A-Za-z_]\w*$/.test(s))) {
    const names = segments.filter(isName);
    return names.length > 0 ? { kind: "name", ref: text, names } : undefined;
  }
  return undefined;
}

/** Whether a path names a tracked file or folder, from the root or as the end of a longer path. */
function tracked(files: string[], path: string): boolean {
  return files.some((f) => f === path || f.startsWith(`${path}/`) || f.endsWith(`/${path}`) || f.includes(`/${path}/`));
}

/** Whether to check a path at all: one into the repository, not git's own folder or something outside it. */
function checkablePath(path: string, topLevel: Set<string>): boolean {
  const head = path.replace(/^\.\//, "").split("/")[0];
  if (head === ".git" || head === "..") return false;
  return topLevel.has(head) || EXTENSIONS.test(path);
}

/** The workspace's Rust package names, from each Cargo.toml's [package] name. */
function packages(tree: Tree): Set<string> {
  const names = new Set<string>();
  for (const file of tree.files().filter((f) => f === "Cargo.toml" || f.endsWith("/Cargo.toml"))) {
    const match = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(tree.read(file));
    if (match) names.add(match[1]);
  }
  return names;
}

/** The scripts in every package.json: app's, and a prototype's that a command may `cd` into first. */
function npmScripts(tree: Tree): Set<string> {
  const names = new Set<string>();
  for (const file of tree.files().filter((f) => f === "package.json" || f.endsWith("/package.json"))) {
    const json = JSON.parse(tree.read(file)) as { scripts?: Record<string, string> };
    for (const name of Object.keys(json.scripts ?? {})) names.add(name);
  }
  return names;
}

/** What's wrong with one command line: a script, package, test target or path that isn't there. */
function commandProblems(
  line: string,
  context: { files: string[]; topLevel: Set<string>; exists: (path: string) => boolean; packages: () => Set<string>; scripts: () => Set<string> },
): string[] {
  const words = line.split(/\s+/).filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
  const problems: string[] = [];
  const tool = words[0] ?? "";
  if (tool.startsWith("scripts/") && !context.files.includes(tool)) problems.push(`no ${tool} script`);
  words.forEach((word, at) => {
    const next = words[at + 1];
    if (next === undefined || PLACEHOLDER.test(next)) return;
    if (tool === "npm" && word === "run" && at === 1 && !context.scripts().has(next)) problems.push(`no npm script "${next}" in any package.json`);
    if (tool === "cargo" && (word === "-p" || word === "--package") && !context.packages().has(next)) problems.push(`no package ${next}`);
    if (tool === "cargo" && word === "--test" && !context.files.some((f) => f.endsWith(`tests/${next}.rs`) || f.endsWith(`tests/${next}/main.rs`))) {
      problems.push(`no test target ${next}`);
    }
  });
  for (const word of words.slice(1)) {
    const path = word.replace(/^['"]|['"]$/g, "");
    if (!path.includes("/") || PLACEHOLDER.test(path) || path.startsWith("-")) continue;
    if (checkablePath(path, context.topLevel) && !context.exists(path.replace(/\/+$/, ""))) problems.push(`no ${path}`);
  }
  return problems;
}

/** Totals in the prose ("76 tests", "13 unit tests", "508 passed"): they go stale with the next test anyone adds. */
export function totals(prose: string): string[] {
  // The words between describe the tests ("13 unit tests"), so a sentence running on ("port 1442 but the test") or a count of CI checks isn't one.
  const between = /^(?:but|and|or|the|a|an|of|to|in|on|that|which|checks?|jobs?)$/i;
  return [...prose.matchAll(/\b\d[\d,]*\s+((?:[A-Za-z-]+\s+){0,2}?)(?:tests?|passed|passing)\b/gi)]
    .filter((m) => !m[1].split(/\s+/).some((word) => between.test(word)))
    .map((m) => m[0]);
}

export const TOTALS_RULE = "name the tests that prove it, don't count them: a total goes stale with the next test anyone adds";

/** Every problem with the references a PR body makes, checked against `tree`. Empty when it's all there. */
export function evidenceProblems(markdown: string, tree: Tree): Problem[] {
  const { spans, shell, prose } = quoted(markdown);
  const files = tree.files();
  const topLevel = new Set(files.map((f) => f.split("/")[0]));
  let packageNames: Set<string> | undefined;
  let scriptNames: Set<string> | undefined;
  const context = {
    files,
    topLevel,
    // Build output and other ignored paths aren't in the branch, but aren't wrong to name either.
    exists: (path: string) => tracked(files, path) || tree.ignored(path),
    packages: () => (packageNames ??= packages(tree)),
    scripts: () => (scriptNames ??= npmScripts(tree)),
  };

  // Each reference once, however often the body quotes it.
  const references: Reference[] = [];
  const seen = new Set<string>();
  for (const reference of [...spans.map(classify), ...shell.map((ref): Reference => ({ kind: "command", ref }))]) {
    if (!reference || seen.has(`${reference.kind} ${reference.ref}`)) continue;
    seen.add(`${reference.kind} ${reference.ref}`);
    references.push(reference);
  }

  const names = [...new Set(references.flatMap((r) => (r.kind === "name" ? r.names : [])))];
  const found = names.length > 0 ? tree.wordsFound(names) : new Set<string>();
  const phrases = references.flatMap((r) => (r.kind === "phrase" ? [r.ref] : []));
  const phrasesFound = phrases.length > 0 ? tree.phrasesFound(phrases) : new Set<string>();

  const problems: Problem[] = [];
  for (const reference of references) {
    if (reference.kind === "name") {
      const missing = reference.names.filter((n) => !found.has(n));
      if (missing.length === 1 && missing[0] === reference.ref) problems.push({ ref: reference.ref, why: "isn't in the code" });
      else if (missing.length > 0) problems.push({ ref: reference.ref, why: `${missing.join(", ")} isn't in the code` });
    } else if (reference.kind === "phrase") {
      if (!phrasesFound.has(reference.ref)) problems.push({ ref: reference.ref, why: "isn't in the code (a test's name, or text it shows, word for word)" });
    } else if (reference.kind === "path") {
      if (checkablePath(reference.path, topLevel) && !context.exists(reference.path)) {
        problems.push({ ref: reference.ref, why: "no such file or folder" });
      }
    } else {
      for (const why of commandProblems(reference.ref, context)) problems.push({ ref: reference.ref, why });
    }
  }
  for (const total of new Set(totals(prose))) problems.push({ ref: total, why: `a total: ${TOTALS_RULE}` });
  return problems;
}
