# Release Train

Checked: 2026-07-06

How a decided version becomes a published set of npm packages. The version is
**a human decision, not a derivation** — no tool infers it from commit history.

## Versioning policy

- The operator picks the number. There is no automatic bump derivation
  (`svu` and the in-repo `derive-version.ts` that replaced it are both gone —
  automation kept inflating minors out of proportion to real progress).
- Stabilization of the existing surface — fixes, hardening, internal
  refactors, even large ones — is a **patch** (`0.3.x`).
- A **minor** bump is an explicit operator call, reserved for a genuine
  feature-set milestone. Nothing cuts one on its own.
- The one CI-enforced exception: `check:workflow-store-schema-version` (wired
  into `bun run verify` and `ci.yml`) fails the build if
  `WORKFLOW_STORE_SCHEMA_VERSION` (`src/workflow-store.ts`) changed since the
  merge-base with `main` and `package.json`'s `version` did not move with it.
  This is the guard for the exact WFE-007 failure mode — a schema change and
  a version bump silently drifting apart across many commits until two
  same-numbered builds write incompatible stores. It does not pick the
  number; it only refuses to let the schema move alone.

## The flow

```
operator decides vX.Y.Z
  -> bun scripts/apply-release-version.ts X.Y.Z
  -> bun install --lockfile-only
  -> gate: bun run verify + test:ci + smoke:core + smoke:npm-cli
  -> commit "chore(release): vX.Y.Z" -> push main
  -> git tag vX.Y.Z -> push tag   fires npm-publish.yml
       -> release environment approval  (manual, held on purpose)
            -> publish 6 packages -> mise picks up latest
```

Two workflows, one direction, no loops:

- **`ci.yml`** — the merge gate. Runs `bun run verify`, `bun run test:ci`, and the publish smokes
  (`smoke:core`, `smoke:npm-cli`). The smokes live here so packaging breakage
  is caught on the PR, *before* a tag exists.
- **`npm-publish.yml`** — the publisher. Fires on `v*` tag push (or manual
  dispatch), held behind the `release` environment approval, then publishes the
  six packages in dependency order.

There is no auto-tagging workflow. Tagging is the operator's (or the
orchestrator's) manual act, performed after the gate is green locally — which
also means no `RELEASE_TOKEN` PAT is required anywhere.

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

## Cutting a release, step by step

From a clean `main` with CI green:

```
bun scripts/apply-release-version.ts 0.3.1
bun install --lockfile-only
bun run verify && bun run test:ci && bun run smoke:core && bun run smoke:npm-cli
git add -A && git commit -m "chore(release): v0.3.1"
git push origin main
git tag -a v0.3.1 -m v0.3.1
git push origin v0.3.1        # <- this fires npm-publish.yml
```

Then approve the `release` environment on the npm-publish run.

## Commit messages

Conventional types (`feat`/`fix`/`chore`/…) remain useful hygiene and changelog
signal, but they are not gated in CI and do not drive version bumps. The
version is an operator decision (see above).

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
