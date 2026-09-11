/**
 * Resolve-phase contract tests.
 *
 * These tests exercise `resolveAgent` against in-memory registries built by
 * `test-support.ts`.
 */

import { expect, test } from "bun:test";
import { Cause, Effect, Option } from "effect";
import type { CompileError } from "./errors.js";
import { resolveAgent } from "./resolve.js";
import {
  addToRegistry,
  makeAgent,
  makeIdentity,
  makeModelspace,
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

test("makeResolvedAgent factory produces a valid ResolvedAgent", () => {
  const resolved = makeResolvedAgent({
    skills: ["testing"],
  });

  expect(resolved.agent.name).toBe("builder");
  expect(resolved.identity.name).toBe("builder");
  expect(resolved.skills).toEqual(["testing"]);
});
