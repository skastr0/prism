# Tools Architecture

This document is the canonical design for `prism` tools and toolspaces.

The purpose is simple: tools are definitions, permissions are visibility, and
filled tool slots are the only reason to synthesize a new harness tool. The
compiler must not create tool implementations from permissions.

## Lexicon

**Tool**

An authored TypeScript runtime artifact in `tools/*.tool.ts`. A tool owns its
implementation, base input schema, output schema, description, and optional
slots.

**Permission**

A compile-time statement that an agent may use a tool. Permissions do not
create tools, copy tools, generate contracts, or change implementations.

**Tool slot**

An optional extension point declared by a tool. A slot is owned by the tool, not
by a trait. Slots are always optional at binding time. A tool with no declared
slots cannot produce synthetic variants.

Slots must not be used as the whole input of a tool. They are named optional
extension points that the tool implementation explicitly agrees to accept.

**Filled slot**

An agent binding supplies a concrete schema for a declared tool slot. Filling a
slot creates a synthetic tool wrapper for that agent-facing contract and gives
the agent permission to the wrapper instead of the base tool.

**Synthetic tool**

A generated harness wrapper created only from filled tool slots. It exposes a
bespoke schema and description to the agent, validates the call, then delegates
to the original tool implementation. It does not own business logic.

**Toolspace**

A target-specific map from logical tool intent to harness-final tool names.
Toolspaces cover built-in harness tools, external plugin tools, and generated
prism tools. They are permission inventory, not implementation factories.

**Runtime artifact**

TypeScript that must execute inside the generated harness plugin: tools,
schemas, slot schemas, shared helpers, and tests where applicable.

**Compiler DSL artifact**

TypeScript that configures `prism`: agents, traits, orbits, toolspaces,
modelspaces, plugin manifests, and other compile-time declarations.

## Laws

1. Tool definitions create tools.
2. Permissions expose tools.
3. Filled tool slots synthesize tools.
4. Nothing else synthesizes tools.
5. A permission without filled slots is only a permission.
6. A tool without slots can never be synthesized.
7. Slots are optional. There are no required slots.
8. Traits do not own slots.
9. Traits may attach permissions to tools.
10. Agent trait bindings may fill declared tool slots.
11. Synthetic tools delegate to the original tool implementation.
12. New implementation means a new `tools/*.tool.ts` module.
13. TypeScript code sharing is a TypeScript concern, not a compiler concern.
14. The compiler must never re-render Effect Schema AST back into source code.
15. The compiler must never emit duplicate identical generic tools.
16. Generated harness output must preserve tool ownership.

## Authoring Model

### Tool Definition

A tool may declare optional slots. The tool owns the slot names and semantics.

```ts
import { schemaSlot, type ToolSource } from "prism";
import { OrbitDispatchReceipt, WorkSubmissionBase } from "../schemas/tool-schemas.ts";

export default {
  name: "submit_work",
  description: "Persist completed orbit work to the canonical dispatch store.",
  input: WorkSubmissionBase,
  output: OrbitDispatchReceipt,
  slots: {
    builder_report: schemaSlot({
      description: "Additional builder-only fields persisted with the work dispatch.",
    }),
  },
  handle(input, context) {
    // Shared persistence logic. Filled slots only change validation and the
    // documented agent-facing shape, not this implementation.
  },
} satisfies ToolSource;
```

If the tool does not declare `builder_report`, no trait or agent can fill it.

### Trait Permission

A trait gives an agent permission to a tool. It does not define slots.

```ts
import type { TraitSource } from "prism";

export default {
  name: "submittable",
  tools: {
    submit_work: {
      ref: "orbit-core:submit_work",
    },
  },
} satisfies TraitSource;
```

### Generic Agent Binding

No slots filled means permission only.

```ts
import type { AgentSource } from "prism";

export default {
  name: "builder",
  description: "Builds scoped changes",
  identity: "builder",
  traits: ["submittable"],
} satisfies AgentSource;
```

The agent receives the base `orbit-core:submit_work` harness tool.

### Filled Slot Binding

The agent fills a tool-owned slot with an imported runtime schema artifact.

```ts
import type { AgentSource } from "prism";
import { BuilderSubmitWorkReport } from "../schemas/tool-schemas.ts";

export default {
  name: "builder",
  description: "Builds scoped changes",
  identity: "builder",
  traits: [
    {
      trait: "submittable",
      tools: {
        submit_work: {
          slots: {
            builder_report: BuilderSubmitWorkReport,
          },
        },
      },
    },
  ],
} satisfies AgentSource;
```

