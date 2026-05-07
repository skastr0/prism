# experiment-orbit

This example shows the compile-time distinction between:

- a reusable orbit template (`experiment.orbit.ts`)
- a concrete orbit instance (`release-experiment.orbit.ts`)

The template declares parameters with `${...}` placeholders. The concrete orbit binds those parameters through `orbit_binding`, so the OpenCode lowerer emits only a concrete skill with real bound values.

Try:

```bash
bun run ./src/cli.ts validate ./examples/experiment-orbit
bun run ./src/cli.ts compile ./examples/experiment-orbit --harness opencode --dry-run
```
