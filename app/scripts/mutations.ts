// The standard ways `scripts/mutate --named` breaks the code, so reviewers
// don't each invent them. Each `find` must match its file exactly once; a
// test checks that against the current code, so a refactor that moves one
// fails here rather than in a review.

export type Mutation = {
  name: string;
  /** What it breaks, and what should catch it. */
  what: string;
  /** Relative to the top of the checkout. */
  file: string;
  find: string;
  replace: string;
  /** The tests that should fail, run when no command is given. */
  command: readonly string[];
};

export const MUTATIONS: readonly Mutation[] = [
  {
    name: "retry-after",
    what: "ignores a 429's Retry-After and waits the default instead; the rate-limit tests must notice the wrong wait",
    file: "crates/deadwax-sources/src/spotify/http.rs",
    find: "            let wait = retry_after(&response);\n",
    replace: "            let wait = DEFAULT_WAIT;\n",
    command: ["cargo", "test", "-p", "deadwax-sources", "--lib", "spotify::http::"],
  },
  {
    name: "token-debug",
    what: "prints the access token in Tokens' Debug output, so a log line would leak it; debug_output_hides_the_tokens must fail",
    file: "crates/deadwax-sources/src/spotify/tokens.rs",
    find: '            .field("access", &"[redacted]")\n',
    replace: '            .field("access", &self.access)\n',
    command: ["cargo", "test", "-p", "deadwax-sources", "--lib", "spotify::tokens::"],
  },
  {
    name: "no-refresh-on-401",
    what: "retries a 401 with the same access token instead of refreshing it; a_rejected_access_token_is_refreshed_once must fail",
    file: "crates/deadwax-sources/src/spotify/mod.rs",
    find: "                .send(request(self.access_token(true).await?))\n",
    replace: "                .send(request(self.access_token(false).await?))\n",
    command: ["cargo", "test", "-p", "deadwax-sources", "--lib", "spotify::tests::"],
  },
];

export const named = (name: string) => MUTATIONS.find((mutation) => mutation.name === name);
