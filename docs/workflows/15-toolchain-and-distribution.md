# Prism Workflows — Toolchain & Distribution

Status: decided 2026-06-16. This document is normative for how Prism ships and
resolves user-authored TypeScript DSL files (both harness-programming sources and
workflows). It supersedes the implicit, dev-repo-only resolution that the codebase
relies on today, and it folds the workflow toolchain and the harness-programming
toolchain into **one** model — they are the same problem twice.

## 1. The problem

A user or agent authors a TypeScript file — an `*.agent.ts`, an `*.orbit.ts`, or a
`*.workflow.ts` — that imports Prism source object types, workflow builders
(`defineWorkflow`, `defineTask`), Effect, and generated refs. To run or typecheck
it, those imports must resolve, the file must transpile, and (for workflows) it
must execute.

Today this works **only inside the source monorepo**:

- Every plugin DSL file and every workflow imports the bare specifier `"prism"`,
  which is a dev-only `file:../prism` workspace alias (`prism-plugins/package.json`).
  The published package is `@skastr0/prism` (scoped, ships only `bin/prism.js`, no
  `exports`, no types). So `from "prism"` resolves to **nothing** off-repo.
- Workflows go further and import `"../../src/workflows.ts"` — a relative path into
  the repo `src/` tree.
- No `.d.ts` is emitted or published anywhere; `prism-core` is `private:true`.
- Generated refs are written **into the project tree**
  (`<projectPath>/.prism/generated/workflows/*.ts`).
- The global compile manifest (`~/.prism/state/compile-manifest.json`) has **no
  project dimension** — it is one flat file keyed `"<plugin>:<agent>"`, so two
  projects with a same-named local plugin clobber each other.

