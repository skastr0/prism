# ADR: Embeddable Prism SDK Contract

Status: ratified as amended 2026-07-13.

## Amendment (2026-07-13)

Ratified with one correction to the Decision below: the published
three-package orchestration model this ADR proposed (`@skastr0/prism` CLI ->
a new `@skastr0/prism-sdk` workflow-execution middle layer ->
`@skastr0/prism-core`) is **rejected**. It did not ship that way and will
not.

What shipped instead, per commit `dbfa9f8` ("refactor(sdk): rename
`@skastr0/prism-core` to `@skastr0/prism-sdk`", 2026-07-05): `@skastr0/prism-core`
was renamed in place to `@skastr0/prism-sdk`. The name this ADR reserved for
a new workflow-authoring/execution package was consumed by the existing
contracts package instead — same exports (`compile-manifest`, `refs`,
`snapshot`, `stable-json`, `mcp/*`; `packages/prism-sdk/package.json`), new
name only, now at 0.3.5. There is no third package.

The shipped reality is **two** published packages:

- `@skastr0/prism` — the binary CLI (unchanged).
- `@skastr0/prism-sdk` — contracts, codecs, refs, manifest, and MCP plumbing
  (the renamed `prism-core`). It carries no workflow-authoring or execution
  exports: `defineWorkflow`, `defineTask`, and `runWorkflow` do not appear
  anywhere in `packages/prism-sdk/src`.

The workflow engine this ADR's Decision and v0 Export Surface sections
describe publishing stays exactly where it already lived: private, in the
CLI workspace root (`src/index.ts`, `src/workflows.ts`,
`src/workflow-runner.ts`). CLI-as-single-runtime is a locked prior decision
(`docs/workflows/15-toolchain-and-distribution.md:44`: "The Prism binary is
the single runtime and the entire toolchain") that a published middle layer
would have eroded had this ADR shipped as originally decided.

The Decision, Versioning, and v0 Export Surface sections below describe the
originally proposed three-package model and are kept for historical record;
they are **superseded** by this amendment, not current architecture.
SDK-003 through SDK-005's internal-boundary hardening (runtime portability
seams, workflow-loader/execution-graph separation, harness detection) stands
regardless — none of that work depended on the engine being a separately
published package. SDK-006, which gated the SDK package/release artifact
this ADR proposed, is superseded/moot: the `@skastr0/prism-sdk` name it
targeted already shipped, attached to SDK-002's contracts package instead.

## Context

Prism currently has three different package shapes that matter for an SDK decision:

- The workspace root is private, named `@skastr0/prism-workspace`, and already exposes raw TypeScript source subpaths for `.`, `./cli`, and `./packager` (`package.json:2`, `package.json:6`, `package.json:12`).
- The published `@skastr0/prism` package is a CLI wrapper: it declares a `prism` binary and publishes only `bin`, `README.md`, and `LICENSE` (`packages/npm/prism/package.json:2`, `packages/npm/prism/package.json:26`, `packages/npm/prism/package.json:29`).
- `@skastr0/prism-core` is a separate publishable workspace package of core contracts/codecs with explicit compiled ESM plus declaration exports (`packages/prism-core/package.json:2`, `packages/prism-core/package.json:27`, `packages/prism-core/package.json:45`; `packages/prism-core/README.md:3`, `packages/prism-core/README.md:5`). It is not considered released until the protected npm publish workflow uploads it and registry verification succeeds.

The root package is not a suitable embeddable SDK as-is because its dependency graph includes CLI and TUI packages: Commander, OpenTUI, and React are root dependencies today (`package.json:44`, `package.json:45`, `package.json:48`, `package.json:52`).

The source already contains a public-looking workflow surface. `src/index.ts` is headed as a public authoring API and re-exports workflow definitions, runner, runtime errors, harness detection, worker contract, and worker metadata (`src/index.ts:1`, `src/index.ts:16`, `src/index.ts:17`, `src/index.ts:18`, `src/index.ts:19`, `src/index.ts:20`). The workflow DSL exports `WorkflowWorkerId`, permission-mode types, `defineTask`, and `defineWorkflow` (`src/workflows.ts:74`, `src/workflows.ts:82`, `src/workflows.ts:90`, `src/workflows.ts:423`, `src/workflows.ts:432`). The runner exports `runWorkflow` (`src/workflow-runner.ts:1045`). The store and direct worker registry are CLI/runtime internals for v0 and are not root SDK exports after the runtime-boundary correction (`src/workflow-sdk-graph.test.ts:73`, `src/workflow-node-compat.test.ts:51`).

The direct worker implementations exist for the ten current workflow workers: Amp, Antigravity, Claude, Codex, Devin, Grok, Hermes, Kimi, OpenCode, and OMP (`src/workflow-amp-worker.ts`, `src/workflow-antigravity-worker.ts`, `src/workflow-claude-worker.ts`, `src/workflow-codex-worker.ts`, `src/workflow-devin-worker.ts`, `src/workflow-grok-worker.ts`, `src/workflow-hermes-worker.ts`, `src/workflow-kimi-worker.ts`, `src/workflow-opencode-worker.ts`, `src/workflow-omp-worker.ts`).

The current code also separates in-memory execution from CLI file-loading: the CLI imports loader, runner, store, and worker registry modules separately (`src/cli.ts:77`, `src/cli.ts:78`, `src/cli.ts:79`, `src/cli.ts:90`), and the loader owns TypeScript/import-rewrite, Prism-home, project-keyed refs, and freshness concerns (`src/workflow-loader.ts:8`, `src/workflow-loader.ts:13`, `src/workflow-loader.ts:14`, `src/workflow-loader.ts:16`, `src/workflow-loader.ts:17`, `src/workflow-loader.ts:128`, `src/workflow-loader.ts:141`).

## Decision (as originally proposed — superseded, see Amendment above)

Create a new published package named `@skastr0/prism-sdk`.

Do not un-private or publish the workspace root as the SDK. Do not turn the existing `@skastr0/prism` CLI package into a mixed CLI/library package. The CLI package remains the binary distribution channel proven by its `bin` and `files` shape (`packages/npm/prism/package.json:26`, `packages/npm/prism/package.json:29`). `@skastr0/prism-core` remains the lower-level package for stable contracts/codecs (`packages/prism-core/README.md:3`, `packages/prism-core/README.md:12`).

The dependency direction is:

```text
@skastr0/prism CLI package
  -> @skastr0/prism-sdk
    -> @skastr0/prism-core
```

There is no reverse dependency and no lateral duplication. The CLI consumes the SDK for shared workflow and worker execution logic. Shared logic needed by both CLI and embedders moves into the SDK package. CLI-specific file and presentation behavior stays in the CLI.

## Versioning (as originally proposed — superseded, see Amendment above)

`@skastr0/prism-sdk`, `@skastr0/prism`, and `@skastr0/prism-core` ship from one repository release train, but they are separate artifacts with separate public contracts. The SDK follows semver for its exported TypeScript/JavaScript API. The CLI follows semver for command behavior and binary packaging. `@skastr0/prism-core` remains the stable lower-level contract package consumed by the SDK.

For v0, publish the SDK at the same version number as the corresponding Prism release to make support matrices easy to read. A patch may be SDK-only or CLI-only when the changed artifact is isolated, but published changelogs must identify which package contract changed.

## Runtime Support

The v0 SDK root is Node-importable, but not every operation is Node-executable. In-memory authoring types and `runWorkflow` can be imported by Node consumers that provide their own executor. Bun-backed operations such as executable discovery, process spawning, and persistent workflow storage fail closed with `WorkflowBunRuntimeUnavailableError` when called outside Bun (`src/workflow-node-compat.test.ts:51`, `src/workflow-node-compat.test.ts:72`, `src/workflow-node-compat.test.ts:91`). Claiming full Node execution parity before replacing those runtime calls with an adapter layer would overstate the current implementation. `@skastr0/prism-core` remains Node-compatible independently because its package declares Node engines and has no Prism CLI dependency (`packages/prism-core/package.json:54`, `packages/prism-core/README.md:12`).

## v0 Export Surface (as originally proposed — superseded, see Amendment above)

### In

Workflow authoring and execution:

- `defineTask`, `defineWorkflow`, workflow definition/task/agent/model/finish-criterion types, workflow shape guards, and task output decoding from the workflow DSL (`src/workflows.ts:8`, `src/workflows.ts:54`, `src/workflows.ts:240`, `src/workflows.ts:297`, `src/workflows.ts:324`, `src/workflows.ts:396`, `src/workflows.ts:423`, `src/workflows.ts:432`, `src/workflows.ts:463`).
- `WorkflowWorkerId`, `WorkflowPermissionMode`, `AntigravityWorkflowPermissionMode`, and worker option types from the workflow DSL. These are part of the authoring contract because `src/index.ts` re-exports `./workflows.js` from the public root today (`src/index.ts:18`; `src/workflows.ts:74`, `src/workflows.ts:82`, `src/workflows.ts:90`, `src/workflows.ts:102`).
- `runWorkflow`, `WorkflowTaskExecutor`, workflow task execution/result types, and workflow runtime errors from the runner/error surface (`src/workflow-runner.ts:39`, `src/workflow-runner.ts:55`, `src/workflow-runner.ts:122`, `src/workflow-runner.ts:62`, `src/workflow-runner.ts:1045`).
- `WorkflowBunRuntimeUnavailableError` and SDK-visible harness detection helpers for startup checks (`src/workflow-errors.ts:30`, `src/workflow-harness-detection.ts:223`).

Deferred from the v0 root surface:

- The store contract and Bun-backed store implementation for persisted runs, cache, events, monitors, and detached-run coordination remain out of the root SDK export until a dedicated persisted-runtime entrypoint is designed (`src/workflow-store.ts:10`, `src/workflow-store.ts:630`; `src/workflow-sdk-graph.test.ts:78`).
- Worker adapter APIs, worker metadata, and direct single-task harness worker dispatch remain internal until the SDK package owns a stable worker-adapter entrypoint. The CLI can still import those modules directly (`src/workflow-workers.ts:164`, `src/workflow-workers.ts:183`; `src/workflow-amp-worker.ts:161`, `src/workflow-grok-worker.ts:149`).

### Out

- CLI command construction, argument parsing, command rendering, and Commander-specific errors stay in the CLI (`src/cli.ts:6`, `src/cli.ts:102`, `src/cli.ts:108`, `src/cli.ts:113`).
- TUI entry points stay in the CLI because they import OpenTUI and React (`src/workflow-tui.tsx:1`, `src/workflow-tui.tsx:2`, `src/workflow-tui.tsx:3`, `src/plugins-tui/app.tsx:12`, `src/plugins-tui/app.tsx:13`, `src/plugins-tui/app.tsx:14`).
- Compile/lowering, refresh, doctor, MCP lifecycle, and packager surfaces stay out of the SDK v0. The CLI imports those subsystems directly today (`src/cli.ts:41`, `src/cli.ts:46`, `src/cli.ts:66`, `src/cli.ts:71`, `src/cli.ts:76`, `src/cli.ts:953`, `src/cli.ts:1139`, `src/cli.ts:1579`, `src/cli.ts:1997`, `src/cli.ts:2372`).
- `.workflow.ts` file loading, typechecking, import rewriting, project-keyed generated refs, and freshness checks stay out of the SDK v0. The loader owns those concerns today (`src/workflow-loader.ts:8`, `src/workflow-loader.ts:13`, `src/workflow-loader.ts:14`, `src/workflow-loader.ts:16`, `src/workflow-loader.ts:17`, `src/workflow-loader.ts:128`, `src/workflow-loader.ts:141`), and the CLI calls `validateWorkflowFile` and `loadWorkflowFile` at the command boundary (`src/cli.ts:223`, `src/cli.ts:380`).
- Raw TypeScript source exports are not the SDK contract. The current root `exports` map points at `src/*.ts`, which is acceptable for workspace development but not a published embeddable artifact with declaration stability (`package.json:12`, `package.json:13`, `package.json:14`, `package.json:15`).

## Discarded Alternatives

1. Publish the current workspace root.

   Rejected because the root is private and carries CLI/TUI dependencies (`package.json:6`, `package.json:44`, `package.json:45`, `package.json:48`, `package.json:52`). Publishing it would make embedders inherit command and TUI dependencies that are not part of the SDK contract.

2. Expand `@skastr0/prism` into a mixed CLI plus SDK package.

   Rejected because the current published package is deliberately a CLI binary wrapper with only `bin`, `README.md`, and `LICENSE` in its package files (`packages/npm/prism/package.json:26`, `packages/npm/prism/package.json:29`). Mixing SDK exports into that artifact would blur binary support and library support.

3. Publish raw `.ts` source exports from the root.

   Rejected because the current root export map targets source TypeScript files (`package.json:12`, `package.json:13`, `package.json:14`, `package.json:15`), while `@skastr0/prism-core` demonstrates the intended compiled ESM plus `.d.ts` package shape (`packages/prism-core/package.json:27`, `packages/prism-core/package.json:45`, `packages/prism-core/README.md:5`).

4. Claim Node support in v0.

   Rejected because workflow execution currently depends on Bun-only APIs (`src/workflow-runtime.ts:1`, `src/workflow-runtime.ts:26`, `src/workflow-runtime.ts:36`). Node parity requires a later runtime abstraction.

5. Include compile/lowering/refresh/doctor/packager in the SDK v0.

   Rejected because the CLI currently owns those command surfaces and imports their implementation directly (`src/cli.ts:41`, `src/cli.ts:66`, `src/cli.ts:71`, `src/cli.ts:76`, `src/cli.ts:953`, `src/cli.ts:1139`, `src/cli.ts:1579`, `src/cli.ts:1997`, `src/cli.ts:2372`). The SDK v0 is the embeddable execution surface, not the full distribution CLI.

## Dedupe

This SDK contract is distinct from the related board items named in the originating work request:

- PQ-115 is workflow-internal tool SDK work: tools callable inside workflow execution. This ADR defines the embeddable package and outer execution API. The existing workflow DSL already models tasks, finish criteria, and runtime execution boundaries (`src/workflows.ts:297`, `src/workflows.ts:371`, `src/workflow-runner.ts:1045`).
- PQ-146 is the CLI npm release channel. This ADR keeps `@skastr0/prism` as the CLI binary package (`packages/npm/prism/package.json:2`, `packages/npm/prism/package.json:26`, `packages/npm/prism/package.json:29`) and adds a separate SDK package.
- PQ-147 is the prism-workflows projection/plugin track. Existing workflow distribution notes treat prism-workflows-related ideas as building on the workflow toolchain (`docs/workflows/15-toolchain-and-distribution.md:185`, `docs/workflows/15-toolchain-and-distribution.md:186`), while this ADR defines the embeddable SDK package and execution API.

The PQ identifiers above are board-routing labels from the request, not package names or source identifiers.

## Downstream Execution Contract

- SDK-002 (`@skastr0/prism-core`) owns the lower-level package artifact. Acceptance: `bun run build:core`, `npm pack --dry-run --workspace packages/prism-core`, packed-tarball install/import smoke for every exported subpath, CI `verify` builds core before root typecheck, and the protected publish workflow includes `packages/prism-core`.
- SDK-003 owns runtime portability seams. Acceptance: public SDK import graph excludes `workflow-store`, `workflow-runtime`, loader/toolchain modules, `typescript`, and `bun:*`; Node-bundled public imports succeed; Bun-only calls throw `WorkflowBunRuntimeUnavailableError`.
- SDK-004 owns workflow-loader/SDK execution graph separation. Acceptance: in-memory SDK usage runs from outside a Prism project without loader/project-key/tsconfig imports, while CLI file-loading remains covered separately.
- SDK-005 owns harness detection. Acceptance: startup-safe detection resolves executables without spawning, optional verification probes have explicit timeout/broken statuses, unsupported harness ids throw a named error, and Bun-runtime absence is not misclassified as a broken harness.
- SDK-006 owns the SDK package/release artifact **as originally proposed — superseded/moot per the Amendment above.** The `@skastr0/prism-sdk` name it targeted already shipped, attached to SDK-002's contracts package; there is no separate workflow-execution SDK package left to release.

## Downstream Gate

This ADR is ratified as amended (2026-07-13); the operator-approval gate is satisfied, and SDK-002 through SDK-005's internal-boundary hardening proceeds on that basis. SDK-006 does not proceed as originally scoped — it is superseded/moot per the Amendment above.
