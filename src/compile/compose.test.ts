/**
 * Compose-phase contract tests.
 *
 * These tests exercise `composeAgent` with hand-constructed `ResolvedAgent`
 * inputs and assert structural invariants rather than exact prose snapshots.
 */

import { expect, test } from "bun:test";
import { composeAgent } from "./compose.js";
import {
  makeAgent,
  makeIdentity,
  makePersonality,
  makeRegistry,
  makeResolvedAgent,
  makeTrait,
} from "./test-support.js";

const sectionHeaders = (body: string): string[] =>
  body.split("\n").filter((line) => line.startsWith("#"));

test("composeAgent splits markdown title from identity body", () => {
  const resolved = makeResolvedAgent({
    identity: makeIdentity({
      body: "# Builder Identity\n\nBuilds scoped changes.\n\nMore detail.",
    }),
  });

  const composed = composeAgent(resolved);

  expect(composed.name).toBe("builder");
  expect(composed.body.startsWith("# Builder Identity")).toBe(true);
  expect(composed.body).toContain("Builds scoped changes.");
});

test("composeAgent section order: title, personality, identity body, skills, trait instructions", () => {
  const resolved = makeResolvedAgent({
    identity: makeIdentity({ body: "# Builder\n\nCore identity." }),
    personality: makePersonality({
      temperament: "focused",
      communication: "terse",
      body: "Be direct.",
    }),
    traits: [
      {
        ref: "reviewable",
        canonicalId: "test-plugin:reviewable",
        trait: makeTrait({
          name: "reviewable",
          instructions: ["Review thoroughly."],
        }),
        binding: { ref: "reviewable", tools: {} },
        owner: makeRegistry(),
      },
    ],
    skills: ["testing", "debugging"],
  });

  const composed = composeAgent(resolved);
  const headers = sectionHeaders(composed.body);

  expect(headers).toEqual([
    "# Builder",
    "## Personality",
    "## Recommended Skills",
    "## Trait Instructions",
    "### reviewable",
  ]);
});

test("composeAgent omits empty sections", () => {
  const resolved = makeResolvedAgent({
    identity: makeIdentity({ body: "# Only Title\n\nOnly body." }),
  });

  const composed = composeAgent(resolved);

  expect(composed.body).not.toContain("## Personality");
  expect(composed.body).not.toContain("## Recommended Skills");
  expect(composed.body).not.toContain("## Trait Instructions");
});

test("composeAgent includes trait instructions in binding order", () => {
  const resolved = makeResolvedAgent({
    identity: makeIdentity({ body: "# Agent\n" }),
    traits: [
      {
        ref: "first",
        canonicalId: "test-plugin:first",
        trait: makeTrait({ name: "first", instructions: ["First instruction."] }),
        binding: { ref: "first", tools: {} },
        owner: makeRegistry(),
      },
      {
        ref: "second",
        canonicalId: "test-plugin:second",
        trait: makeTrait({ name: "second", instructions: ["Second instruction."] }),
        binding: { ref: "second", tools: {} },
        owner: makeRegistry(),
      },
    ],
  });

  const composed = composeAgent(resolved);
  const firstIndex = composed.body.indexOf("First instruction.");
  const secondIndex = composed.body.indexOf("Second instruction.");

  expect(firstIndex).toBeGreaterThan(-1);
  expect(secondIndex).toBeGreaterThan(firstIndex);
});

test("composeAgent surfaces resolved model and allowed tools/skills", () => {
  const resolved = makeResolvedAgent({
    agent: makeAgent({ name: "worker", targets: { opencode: { mode: "primary" } } }),
    identity: makeIdentity({ name: "worker", body: "# Worker\n" }),
    resolvedModel: { model: "openai/gpt-5", temperature: 0.2 },
    skills: ["testing"],
    allowedSkills: ["testing", "debugging"],
    allowedTools: ["bash"],
  });

  const composed = composeAgent(resolved);

  expect(composed.model).toEqual({ model: "openai/gpt-5", temperature: 0.2 });
  expect(composed.skills).toEqual(["testing"]);
  expect(composed.allowedSkills).toEqual(["testing", "debugging"]);
  expect(composed.allowedTools).toEqual(["bash"]);
  expect(composed.targetOverride).toEqual({ opencode: { mode: "primary" } });
});

test("composeAgent preserves color and description", () => {
  const resolved = makeResolvedAgent({
    agent: makeAgent({ name: "worker", description: "Does work.", color: "green" }),
    identity: makeIdentity({ name: "worker", body: "# Worker\n" }),
  });

  const composed = composeAgent(resolved);

  expect(composed.description).toBe("Does work.");
  expect(composed.color).toBe("green");
});

test("composeAgent manifest metadata lists trait ids and model bindings", () => {
  const resolved = makeResolvedAgent({
    agent: makeAgent({ name: "worker", model: "models/default" }),
    identity: makeIdentity({ name: "worker", body: "# Worker\n" }),
    traits: [
      {
        ref: "reviewable",
        canonicalId: "test-plugin:reviewable",
        trait: makeTrait({ name: "reviewable" }),
        binding: { ref: "reviewable", tools: {} },
        owner: makeRegistry(),
      },
    ],
  });

  const composed = composeAgent(resolved);

  expect(composed.manifest).toBeDefined();
  expect(composed.manifest!.traits).toEqual([
    { id: "test-plugin:reviewable", ref: "reviewable" },
  ]);
  expect(composed.manifest!.modelBindings).toEqual({
    modelspace: "models",
    profile: "default",
  });
});

test("composeAgent handles identity body without title", () => {
  const resolved = makeResolvedAgent({
    identity: makeIdentity({ body: "No title here.\n\nJust body." }),
  });

  const composed = composeAgent(resolved);

  expect(composed.body).toBe("No title here.\n\nJust body.");
});
