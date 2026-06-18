/**
 * Property tests for trait tool materialization (src/compile/protocol-tools.ts)
 * and the cross-trait merge rules that consume it.
 *
 * Covered properties:
 *  - materializeTraitTools is deterministic/idempotent for the same inputs.
 *  - Cross-trait tool binding merge is order-independent when no conflicts exist.
 *  - Identical logical-name/tool bindings from different traits do not conflict.
 *  - Conflicting logical-name/tool bindings from different traits fail closed.
 *  - Unknown canonical tool refs, undeclared slots, and non-schema slots fail closed.
 */

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Schema } from "effect";
import fc from "fast-check";
import { emptyRegistry } from "./registry.js";
import { materializeTraitTools, type ProtocolSurfaceError } from "./protocol-tools.js";
import { resolveAgentCapabilities } from "./resolve.js";
import { Agent, CanonicalTool, Trait } from "./sources.js";
import type { PluginRegistry } from "./registry.js";
import {
  arbitraryBridgeSupportedSchema,
  arbitraryIdentifier,
  arbitraryTraitWithSlottedTool,
  arbitraryTraitWithTool,
  propertyTestConfig,
} from "./testing/registry-fixtures.js";

const pluginRoot = "/tmp/prism-protocol-property/main";

const runAgentCapabilities = (agent: Agent, registry: PluginRegistry) => {
  const effect = resolveAgentCapabilities(agent, registry);
  const exit = Effect.runSyncExit(effect);
  if (exit._tag === "Failure") {
    throw Cause.squash(exit.cause);
  }
  return exit.value;
};

const agentWithTraits = (name: string, traits: Agent["traits"]): Agent =>
  new Agent({
    name,
    sourcePath: `${pluginRoot}/agents/${name}.agent.ts`,
    description: `Agent ${name}`,
    identity: "builder",
    traits,
    access: { tools: [], toolGroups: [], skills: [] },
    skills: [],
    targets: {},
  });

const isProtocolError = (result: unknown): result is ProtocolSurfaceError =>
  typeof result === "object" && result !== null && "field" in result && "message" in result;

