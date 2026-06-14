# 14 — Workflow Architecture Boundaries

Status: normative guardrail.

This document fixes the line between Prism core, Prism compiler/install, Prism
workflows, and userland orchestration systems. It exists to prevent workflow
features from quietly absorbing one user's ontology, plugin source layout, Git
policy, or coordination mechanics into Prism itself.

## The boundary stack

1. **Plugin source** — user-authored Prism DSL files: agents, skills, tools,
   modelspaces, skillspaces, traits, orbits, hooks, and manifests.
2. **Compiler/install** — the only layer that reads plugin source, resolves
   dependencies, composes traits, lowers artifacts, and writes installed harness
   outputs plus compile manifests.
3. **Installed/compiled registry truth** — generated artifacts and durable state:
   compile manifest, installed harness files, snapshot manifests, generated
   workflow refs, and sync state.
4. **Workflow authoring/runtime** — Effect TypeScript over generated refs and
   runtime services. It consumes installed/compiled truth. It does not resolve or
   inspect plugin source.
5. **Userland systems** — any project-specific business OS, orbit family, board,
   asset review system, memory system, eval harness, resource semaphore, or
   policy layer built on top of Prism.

## Core invariants

- Workflows consume **compiled Prism data**, not plugin source trees.
- Compiler/install owns plugin discovery, dependency resolution, composition,
  lowering, and installed-state repair.
- Workflow refs carry falsifiable compile pointers (`plugin`, `name`,
  `sourceHash`, `manifestHash`, model binding, install coverage), not filesystem
  paths to plugin sources.
- Orbit semantics are optional installed metadata. Prism core has no default
  orbit, no default phase set, and no default domain ontology.
- Forge, Tower, Glyphs, Booth, Quasar, Beacon, Scribe, Atelier, and similar
  concepts are userland plugin/product vocabulary unless explicitly authored as
  fixtures inside tests or examples. They are not Prism workflow defaults.
- Traits are compiler composition inputs. Workflows consume the composed agent
  surface; they do not normally author trait bindings directly.
- Resource claims, file-edit semaphores, proposal-layer editing, Git/worktree
  policy, and domain-specific side-effect rules are not Prism workflow core.
  They can be built as plugins, harness integrations, or external tools that
  workflows invoke through typed services later.

## Allowed dependencies

```text
plugin source ──read by──▶ compiler/install
compiler/install ──writes──▶ compile manifest + installed harness artifacts
compile manifest ──emits──▶ generated workflow refs
generated refs + runtime services ──used by──▶ workflows
userland plugins ──may build on──▶ workflows
```

The reverse arrows are forbidden. A workflow runtime must not crawl plugin
source, reach into `~/Projects/prism-plugins`, import plugin modules directly, or
decide plugin dependency resolution. If a workflow needs a capability from a
plugin, that capability must first be represented in compiled/generated state or
provided as an explicit userland runtime service.

## Orbit boundary

Orbits remain a Prism DSL concept because the compiler can lower orbit metadata
into harness skills and, later, generated workflow affordances. That does not
make any specific orbit universal.

Correct shape:

- an installed plugin defines an orbit;
- compiler resolves its agents, phases, tools, and references;
- generated workflow metadata may expose type-safe helpers for that installed
  orbit;
- workflows may use those helpers when that plugin is present.

Incorrect shape:

- Prism core assumes `forge`, `survey`, `beacon`, `scribe`, or `oracle` exist;
- Prism workflow runtime treats glyphs, dispatches, chatter, or Tower signals as
  universal concepts;
- workflow files import an orbit from a plugin source directory;
- generated refs bake in board IDs, work-item IDs, or domain-specific lifecycle
  state.

## Userland ontology boundary

Userland plugins are how Prism becomes powerful. They are not second-class; they
are the whole point. The boundary is that userland truth must enter workflows via
compiled artifacts and typed runtime services, not by being smuggled into Prism
core.

Examples:

- A Tower plugin can generate MCP tools and harness skills. Workflow runtime does
  not know what a glyph is unless a workflow imports a Tower-generated service or
  calls a Tower tool explicitly.
- A Booth plugin can provide creative review tooling. Workflow runtime does not
  have a built-in asset-review concept.
- A Quasar plugin can provide session observability. Workflow runtime records
  session pointers and metadata; it does not become the transcript database.
- A Semaphore-style plugin could implement claims over files, domains, or other
  project resources. Workflow runtime does not enforce a universal claim model.

## Review checklist

Before landing workflow changes, check:

- Does new workflow code import from plugin source paths or scan plugin folders?
- Does generated workflow output expose source file paths where hashes/manifests
  would suffice?
- Does runtime behavior assume a named orbit or board concept exists?
- Does a docs example present a userland plugin as Prism default truth?
- Does the change make Prism act like Git, a diff manager, a policy engine, or a
  software-only work tracker?
- If side-effect control is needed, is it represented as a plugin/service seam
  rather than a hardcoded Prism workflow primitive?

If any answer is yes, stop and either move the behavior into compiler/install,
represent it in generated installed state, or make it a userland plugin/service.
