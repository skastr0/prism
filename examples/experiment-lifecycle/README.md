# experiment-lifecycle

This example shows the compile-time distinction between:

- a reusable lifecycle template (`experiment.lifecycle.ts`)
- a concrete lifecycle instance (`release-experiment.lifecycle.ts`)

The template declares parameters with `${...}` placeholders. The concrete lifecycle binds those parameters through `lifecycle_binding`, so the OpenCode lowerer emits only a concrete skill with real bound values.

Try:

```bash
bun run ./src/cli.ts validate ./examples/experiment-lifecycle
bun run ./src/cli.ts compile ./examples/experiment-lifecycle --harness opencode --dry-run
```
