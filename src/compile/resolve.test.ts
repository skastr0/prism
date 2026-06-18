/**
 * Resolve-phase contract tests.
 *
 * These tests exercise `resolveAgent`, `validateOrbit`, and `instantiateOrbit`
 * against in-memory registries built by `test-support.ts`.
 */

import { expect, test } from "bun:test";
import { Cause, Effect, Option } from "effect";
import type { CompileError } from "./errors.js";
import { resolveAgent, validateOrbit, instantiateOrbit } from "./resolve.js";
import {
  addToRegistry,
  makeAgent,
  makeIdentity,
  makeModelspace,
  makeOrbit,
  makePersonality,
  makeRegistry,
  makeResolvedAgent,
  makeSkillspace,
  makeTool,
  makeToolspace,
  makeTrait,
} from "./test-support.js";

const getFailure = <E>(
  exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>,
): E => {
  if (exit._tag !== "Failure") {
    throw new Error("Expected effect to fail");
  }
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) {
    throw new Error("Expected typed failure");
  }
  return failure.value as E;
};

const runResolve = <A>(effect: Effect.Effect<A, CompileError>): Promise<A> =>
  Effect.runPromise(effect);

const failResolve = <A>(
  effect: Effect.Effect<A, CompileError>,
): Promise<CompileError> =>
  Effect.runPromiseExit(effect).then((exit) => getFailure<CompileError>(exit));

const assertErrorTag = <Tag extends CompileError["_tag"]>(
  error: CompileError,
  tag: Tag,
): Extract<CompileError, { _tag: Tag }> => {
  expect(error._tag).toBe(tag);
  return error as Extract<CompileError, { _tag: Tag }>;
};

test("resolveAgent succeeds and exposes target-resolved surfaces", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity({ name: "builder" })],
    personalities: [makePersonality({ name: "focused" })],
    traits: [
      makeTrait({
        name: "reviewable",
        tools: { submit_review: { ref: "submit_review" } },
        access: { tools: ["workspace/run_shell"], skills: ["global/testing"] },
      }),
    ],
    tools: [makeTool({ name: "submit_review" })],
    toolspaces: [
      makeToolspace({
        name: "workspace",
        tools: { run_shell: { targets: { opencode: "bash" } } },
      }),
    ],
    modelspaces: [
      makeModelspace({
        name: "models",
        profiles: { default: { targets: { opencode: { model: "openai/gpt-5" } } } },
      }),
    ],
    skillspaces: [
      makeSkillspace({
        name: "global",
        skills: { testing: { targets: { opencode: { name: "testing" } } } },
      }),
    ],
    agents: [
      makeAgent({
        name: "builder",
        identity: "builder",
        personality: "focused",
        model: "models/default",
        traits: [{ ref: "reviewable" }],
        skills: ["global/testing"],
        access: { tools: ["workspace/run_shell"], skills: ["global/testing"] },
      }),
    ],
  });

  const agent = registry.agents.get("builder")!;
  const resolved = await runResolve(resolveAgent(agent, registry, "opencode"));

  expect(resolved.identity.name).toBe("builder");
  expect(resolved.personality?.name).toBe("focused");
  expect(resolved.resolvedModel).toEqual({ model: "openai/gpt-5" });
  expect(resolved.canonicalTraitIds).toEqual(["test-plugin:reviewable"]);
  expect(resolved.skills).toEqual(["testing"]);
  expect(resolved.allowedSkills).toEqual(["testing"]);
  expect(resolved.allowedTools).toEqual(["bash"]);
  expect(resolved.toolBindings).toHaveLength(1);
  expect(resolved.toolBindings[0]!.kind).toBe("permission");
  expect(resolved.toolBindings[0]!.logicalName).toBe("submit_review");
});

test("resolveAgent fails with UnknownReferenceError for missing identity", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    agents: [makeAgent({ name: "builder", identity: "missing" })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "UnknownReferenceError",
  );

  expect(error.field).toBe("identity");
  expect(error.referenceName).toBe("missing");
});

test("resolveAgent fails with UnknownReferenceError for missing trait", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    agents: [makeAgent({ traits: [{ ref: "missing" }] })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "UnknownReferenceError",
  );

  expect(error.field).toBe("trait");
  expect(error.referenceName).toBe("missing");
});

test("resolveAgent fails with UnknownReferenceError for missing tool ref", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    agents: [makeAgent({ access: { tools: ["workspace/missing"] } })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "UnknownReferenceError",
  );

  expect(error.field).toBe("tool");
});

test("resolveAgent fails with UnknownReferenceError for missing tool group", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    toolspaces: [makeToolspace({ name: "workspace" })],
    agents: [makeAgent({ access: { toolGroups: ["workspace#missing"] } })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "UnknownReferenceError",
  );

  expect(error.field).toBe("tool-group");
});

