/**
 * Resolve-phase contract tests.
 *
 * These tests exercise `resolveAgent`, `validateOrbit`, and `instantiateOrbit`
 * against in-memory registries built by `test-support.ts`.
 */

import { expect, test } from "bun:test";
import { Cause, Effect, Option, Schema } from "effect";
import type { CompileError } from "./errors.js";
import {
  projectOrbitsForCompileManifest,
  resolveAgent,
  validateOrbit,
  instantiateOrbit,
} from "./resolve.js";
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
        skills: ["global/testing"],
      }),
    ],
  });

  const agent = registry.agents.get("builder")!;
  const resolved = await runResolve(resolveAgent(agent, registry, "opencode"));

  expect(resolved.identity.name).toBe("builder");
  expect(resolved.personality?.name).toBe("focused");
  expect(resolved.resolvedModel).toEqual({ model: "openai/gpt-5" });
  expect(resolved.skills).toEqual(["testing"]);
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

test("resolveAgent ignores model profile target cells for model-free agent surfaces", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    modelspaces: [
      makeModelspace({
        name: "models",
        profiles: { default: { targets: { opencode: { model: "openai/gpt-5" } } } },
      }),
    ],
    agents: [makeAgent({ model: "models/default" })],
  });

  const resolved = await runResolve(
    resolveAgent(registry.agents.get("builder")!, registry, "amp-code"),
  );

  expect(resolved.resolvedModel).toBeUndefined();
});

test("resolveAgent still validates missing modelspace refs for model-free agent surfaces", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    agents: [makeAgent({ model: "missing/default" })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "amp-code")),
    "UnknownReferenceError",
  );

  expect(error.field).toBe("model");
  expect(error.referenceName).toBe("missing/default");
});

test("resolveAgent still validates missing model profiles for model-free agent surfaces", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    modelspaces: [makeModelspace({ name: "models", profiles: {} })],
    agents: [makeAgent({ model: "models/missing" })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "amp-code")),
    "UnknownReferenceError",
  );

  expect(error.field).toBe("model");
  expect(error.referenceName).toBe("models/missing");
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
    agents: [makeAgent({ skills: ["global/testing"] })],
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
    agents: [makeAgent({ skills: ["global/testing"] })],
  });

  const error = assertErrorTag(
    await failResolve(resolveAgent(registry.agents.get("builder")!, registry, "opencode")),
    "AgentValidationError",
  );

  expect(error.field).toBe("skill");
  expect(error.message).toContain("invalid OpenCode skill name");
});

test("resolveAgent resolves cross-plugin references through deps", async () => {
  const core = makeRegistry({ pluginName: "agent-core" });
  addToRegistry(core, {
    identities: [makeIdentity({ name: "builder" })],
    skillspaces: [
      makeSkillspace({
        name: "core-skills",
        skills: { testing: { targets: { opencode: { name: "testing" } } } },
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
        skills: ["agent-core:core-skills/testing"],
      }),
    ],
  });

  const resolved = await runResolve(
    resolveAgent(plugin.agents.get("worker")!, plugin, "opencode"),
  );

  expect(resolved.identity.name).toBe("builder");
  expect(resolved.skills).toEqual(["testing"]);
});

test("resolveAgent produces sorted skill lists", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
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
        skills: ["global/zeta", "global/alpha"],
      }),
    ],
  });

  const resolved = await runResolve(
    resolveAgent(registry.agents.get("builder")!, registry, "opencode"),
  );

  expect(resolved.skills).toEqual(["alpha", "zeta"]);
});

test("validateOrbit succeeds for a valid agent phase", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    identities: [makeIdentity()],
    agents: [makeAgent({ name: "builder" })],
    orbits: [
      makeOrbit({
        phases: [
          {
            name: "Review",
            agents: ["builder"],
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

test("validateOrbit fails dangling phase agent refs with orbit phase and ref context", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    agents: [makeAgent({ name: "builder" })],
    orbits: [
      makeOrbit({
        phases: [
          {
            name: "Review",
            agents: ["missing-reviewer"],
          },
        ],
      }),
    ],
  });

  const error = assertErrorTag(
    await failResolve(validateOrbit(registry.orbits.get("delivery")!, registry)),
    "OrbitValidationError",
  );

  expect(error.orbitName).toBe("delivery");
  expect(error.field).toBe("phases[0].agents[0]");
  expect(error.message).toContain("missing-reviewer");
});

test("validateOrbit fails unsupported phase contract schemas at compile time", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    agents: [makeAgent({ name: "builder" })],
    orbits: [
      makeOrbit({
        phases: [
          {
            name: "Explore",
            agents: ["builder"],
            contract: {
              output: Schema.Struct({
                value: Schema.Union(Schema.String, Schema.Number),
              }),
            },
          },
        ],
      }),
    ],
  });

  const error = assertErrorTag(
    await failResolve(validateOrbit(registry.orbits.get("delivery")!, registry)),
    "OrbitValidationError",
  );

  expect(error.field).toBe("phases[0].contract.output");
  expect(error.message).toContain("workflow output schema");
});

test("projectOrbitsForCompileManifest fails for dangling agent refs", async () => {
  const registry = makeRegistry();
  addToRegistry(registry, {
    orbits: [
      makeOrbit({
        phases: [{ name: "Review", agents: ["ghost"] }],
      }),
    ],
  });

  const error = assertErrorTag(
    await failResolve(
      projectOrbitsForCompileManifest([registry.orbits.get("delivery")!], registry),
    ),
    "OrbitValidationError",
  );

  expect(error.message).toContain("ghost");
});

test("makeResolvedAgent factory produces a valid ResolvedAgent", () => {
  const resolved = makeResolvedAgent({
    skills: ["testing"],
  });

  expect(resolved.agent.name).toBe("builder");
  expect(resolved.identity.name).toBe("builder");
  expect(resolved.skills).toEqual(["testing"]);
});
