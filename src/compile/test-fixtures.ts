import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const effectImportPath = join(
  process.cwd(),
  "node_modules",
  "effect",
  "dist",
  "esm",
  "index.js"
).replace(/\\/g, "/");

const agentpkgImportPath = join(process.cwd(), "src", "index.ts").replace(/\\/g, "/");

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

export const createCanonicalCompileFixture = async (options: {
  pluginRoot: string;
  projectRoot: string;
  invalidLifecycle?: boolean;
  invalidLifecycleGrantAgent?: boolean;
  invalidLifecycleGrantRoot?: boolean;
}): Promise<{ pluginRoot: string; projectRoot: string }> => {
  const { pluginRoot, projectRoot } = options;
  const coreRoot = join(pluginRoot, "deps", "agent-core");
  const protocolRoot = join(pluginRoot, "deps", "protocol-core");
  await mkdir(projectRoot, { recursive: true });

  await writeText(
    join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "canonical-compile-fixture",
        version: "0.1.0",
        deps: {
          "agent-core": "./deps/agent-core",
          "protocol-core": "./deps/protocol-core",
        },
        targets: {
          agents: ["opencode", "claude-code"],
          lifecycles: ["opencode", "claude-code"],
          tools: ["opencode", "claude-code"],
          toolspaces: ["opencode", "claude-code"],
          modelspaces: ["opencode", "claude-code"],
        },
      },
      null,
      2
    )}\n`
  );

  await writeText(
    join(coreRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "agent-core",
        version: "0.1.0",
        targets: {
          toolspaces: ["opencode", "claude-code"],
          modelspaces: ["opencode", "claude-code"],
        },
      },
      null,
      2
    )}\n`
  );

  await writeText(
    join(protocolRoot, "plugin.json"),
    `${JSON.stringify(
      {
        name: "protocol-core",
        version: "0.1.0",
        targets: {
          tools: ["opencode", "claude-code"],
        },
      },
      null,
      2
    )}\n`
  );

  await writeText(
    join(coreRoot, "toolspaces", "workspace-tools.toolspace.ts"),
    `import { defineToolspace, toolRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineToolspace({
  name: "workspace-tools",
  description: "Logical tool vocabulary shared across compile fixtures",
  tools: {
    read_repo: {
      description: "Read repository files",
      targets: {
        opencode: { name: "read" },
        "claude-code": { name: "Read" },
      },
    },
    search_repo: {
      description: "Search repository contents",
      targets: {
        opencode: { name: "grep" },
        "claude-code": { name: "Grep" },
      },
    },
    run_shell: {
      description: "Run shell commands",
      targets: {
        opencode: { name: "bash" },
        "claude-code": { name: "Bash" },
      },
    },
  },
  groups: {
    repo_inspection: {
      description: "Read and search the repository",
      tools: [
        toolRef("workspace-tools", "read_repo"),
        toolRef("workspace-tools", "search_repo"),
      ],
    },
  },
});
`
  );

  await writeText(
    join(coreRoot, "modelspaces", "default-models.modelspace.ts"),
    `import { defineModelspace } from ${JSON.stringify(agentpkgImportPath)};

export default defineModelspace({
  name: "default-models",
  description: "Shared logical model profiles",
  profiles: {
    builder: {
      description: "Primary build profile",
      targets: {
        opencode: {
          model: "openai/gpt-5.4",
          variant: "xhigh",
          temperature: 0.2,
        },
        "claude-code": {
          model: "sonnet",
          temperature: 0.1,
        },
      },
    },
    reviewer: {
      description: "Primary review profile",
      targets: {
        opencode: {
          model: "openai/gpt-5.4",
          variant: "medium",
          temperature: 0.1,
        },
        "claude-code": {
          model: "opus",
          temperature: 0.1,
        },
      },
    },
  },
});
`
  );

  await writeText(
    join(pluginRoot, "identities", "builder.identity.md"),
    `---
description: Build specialist for canonical compile tests
---

# Builder

You implement one committed work item and validate it before review.
`
  );

  await writeText(
    join(pluginRoot, "identities", "reviewer.identity.md"),
    `---
description: Review specialist for canonical compile tests
---

# Reviewer

You assess completed work and report whether it is ready to ship.
`
  );

  await writeText(
    join(pluginRoot, "tools", "submit-work.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "submit-work",
  description: "Submit completed work",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`
  );

  await writeText(
    join(protocolRoot, "tools", "external-submit.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "external-submit",
  description: "Submit completed work through an external protocol plugin",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`
  );

  await writeText(
    join(protocolRoot, "tools", "create_item.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "create_item",
  description: "Create a lifecycle work item",
  input: Schema.Struct({
    lifecycle: Schema.Literal("sdlc", "rlc", "mlc", "wlc"),
    id: Schema.String,
    title: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
    lifecycle: Schema.Literal("sdlc", "rlc", "mlc", "wlc"),
    id: Schema.String,
  }),
  async handle(input, context) {
    return { acknowledged: true, lifecycle: input.lifecycle, id: input.id };
  },
});
`
  );

  await writeText(
    join(pluginRoot, "tools", "commit-work.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "commit-work",
  description: "Commit validated implementation work",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`
  );

  await writeText(
    join(pluginRoot, "tools", "submit-review.tool.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTool } from ${JSON.stringify(agentpkgImportPath)};

export default defineTool({
  name: "submit-review",
  description: "Submit review findings",
  input: Schema.Struct({
    summary: Schema.String,
  }),
  output: Schema.Struct({
    acknowledged: Schema.Boolean,
  }),
  async handle(input, context) {
    return { acknowledged: true };
  },
});
`
  );

  await writeText(
    join(pluginRoot, "traits", "submittable.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "submittable",
  description: "Can submit completed work",
  instructions: "Submit completed work through the typed submission surface before handing off.",
  tools: {
    submit_work: {
      ref: "protocol-core:external-submit",
    },
  },
  require: {
    tools: ["submit_work"],
  },
});
`
  );

  await writeText(
    join(pluginRoot, "traits", "committable.trait.ts"),
    `import { defineTrait } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "committable",
  description: "Can create implementation commits",
  instructions: "Commit owned implementation changes only after the submitted work is complete.",
  tools: {
    commit_work: {
      ref: "commit-work",
    },
  },
  require: {
    tools: ["commit_work"],
  },
});
`
  );

  await writeText(
    join(pluginRoot, "traits", "reviewable.trait.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { defineTrait, schemaSlot, slotRef, toolGroupRef, valueSlot } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "reviewable",
  description: "Can submit review findings",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  },
  slots: {
    review_input: schemaSlot({
      description: "Agent-specific review packet schema",
    }),
    review_lane: valueSlot(Schema.String, {
      description: "Lane for routed review findings",
    }),
  },
  tools: {
    submit_review: {
      ref: "submit-review",
      description: "Submit review findings to \${review_lane}",
      input: slotRef("review_input"),
    },
  },
  require: {
    tools: ["submit_review"],
  },
});
`
  );

  await writeText(
    join(pluginRoot, "traits", "self-assessing.trait.ts"),
    `import { defineTrait, toolGroupRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineTrait({
  name: "self-assessing",
  description: "Runs validation before handing work off",
  instructions: "Run the relevant validation before final response or handoff.",
  access: {
    toolGroups: [toolGroupRef("agent-core", "workspace-tools", "repo_inspection")],
  },
  inject: {
    skills: ["testing"],
  },
  require: {
    skills: ["testing"],
  },
});
`
  );

  await writeText(
    join(pluginRoot, "agents", "builder.agent.ts"),
    `import { bindTrait, defineAgent, modelProfileRef, toolRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineAgent({
  name: "builder",
  description: "Builder agent for canonical compile integration tests",
  identity: "builder",
  model: modelProfileRef("agent-core", "default-models", "builder"),
  traits: [
    bindTrait("submittable"),
    bindTrait("committable"),
    bindTrait("self-assessing"),
  ],
  access: {
    tools: [toolRef("agent-core", "workspace-tools", "run_shell")],
  },
  targets: {
    opencode: {
      mode: "subagent",
      maxSteps: 12,
    },
    "claude-code": {
      top_p: 0.7,
    },
  },
});
`
  );

  await writeText(
    join(pluginRoot, "agents", "reviewer.agent.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { bindTrait, defineAgent, modelProfileRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineAgent({
  name: "reviewer",
  description: "Reviewer agent for canonical compile integration tests",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    bindTrait("submittable"),
    bindTrait("reviewable", {
      slots: {
        review_lane: "review-findings",
        review_input: Schema.Struct({
          summary: Schema.String,
          verdict: Schema.Literal("approve", "request_changes"),
        }),
      },
    }),
    bindTrait("self-assessing"),
  ],
  targets: {
    opencode: {
      mode: "subagent",
    },
    "claude-code": {
      top_p: 0.5,
    },
  },
});
`
  );

  await writeText(
    join(pluginRoot, "agents", "security-reviewer.agent.ts"),
    `import { Schema } from ${JSON.stringify(effectImportPath)};
import { bindTrait, defineAgent, modelProfileRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineAgent({
  name: "security-reviewer",
  description: "Security reviewer variant using the same reviewable trait",
  identity: "reviewer",
  model: modelProfileRef("agent-core", "default-models", "reviewer"),
  traits: [
    bindTrait("submittable"),
    bindTrait("reviewable", {
      slots: {
        review_lane: "security-review",
        review_input: Schema.Struct({
          summary: Schema.String,
          severity: Schema.Literal("low", "medium", "high"),
          findings: Schema.Array(Schema.String),
        }),
      },
    }),
    bindTrait("self-assessing"),
  ],
  targets: {
    opencode: {
      mode: "subagent",
    },
    "claude-code": {
      top_p: 0.4,
    },
  },
});
`
  );

  const reviewAgents = options.invalidLifecycle ? ["builder"] : ["reviewer"];
  const grantAgents = options.invalidLifecycleGrantAgent
    ? ["security-reviewer"]
    : ["builder"];
  const grantRoot = options.invalidLifecycleGrantRoot ? "research" : "sdlc";

  await writeText(
    join(pluginRoot, "lifecycles", "delivery-contract.lifecycle.ts"),
    `import { agentRef, defineLifecycle, traitRef } from ${JSON.stringify(agentpkgImportPath)};

export default defineLifecycle({
  name: "delivery-contract",
  description: "Validate that work moves through the right trait-conforming agents",
  phases: [
    {
      name: "Implement change",
      agents: [agentRef("builder")],
      requires: [
        {
          all: [traitRef("committable"), traitRef("self-assessing")],
        },
      ],
      signal_in: "Work item is ready to build",
      termination: "Implementation is ready for review",
    },
    {
      name: "Review change",
      agents: [${reviewAgents.map((agent) => `agentRef(${JSON.stringify(agent)})`).join(", ")}],
      requires: [
        {
          all: [traitRef("reviewable"), traitRef("self-assessing")],
        },
      ],
      signal_in: "Implementation is ready for review",
      termination: "Review findings are recorded",
    },
    {
      name: "Hand off work",
      agents: [agentRef("builder"), agentRef("reviewer")],
      requires: [
        {
          all: [traitRef("submittable")],
          min: 2,
        },
      ],
      signal_in: "Build and review are complete",
      termination: "Work has been handed off cleanly",
    },
  ],
  tool_grants: [
    {
      lifecycle_root: ${JSON.stringify(grantRoot)},
      agents: [${grantAgents.map((agent) => `agentRef(${JSON.stringify(agent)})`).join(", ")}],
      tools: [
        {
          ref: "protocol-core:create_item",
          as: "create_item",
        },
      ],
    },
  ],
  body: "Use this lifecycle when you want the compile-time graph to prove that each phase has the right agents assigned.",
});
`
  );

  return { pluginRoot, projectRoot };
};