test("resolveAgent fails with MissingTargetResolutionError for tool missing target", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    toolspaces: [
      makeToolspace({
        name: "workspace",
        tools: { run_shell: { targets: { "claude-code": "bash" } } },
      }),
    ],
    agents: [makeAgent({ access: { tools: ["workspace/run_shell"] } })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "MissingTargetResolutionError",
  );

  expect(error.referenceKind).toBe("tool");
  expect(error.target).toBe("opencode");
});

test("resolveAgent fails with MissingTargetResolutionError for model profile missing target", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    modelspaces: [
      makeModelspace({
        name: "models",
        profiles: { default: { targets: { "claude-code": { model: "claude" } } } },
      }),
    ],
    agents: [makeAgent({ model: "models/default" })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "MissingTargetResolutionError",
  );

  expect(error.referenceKind).toBe("model-profile");
  expect(error.target).toBe("opencode");
});

test("resolveAgent fails with MissingTargetResolutionError for skillspace skill missing target", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    skillspaces: [
      makeSkillspace({
        name: "global",
        skills: { testing: { targets: { "claude-code": { name: "testing" } } } },
      }),
    ],
    agents: [makeAgent({ access: { skills: ["global/testing"] } })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "MissingTargetResolutionError",
  );

  expect(error.referenceKind).toBe("skill");
  expect(error.target).toBe("opencode");
});

test("resolveAgent fails with AgentValidationError for invalid OpenCode skill name", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    skillspaces: [
      makeSkillspace({
        name: "global",
        skills: { testing: { targets: { opencode: { name: "Testing_123" } } } },
      }),
    ],
    agents: [makeAgent({ access: { skills: ["global/testing"] } })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "AgentValidationError",
  );

  expect(error.field).toBe("skill");
  expect(error.message).toContain("invalid OpenCode skill name");
});

test("resolveAgent fails with AgentValidationError for duplicate trait", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    traits: [makeTrait({ name: "reviewable" })],
    agents: [makeAgent({ traits: [{ ref: "reviewable" }, { ref: "reviewable" }] })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "AgentValidationError",
  );

  expect(error.field).toBe("traits[1]");
  expect(error.message).toContain("duplicate trait");
});

test("resolveAgent fails with AgentValidationError for trait slot on unknown tool", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    traits: [makeTrait({ name: "reviewable", tools: {} })],
    agents: [
      makeAgent({
        traits: [{ ref: "reviewable", tools: { missing: { slots: {} } } }],
      }),
    ],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "AgentValidationError",
  );

  expect(error.message).toContain("fills slots for unknown tool");
});

test("resolveAgent resolves cross-plugin references through deps", async () => {
  const core = makeRegistry({ pluginName: "agent-core" });
  addToRegistry(core, {
    identities: [makeIdentity({ name: "builder" })],
    toolspaces: [
      makeToolspace({
        name: "workspace",
        tools: { run_shell: { targets: { opencode: "bash" } } },
      }),
    ],
  });

  const plugin = makeRegistry({ pluginName: "app", dependencyPaths: { "agent-core": core.pluginPath } });
  addToRegistry(plugin, {
    deps: [core],
    agents: [
      makeAgent({
        name: "worker",
        identity: "agent-core:builder",
        access: { tools: ["agent-core:workspace/run_shell"] },
      }),
    ],
  });

  const resolved = await runResolve(
    resolveAgent(plugin.agents.get("worker")!, plugin, "opencode"),
  );

  expect(resolved.identity.name).toBe("builder");
  expect(resolved.allowedTools).toEqual(["bash"]);
});

test("resolveAgent produces sorted tool and skill lists", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    toolspaces: [
      makeToolspace({
        name: "workspace",
        tools: {
          z_tool: { targets: { opencode: "z" } },
          a_tool: { targets: { opencode: "a" } },
        },
      }),
    ],
    skillspaces: [
      makeSkillspace({
        name: "global",
        skills: {
          zeta: { targets: { opencode: { name: "zeta" } } },
          alpha: { targets: { opencode: { name: "alpha" } } },
        },
      }),
    ],
    agents: [
      makeAgent({
        access: {
          tools: ["workspace/z_tool", "workspace/a_tool"],
          skills: ["global/zeta", "global/alpha"],
        },
      }),
    ],
  });

  const resolved = await runResolve(
    resolveAgent(registry.agents.get("builder")!, registry, "opencode"),
  );

  expect(resolved.allowedTools).toEqual(["a", "z"]);
  expect(resolved.allowedSkills).toEqual(["alpha", "zeta"]);
});

test("validateOrbit succeeds for valid agent phase with trait requirements", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    traits: [makeTrait({ name: "reviewable" })],
    agents: [
      makeAgent({
        name: "builder",
        traits: [{ ref: "reviewable" }],
      }),
    ],
    orbits: [
      makeOrbit({
        phases: [
          {
            name: "Review",
            agents: ["builder"],
            requires: [{ all: ["reviewable"] }],
          },
        ],
      }),
    ],
  });

  await runResolve(validateOrbit(registry.orbits.get("delivery")!, registry));
});

