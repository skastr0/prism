# Prism packager: shipped library and discarded CLI experiment

Investigation date: 2026-09-05. Publication facts below are a dated snapshot,
not a claim that every local change has shipped.

## What is shipped

`@skastr0/prism-packager` is an embeddable, Bun-required library that compiles
Prism plugins into harness-native file payloads (`DesiredFile[]`) and shared
configuration fragments (`DesiredRegion[]`). Consumers such as Vellum can
compile locally and apply those payloads themselves, including remotely,
without shipping the full Prism CLI to the target host.

- npm registry check: `npm view @skastr0/prism-packager version time dist-tags --json`.
- Verified latest version: **0.4.6**, published **2026-08-17**.
- First published version: **0.4.3**, on **2026-07-24**; 0.4.4 followed that day.
- [npm package](https://www.npmjs.com/package/@skastr0/prism-packager).
- The library was already committed and present on GitHub `main` before this cleanup.

The canonical implementation is `src/packager.ts`. The package build copies
its transitive source graph into `packages/prism-packager/src/`; that directory
is a publishable snapshot, not a separate implementation to maintain manually.
The public API, runtime requirements, and intended consumers are documented in
[the package README](../packages/prism-packager/README.md) and
[the SDK contract amendment](sdk-contract.md#amendment-2026-07-24--embeddable-packager-package).

## What was unfinished

The only untracked file was `packages/prism-packager/bin-src/cli.ts`.
It was a thin executable adapter around `packagePluginForTarget`, intended
for `bun --compile`:

- Read JSON options from `argv[2]`, including plugin path and harness target.
- Default to dry-run and global scope.
- Print JSON containing generated files, configuration fragments, and operations.

This would let another process call the Bun-only library through a subprocess.
However, it had no integration into the package build, no published `bin`
entry, and was excluded by the package's published-file allowlist. It used
type assertions for target/scope instead of validating those inputs, and no
dedicated verification for the wrapper was established in this investigation.

Git had no history for this file. Its filesystem timestamp was July 24, but
that does not establish authorship or the reason it was abandoned. No matching
Amp thread explaining the leftover was found. Calling it an experiment is an
inference from the code and missing integration, not a recovered design decision.

## Decision

Discard the untracked wrapper rather than commit unused, unfinished code.
Retain the published library as the supported embedding surface. This cleanup
does not add a standalone packager executable or change the library API.

If a concrete consumer later needs an executable, implement it as an explicit
feature with validated JSON inputs, a defined error/output contract, build and
distribution wiring, and a clean-consumer execution test. The existing
`scripts/smoke-prism-packager-package.ts` tests the library packaging path;
it is not evidence that the discarded executable worked.

## Git state versus release state

At investigation time, local `main` and freshly fetched `origin/main` had
diverged by one commit each:

- Local only: removal of `inlineSkills` rule dumping, including manifest
  rejection, TUI/catalog updates, tests, and the generated packager snapshot.
- Remote only: fresh orb setup improvements.
- Untracked: the wrapper described above; there were no tracked uncommitted edits.

The cleanup preserves both committed changes by rebasing local work onto
`origin/main`, then pushing normally. A Git push is not an npm release:
the local `inlineSkills` removal was not included in the verified 0.4.6 release.
No new npm publication is part of this cleanup.

The distinction matters: package publication, Git commits, remote branch state,
and untracked files are independent. A dirty package directory does not mean
the whole package is uncommitted or unpublished.