The runtime survives all of this because the binary rewrites imports at load time
(`src/compile/load.ts`: `from "prism"` → an in-tmpdir identity-stub `.mjs`,
`from "effect"` → the binary's own embedded Effect via `globalThis.__prism_effect`).
But **authoring, typechecking, and off-repo execution do not work.**

## 2. Principle

**The Prism binary is the single runtime and the entire toolchain.** A user or agent
needs *only* the binary — not Node as a runtime, not Effect, not TypeScript, not a
`package.json`, not `node_modules`, not a published library. The binary owns
resolve + transpile + execute + typecheck, and pins every framework dependency it
needs. The user's environment (absent or chaotic Effect/TS versions) is never
consulted, so version skew is structurally impossible on the DSL path.

This is already true at runtime for harness-programming; this document extends it to
workflows and to **authoring/typecheck**, and makes the storage Prism-owned.

## 3. The resolution model

A DSL file imports only **Prism-owned virtual specifiers**. No relative paths into
any repo, no bare `node_modules` packages. Three specifiers, resolved two ways:

| specifier | what it is | runtime resolution (binary) | edit/typecheck resolution (generated tsconfig `paths`) |
|---|---|---|---|
| `prism` | source object types, `defineWorkflow`, `defineTask`, ref/builder types | rewritten to the embedded authoring-runtime `.mjs` (identity stubs) — `load.ts` mechanism, extended to the workflow loader | → the shipped `prism.d.ts` (in the platform package) |
| `prism/refs` | the generated project refs (`agents`, `models`, `skills`, `traits`, `orbits`, `tools`) | resolved to `~/.prism/state/projects/<key>/generated/` | → that same generated `.ts`/`.d.ts` |
| `effect` | Effect + Schema | rewritten to the binary's embedded Effect (`globalThis.__prism_effect`) | → the `effect` that already ships in the platform package |

Consequences:

- **Workflows stop importing `"../../src/workflows.ts"`** — they import `prism`.
- **Refs stop being a relative path** — `import { agents } from "prism/refs"`.
  This is required because refs move out of the project tree (§5).
- The workflow loader (`src/workflow-loader.ts`, currently a naked
  `await import(file)`) must adopt the same specifier-rewrite the compile path uses.
  This unifies the two loaders.

## 4. Project identity

A project key is derived at the CLI edge:

- **git repository root** (origin/worktree root) if the cwd is inside a git repo,
- else the **cwd** (realpath).

Do not over-engineer this until evidence demands more. The key is hashed
(`sha256(realpath)`) only to produce a filesystem-safe directory name; the human
path is recorded alongside for inspection.

## 5. Storage layout — machine-global, project-keyed, never in project source

Generated types are **Prism-owned concerns**, not project source. Vendoring them into
the project tree would (a) drag them into the user's version control, (b) force
migrations when a Prism upgrade changes generated output. So they live machine-global,
associated to a project key:

```
~/.prism/
  state/
    projects/<key>/
      compile-manifest.json     # per-project manifest partition (fixes clobbering)
      generated/                # agents/models/skills/traits/orbits/tools (.ts + .d.ts)
      tsconfig.json             # Prism-generated; paths-maps prism/effect/refs; includes the workflow dir; allowImportingTsExtensions
  workflows/<key>/              # default workflow location (a user MAY instead keep workflows as project .ts files)
  runtime/mcp/<plugin>/server.mjs   # existing; unchanged
```

The **per-project manifest partition** replaces the single flat global manifest and
**fixes the clobbering bug**: two projects with a same-named local plugin no longer
stomp each other, and a project's generated refs reflect only that project's agents.

Distinction to hold: **harness output** (`~/.claude/...` or `<project>/.claude/...`,
user-facing config) may legitimately be global or project-scoped. **Prism-owned
generated types** are always machine-global. That is the clean line.

## 6. The shipped type surface

There is no published library and no published types package. Instead:

- A **`.d.ts` emit build step** (none exists today) produces `prism.d.ts` from
  `src/index.ts` + `src/workflows.ts`, with `prism-core`'s contract types folded in.
- That `.d.ts` ships **inside the platform binary package**
  (`@skastr0/prism-<platform>`), beside the `effect` and `typescript` that already
  ship there (`prism-<platform>/package.json` `dependencies`).
- `prism` is **not** intended as a project dependency. (A user may depend on the CLI
  if they want, but nothing requires it.)

So the editor and `tsc` resolve `prism`/`effect`/`prism/refs` purely through the
Prism-generated `tsconfig.json` (§5), with zero `npm install` and zero skew.

## 7. The `run` pipeline

`prism workflow run <file>` becomes:

1. **resolve** — load via the unified specifier-rewrite (§3).
2. **typecheck (transparent pre-step)** — build an in-process `ts.createProgram`
   from the embedded `typescript` + the generated tsconfig (§5) + the shipped
   `prism.d.ts` + effect `.d.ts`. Fail fast with diagnostics on type error. This is
   *not* a separate goal — it is a necessary part of running. (A standalone
   `prism workflow typecheck -` that checks a piped TS string → JSON diagnostics is a
   **secondary** agent affordance, designed later.)
3. **ref-freshness** — verify the generated refs' `manifestHash` matches the current
   compile manifest; stale refs silently lie (the stale-world trap), so warn or
   auto-refresh.
4. **execute** — in-process, as today.

### 7a. Repair budget (decoupled — fixes a real footgun)

Today `maxRepairs = task.finish?.maxRepairs ?? 0` (`workflow-runner.ts:598`) fuses
objective decode/parse repair to the subjective finish-criterion budget, so a task
without a `finish` block gets **zero** decode repairs and dies on one malformed JSON.
Decouple them: give JSON-parse and schema-decode repair their **own runtime default
budget** (e.g. 2), independent of `finish`; keep `finish.maxRepairs` for the
subjective `continue` loop. Objective failures self-heal by default; completion
gating stays opt-in. (Not a publish blocker; ~10 lines.)

## 8. The MCP — a Prism plugin that compiles to MCP

The workflow MCP is authored as a **Prism plugin** and compiled to an MCP server, so
it works across every harness Prism supports. The mechanism already exists: prism
compiles plugins into standalone Bun `.mjs` MCP servers in
`~/.prism/runtime/mcp/<plugin>/server.mjs` with Effect inlined
(`src/compile/mcp-bundle.ts`). The workflow MCP's tools
(`workflow_run`/`validate`/`status`/`approve`) **delegate execution to the prism
binary** — the server is standalone as a process, but the work is the CLI's.

Invariant: **the CLI/binary is the single runtime; plugins, workflows, and the MCP
are all clients.** No runtime-duplicating standalone MCP.

## 9. Harness-programming cleanup (subsumed by this workstream)

The same fixes make harness-programming itself publish-clean:

- Replace the `"prism": "file:../prism"` workspace alias with the virtual-specifier +
  generated-tsconfig model (§3, §6). Plugin DSL files keep `from "prism"`; it now
  resolves off-repo.
- Plugins without a `package.json` get effect/prism resolution from the generated
  tsconfig, not the workspace root.
- `prism.lock` relative `sourcePath`/dep paths and the `effectBundleImportPath()`
  dev-vs-binary divergence (`runtime-deps.ts`) are cleaned as part of the same pass.

## 10. Migration (consolidation stance: delete + regenerate, no compat)

- Move generated refs from `<project>/.prism/generated` to
  `~/.prism/state/projects/<key>/generated`; delete the project-tree copies; no dual
  path, no adopt.
- Partition the manifest per project; the old flat global manifest is regenerated,
  not migrated.
- Rewrite workflow imports from `../../src/...` to `prism` / `prism/refs`.

## 11. Deferred / open

- Standalone `prism workflow typecheck -` (string → JSON diagnostics) — secondary.
- Whether `run` auto-refreshes stale refs or only warns.
- The cached-agent-composition layer and its world-ref staleness surface (see
  `prism-workflows-future-ideas`) build *on* this toolchain, not within it.
