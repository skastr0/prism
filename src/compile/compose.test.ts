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
  makeResolvedAgent,
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

test("composeAgent section order: title, personality, identity body, skills", () => {
  const resolved = makeResolvedAgent({
    identity: makeIdentity({ body: "# Builder\n\nCore identity." }),
    personality: makePersonality({
      temperament: "focused",
      communication: "terse",
      body: "Be direct.",
    }),
    skills: ["testing", "debugging"],
  });

  const composed = composeAgent(resolved);
  const headers = sectionHeaders(composed.body);

  expect(headers).toEqual([
    "# Builder",
    "## Personality",
    "## Recommended Skills",
  ]);
});

test("composeAgent omits empty sections", () => {
  const resolved = makeResolvedAgent({
    identity: makeIdentity({ body: "# Only Title\n\nOnly body." }),
  });

  const composed = composeAgent(resolved);

  expect(composed.body).not.toContain("## Personality");
  expect(composed.body).not.toContain("## Recommended Skills");
});

test("composeAgent surfaces resolved model and skills", () => {
  const resolved = makeResolvedAgent({
    agent: makeAgent({ name: "worker", targets: { opencode: { mode: "primary" } } }),
    identity: makeIdentity({ name: "worker", body: "# Worker\n" }),
    resolvedModel: { model: "openai/gpt-5", temperature: 0.2 },
    skills: ["testing"],
  });

  const composed = composeAgent(resolved);

  expect(composed.model).toEqual({ model: "openai/gpt-5", temperature: 0.2 });
  expect(composed.skills).toEqual(["testing"]);
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

test("composeAgent manifest metadata carries model bindings", () => {
  const resolved = makeResolvedAgent({
    agent: makeAgent({ name: "worker", model: "models/default" }),
    identity: makeIdentity({ name: "worker", body: "# Worker\n" }),
  });

  const composed = composeAgent(resolved);

  expect(composed.manifest).toBeDefined();
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
