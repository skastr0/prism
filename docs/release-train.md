# Release Train

Checked: 2026-07-04

How a merge to `main` becomes a published set of npm packages, and the single
change that flips the train from manual-approval to fully automatic.

## The flow

```
push main
  -> ci.yml            verify + publish smokes + commit lint   (per PR and per push)
  -> release.yml       derive semver -> bump -> commit -> tag   (per push to main)
       -> tag v* push  fires npm-publish.yml
            -> release environment approval  (manual, held on purpose)
                 -> publish 6 packages -> mise picks up latest
```

Three workflows, one direction, no loops:

- **`ci.yml`** — the merge gate. Runs `bun run verify`, lints the pushed/PR
  commit range with commitlint, and runs the publish smokes (`smoke:core`,
  `smoke:npm-cli`). The smokes live here so packaging breakage is caught on the
  PR, *before* a tag exists.
- **`release.yml`** — the train. On every push to `main` it re-runs the full
  pre-publish gate (verify + both smokes), derives the next version from the
  conventional commits since the last tag, bumps every workspace package in one
  `chore(release): vX.Y.Z` commit, tags it, and pushes commit + tag.
- **`npm-publish.yml`** — the publisher. Fires on `v*` tag push (or manual
  dispatch), held behind the `release` environment approval, then publishes the
  six packages in dependency order. **Unchanged by RT-001**; its approval gate
  is deliberately kept.

## Version derivation — scripts/derive-version.ts

The train derives the bump with an in-repo script, `scripts/derive-version.ts`
(pure Bun + git, zero external dependencies), not svu, changesets, or
git-cliff:

- **No changelog file.** The script computes a version from git history and
  prints it — nothing else. changesets requires per-PR changeset files (a
  changelog-file flow this repo does not use); git-cliff is fundamentally a
  changelog generator whose version output is a byproduct. svu was the one
  external tool whose entire job was this derivation, but pulling in a 1k-star
  Go binary (plus a whole Go toolchain in CI) for ~30 lines of semver logic was
  not worth the dependency; the logic is now in-repo and unit-tested
  (`scripts/derive-version.test.ts`).
- **`--v0`.** While the project is on `0.x`, a breaking change bumps the *minor*
  (`0.Y.0`) instead of auto-cutting `v1.0.0`. Without this flag a stray `feat!:`
  or `BREAKING CHANGE:` footer during stabilization would cut and publish
  `1.0.0` — and (see below) propagate it to every machine instantly.

The derivation is a pure read of git history. To see what the train *would* cut
right now, from a full clone:

```
bun scripts/derive-version.ts current    # last tag, e.g. v0.2.2
bun scripts/derive-version.ts next --v0  # next version from conventional commits, e.g. v0.3.0
```

`bun scripts/derive-version.ts --self-test` runs the fixture table (commit
list -> expected bump) that backs the bump rules.

If `next` equals `current`, the range holds only non-releasable commits
(docs/chore/test/refactor) and `release.yml` skips — no empty release.

## The version bump

`scripts/apply-release-version.ts <version>` applies the decided version in
lockstep across:

- the workspace root `package.json` (the version `scripts/compile.ts` stamps
  into the binary as `APP_VERSION`),
- every workspace package (`packages/prism-sdk`, `packages/npm/*`), and
- the umbrella `@skastr0/prism` `optionalDependencies` pins on the four platform
  packages — these are exact-version pins and must move with the release so the
  umbrella resolves the freshly cut platform builds.

Range pins (`workspace:*`, `^x`) are left alone. Run
`bun scripts/apply-release-version.ts --self-test` to exercise the rewrite rules.

## Loop and no-op guards

- **No self-trigger.** `release.yml` skips when the head commit message starts
  with `chore(release):`. The train pushes with a PAT (see below), and PAT
  pushes *do* re-trigger workflows, so this guard is load-bearing, not
  decorative.
- **No empty release.** The `current == next` check skips pushes that
  carry no releasable commit.

## Required secret and branch permission

`release.yml` checks out and pushes with `secrets.RELEASE_TOKEN` — a PAT (or a
GitHub App token), **not** the default `GITHUB_TOKEN`. Pushes authored by
`GITHUB_TOKEN` cannot trigger other workflows, so a `GITHUB_TOKEN`-pushed tag
would never reach `npm-publish.yml`. The token's identity must also be permitted
to push `main` (branch-protection bypass) so the `chore(release):` commit lands.

## Conventional-commit gate

`ci.yml` lints only the *new* commit range (PR `base..head`, or push
`before..sha`) with commitlint + `@commitlint/config-conventional`, so frozen
history is never re-litigated — CI never lints pre-tip history. Older commits
carry no conventional type; the newest pre-gate non-conventional commit is
`f25a9d3` (`Fix model demand for model-free agent surfaces`), and every commit
after it is conventional. Pre-gate commits are unreachable by any future PR
range, so they are permanent, documented exceptions the gate never re-litigates.

## The one-line flip to auto-approve

The `release` environment on `npm-publish.yml` currently requires a manual
reviewer. Auto-publish is one change in **GitHub → Settings → Environments →
`release`**: remove the required reviewer (clear the protection rule). No YAML
change; `npm-publish.yml` is untouched.

**Do not flip this until stabilization waves 1 and 2 are green.** `mise` pins
`npm:@skastr0/prism` with `minimum_release_age = "0s"`, so there is *no* soak
window: the instant a version is published, every machine running `mise install`
/ `mise up` pulls it. An armed train (auto-approve + `0s`) turns a single merge
to `main` into an immediate fleet-wide upgrade. The manual approval is the only
brake between a green merge and instant global propagation; it stays until the
stabilization program has proven the train end to end.
