# @skastr0/prism-packager

Embeddable Prism packager library. Compile a Prism plugin into harness-native
package payloads (`DesiredFile[]` + activation regions) without shipping the
Prism CLI to the target host.

**Runtime:** Bun ≥ 1.3 (required). The compile pipeline uses `Bun.file` /
`Bun.build` for tool and hook emission. This package is not a Node-only library.

## Install

```bash
bun add @skastr0/prism-packager
```

Do not depend on the private workspace root (`@skastr0/prism-workspace`).
This package has **no `workspace:*` dependencies** so `file:` links and normal
npm installs both resolve.

## API

```ts
import {
  packagePluginForTarget,
  packagePluginForTargets,
  type PackageResult,
  type DesiredFile,
  type DesiredRegion,
  type HarnessId,
} from "@skastr0/prism-packager";

const result = await packagePluginForTarget({
  pluginPath: "./my-plugin",
  target: "claude-code",
  scope: "global",
  dryRun: true, // plan only — no package-root writes
});

// Apply these yourself (local fs or remote SSH lease):
for (const file of result.compileFiles) {
  // file.targetPath, file.content, file.mode?
}
// Shared-file fragments (if any):
for (const region of result.compileRegions) {
  // marker / json-key / json-array-member
}
```

### What this is for

- **Vellum / product embedders** that need Prism lowerers to emit native
  `prism-generated-*` payloads, then apply files themselves (compile-local,
  apply-remote).
- **Not** a replacement for `prism refresh` live harness mutation.

### What this is not

- Workflow engine / `defineWorkflow` (stays private CLI runtime)
- Contracts/codecs only → use `@skastr0/prism-sdk`
- CLI binary → use `@skastr0/prism`

## Public exports

| Export | Kind |
|--------|------|
| `packagePluginForTarget` | async function |
| `packagePluginForTargets` | async function |
| `formatPackageOperations` | function |
| `PackageTargetOptions` / `PackageResult` / … | types |
| `DesiredFile` / `DesiredRegion` | types (apply surface) |
| `HarnessId` / `HarnessScope` | types |

## Versioning

Lockstep with the Prism release train (`docs/release-train.md`). Same version
number as `@skastr0/prism` / `@skastr0/prism-sdk` for a given cut.
