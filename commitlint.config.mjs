/**
 * Conventional-commit lint for Prism.
 *
 * Extends config-conventional, whose type-enum
 * (feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert) is a superset
 * of every type in this repo's history (feat, fix, test, chore, docs, refactor).
 * Scopes are intentionally free-form to match existing (workflow), (sync),
 * (core), (mcp), (sdk), (codex), (compile) scopes.
 *
 * The gate lints only NEW commit ranges (PR base..head, or push before..sha) in
 * .github/workflows/ci.yml, so frozen pre-gate history is never re-litigated.
 * The newest pre-gate non-conventional commit is f25a9d3; every commit after it
 * is conventional, and CI never lints pre-tip history, so older commits are
 * permanent, documented exceptions; see docs/release-train.md.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Commit bodies here quote long changelog-style sentences and Co-Authored-By
    // trailers; wrapping them is not worth failing an otherwise-valid commit.
    "body-max-line-length": [0, "always"],
    "footer-max-line-length": [0, "always"],
  },
};