test("validateOrbit fails when phase declares multiple references", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    agents: [makeAgent()],
    orbits: [
      makeOrbit({
        phases: [
          {
            name: "Bad",
            agents: ["builder"],
            orbit: "delivery",
          },
        ],
      }),
    ],
  });

  const error = assertErrorTag(
    await failResolve(validateOrbit(registry.orbits.get("delivery")!, registry)),
    "OrbitValidationError",
  );

  expect(error.message).toContain("multiple references");
});

test("validateOrbit fails when assigned agents do not satisfy required traits", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    traits: [makeTrait({ name: "reviewable" })],
    agents: [makeAgent({ name: "builder" })],
    orbits: [
      makeOrbit({
        phases: [
          {
            name: "Review",
            agents: ["builder"],
            requires: [{ all: ["reviewable"], min: 1 }],
          },
        ],
      }),
    ],
  });

  const error = assertErrorTag(
    await failResolve(validateOrbit(registry.orbits.get("delivery")!, registry)),
    "OrbitValidationError",
  );

  expect(error.message).toContain("requires at least 1");
});

test("validateOrbit fails when parameterized orbit is referenced directly", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    orbits: [
      makeOrbit({
        name: "template",
        description: "Template ${X}",
        parameters: [{ name: "X" }],
        phases: [{ name: "Phase" }],
      }),
      makeOrbit({
        name: "delivery",
        phases: [{ name: "Bad", orbit: "template" }],
      }),
    ],
  });

  const error = assertErrorTag(
    await failResolve(validateOrbit(registry.orbits.get("delivery")!, registry)),
    "OrbitValidationError",
  );

  expect(error.message).toContain("use orbit_binding instead");
});

test("instantiateOrbit substitutes template parameters", async () => {
  const orbit = makeOrbit({
    name: "template",
    description: "Experiment ${H} for ${App}",
    parameters: [
      { name: "H", description: "Hypothesis" },
      { name: "App", description: "Application" },
    ],
    phases: [
      {
        name: "Run ${App}",
        notes: { Input: "${H}" },
      },
    ],
    body: "Body: ${H} ${App}",
  });

  const instantiated = await runResolve(
    instantiateOrbit(orbit, { H: "async commits", App: "release" }),
  );

  expect(instantiated.description).toBe("Experiment async commits for release");
  expect(instantiated.phases[0]!.name).toBe("Run release");
  expect(instantiated.phases[0]!.notes).toEqual({ Input: "async commits" });
  expect(instantiated.body).toBe("Body: async commits release");
  expect(instantiated.parameters).toHaveLength(0);
});

test("instantiateOrbit fails on missing required binding", async () => {
  const orbit = makeOrbit({
    name: "template",
    description: "${X}",
    parameters: [{ name: "X" }],
    phases: [{ name: "Phase" }],
    body: "",
  });

  const error = assertErrorTag(
    await failResolve(instantiateOrbit(orbit, {})),
    "OrbitValidationError",
  );

  expect(error.message).toContain("missing required binding");
});

test("instantiateOrbit fails on unknown binding", async () => {
  const orbit = makeOrbit({
    name: "template",
    description: "${X}",
    parameters: [{ name: "X" }],
    phases: [{ name: "Phase" }],
    body: "",
  });

  const error = assertErrorTag(
    await failResolve(instantiateOrbit(orbit, { X: "value", Y: "extra" })),
    "OrbitValidationError",
  );

  expect(error.message).toContain("unknown binding");
});

test("validateOrbit allows orbit_binding for parameterized orbits", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    agents: [makeAgent()],
    orbits: [
      makeOrbit({
        name: "template",
        description: "${X}",
        parameters: [{ name: "X" }],
        phases: [{ name: "Phase" }],
        body: "",
      }),
      makeOrbit({
        name: "delivery",
        phases: [
          {
            name: "Run",
            orbit_binding: { orbit: "template", bindings: { X: "bound" } },
          },
        ],
      }),
    ],
  });

  await runResolve(validateOrbit(registry.orbits.get("delivery")!, registry));
});

test("makeResolvedAgent factory produces a valid ResolvedAgent", () => {
  const resolved = makeResolvedAgent({
    skills: ["testing"],
    toolBindings: [
      {
        kind: "permission",
        logicalName: "submit_review",
        toolPluginName: "test-plugin",
        toolName: "submit_review",
        toolSourcePath: "/test/plugin/tools/submit_review.tool.ts",
      },
    ],
  });

  expect(resolved.agent.name).toBe("builder");
  expect(resolved.identity.name).toBe("builder");
  expect(resolved.skills).toEqual(["testing"]);
  expect(resolved.toolBindings[0]!.kind).toBe("permission");
});