describe("trait tool materialization properties", () => {
  const config = propertyTestConfig();

  test("materializeTraitTools is idempotent for the same trait+binding", () => {
    fc.assert(
      fc.property(arbitraryTraitWithSlottedTool(pluginRoot), (fixture) => {
        const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
        registry.tools.set(fixture.canonicalTool.name, fixture.canonicalTool);

        const options = {
          agentName: "test-agent",
          ownerPluginName: "main",
          canonicalTraitId: `main:${fixture.trait.name}`,
          trait: fixture.trait,
          binding: fixture.binding,
          registry,
        };

        const first = materializeTraitTools(options);
        const second = materializeTraitTools(options);

        expect(Array.isArray(first)).toBe(true);
        expect(first).toEqual(second);
      }),
      config,
    );
  });

  test("cross-trait merge is order-independent for disjoint tool bindings", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbitraryTraitWithTool(pluginRoot), arbitraryTraitWithTool(pluginRoot)).filter(
          ([a, b]) => a.trait.name !== b.trait.name && !Object.keys(a.trait.tools).some((k) => k in b.trait.tools),
        ),
        ([fixtureA, fixtureB]) => {
          const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
          registry.tools.set(fixtureA.canonicalTool.name, fixtureA.canonicalTool);
          registry.tools.set(fixtureB.canonicalTool.name, fixtureB.canonicalTool);
          registry.traits.set(fixtureA.trait.name, fixtureA.trait);
          registry.traits.set(fixtureB.trait.name, fixtureB.trait);

          const agentAFirst = agentWithTraits("order-test", [fixtureA.binding, fixtureB.binding]);
          const agentBFirst = agentWithTraits("order-test", [fixtureB.binding, fixtureA.binding]);

          const resultAFirst = runAgentCapabilities(agentAFirst, registry);
          const resultBFirst = runAgentCapabilities(agentBFirst, registry);

          expect(resultAFirst.toolRefs.map((r) => r.logicalName).sort()).toEqual(
            resultBFirst.toolRefs.map((r) => r.logicalName).sort(),
          );
          expect(resultAFirst.access.tools).toEqual(resultBFirst.access.tools);
        },
      ),
      config,
    );
  });

  test("identical logical-name/tool bindings from different traits do not conflict", () => {
    fc.assert(
      fc.property(arbitraryTraitWithTool(pluginRoot), (fixture) => {
        const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
        registry.tools.set(fixture.canonicalTool.name, fixture.canonicalTool);

        const traitA = new Trait({
          ...fixture.trait,
          name: `${fixture.trait.name}_a`,
          sourcePath: fixture.trait.sourcePath.replace(".trait", "_a.trait"),
        });
        const traitB = new Trait({
          ...fixture.trait,
          name: `${fixture.trait.name}_b`,
          sourcePath: fixture.trait.sourcePath.replace(".trait", "_b.trait"),
        });
        registry.traits.set(traitA.name, traitA);
        registry.traits.set(traitB.name, traitB);

        const bindingA = { ...fixture.binding, ref: traitA.name };
        const bindingB = { ...fixture.binding, ref: traitB.name };

        const agent = agentWithTraits("shared-binding", [bindingA, bindingB]);
        const result = runAgentCapabilities(agent, registry);

        expect(result.toolRefs.map((r) => r.logicalName)).toEqual(
          Object.keys(fixture.trait.tools).sort(),
        );
      }),
      config,
    );
  });

  test("conflicting logical-name/tool bindings from different traits fail closed", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbitraryIdentifier(), arbitraryIdentifier(), arbitraryIdentifier()).chain(
          ([logicalName, toolA, toolB]) =>
            fc.tuple(
              arbitraryBridgeSupportedSchema({ maxDepth: 1 }),
              arbitraryBridgeSupportedSchema({ maxDepth: 1 }),
            ).map(([inputA, inputB]) => {
              const makeTool = (name: string, input: Schema.Schema.AnyNoContext) =>
                new CanonicalTool({
                  name,
                  sourcePath: `${pluginRoot}/tools/${name}.tool.ts`,
                  description: `Tool ${name}`,
                  input,
                  output: Schema.Struct({ ok: Schema.Boolean }),
                  slots: {},
                  async handle() {
                    return { ok: true };
                  },
                });

              const traitA = new Trait({
                name: "trait_a",
                sourcePath: `${pluginRoot}/traits/trait_a.trait.ts`,
                description: "Trait A",
                instructions: [],
                access: { tools: [], toolGroups: [], skills: [] },
                tools: { [logicalName]: { ref: toolA } },
                inject: { skills: [] },
                require: { tools: [], skills: [] },
              });

              const traitB = new Trait({
                name: "trait_b",
                sourcePath: `${pluginRoot}/traits/trait_b.trait.ts`,
                description: "Trait B",
                instructions: [],
                access: { tools: [], toolGroups: [], skills: [] },
                tools: { [logicalName]: { ref: toolB } },
                inject: { skills: [] },
                require: { tools: [], skills: [] },
              });

              return {
                toolA: makeTool(toolA, inputA),
                toolB: makeTool(toolB, inputB),
                traitA,
                traitB,
              };
            }),
        ),
        ({ toolA, toolB, traitA, traitB }) => {
          fc.pre(toolA.name !== toolB.name);
          const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
          registry.tools.set(toolA.name, toolA);
          registry.tools.set(toolB.name, toolB);
          registry.traits.set(traitA.name, traitA);
          registry.traits.set(traitB.name, traitB);

          const agent = agentWithTraits("conflict", [
            { ref: traitA.name, tools: {} },
            { ref: traitB.name, tools: {} },
          ]);

          expect(() => runAgentCapabilities(agent, registry)).toThrow(/conflicting tool bindings/);
        },
      ),
      config,
    );
  });

  test("materializeTraitTools fails closed on unknown canonical tool refs", () => {
    fc.assert(
      fc.property(arbitraryTraitWithTool(pluginRoot), arbitraryIdentifier(), (fixture, missingRef) => {
        fc.pre(!Object.prototype.hasOwnProperty.call(fixture.trait.tools, missingRef));

        const trait = new Trait({
          ...fixture.trait,
          tools: { ...fixture.trait.tools, [missingRef]: { ref: "missing-tool" } },
        });
        const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
        registry.tools.set(fixture.canonicalTool.name, fixture.canonicalTool);

        const result = materializeTraitTools({
          agentName: "test-agent",
          ownerPluginName: "main",
          canonicalTraitId: `main:${trait.name}`,
          trait,
          binding: fixture.binding,
          registry,
        });

        expect(isProtocolError(result)).toBe(true);
        const error = result as ProtocolSurfaceError;
        expect(error.field).toContain(`traits.${trait.name}.tools.${missingRef}.ref`);
        expect(error.message).toContain("references unknown tool 'missing-tool'");
      }),
      config,
    );
  });

  test("materializeTraitTools fails closed on undeclared slots", () => {
    fc.assert(
      fc.property(arbitraryTraitWithSlottedTool(pluginRoot), arbitraryIdentifier(), (fixture, unknownSlot) => {
        fc.pre(!Object.prototype.hasOwnProperty.call(fixture.canonicalTool.slots, unknownSlot));
        fc.pre(unknownSlot.length > 0);

        const logicalName = Object.keys(fixture.trait.tools)[0]!;
        const binding = {
          ...fixture.binding,
          tools: {
            ...fixture.binding.tools,
            [logicalName]: {
              slots: {
                [unknownSlot]: {
                  schema: Schema.String,
                  source: { sourcePath: `${pluginRoot}/schemas/extra.ts`, exportName: "Extra" },
                },
              },
            },
          },
        };

        const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
        registry.tools.set(fixture.canonicalTool.name, fixture.canonicalTool);

        const result = materializeTraitTools({
          agentName: "test-agent",
          ownerPluginName: "main",
          canonicalTraitId: `main:${fixture.trait.name}`,
          trait: fixture.trait,
          binding,
          registry,
        });

        expect(isProtocolError(result)).toBe(true);
        const error = result as ProtocolSurfaceError;
        expect(error.field).toContain(`slots`);
        expect(error.message).toContain("fills undeclared tool slot(s)");
        expect(error.message).toContain(unknownSlot);
      }),
      config,
    );
  });

  test("materializeTraitTools fails closed on non-Effect schema slots", () => {
    fc.assert(
      fc.property(arbitraryTraitWithSlottedTool(pluginRoot), (fixture) => {
        const logicalName = Object.keys(fixture.trait.tools)[0]!;
        const declaredSlot = Object.keys(fixture.canonicalTool.slots)[0]!;
        const binding = {
          ...fixture.binding,
          tools: {
            ...fixture.binding.tools,
            [logicalName]: {
              slots: {
                [declaredSlot]: {
                  schema: 42 as any,
                  source: { sourcePath: `${pluginRoot}/schemas/bad.ts`, exportName: "Bad" },
                },
              },
            },
          },
        };

        const registry = emptyRegistry(pluginRoot, "main", "0.1.0");
        registry.tools.set(fixture.canonicalTool.name, fixture.canonicalTool);

        const result = materializeTraitTools({
          agentName: "test-agent",
          ownerPluginName: "main",
          canonicalTraitId: `main:${fixture.trait.name}`,
          trait: fixture.trait,
          binding,
          registry,
        });

        expect(isProtocolError(result)).toBe(true);
        const error = result as ProtocolSurfaceError;
        expect(error.message).toContain("must resolve to an Effect Schema");
      }),
      config,
    );
  });
});