The compiler creates one synthetic wrapper for this filled-slot contract. The
wrapper validates `builder_report` as part of the agent-facing input and then
delegates to `orbit-core:submit_work`.

## Runtime Artifact Rules

Runtime artifacts are copied as files, preserving relative imports. They are not
reconstructed from live values.

Runtime artifact roots include:

- `tools/**/*.tool.ts`
- `tools/shared/**/*.ts`
- `schemas/**/*.ts`
- `slots/**/*.ts` when a plugin wants a dedicated slot-schema directory
- other explicitly declared runtime files required by copied modules

Compiler DSL files may reference runtime artifacts, but serious tool schemas and
slot schemas must be importable symbols from copied runtime files.

Inline Effect schemas in DSL files are not supported for tool slots. If the
compiler cannot trace a filled slot to a copied runtime artifact/export, compile
must fail.

## Effect Schema Rule

The compiler must not serialize or replay Effect Schema AST.

Effect Schema can contain refinements, transforms, annotations, suspends, and
other semantics that are not faithfully represented by a tiny schema printer.
The source module is the artifact. Copy it and import it.

This is a hard boundary, not a fallback path.

## Harness Lowering

Lowering happens in two independent lanes.

### Tool Runtime Lane

Each tool-owning plugin lowers to one harness plugin for its owned tools and
runtime artifacts.

For example, `orbit-core` owns `submit_work`, so the generated OpenCode
plugin for `orbit-core` owns that runtime tool. `survey`, `beacon`, `scribe`, and
`forge` must not mirror or copy `submit_work` as if they own it.

### Permission Lane

Agents, traits, orbits, and toolspaces determine which harness-final tool
names are visible to each agent.

For a generic permission, the agent receives permission to the owner tool.

For a filled slot, the compiler creates a synthetic wrapper and gives the agent
permission to that wrapper.

For harnesses with global tool registries such as OpenCode, generated
prism plugin tools must fail closed. The lowerer writes a global default-deny
permission for each generated plugin namespace, then generated agent
frontmatter writes explicit per-tool `allow` entries for assigned tools. An
agent with no generated-tool permission block therefore has access to none of
the generated prism plugin tools.

Compiled-agent cache keys include a compiler-semantics version, not just source
hashes. When generated tool naming, slot lowering, permission lowering, or other
compile semantics change, cached composed agents must be invalidated even when
the source DSL files did not change.

## Toolspaces

Toolspaces are the harness-facing permission inventory.

They answer:

- What is the harness-final name for this built-in or external tool?
- What logical groups should traits reference?
- Which agents receive which allowed tool names?
- Which tools should be explicitly disabled for an agent when the harness
  supports deny lists?

Toolspaces do not create executable implementations. They resolve concrete
harness names so traits and agents can stay semantic.

Generated prism tools should be added to the same final permission inventory
as harness-native tools. That lets one permission pass produce each agent's
complete allow/block surface.

## OXC Guardrails

`prism init` should scaffold OXC guardrails for TypeScript plugin authors.

Oxlint supports project configuration files and JavaScript plugins through
`jsPlugins`, with paths resolved relative to the config file. Oxfmt supports
project configuration and `fmt` / `fmt:check` style scripts. See:

- [Oxlint usage](https://oxc.rs/docs/guide/usage/linter.html)
- [Oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html)
- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config)
- [Oxfmt usage](https://oxc.rs/docs/guide/usage/formatter.html)
- [Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config)

The first custom lint rules should enforce:

- no inline `Schema.*` tool slot values in DSL files
- filled slot schemas must be imported identifiers
- traits must not define root-level slots
- trait tool attachments must not replace `input` or `output`
- compiler DSL files must not contain runtime tool implementation logic

## Deleted Concepts

The final system does not keep obsolete naming, input/output replacement,
generated contracts for plain tool references, dependency tool mirrors under
consumer plugin ownership, or Effect Schema AST replay.

## Acceptance Bar

The compiler is broken if any of these happen:

- one plain permission creates a tool
- one generic tool is emitted under more than one owning plugin
- one orbit plugin contains a copied dependency tool implementation
- one tool without slots produces a synthetic wrapper
- one filled undeclared slot compiles
- one schema is re-rendered from Effect Schema AST
- one generated harness agent can see a tool it was not assigned

The `submit_work` test case is the standing smoke test:

- `orbit-core:submit_work` exists once
- generic `submittable` agents receive permission to that one tool
- builder-style agents receive a synthetic wrapper only if they fill a
  `submit_work` slot declared by `orbit-core`
- no `survey`, `beacon`, `scribe`, or `forge` generated plugin owns a duplicate
  `submit_work.tool.ts`
